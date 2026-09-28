// PostHog events from the PartyKit server.
//
// PartyKit has no log export, so what the room sees (auth failures at connect, refused
// edits, D1 sync failures) would otherwise only exist in `partykit tail`. Events go
// straight to PostHog's batch capture endpoint rather than through the Worker: they land
// as queryable, alertable events next to the web client's, without costing a Worker
// request per event or coupling the two deploys.
//
// Never on the hot path: capture() only buffers; a timer flushes fire-and-forget, and a
// failed flush is dropped. Storage and broadcast never wait on it. Noisy keys are
// throttled per room, so a client stuck sending refused edits (or a D1 outage retrying
// every 2s) costs one event per window plus a count, not one per attempt.

export interface TelemetryEnv {
  POSTHOG_KEY?: unknown;
  POSTHOG_HOST?: unknown;
  DEV_MODE?: unknown;
}

type Properties = Record<string, unknown>;

interface QueuedEvent {
  event: string;
  distinct_id: string;
  timestamp: string;
  properties: Properties;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const APP_NAME = 'fila-dbd';
const FLUSH_DELAY_MS = 2_000;
const MAX_BATCH = 50;
const MAX_BUFFER = 500;
export const THROTTLE_WINDOW_MS = 60_000;
// Throttle keys are built from server-side vocabulary only, but a bound keeps a bug (or
// a new key built from client input) from growing the room's memory without limit.
export const MAX_THROTTLE_KEYS = 64;
// A slow PostHog must not hold a room's fetch slots: the room's own D1 write-through
// and chat-confirm fetches share the connection limit with these.
export const EXPORT_TIMEOUT_MS = 5_000;

interface ThrottleState {
  windowStart: number;
  suppressed: number;
  last: Properties;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RoomTelemetry {
  private buffer: QueuedEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private throttles = new Map<string, ThrottleState>();
  private inFlight = false;
  private readonly key: string | null;
  private readonly host: string;

  constructor(
    private room: string,
    env: TelemetryEnv,
    private fetcher: Fetch = (url, init) => fetch(url, init),
    private now: () => number = Date.now,
    private warn: (...args: unknown[]) => void = (...args) => console.warn(...args),
  ) {
    const key = typeof env.POSTHOG_KEY === 'string' && env.POSTHOG_KEY ? env.POSTHOG_KEY : null;
    // `partykit dev` runs with DEV_MODE=true: keep local rooms out of the production project.
    this.key = env.DEV_MODE === 'true' ? null : key;
    this.host = (typeof env.POSTHOG_HOST === 'string' && env.POSTHOG_HOST) || 'https://us.i.posthog.com';
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  capture(event: string, properties: Properties = {}): void {
    if (!this.key) return;
    if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
    this.buffer.push({
      event,
      // The room id is the streamer's Twitch login — the same id the web client
      // identifies them by, so both sides line up per channel.
      distinct_id: this.room,
      timestamp: new Date(this.now()).toISOString(),
      properties: {
        ...properties,
        app: APP_NAME,
        source: 'partykit',
        channel: this.room,
        // Server events never create or update person profiles.
        $process_person_profile: false,
      },
    });
    if (this.buffer.length >= MAX_BATCH) this.flush();
    else this.scheduleFlush();
  }

  /**
   * At most one event per `key` per window. The first occurrence is sent at once
   * (count: 1); later ones in the same window are folded into one follow-up event at
   * the window's end, carrying their count and the latest properties.
   */
  captureThrottled(key: string, event: string, properties: Properties = {}, windowMs = THROTTLE_WINDOW_MS): void {
    if (!this.key) return;
    const now = this.now();
    const state = this.throttles.get(key);
    if (!state && this.throttles.size >= MAX_THROTTLE_KEYS) {
      for (const [k, s] of this.throttles) {
        if (!s.timer && now - s.windowStart >= windowMs) this.throttles.delete(k);
      }
      // Still full of live windows: dropping this one keeps memory and event volume bounded.
      if (this.throttles.size >= MAX_THROTTLE_KEYS) return;
    }
    if (!state || now - state.windowStart >= windowMs) {
      if (state?.timer) clearTimeout(state.timer);
      this.throttles.set(key, { windowStart: now, suppressed: 0, last: properties, timer: null });
      this.capture(event, { ...properties, count: 1 });
      return;
    }
    state.suppressed++;
    state.last = properties;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        if (state.suppressed === 0) return;
        const count = state.suppressed;
        state.suppressed = 0;
        // Next occurrence opens a fresh window.
        state.windowStart = 0;
        this.capture(event, { ...state.last, count, throttled: true });
      }, Math.max(0, state.windowStart + windowMs - now));
    }
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.key || this.buffer.length === 0) return;
    // One request at a time: when PostHog is slow, events wait in the (bounded) buffer
    // instead of stacking a new pending fetch every flush.
    if (this.inFlight) {
      this.scheduleFlush();
      return;
    }
    const batch = this.buffer.splice(0, MAX_BATCH);
    this.inFlight = true;
    void this.fetcher(`${this.host}/batch/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.key, batch }),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    }).then(
      (res) => {
        if (!res.ok) this.warn(`[${this.room}] PostHog capture failed: ${res.status}`);
      },
      (e) => this.warn(`[${this.room}] PostHog capture error:`, e),
    ).finally(() => {
      this.inFlight = false;
    });
    if (this.buffer.length > 0) this.scheduleFlush();
  }
}

/**
 * Why a token failed verification, from its unverified payload — never the token itself.
 * `expired` separates the stale-token case (a socket reconnecting with an old access
 * token) from a bad signature or a malformed token.
 */
export function describeRejectedToken(token: string, nowMs = Date.now()): Properties {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    const expiredForS = exp !== null ? Math.round(nowMs / 1000 - exp) : null;
    return {
      reason: expiredForS !== null && expiredForS >= 0 ? 'expired' : 'invalid',
      expired_for_s: expiredForS !== null && expiredForS >= 0 ? expiredForS : null,
      // Unverified: whoever the token claims to be. Twitch logins are public.
      // Twitch logins are ≤25 of [a-z0-9_]; anything else in an unverified token is noise.
      claimed_login: typeof payload.login === 'string' && /^\w{1,25}$/.test(payload.login) ? payload.login.toLowerCase() : null,
    };
  } catch {
    return { reason: 'malformed', expired_for_s: null, claimed_login: null };
  }
}
