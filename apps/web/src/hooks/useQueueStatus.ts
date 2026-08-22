import { useChannel } from '../store';
import { t } from '../i18n';

/**
 * The one thing anyone — streamer or viewer — actually wants to know: is the queue taking
 * requests right now? Which socket is up, which window holds the lock and whether chat is
 * joined are internal, so they collapse into a single intermediate state while the channel
 * is on its way up. Failures surface as toasts, not as a badge.
 */
export type QueueState = 'open' | 'connecting' | 'closed';

export function useQueueStatus(): { state: QueueState; text: string } {
  const { useSources, useChannelInfo } = useChannel();
  const channelStatus = useChannelInfo((s) => s.status);
  const hasLock = useChannelInfo((s) => s.hasLock);
  const localIrcConnectionState = useChannelInfo((s) => s.localIrcConnectionState);
  const localPartyConnectionState = useChannelInfo((s) => s.localPartyConnectionState);
  const enabledSources = useSources((s) => s.enabled);

  // Manual entry doesn't count: it works whether or not the channel is live.
  const { manual, ...autoSources } = enabledSources;
  const takingRequests = channelStatus === 'live' && Object.values(autoSources).some(Boolean);
  if (takingRequests) {
    return { state: 'open', text: t('status.queueOpen') };
  }

  // On the way up: our own socket, the chat connection in the window driving it, or a
  // channel that has an owner but isn't live yet.
  const connecting =
    localPartyConnectionState === 'connecting' ||
    (hasLock && localIrcConnectionState === 'connecting') ||
    channelStatus === 'online';
  if (connecting) {
    return { state: 'connecting', text: t('status.connecting') };
  }

  return { state: 'closed', text: t('status.queueClosed') };
}
