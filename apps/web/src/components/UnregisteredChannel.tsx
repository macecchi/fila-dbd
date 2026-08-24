import { useAuth } from '../store';
import { useTranslation } from '../i18n';
import { handleLinkClick } from '../utils/helpers';
import type { RoomInfo } from '../services/roomInfo';

/**
 * Full-page state for a channel that never used the app. Without it, any Twitch
 * login typed into the address bar or search box rendered like a real channel
 * with a closed queue. Shows the streamer's Twitch identity (the API enriches
 * the lookup with their profile even without a room row) and points visitors
 * at the landing page — or at connecting, if the streamer themself landed here
 * signed out.
 */
export function UnregisteredChannel({ channel, room }: { channel: string; room: RoomInfo }) {
  const { t, locale, setLocale } = useTranslation();
  const { isAuthenticated, login } = useAuth();
  const displayName = room.display_name || channel;

  return (
    <div className="unregistered">
      <div className="unregistered-card">
        {room.avatar_url ? (
          <img className="unregistered-avatar" src={room.avatar_url} alt={displayName} />
        ) : (
          <div className="unregistered-avatar unregistered-avatar-fallback">{channel[0].toUpperCase()}</div>
        )}
        <a
          className="unregistered-name"
          href={`https://twitch.tv/${channel}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          {displayName}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
          </svg>
          {room.is_live && <span className="channel-header-live">{t('landing.live')}</span>}
        </a>
        <p className="unregistered-title">{t('channel.notUsingTitle')}</p>
        <p className="unregistered-desc">{t('channel.notUsingDesc')}</p>
        <div className="unregistered-actions">
          <a className="btn btn-primary" href="/" onClick={handleLinkClick}>{t('channel.notUsingLearn')}</a>
          {!isAuthenticated && (
            <button className="btn btn-ghost" onClick={login}>{t('channel.notUsingOwner')}</button>
          )}
        </div>
      </div>
      <footer className="unregistered-footer">
        <span>Fila DBD</span>
        <span>•</span>
        <span className="footer-lang">
          {locale === 'en'
            ? <>English / <button className="btn-link" onClick={() => setLocale('pt-BR')}>Português</button></>
            : <><button className="btn-link" onClick={() => setLocale('en')}>English</button> / Português</>
          }
        </span>
      </footer>
    </div>
  );
}
