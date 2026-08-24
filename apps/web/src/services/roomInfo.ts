// Shared lookup for GET /rooms/:roomId, memoized per channel so the channel
// gate and the header (both mounted on every channel view) share one request.
// A failed fetch resolves to null and is evicted, so a retry is possible.

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export interface RoomInfo {
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  updated_at: string | null;
  // Whether the channel ever used the app (has a D1 row). Optional: an older
  // API without the flag means "unknown" — treat as registered, never block.
  registered?: boolean;
  // Live on Twitch right now (independent of the queue being open).
  is_live?: boolean;
  viewer_count?: number | null;
}

const cache = new Map<string, Promise<RoomInfo | null>>();

export function fetchRoomInfo(channel: string): Promise<RoomInfo | null> {
  const key = channel.toLowerCase();
  let promise = cache.get(key);
  if (!promise) {
    promise = fetch(`${API_URL}/rooms/${key}`)
      .then(r => (r.ok ? r.json() : null))
      .then((data: { room: RoomInfo | null } | null) => data?.room ?? null)
      .catch(() => null)
      .then(room => {
        if (room === null) cache.delete(key);
        return room;
      });
    cache.set(key, promise);
  }
  return promise;
}
