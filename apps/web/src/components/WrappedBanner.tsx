import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { navigate } from '../utils/helpers';
import { CURRENT_WRAPPED_EDITION, wrappedEditionLabel } from '@filadbd/shared';
import '../styles/wrapped-banner.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

// Retrospectiva discovery banner on the channel page. Deliberately does NOT
// import the lazy wrapped chunk (services/wrapped stays lazy) — it only needs
// to know whether this edition was generated, via the public endpoint, and
// caches the answer per session. The check is deferred so it never competes
// with the queue's first paint.
export function WrappedBanner({ channel, isOwner }: { channel: string; isOwner: boolean }) {
  const { t, locale } = useTranslation();
  const edition = CURRENT_WRAPPED_EDITION;
  const label = wrappedEditionLabel(edition, locale === 'en' ? 'en' : 'pt-BR');
  const dismissKey = `dbd-wrapped-banner-dismissed-${edition.id}`;

  const [generated, setGenerated] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) === '1'; } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    const key = `dbd-wrapped-exists-${channel.toLowerCase()}-${edition.id}`;
    try {
      const cached = sessionStorage.getItem(key);
      if (cached !== null) {
        setGenerated(cached === '1');
        if (cached === '1') return; // generated is final; "not yet" can change
      }
    } catch { /* ignore */ }
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/rooms/${channel.toLowerCase()}/wrapped/${edition.id}`);
        if (cancelled) return;
        setGenerated(res.ok);
        try { sessionStorage.setItem(key, res.ok ? '1' : '0'); } catch { /* ignore */ }
      } catch { /* leave as-is — no banner is better than a wrong one */ }
    }, 1500);
    return () => { cancelled = true; clearTimeout(id); };
  }, [channel, edition.id]);

  if (dismissed || generated === null) return null;
  // Viewers with nothing to watch and no way to act only need a quiet note;
  // owners always get a call to action.
  const open = () => navigate(`/${channel.toLowerCase()}/wrapped`);

  const text = isOwner
    ? (generated ? t('wrapped.banner.ownerReady', { label }) : t('wrapped.banner.ownerCta', { label }))
    : (generated ? t('wrapped.banner.viewerReady', { label, channel }) : t('wrapped.banner.viewerNotYet', { label, channel }));
  const actionable = isOwner || generated;

  return (
    <div className={`wrapped-banner ${actionable ? '' : 'wrapped-banner--muted'}`}>
      <span className="wrapped-banner-flame" aria-hidden="true">
        <img src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="" />
      </span>
      <span className="wrapped-banner-text">{text}</span>
      {actionable && (
        <button className="wrapped-banner-cta" onClick={open}>
          {generated ? t('wrapped.banner.watch') : t('wrapped.banner.generate')}
        </button>
      )}
      <button
        className="wrapped-banner-dismiss"
        aria-label={t('wrapped.banner.dismiss')}
        onClick={() => {
          setDismissed(true);
          try { localStorage.setItem(dismissKey, '1'); } catch { /* ignore */ }
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}
