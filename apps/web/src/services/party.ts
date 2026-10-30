// The room transport: plain HTTP against the API Worker, which keeps every room in D1.
// It replaced the PartyKit WebSocket (hosted PartyKit shut down on 2026-10-23) behind the
// same exports, so the stores still receive PartyMessages:
//
// - The room is polled (`GET /rooms/:id/state`). The first answer is a `sync-full`; later
//   ones only carry the queue when its `version` moved, and become a `sync-full` too.
//   The channel status comes with every answer, as `update-channel` when it changed.
// - Edits go out one at a time (`POST /rooms/:id/ops`), in order, retried on network and
//   5xx failures. The answer holds the server's echo (or a `server-error`), applied as if
//   the socket had delivered it, and relayed to this browser's other windows.
// - A poll that left before an edit landed would paint the queue from before it, so
//   answers are dropped while an edit is in flight or when older than the last write.
//
// The streamer's polls carry their token: that is their presence heartbeat (`irc=1` from
// a window reading chat), which is what the room's open/live status is derived from.
import type { Request, PartyMessage, SerializedRequest, SourcesSettings, ChannelState } from '../types';
import { serializeRequest, PROTOCOL_VERSION } from '../types';
import { realtimeTelemetry, describeToken } from './realtimeTelemetry';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

// The streamer's windows poll faster: their own edits from another window, and the
// open/closed switch, should show up quickly. Background tabs are throttled by the
// browser to about once a minute anyway; the server's presence TTL allows for that.
const POLL_OWNER_MS = 5_000;
const POLL_VIEWER_MS = 10_000;
const POLL_HIDDEN_MS = 30_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];
const MAX_BACKOFF_MS = 30_000;

interface StateResponse {
  version: number;
  channel: ChannelState;
  requests?: SerializedRequest[];
  sources?: SourcesSettings;
}

interface OpResponse {
  version?: number;
  messages?: PartyMessage[];
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

interface Session {
  room: string;
  getToken: () => Promise<string | null>;
  onMessage: (msg: PartyMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: () => void;
  isOwner: boolean;
  open: boolean;
  closed: boolean;
  version: number | null;
  /** Highest version our own writes produced; polls answering below it are stale. */
  writeVersion: number;
  lastChannel: string | null;
  inFlight: number;
  queue: PartyMessage[];
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
  ircLive: boolean;
  channel: BroadcastChannel | null;
}

let session: Session | null = null;

const pollDelay = (s: Session) => {
  if (s.failures > 0) return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (s.failures - 1));
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return POLL_HIDDEN_MS;
  return s.isOwner ? POLL_OWNER_MS : POLL_VIEWER_MS;
};

function deliver(s: Session, msg: PartyMessage) {
  if (session !== s) return;
  observe(() => realtimeTelemetry.onMessage(msg));
  try {
    s.onMessage(msg);
  } catch (e) {
    console.error('[room] message handler failed', e);
  }
}

function schedule(s: Session, delay = pollDelay(s)) {
  if (s.closed) return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => void poll(s), delay);
}

async function poll(s: Session) {
  s.timer = null;
  if (s.closed) return;
  let token: string | null = null;
  try {
    token = await s.getToken();
  } catch {
    // The streamer's session has no token right now (a refresh failed on the network).
    // Polling anonymously would read fine but stop the heartbeat; retry instead.
    return fail(s);
  }
  if (s.closed) return;
  const params = new URLSearchParams({ p: String(PROTOCOL_VERSION) });
  if (s.version !== null) params.set('v', String(s.version));
  if (s.ircLive) params.set('irc', '1');
  try {
    const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(s.room)}/state?${params}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    });
    if (s.closed) return;
    if (res.status === 426) {
      deliver(s, { type: 'server-error', code: 'version_mismatch', message: 'Nova versão disponível.' });
      return;
    }
    if (!res.ok) throw new HttpError(res.status);
    const body = await res.json() as StateResponse;
    if (s.closed) return;
    if (!s.open) {
      s.open = true;
      s.failures = 0;
      observe(() => realtimeTelemetry.onOpen(describeToken(token)));
      s.onOpen?.();
    }
    s.failures = 0;
    apply(s, body);
  } catch (e) {
    if (s.closed) return;
    console.warn('[room] poll failed', e);
    return fail(s);
  }
  schedule(s);
}

function apply(s: Session, body: StateResponse) {
  // An edit is in flight, or this answer predates one we already applied: the
  // optimistic state on screen is newer than what it carries.
  if (s.inFlight > 0 || body.version < s.writeVersion) return;
  const channel = JSON.stringify(body.channel);
  if (body.requests && body.sources) {
    s.version = body.version;
    s.lastChannel = channel;
    deliver(s, { type: 'sync-full', requests: body.requests, sources: body.sources, channel: body.channel });
    return;
  }
  if (channel !== s.lastChannel) {
    s.lastChannel = channel;
    deliver(s, { type: 'update-channel', channel: body.channel });
  }
}

function fail(s: Session) {
  s.failures++;
  if (s.open) {
    s.open = false;
    // The next answer must be a full sync: whatever happened meanwhile is unknown here.
    s.version = null;
    observe(() => realtimeTelemetry.onClose({}));
    s.onClose?.();
  } else {
    observe(() => realtimeTelemetry.onClose({}));
    s.onError?.();
  }
  schedule(s);
}

