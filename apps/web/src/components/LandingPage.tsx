import { useState, useEffect } from 'react';
import { useAuth } from '../store';
import { useTranslation } from '../i18n';
import { formatRelativeTime, handleLinkClick } from '../utils/helpers';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

interface ActiveRoom {
  id: string;
  channel_login: string;
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

function ConnectButton() {
  const { isAuthenticated, user, login } = useAuth();
  const { t } = useTranslation();

  if (isAuthenticated && user) {
    return (
      <a className="btn btn-primary landing-cta" href={`/${user.login.toLowerCase()}`} onClick={handleLinkClick}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
        </svg>
        {t('landing.startQueue')}
      </a>
    );
  }

  return (
    <button className="btn btn-primary landing-cta" onClick={login}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z" />
      </svg>
      {t('landing.connectTwitch')}
    </button>
  );
}

function LiveChannels() {
  const { t } = useTranslation();
  const [rooms, setRooms] = useState<ActiveRoom[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/rooms/active`)
      .then(r => r.json())
      .then((data: { rooms: ActiveRoom[] }) => setRooms(data.rooms.filter(r => r.channel_login !== 'meriw_')))
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="landing-channels-grid">
        {[1, 2].map(i => (
          <div key={i} className="landing-channel-card skeleton">
            <div className="landing-channel-thumb" />
            <div className="landing-channel-info">
              <div className="landing-channel-card-header">
                <div className="skeleton-circle" />
                <div className="skeleton-line" />
              </div>
              <div className="landing-channel-stats">
                <div className="skeleton-line short" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (rooms.length === 0) {
    return <p className="landing-channels-empty">{t('landing.noActiveChannels')}</p>;
  }

  return (
    <div className={`landing-channels-grid${rooms.length === 1 ? ' single' : ''}`}>
      {rooms.map(room => (
        <a key={room.id} className="landing-channel-card" href={`/${room.channel_login}`} onClick={handleLinkClick}>
          <div className="landing-channel-thumb">
            {(room.thumbnail_url || room.banner_url) ? (
              <img src={(room.thumbnail_url || room.banner_url)!} alt={room.channel_login} />
            ) : (
              <img className="landing-channel-thumb-placeholder" src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            )}
            {room.is_live && <span className="landing-channel-live">{t('landing.live')}</span>}
          </div>
          <div className="landing-channel-info">
            <div className="landing-channel-card-header">
              {room.avatar_url && <img className="landing-channel-avatar" src={room.avatar_url} alt="" />}
              <span className="landing-channel-name">{room.channel_login}</span>
              {room.status !== 'offline' && <span className="landing-channel-status">{t('landing.queueOpen')}</span>}
            </div>
            <div className="landing-channel-stats">
              <span className="landing-channel-pending">
                {t('landing.requestCount', { count: room.pending_count })}
              </span>
              <span className="landing-channel-meta">
                {room.viewer_count != null && <span>{room.viewer_count} viewers</span>}
                <span>{formatRelativeTime(new Date(room.updated_at + 'Z'))}</span>
              </span>
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

const FEATURE_ICONS = [
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>,
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
    <circle cx="12" cy="17" r="0.5" fill="currentColor" />
  </svg>,
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>,
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>,
];

const FEATURE_KEYS = [
  { title: 'landing.featureDetectionTitle', desc: 'landing.featureDetectionDesc' },
  { title: 'landing.featureAITitle', desc: 'landing.featureAIDesc' },
  { title: 'landing.featureSyncTitle', desc: 'landing.featureSyncDesc' },
  { title: 'landing.featureFreeTitle', desc: 'landing.featureFreeDesc' },
] as const;

const STEP_KEYS = [
  { num: '1', title: 'landing.step1Title', desc: 'landing.step1Desc' },
  { num: '2', title: 'landing.step2Title', desc: 'landing.step2Desc' },
  { num: '3', title: 'landing.step3Title', desc: 'landing.step3Desc' },
] as const;

export function LandingPage() {
  const { t, locale, setLocale } = useTranslation();
  return (
    <div className="landing">
      <section className="landing-hero">
        <div className="landing-hero-content">
          <div className="landing-brand">
            <img src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="DBD" />
          </div>
          <h1>Fila <span>DBD</span></h1>
          <p className="landing-tagline">
            {t('landing.tagline')}
          </p>
          <ConnectButton />
        </div>
        <div className="landing-hero-glow" />
      </section>

      <section className="landing-section landing-section-channels">
        <h2>{t('landing.activeChannels')}</h2>
        <LiveChannels />
      </section>

      <section className="landing-section">
        <h2>{t('landing.howItWorks')}</h2>
        <div className="landing-features">
          {FEATURE_KEYS.map((f, i) => (
            <div key={i} className="landing-feature" style={{ animationDelay: `${i * 0.1}s` }}>
              <div className="landing-feature-icon">{FEATURE_ICONS[i]}</div>
              <h3>{t(f.title)}</h3>
              <p>{t(f.desc)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-section">
        <h2>{t('landing.startIn3Steps')}</h2>
        <div className="landing-steps">
          {STEP_KEYS.map((s, i) => (
            <div key={i} className="landing-step" style={{ animationDelay: `${i * 0.1 + 0.3}s` }}>
              <div className="landing-step-num">{s.num}</div>
              <div>
                <h3>{t(s.title)}</h3>
                <p>{t(s.desc)}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="landing-disclaimer">
        <p>{t('landing.disclaimer1')}</p>
        <p>{t('landing.disclaimer2')}</p>
        <p>{t('landing.madeWith')} <a href="https://github.com/macecchi" target="_blank">macecchi</a> {t('landing.forStreamer')} <a href="https://twitch.tv/mandymess" target="_blank">@MandyMess</a>.</p>
      </div>
      <footer className="landing-footer">
        <span>Fila DBD</span>
        <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {t('landing.helpAndFeedback')}
          <a href="https://github.com/macecchi/dbd-utils" target="_blank">GitHub</a>
          <span>•</span>
          <a href="https://discord.gg/6pY7Efhxd" target="_blank">Discord</a>
          <span>•</span>
          <button className="btn btn-ghost btn-small lang-toggle" onClick={() => setLocale(locale === 'pt-BR' ? 'en' : 'pt-BR')}>
            {t('lang.toggle')}
          </button>
        </span>
      </footer>
    </div>
  );
}
