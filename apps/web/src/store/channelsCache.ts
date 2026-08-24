// Landing-page active-channels cache (localStorage): paints the last-known channel
// list on mount before the `/rooms/active` request returns, then LiveChannels
// revalidates in the background and the response wins (stale-while-revalidate).
// Versioned + defensive reads, so a corrupt/old cache can't break a newer client
// (bump VERSION to invalidate). Never authoritative — the API is the source of truth.

const VERSION = 3;
const KEY = `fila-dbd-channels-v${VERSION}`;

export interface ActiveRoom {
  id: string;
  channel_login: string;
  // Twitch's cased name (e.g. "MandyMess"). Optional: entries cached before this
  // field existed won't have it, and callers fall back to `channel_login`.
  display_name?: string | null;
  request_count: number;
  pending_count: number;
  updated_at: string;
  avatar_url: string | null;
  banner_url: string | null;
  status: 'offline' | 'online' | 'live';
  is_live: boolean;
  thumbnail_url: string | null;
  viewer_count: number | null;
}

// Slim room shape for recently-active channels — used the app in the last few
// days but no open queue or pending requests right now. They fill out the
// featured grid so it's never empty between streams.
export interface RecentRoom {
  id: string;
  channel_login: string;
  display_name?: string | null;
  avatar_url: string | null;
  banner_url?: string | null;
  request_count: number;
  updated_at: string;
  is_live?: boolean;
  thumbnail_url?: string | null;
  viewer_count?: number | null;
}

export interface CachedChannels {
  rooms: ActiveRoom[];
  recent: RecentRoom[];
  // All-time channel count (vanity stat). Absent on caches written against an
  // older API response.
  totalChannels?: number;
}

interface ChannelsCacheEnvelope {
  v: number;
  rooms: ActiveRoom[];
  recent?: RecentRoom[];
  totalChannels?: number;
}

// Returns null on a cache miss (nothing stored, corrupt, or stale version) so a
// caller can tell "never cached" from a cached-but-empty list — a real response
// can legitimately be empty, and that's still a hit worth painting.
export function loadCachedChannels(): CachedChannels | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ChannelsCacheEnvelope | null;
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.rooms)) return null;
    return {
      rooms: parsed.rooms,
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      totalChannels: typeof parsed.totalChannels === 'number' ? parsed.totalChannels : undefined,
    };
  } catch {
    return null;
  }
}

export function saveCachedChannels(rooms: ActiveRoom[], recent: RecentRoom[], totalChannels?: number): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const envelope: ChannelsCacheEnvelope = { v: VERSION, rooms, recent, totalChannels };
    localStorage.setItem(KEY, JSON.stringify(envelope));
  } catch {
    // ignore quota / serialization / storage-unavailable errors — the cache is
    // an optimization, not a requirement.
  }
}
