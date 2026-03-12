import { useState, useEffect } from 'react';
import { useSettings, useAuth, useChannel } from '../store';
import { connect, disconnect } from '../services/twitch';
import { claimOwnership, releaseOwnership } from '../services/party';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { navigate } from '../utils/helpers';


export function ControlPanel() {
  const { channel, isOwnChannel, canControlConnection, useChannelInfo } = useChannel();
  const twitchStatus = useChannelInfo((s) => s.localIrcConnectionState);
  const hasLock = useChannelInfo((s) => s.hasLock);
  const { user, isAuthenticated, login, logout } = useAuth();
  const { connection, queue } = useConnectionStatus();
  const owner = useChannelInfo((s) => s.owner);

  const [channelInput, setChannelInput] = useState(channel);

  // Sync input when channel changes from elsewhere
  useEffect(() => {
    setChannelInput(channel);
  }, [channel]);

  const inputChannel = channelInput.trim().toLowerCase();
  const isSameChannel = inputChannel === channel;
  const isIrcConnected = twitchStatus === 'connected' && isSameChannel;
  const isIrcConnecting = twitchStatus === 'connecting';

  const handleConnect = () => {
    if (isIrcConnected) {
      disconnect();
      releaseOwnership();
    } else if (inputChannel) {
      if (inputChannel !== channel) {
        navigate(`/${inputChannel}`);
      } else if (hasLock) {
        // Already have ownership, just connect IRC
        connect(channel);
      } else {
        // Claim ownership - IRC will auto-connect when ownership is granted
        claimOwnership();
      }
    }
  };

  const handleGoToChannel = () => {
    if (inputChannel && inputChannel !== channel) {
      navigate(`/${inputChannel}`);
    }
  };

  const handleMyQueue = () => {
    if (!isAuthenticated) {
      login();
    } else if (user) {
      navigate(`/${user.login.toLowerCase()}`);
    }
  };

  // Determine which buttons to show:
  // - canControlConnection: show connect/disconnect + logout
  // - isOwnChannel but not canControlConnection (conflict): show only "Go" if different channel
  // - not isOwnChannel (viewer): show "Go" + "Minha fila"
  const renderButtons = () => {
    if (canControlConnection) {
      return (
        <>
          <button
            className={`btn btn-primary ${isIrcConnected ? 'connected' : ''}`}
            onClick={handleConnect}
            disabled={isIrcConnecting || !inputChannel}
          >
            {isIrcConnecting ? 'Conectando...' : isIrcConnected ? 'Desconectar' : 'Conectar'}
          </button>
          <div className="channel auth-info">
            <button className="btn btn-ghost" onClick={logout}>Sair</button>
          </div>
        </>
      );
    }

    if (isOwnChannel) {
      // Owner conflict - only show "Go" button if they typed a different channel
      return inputChannel !== channel ? (
        <button className="btn btn-primary" onClick={handleGoToChannel}>
          Ir
        </button>
      ) : null;
    }

    // Viewer mode
    return (
      <>
        {inputChannel !== channel && (
          <button className="btn btn-primary" onClick={handleGoToChannel}>
            Ir
          </button>
        )}
        <button className="btn" onClick={handleMyQueue}>
          {isAuthenticated ? 'Minha fila' : 'Criar minha fila'}
        </button>
      </>
    );
  };

  return (
    <section className="controls">
      <div className="field grow channel">
        <label>Canal Twitch</label>
        <div className="channel-input">
          {owner && (
            <img src={owner.avatar} alt={owner.displayName} className="avatar" />
          )}
          <input
            type="text"
            value={channelInput}
            placeholder="canal"
            onChange={e => setChannelInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && (canControlConnection ? handleConnect() : handleGoToChannel())}
          />
        </div>
      </div>
      {renderButtons()}
      <div className="status-block">
        <div className="status-row">
          <span className={`status-dot ${connection.state}`} />
          <span>{connection.text}</span>
        </div>
        <div className="status-row">
          <span className={`status-dot ${queue.state}`} />
          <span>{queue.text}</span>
        </div>
      </div>
    </section>
  );
}
