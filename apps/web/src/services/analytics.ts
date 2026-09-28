// PostHog, loaded off the paint path. Nothing here imports posthog-js statically:
// the SDK is its own chunk (vite.config.ts manualChunks), fetched once the page has
// painted and the browser is idle. Events captured before that are queued, so
// instrumentation can call track() from the first render on.
//
// Privacy: the party socket URL carries `?token=<JWT>`, the OAuth callback URL
// carries `?code=&state=`, and `dbd-auth` in localStorage holds both tokens. No
// event property may ever contain one — every event goes through scrubProperties()
// in before_send, whatever produced it (our events, pageviews, exceptions). Session
// replay, autocapture, heatmaps and console capture stay off (see initAnalytics).
import type { PostHog, CaptureResult } from 'posthog-js';

export type Properties = Record<string, unknown>;

// Read per call (not at module load) so tests can stub them.
const key = () => import.meta.env.VITE_POSTHOG_KEY as string | undefined;
const host = () => (import.meta.env.VITE_POSTHOG_HOST as string | undefined) || 'https://us.i.posthog.com';
// Local builds (preview included) stay silent unless this is set at build time, so
// verifying a production build doesn't write into the production project.
const allowLocal = () => import.meta.env.VITE_POSTHOG_ALLOW_LOCAL === 'true';

// The project is shared with other apps: every event carries this.
export const APP_NAME = 'fila-dbd';

const MAX_QUEUE = 200;

type Queued =
  | { kind: 'capture'; event: string; props: Properties }
  | { kind: 'identify'; login: string }
  | { kind: 'reset' };

let client: PostHog | null = null;
let queue: Queued[] = [];
let started = false;
let identifiedAs: string | null = null;

// ---------- scrubbing ----------

const JWT_RE = /eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g;
const SECRET_PARAM_RE = /([?&#](?:token|access_token|refresh_token|id_token|code|state)=)[^&#\s"']*/gi;
// Not bare `token`: that's the SDK's own property, the project token ingestion routes on.
const SECRET_KEY_RE = /^(access_?token|refresh_?token|id_?token|authorization|password|secret)$/i;

export function scrubString(value: string): string {
  return value.replace(JWT_RE, '[redacted]').replace(SECRET_PARAM_RE, '$1[redacted]');
}

/** Deep copy of `value` with every token-shaped string and token-named key redacted. */
export function scrubProperties<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === 'string') return scrubString(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubProperties(v, depth + 1)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && v != null ? '[redacted]' : scrubProperties(v, depth + 1);
    }
    return out as T;
  }
  return value;
}

function beforeSend(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  event.properties = scrubProperties(event.properties);
  if (event.$set) event.$set = scrubProperties(event.$set);
  if (event.$set_once) event.$set_once = scrubProperties(event.$set_once);
  return event;
}

// ---------- public API ----------

function enabled(): boolean {
  if (!key() || typeof window === 'undefined') return false;
  const hostname = window.location.hostname;
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  return !isLocal || allowLocal();
}

function enqueue(item: Queued) {
  if (queue.length >= MAX_QUEUE) queue.shift();
  queue.push(item);
}

export function track(event: string, props: Properties = {}): void {
  if (!enabled()) return;
  if (client) client.capture(event, props);
  else enqueue({ kind: 'capture', event, props });
}

/** Signed-in streamers only, by their public Twitch login. Viewers stay anonymous. */
export function identify(login: string): void {
  if (!enabled()) return;
  const id = login.toLowerCase();
  if (identifiedAs === id) return;
  identifiedAs = id;
  if (client) client.identify(id, { twitch_login: id });
  else enqueue({ kind: 'identify', login: id });
}

export function resetIdentity(): void {
  if (!enabled() || identifiedAs === null) return;
  identifiedAs = null;
  if (client) client.reset();
  else enqueue({ kind: 'reset' });
}

function flushQueue(ph: PostHog) {
  const pending = queue;
  queue = [];
  for (const item of pending) {
    if (item.kind === 'capture') ph.capture(item.event, item.props);
    else if (item.kind === 'identify') ph.identify(item.login, { twitch_login: item.login });
    else ph.reset();
  }
}

async function load() {
  // The full default entrypoint (~100 kB gz, its own lazy chunk). The slim build plus
  // extension bundles came out no smaller: the prebuilt bundle doesn't tree-shake.
  const { default: posthog } = await import('posthog-js');
  posthog.init(key()!, {
    api_host: host(),
    ui_host: 'https://us.posthog.com',
    // Anonymous viewers never get a person profile; streamers do once identified.
    person_profiles: 'identified_only',
    persistence: 'localStorage',
    capture_pageview: 'history_change',
    capture_pageleave: 'if_capture_pageview',
    // Explicit, not left to the (shared) project's remote config: autocapture and
    // heatmaps would record viewer names and request text off the queue, and replay
    // would record the socket URL and the auth payload. Replay also costs a large
    // recorder bundle on every streamer's machine.
    autocapture: false,
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    disable_session_recording: true,
    enable_recording_console_log: false,
    capture_performance: false,
    disable_surveys: true,
    disable_product_tours: true,
    disable_web_experiments: true,
    disable_conversations: true,
    // No flags in use: skip the /flags round trip.
    advanced_disable_flags: true,
    capture_exceptions: true,
    before_send: beforeSend,
    loaded: (ph) => {
      ph.register({ app: APP_NAME, app_version: __APP_VERSION__ });
    },
  });
  client = posthog;
  flushQueue(posthog);
}

/**
 * Schedules the SDK load for after first paint, when the browser is idle. Safe to call
 * more than once; a no-op without VITE_POSTHOG_KEY (dev, tests) or on localhost.
 */
export function initAnalytics(): void {
  if (started || !enabled()) return;
  started = true;
  const start = () => {
    load().catch((e) => {
      // An ad blocker or a failed chunk fetch: analytics is best-effort.
      console.warn('[analytics] PostHog failed to load', e);
      queue = [];
    });
  };
  const whenIdle = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(start, { timeout: 5000 });
    else setTimeout(start, 1000);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
}

// Test-only: resets module state between cases.
export function __resetAnalyticsForTests(): void {
  client = null;
  queue = [];
  started = false;
  identifiedAs = null;
}
