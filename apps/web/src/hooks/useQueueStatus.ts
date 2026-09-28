import { useChannel } from '../store';
import { t } from '../i18n';
import { useRoomInfo } from './useRoomInfo';

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

export function useQueueStatus(): { state: QueueState; text: string } {
  const { channel, useSources, useChannelInfo } = useChannel();
  const channelStatus = useChannelInfo((s) => s.status);
  const hasLock = useChannelInfo((s) => s.hasLock);
  const localIrcConnectionState = useChannelInfo((s) => s.localIrcConnectionState);
  // Manual entry doesn't count: it works whether or not the channel is live. A boolean,
  // so a sources message with the same settings doesn't re-render every caller.
  const autoSourceOn = useSources((s) => Object.entries(s.enabled).some(([source, on]) => source !== 'manual' && on));
  // The room's last saved queue status, from the /rooms/:id request the page makes anyway.
  const savedStatus = useRoomInfo(channel).room?.status;

  // Before the server's first status, only the room's saved one says anything — never
  // this window's socket opening.
  if (channelStatus === null) {
    if (savedStatus === 'live' || savedStatus === 'online') return { state: 'connecting', text: t('status.connecting') };
    if (savedStatus === 'offline') return { state: 'closed', text: t('status.queueClosed') };
    return { state: 'unknown', text: '' };
  }

  if (channelStatus === 'live' && autoSourceOn) {
    return { state: 'open', text: t('status.queueOpen') };
  }

  // On the way up: the chat connection in the window driving it, or a channel that has an
  // owner but isn't live yet. A reconnecting socket alone isn't: `status` keeps the last
  // value the server sent, so a closed queue stays closed while it reconnects.
  if ((hasLock && localIrcConnectionState === 'connecting') || channelStatus === 'online') {
    return { state: 'connecting', text: t('status.connecting') };
  }

  return { state: 'closed', text: t('status.queueClosed') };
}
