import PartySocket from 'partysocket';
import type { Request, PartyMessage, SerializedRequest, SourcesSettings } from '../types';
import { serializeRequest, PROTOCOL_VERSION } from '../types';
import { realtimeTelemetry, describeSocketUrl } from './realtimeTelemetry';

const PARTY_HOST = import.meta.env.VITE_PARTY_HOST || 'localhost:1999';

let socket: PartySocket | null = null;

export function connectParty(
  channel: string,
  accessToken: string | null,
  onMessage: (msg: PartyMessage) => void,
  onOpen?: () => void,
  onClose?: () => void,
  onError?: () => void
): void {
  if (socket) {
    socket.close();
  }

  socket = new PartySocket({
    host: PARTY_HOST,
    room: channel.toLowerCase(),
    query: { ...(accessToken ? { token: accessToken } : {}), v: String(PROTOCOL_VERSION) },
  });

  const current = socket;
  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data) as PartyMessage;
      observe(() => realtimeTelemetry.onMessage(msg));
      onMessage(msg);
    } catch {
      // ignore invalid messages
    }
  });

  socket.addEventListener('open', () => {
    // Only whether a token was presented and its remaining TTL — never the URL.
    observe(() => realtimeTelemetry.onOpen(describeSocketUrl(current.url)));
    onOpen?.();
  });

  socket.addEventListener('close', (event) => {
    // A socket we closed on purpose (disconnectParty, a channel switch) isn't an outage.
    if (current === socket) observe(() => realtimeTelemetry.onClose({ code: event.code, wasClean: event.wasClean }));
    onClose?.();
  });

  socket.addEventListener('error', () => {
    onError?.();
  });
}

export function disconnectParty(): void {
  if (socket) {
    socket.close();
    socket = null;
  }
}

export function isPartyConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}

function send(msg: PartyMessage): void {
  const open = socket?.readyState === WebSocket.OPEN;
  observe(() => realtimeTelemetry.onSend(msg, open));
  if (socket && open) {
    socket.send(JSON.stringify(msg));
  }
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

export function broadcastIrcStatus(connected: boolean): void {
  send({ type: 'irc-status', connected });
}

export function claimOwnership(): void {
  send({ type: 'claim-ownership' });
}

export function releaseOwnership(): void {
  send({ type: 'release-ownership' });
}

// Telemetry must never break the socket path it watches.
function observe(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.warn('[telemetry]', e);
  }
}
