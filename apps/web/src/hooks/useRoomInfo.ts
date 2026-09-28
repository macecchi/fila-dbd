import { useEffect, useState } from 'react';
import { fetchRoomInfo, type RoomInfo } from '../services/roomInfo';

/**
 * The channel's `/rooms/:id` info (one memoized request per channel, shared by every
 * caller). `loaded` turns true once it settled, even as a failure (`room: null`); until
 * then what depends on it is unknown, not absent. Keyed by channel, since the channel
 * view stays mounted across an in-app channel switch.
 */
export function useRoomInfo(channel: string): { room: RoomInfo | null; loaded: boolean } {
  const [result, setResult] = useState<{ channel: string; room: RoomInfo | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchRoomInfo(channel).then((room) => {
      if (!cancelled) setResult({ channel, room });
    });
    return () => { cancelled = true; };
  }, [channel]);
  return result?.channel === channel ? { room: result.room, loaded: true } : { room: null, loaded: false };
}
