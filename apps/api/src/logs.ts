// PartyKit logs → PostHog Logs, next to the Worker's.
//
// PartyKit has no log export (the Worker gets one from wrangler.toml's
// `[observability.logs] destinations`), so each room owns a RoomLogger: it prints to
// the console exactly as before — `partykit tail` output is unchanged — and also
// queues an OTLP log record, shipped to PostHog's OTLP/HTTP logs endpoint
// (`/i/v1/logs`, JSON encoding) in batches.
//
// Per room, not a patched global `console`: Durable Objects for different rooms can
// share an isolate, so a global hook could not tell which room a line belongs to.
//
// Never on the hot path: a call only formats and buffers; a timer flushes
// fire-and-forget, a failed flush is dropped (and reported on the console only, so a
// PostHog outage can't feed itself). Bodies are scrubbed of JWTs and token URL params
// before they leave, as a backstop — the call sites don't log tokens to begin with.

export interface LogsEnv {
  POSTHOG_KEY?: unknown;
  POSTHOG_HOST?: unknown;
  DEV_MODE?: unknown;
}

type Level = 'debug' | 'log' | 'info' | 'warn' | 'error';
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Matches the Worker's `service.name` scheme (`dbd-tracker-production`). */
export const SERVICE_NAME = 'dbd-tracker-party';

const FLUSH_DELAY_MS = 2_000;
const MAX_BATCH = 200;
const MAX_BUFFER = 2_000;
const MAX_BODY = 8_000;
// Same bound as telemetry.ts: a slow PostHog can't hold the room's fetch slots.
const EXPORT_TIMEOUT_MS = 5_000;

// OTLP severity numbers: DEBUG=5, INFO=9, WARN=13, ERROR=17.
const SEVERITY: Record<Level, { text: string; number: number }> = {
  debug: { text: 'debug', number: 5 },
  log: { text: 'info', number: 9 },
  info: { text: 'info', number: 9 },
  warn: { text: 'warn', number: 13 },
  error: { text: 'error', number: 17 },
};

const JWT_RE = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const SECRET_PARAM_RE = /([?&](?:token|access_token|refresh_token|code)=)[^&#\s"']*/gi;
const BEARER_RE = /(Bearer\s+)(?!\[redacted\])[\w.:-]+/gi;

export function scrubLogText(text: string): string {
  return text.replace(JWT_RE, '[redacted]').replace(SECRET_PARAM_RE, '$1[redacted]').replace(BEARER_RE, '$1[redacted]');
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === undefined) return 'undefined';
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

/** One console line as the body PostHog shows: args joined by spaces, like the console. */
export function formatLogBody(args: unknown[]): string {
  const body = scrubLogText(args.map(formatArg).join(' '));
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…[truncated]` : body;
}

interface OtlpRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: { key: string; value: { stringValue: string } }[];
}

export class RoomLogger {
  private buffer: OtlpRecord[] = [];
  private dropped = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private readonly key: string | null;
  private readonly endpoint: string;

  constructor(
    private room: string,
    env: LogsEnv,
    private fetcher: Fetch = (url, init) => fetch(url, init),
    private now: () => number = Date.now,
    private sink: Pick<Console, Level> = console,
  ) {
    const key = typeof env.POSTHOG_KEY === 'string' && env.POSTHOG_KEY ? env.POSTHOG_KEY : null;
    // `partykit dev` runs with DEV_MODE=true: local rooms stay out of the production project.
    this.key = env.DEV_MODE === 'true' ? null : key;
    const host = (typeof env.POSTHOG_HOST === 'string' && env.POSTHOG_HOST) || 'https://us.i.posthog.com';
    this.endpoint = `${host.replace(/\/+$/, '')}/i/v1/logs`;
  }

  get enabled(): boolean {
    return this.key !== null;
  }

  debug(...args: unknown[]) { this.write('debug', args); }
  log(...args: unknown[]) { this.write('log', args); }
  info(...args: unknown[]) { this.write('info', args); }
  warn(...args: unknown[]) { this.write('warn', args); }
  error(...args: unknown[]) { this.write('error', args); }

  private write(level: Level, args: unknown[]) {
    // Console first and untouched, so `partykit tail` reads exactly as it always has.
    this.sink[level](...args);
    if (!this.key) return;
    try {
      this.enqueue(level, formatLogBody(args));
    } catch {
      // Shipping is best-effort; the console line above already happened.
    }
  }

  private enqueue(level: Level, body: string) {
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      this.dropped++;
    }
    const nanos = `${Math.floor(this.now())}000000`;
    const severity = SEVERITY[level];
    this.buffer.push({
      timeUnixNano: nanos,
      observedTimeUnixNano: nanos,
      severityNumber: severity.number,
      severityText: severity.text,
      body: { stringValue: body },
      attributes: [
        { key: 'room.id', value: { stringValue: this.room } },
        // Same attribute the Worker's export carries: which console method wrote it.
        { key: 'name', value: { stringValue: level } },
      ],
    });
    if (this.buffer.length >= MAX_BATCH) this.flush();
    else this.scheduleFlush();
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  /** Sends what's buffered now. Also called when a room empties, before it can be evicted. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.key || this.buffer.length === 0) return;
    // One export at a time: when PostHog is slow, lines wait in the (bounded) buffer
    // instead of stacking a pending fetch per room every flush — those would queue the
    // room's own D1 write-through and chat-confirm fetches behind them.
    if (this.inFlight) {
      this.scheduleFlush();
      return;
    }
    if (this.dropped > 0) {
      const nanos = `${Math.floor(this.now())}000000`;
      this.buffer.push({
        timeUnixNano: nanos,
        observedTimeUnixNano: nanos,
        severityNumber: SEVERITY.warn.number,
        severityText: SEVERITY.warn.text,
        body: { stringValue: `[${this.room}] log buffer overflow: dropped ${this.dropped} line(s) before shipping` },
        attributes: [{ key: 'room.id', value: { stringValue: this.room } }, { key: 'name', value: { stringValue: 'warn' } }],
      });
      this.dropped = 0;
    }
    const records = this.buffer.splice(0, MAX_BATCH);
    const payload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: SERVICE_NAME } },
            { key: 'deployment.environment.name', value: { stringValue: 'production' } },
            { key: 'cloud.provider', value: { stringValue: 'partykit' } },
          ],
        },
        scopeLogs: [{ scope: { name: 'party.ts' }, logRecords: records }],
      }],
    };
    this.inFlight = true;
    void this.fetcher(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    }).then(
      // Console only: shipping this through the logger would feed a PostHog outage.
      (res) => { if (!res.ok) this.sink.warn(`[${this.room}] PostHog logs export failed: ${res.status}`); },
      (e) => this.sink.warn(`[${this.room}] PostHog logs export error:`, e),
    ).finally(() => {
      this.inFlight = false;
    });
    if (this.buffer.length > 0) this.scheduleFlush();
  }
}
