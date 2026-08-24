import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { useChannel } from '../store';
import { useQueueStatus } from '../hooks/useQueueStatus';
import { useTranslation } from '../i18n';
import { formatRelativeTime } from '../utils/helpers';
import { Stats } from './Stats';
import { RecentPlays } from './RecentPlays';
import { Panel } from './Panel';
import { fetchRoomInfo, type RoomInfo } from '../services/roomInfo';

export function ChannelHeader() {
  const { channel, canEditQueue, openQueue, closeQueue, useChannelInfo } = useChannel();
  const { t } = useTranslation();
  const owner = useChannelInfo((s) => s.owner);
  const channelStatus = useChannelInfo((s) => s.status);
  const hasLock = useChannelInfo((s) => s.hasLock);
  const twitchStatus = useChannelInfo((s) => s.localIrcConnectionState);
  const queue = useQueueStatus();

  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Shared, memoized lookup — the channel gate already fired the same request.
    fetchRoomInfo(channel).then((room) => { if (!cancelled && room) setRoomInfo(room); });
    return () => { cancelled = true; };
  }, [channel]);

  const avatarUrl = roomInfo?.avatar_url || owner?.avatar;
  const displayName = owner?.displayName || roomInfo?.display_name || channel;
  const lastActive = roomInfo?.updated_at ? new Date(roomInfo.updated_at + 'Z') : null;

  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}${import.meta.env.BASE_URL}${channel}`;

  const handleCopyLink = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    navigator.clipboard.writeText(shareUrl)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success(t('toast.linkCopied'));
      })
      .catch(() => toast.error(t('toast.error')));
  }, [shareUrl, t]);

  // Read off the channel, not this window's socket, so both windows show the same button.
  const isConnected = channelStatus === 'live';
  const isConnecting = hasLock && twitchStatus === 'connecting';

  const handleToggle = () => {
    if (isConnected) closeQueue();
    else openQueue();
  };

  return (
    <section className="channel-header">
      <div className="channel-header-profile">
        <div className={`channel-header-avatar-ring ring-${queue.state}`}>
          {avatarUrl ? (
            <img className="channel-header-avatar" src={avatarUrl} alt={channel} />
          ) : (
            <div className="channel-header-avatar channel-header-avatar-fallback">
              {channel[0].toUpperCase()}
            </div>
          )}
        </div>
        <div className="channel-header-info">
          <div className="channel-header-name-row">
            <a
              href={`https://twitch.tv/${channel}`}
              target="_blank"
              rel="noopener noreferrer"
              className="channel-header-name-link"
            >
              <h2 className="channel-header-name">{displayName}</h2>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
              </svg>
            </a>
          </div>
          <div className="channel-header-meta">
            <span className={`channel-header-badge state-${queue.state}`}>
              <span className="dot" />
              {queue.text}
            </span>
          </div>
          <span className="channel-header-sub">
            {lastActive && queue.state === 'closed'
              ? t('header.lastUsed', { time: formatRelativeTime(lastActive) })
              : <a href={shareUrl} className="channel-header-share" onClick={handleCopyLink}>
                {new URL(shareUrl).href.replace(/https?:\/\//, '')}
                <span className="channel-header-share-hint">{copied ? t('header.copied') : t('header.clickToCopy')}</span>
              </a>
            }
          </span>
        </div>
      </div>

      <RecentPlays />

      <div className="channel-header-right">
        <Stats />
        {canEditQueue && (
          <div className="channel-header-actions">
            <button
              className={`btn ${isConnected ? 'btn-ghost' : 'btn-primary'} ${!isConnected && !isConnecting ? 'btn-pulse' : ''}`.trim()}
              onClick={handleToggle}
              disabled={isConnecting}
            >
              {isConnecting ? t('status.connecting') : isConnected ? t('header.closeQueue') : t('header.openQueue')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
