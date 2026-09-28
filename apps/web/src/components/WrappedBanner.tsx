import { useEffect, useState } from 'react';
import { useTranslation } from '../i18n';
import { useChannel } from '../store';
import { navigate } from '../utils/helpers';
import { CURRENT_WRAPPED_EDITION, wrappedEditionLabel } from '@filadbd/shared';
import '../styles/wrapped-banner.css';
import { API_URL } from '../config';

// Retrospectiva discovery banner on the channel page. Deliberately does NOT
// import the lazy wrapped chunk (services/wrapped stays lazy) — it only needs
// to know whether this edition was generated, via the public endpoint (a
// single-row PK lookup, cheap enough to ask on every mount). The check is
// deferred so it never competes with the queue's first paint.
export function WrappedBanner({ channel, isOwner }: { channel: string; isOwner: boolean }) {
  const { t, locale } = useTranslation();
  const { useChannelInfo } = useChannel();
  const owner = useChannelInfo((s) => s.owner);
  const edition = CURRENT_WRAPPED_EDITION;
  const label = wrappedEditionLabel(edition, locale === 'en' ? 'en' : 'pt-BR');
  const dismissKey = `dbd-wrapped-banner-dismissed-${edition.id}`;

  const [generated, setGenerated] = useState<boolean | null>(null);
  const [payloadName, setPayloadName] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) === '1'; } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await fetch(`${API_URL}/rooms/${channel.toLowerCase()}/wrapped/${edition.id}`);
        if (cancelled) return;
        setGenerated(res.ok);
        if (res.ok) {
          const data = await res.json().catch(() => null) as { wrapped?: { channel?: { displayName?: string } } } | null;
          if (cancelled) return;
          const name = data?.wrapped?.channel?.displayName || '';
          if (name) setPayloadName(name);
        }
      } catch { /* leave as-is — no banner is better than a wrong one */ }
    }, 1500);
    return () => { cancelled = true; clearTimeout(id); };
  }, [channel, edition.id]);

  if (dismissed || generated === null) return null;
  // Viewers with nothing to watch and no way to act only need a quiet note;
  // owners always get a call to action.
  const open = () => navigate(`/${channel.toLowerCase()}/wrapped`);

  const channelName = owner?.displayName || payloadName || channel;

  const text = isOwner
    ? (generated ? t('wrapped.banner.ownerReady', { label }) : t('wrapped.banner.ownerCta', { label }))
    : (generated ? t('wrapped.banner.viewerReady', { label, channel: channelName }) : t('wrapped.banner.viewerNotYet', { label, channel: channelName }));
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
