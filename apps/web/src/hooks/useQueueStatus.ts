import { useEffect, useState } from 'react';
import { useChannel } from '../store';
import { t } from '../i18n';
import { fetchRoomInfo } from '../services/roomInfo';

/**
 * The one thing anyone — streamer or viewer — actually wants to know: is the queue taking
 * requests right now? Which socket is up, which window holds the lock and whether chat is
 * joined are internal, so they collapse into a single intermediate state while the channel
 * is on its way up. Failures surface as toasts, not as a badge.
 *
 * `unknown` is the moment before anything says what the channel is doing: no badge text,
 * no animation, rather than a guess that flips a split second later.
 */
export type QueueState = 'open' | 'connecting' | 'closed' | 'unknown';

/** The room's last saved queue status (`/rooms/:id`, the same memoized request the channel gate makes). */
function useSavedStatus(channel: string, wanted: boolean): string | null {
  const [saved, setSaved] = useState<{ channel: string; status: string | null } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    fetchRoomInfo(channel).then((room) => {
      if (!cancelled) setSaved({ channel, status: room?.status ?? null });
    });
    return () => { cancelled = true; };
  }, [channel, wanted]);
  return saved?.channel === channel ? saved.status : null;
}

export function useQueueStatus(): { state: QueueState; text: string } {
  const { channel, useSources, useChannelInfo } = useChannel();
  const channelStatus = useChannelInfo((s) => s.status);
  const statusKnown = useChannelInfo((s) => s.statusKnown);
  const hasLock = useChannelInfo((s) => s.hasLock);
  const localIrcConnectionState = useChannelInfo((s) => s.localIrcConnectionState);
  const enabledSources = useSources((s) => s.enabled);
  const savedStatus = useSavedStatus(channel, !statusKnown);

  // Before the server's first word, only the room's last saved status says anything —
  // our own socket opening doesn't. Counting it as "connecting" made every channel page
  // pulse on load, only to settle on "closed" for a queue that was never open.
  if (!statusKnown) {
    if (savedStatus === 'live' || savedStatus === 'online') return { state: 'connecting', text: t('status.connecting') };
    if (savedStatus === 'offline') return { state: 'closed', text: t('status.queueClosed') };
    return { state: 'unknown', text: '' };
  }

  // Manual entry doesn't count: it works whether or not the channel is live.
  const { manual, ...autoSources } = enabledSources;
  const takingRequests = channelStatus === 'live' && Object.values(autoSources).some(Boolean);
  if (takingRequests) {
    return { state: 'open', text: t('status.queueOpen') };
  }

  // On the way up: the chat connection in the window driving it, or a channel that has an
  // owner but isn't live yet. A reconnecting socket alone isn't: `status` keeps the last
  // value the server sent, so a closed queue stays closed while it reconnects.
  const connecting = (hasLock && localIrcConnectionState === 'connecting') || channelStatus === 'online';
  if (connecting) {
    return { state: 'connecting', text: t('status.connecting') };
  }

  return { state: 'closed', text: t('status.queueClosed') };
}