async function flush(s: Session) {
  if (s.inFlight > 0) return;
  while (s.queue.length && !s.closed) {
    const msg = s.queue[0];
    s.inFlight++;
    try {
      const body = await post(s, msg);
      if (s.closed) return;
      if (typeof body.version === 'number') {
        s.writeVersion = Math.max(s.writeVersion, body.version);
        // Our own write moved the room on; the next poll fetches it in full (cheap)
        // rather than trusting that every echo reproduced the server's state.
        s.version = null;
      }
      const messages = body.messages ?? [];
      if (!messages.some((m) => m.type !== 'server-error')) observe(() => realtimeTelemetry.onNoEcho(msg));
      for (const m of messages) deliver(s, m);
      relay(s, messages);
    } catch (e) {
      if (s.closed) return;
      console.error('[room] edit failed', msg.type, e);
      deliver(s, {
        type: 'server-error',
        code: 'persist_failed',
        message: 'Não foi possível salvar a última alteração. Recarregue a página.',
      });
    } finally {
      s.inFlight--;
      s.queue.shift();
    }
  }
}

async function post(s: Session, msg: PartyMessage): Promise<OpResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const token = await s.getToken();
      const res = await fetch(`${API_URL}/rooms/${encodeURIComponent(s.room)}/ops`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ msg, p: PROTOCOL_VERSION }),
      });
      // 401/403 carry a not_room_owner server-error for the stores; other 4xx are bugs.
      if (res.status >= 500) throw new HttpError(res.status);
      return await res.json() as OpResponse;
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || s.closed) throw e;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Other windows of this browser on the same room apply our echoes at once instead of
// waiting for their next poll. Server errors stay with the window that caused them.
function relay(s: Session, messages: PartyMessage[]) {
  const shared = messages.filter((m) => m.type !== 'server-error');
  if (shared.length) s.channel?.postMessage(shared);
}

/**
 * `getToken` runs before every request: access tokens live an hour, and the streamer's
 * session must present a current one on each poll (its heartbeat) and each edit. A
 * rejection from `getToken` fails that poll, which is retried.
 */
export function connectParty(
  channel: string,
  getToken: () => Promise<string | null>,
  onMessage: (msg: PartyMessage) => void,
  onOpen?: () => void,
  onClose?: () => void,
  onError?: () => void,
  opts: { isOwner?: boolean } = {}
): void {
  disconnectParty();
  const room = channel.toLowerCase();
  const s: Session = {
    room, getToken, onMessage, onOpen, onClose, onError,
    isOwner: !!opts.isOwner,
    open: false, closed: false, version: null, writeVersion: 0, lastChannel: null,
    inFlight: 0, queue: [], failures: 0, timer: null, ircLive: false,
    channel: typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`fila-room:${room}`) : null,
  };
  if (s.channel) {
    s.channel.onmessage = (event: MessageEvent<PartyMessage[]>) => {
      if (s.closed || !Array.isArray(event.data)) return;
      for (const m of event.data) deliver(s, m);
      // Theirs moved the room on: fetch it in full next time.
      s.version = null;
    };
  }
  session = s;
  void poll(s);
}

export function disconnectParty(): void {
  const s = session;
  if (!s) return;
  s.closed = true;
  if (s.timer) clearTimeout(s.timer);
  s.channel?.close();
  session = null;
}

/** Fetches the room again right away, in full, with a fresh token. */
export function reconnectParty(): void {
  const s = session;
  if (!s) return;
  s.version = null;
  schedule(s, 0);
}

/** Polls right away (a tab coming back into view shouldn't wait out a hidden interval). */
export function refreshParty(): void {
  if (session && !session.closed) schedule(session, 0);
}

export function isPartyConnected(): boolean {
  return !!session?.open;
}

function send(msg: PartyMessage): void {
  const s = session;
  const open = !!s?.open;
  observe(() => realtimeTelemetry.onSend(msg, open));
  if (!s || !open) return;
  s.queue.push(msg);
  void flush(s);
}

export function broadcastAdd(request: Request): void {
  send({ type: 'add-request', request: serializeRequest(request) });
}

export function broadcastUpdate(id: number, updates: Partial<Request>): void {
  const { timestamp, doneAt, ...rest } = updates;
  const serializedUpdates: Record<string, unknown> = { ...rest };
  if ('timestamp' in updates) {
    serializedUpdates.timestamp = timestamp?.toISOString() ?? null;
  }
  if ('doneAt' in updates) {
    serializedUpdates.doneAt = doneAt?.toISOString() ?? null;
  }
  send({ type: 'update-request', id, updates: serializedUpdates as Partial<SerializedRequest> });
}

export function broadcastToggleDone(id: number, done: boolean): void {
  send({ type: 'toggle-done', id, done });
}

export function broadcastReorder(fromId: number, toId: number, opId?: string): void {
  send({ type: 'reorder', fromId, toId, opId });
}

export function broadcastDelete(id: number): void {
  send({ type: 'delete-request', id });
}

export function broadcastSetAll(requests: Request[]): void {
  send({ type: 'set-all', requests: requests.map(serializeRequest) });
}

export function broadcastSources(sources: SourcesSettings): void {
  send({ type: 'update-sources', sources });
}

/** Whether this window reads chat. Sent now, and kept as the heartbeat of every poll. */
export function broadcastIrcStatus(connected: boolean): void {
  if (session) session.ircLive = connected;
  send({ type: 'irc-status', connected });
}

export function openQueueOp(): void {
  send({ type: 'open-queue' });
}

export function closeQueueOp(): void {
  if (session) session.ircLive = false;
  send({ type: 'close-queue' });
}

// Telemetry must never break the transport it watches.
function observe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn('[telemetry]', e);
  }
}
