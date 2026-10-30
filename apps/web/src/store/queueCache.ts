// Per-room queue cache (localStorage): paints the last-known queue on reload
// before the room's first sync-full arrives. Stale-while-revalidate only — the room
// (D1, via the API) stays authoritative and sync-full replaces this. Versioned + defensive
// reads, so an old cache can't break a newer client (bump VERSION to invalidate).
import { serializeRequest, deserializeRequest } from '../types';
import type { Request, SerializedRequest } from '../types';

const VERSION = 1;

const keyFor = (channel: string) => `fila-dbd-queue-v${VERSION}-${channel.toLowerCase()}`;

interface QueueCacheEnvelope {
  v: number;
  requests: SerializedRequest[];
}

export function loadCachedQueue(channel: string): Request[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(keyFor(channel));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as QueueCacheEnvelope | null;
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.requests)) return [];
    return parsed.requests.map(deserializeRequest);
  } catch {
    return [];
  }
}

export function saveCachedQueue(channel: string, requests: Request[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: QueueCacheEnvelope = { v: VERSION, requests: requests.map(serializeRequest) };
    localStorage.setItem(keyFor(channel), JSON.stringify(envelope));
  } catch {
    // ignore quota / serialization / storage-unavailable errors — the cache is
    // an optimization, not a requirement.
  }
}
