import PartySocket from 'partysocket';
import type { Request, PartyMessage, SerializedRequest, SourcesSettings } from '../types';
import { serializeRequest } from '../types';

declare const __APP_VERSION__: string;

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
    query: { ...(accessToken ? { token: accessToken } : {}), v: __APP_VERSION__ },
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data) as PartyMessage;
      onMessage(msg);
    } catch {
      // ignore invalid messages
    }
  });

  socket.addEventListener('open', () => {
    onOpen?.();
  });

  socket.addEventListener('close', () => {
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
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export function broadcastAdd(request: Request): void {
  send({ type: 'add-request', request: serializeRequest(request) });
}

export function broadcastUpdate(id: number, updates: Partial<Request>): void {
  const serializedUpdates: Partial<SerializedRequest> = {
    ...updates,
    timestamp: updates.timestamp?.toISOString(),
    doneAt: updates.doneAt?.toISOString(),
  };
  send({ type: 'update-request', id, updates: serializedUpdates });
}

export function broadcastToggleDone(id: number): void {
  send({ type: 'toggle-done', id });
}

export function broadcastReorder(fromId: number, toId: number): void {
  send({ type: 'reorder', fromId, toId });
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
