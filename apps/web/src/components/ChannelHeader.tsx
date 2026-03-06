import { useState, useEffect } from 'react';
import { useChannel, useAuth } from '../store';
import { connect, disconnect } from '../services/twitch';
import { claimOwnership, releaseOwnership } from '../services/party';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { formatRelativeTime } from '../utils/helpers';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

interface RoomInfo {
  avatar_url: string | null;
  updated_at: string;
}

export function ChannelHeader() {
  const { channel, canManageChannel, useChannelInfo } = useChannel();
  const { isAuthenticated, logout } = useAuth();
  const owner = useChannelInfo((s) => s.owner);
  const isOwner = useChannelInfo((s) => s.isOwner);
  const twitchStatus = useChannelInfo((s) => s.localIrcConnectionState);
  const { connection, queue } = useConnectionStatus();

  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/rooms/${channel}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { room: RoomInfo | null } | null) => {
        if (data?.room) setRoomInfo(data.room);
      })
      .catch(() => { });
  }, [channel]);

  const avatarUrl = roomInfo?.avatar_url || owner?.avatar;
  const lastActive = roomInfo?.updated_at ? new Date(roomInfo.updated_at + 'Z') : null;

  const isConnected = twitchStatus === 'connected';
  const isConnecting = twitchStatus === 'connecting';

  const handleToggle = () => {
    if (isConnected) {
      disconnect();
      releaseOwnership();
    } else if (isOwner) {
      connect(channel);
    } else {
      claimOwnership();
    }
  };

  return (
    <section className="channel-header">
      <div className="channel-header-profile">
        <div className={`channel-header-avatar-ring ring-${connection.state}`}>
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
            <h2 className="channel-header-name">{channel}</h2>
            <a
              href={`https://twitch.tv/${channel}`}
              target="_blank"
              rel="noopener noreferrer"
              className="channel-header-twitch"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
              </svg>
            </a>
          </div>
          <div className="channel-header-meta">
            <span className={`channel-header-badge state-${connection.state}`}>
              <span className="dot" />
              {connection.text}
            </span>
            <span className={`channel-header-badge state-${queue.state}`}>
              <span className="dot" />
              {queue.text}
            </span>
          </div>
          <span className="channel-header-sub">
            {lastActive && connection.state === 'disconnected'
              ? `Último uso ${formatRelativeTime(lastActive)}`
              : <a href={`https://twitch.tv/${channel}`} target="_blank" rel="noopener noreferrer">twitch.tv/{channel}</a>
            }
          </span>
        </div>
      </div>

      {canManageChannel && (
        <div className="channel-header-actions">
          <button
            className={`btn ${isConnected ? 'btn-ghost' : 'btn-primary'} ${!isConnected && !isConnecting ? 'btn-pulse' : ''}`.trim()}
            onClick={handleToggle}
            disabled={isConnecting}
          >
            {isConnecting ? 'Conectando...' : isConnected ? 'Fechar fila' : 'Abrir fila'}
          </button>
          {isAuthenticated && (
            <a className="channel-header-logout" href="#" onClick={(e) => { e.preventDefault(); logout(); }}>
              Desconectar Twitch
            </a>
          )}
        </div>
      )}
    </section>
  );
}
