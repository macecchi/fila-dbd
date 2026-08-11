import { useState, useEffect, useCallback, useMemo, useRef, useLayoutEffect, type ReactNode } from 'react';
import { toast } from 'sonner';
import { renderSVG as renderQrSvg } from 'uqr';
import { useAuth } from '../../store';
import { useTranslation, tLocale, type Locale } from '../../i18n';
import { navigate } from '../../utils/helpers';
import { getCharacterPortrait, getCharacterPortraitLarge, tryLocalMatch } from '../../data/characters';
import { CURRENT_WRAPPED_EDITION, getWrappedEdition, type WrappedPayload, type WrappedLanguage } from '@filadbd/shared';
import { fetchPublicWrapped, fetchOwnerWrapped, generateWrapped, WrappedError } from '../../services/wrapped';
import '../../styles/wrapped.css';

const base = import.meta.env.BASE_URL;

// Desktop/laptop pointers can't tap-navigate to the phone-only export flow —
// they get a QR to scan with their phone instead. Touch devices (the phone
// itself) jump straight to the route.
function hasFinePointer(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: fine)').matches;
}

// Share popover attached to both the floating pill and the finale button:
// copy link, native share (when available), and the video-export entry point
// (QR on desktop, direct navigation on touch devices).
function SharePopover({
  wt,
  exportUrl,
  onCopyLink,
  canNativeShare,
  onNativeShare,
  onNavigateExport,
  align,
}: {
  wt: (key: any, params?: Record<string, string | number>) => string;
  exportUrl: string;
  onCopyLink: () => void;
  canNativeShare: boolean;
  onNativeShare: () => void;
  onNavigateExport: () => void;
  align: 'float' | 'finale';
}) {
  // Desktop (fine pointer): the QR is always visible in the open popover —
  // no extra click. Touch devices navigate straight to the export page.
  const fine = hasFinePointer();
  const qrSvg = useMemo(() => (fine ? renderQrSvg(exportUrl, { border: 1 }) : ''), [fine, exportUrl]);

  return (
    <div className={`wr-share-menu wr-share-menu--${align}`} onClick={(e) => e.stopPropagation()}>
      <button className="wr-share-menu-item" onClick={onCopyLink}>{wt('wrapped.share.copyLink')}</button>
      {canNativeShare && <button className="wr-share-menu-item" onClick={onNativeShare}>{wt('wrapped.share')}</button>}
      {fine ? (
        <div className="wr-share-qr">
          <span className="wr-share-qr-title">{wt('wrapped.share.video')}</span>
          <div className="wr-share-qr-code" dangerouslySetInnerHTML={{ __html: qrSvg }} />
          <span className="wr-share-qr-hint">{wt('wrapped.share.scanHint')}</span>
        </div>
      ) : (
        <button className="wr-share-menu-item" onClick={onNavigateExport}>{wt('wrapped.share.video')}</button>
      )}
    </div>
  );
}

type PageState =
  | { phase: 'loading' }
  | { phase: 'not-generated' }
  | { phase: 'generate-cta' }
  | { phase: 'generating' }
  | { phase: 'not-enough-data'; total: number; min: number }
  | { phase: 'error' }
  | { phase: 'ready'; payload: WrappedPayload };

interface Slide {
  key: string;
  render: () => ReactNode;
}

// Perk-tier roman numerals — DBD's own ranking vocabulary.
const ROMAN = ['I', 'II', 'III', 'IV', 'V'];

const MONTH_NAMES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTH_NAMES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function monthParts(month: string, locale: string): { name: string; year: string } {
  const idx = parseInt(month.slice(5, 7), 10) - 1;
  const names = locale === 'en' ? MONTH_NAMES_EN : MONTH_NAMES_PT;
  return { name: names[idx] ?? month, year: month.slice(0, 4) };
}

function formatDay(date: string, locale: string): string {
  const [y, m, d] = date.split('-');
  return locale === 'en' ? `${MONTH_NAMES_EN[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}` : `${parseInt(d, 10)} de ${MONTH_NAMES_PT[parseInt(m, 10) - 1]} de ${y}`;
}

function formatBRL(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// Large (lg/) portraits may not exist for every character (freshly added
// ones the scrape hasn't picked up yet, or future data). Degrade to the
// small queue-avatar portrait rather than a broken image.
function fallbackToSmall(smallSrc: string) {
  return (e: React.SyntheticEvent<HTMLImageElement>) => {
    if (e.currentTarget.src !== window.location.origin + smallSrc && !e.currentTarget.src.endsWith(smallSrc)) {
      e.currentTarget.src = smallSrc;
    }
  };
}

// Deterministic Twitch-chat username hue per name.
function chatHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

// Number pop-in (transitions.dev): every displayed number reveals digit by
// digit, each popping in with a staggered overshoot. Keying each char by its
// value makes the animation re-run when the text changes (e.g. money reveal).
function PopDigits({ value, delay = 0, step = 0.07 }: { value: string | number; delay?: number; step?: number }) {
  const chars = String(value).split('');
  return (
    <span className="wr-pop-num" aria-label={String(value)}>
      {chars.map((c, i) => (
        <span key={`${i}-${c}`} className="wrapped-digit" style={{ animationDelay: `${delay + i * step}s` }} aria-hidden="true">{c === ' ' || c === ' ' ? ' ' : c}</span>
      ))}
    </span>
  );
}

const EASE_OUT_EXPO = (p: number) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));

// Count-up number: starts at 0 and climbs to the target in quick eased steps;
// every digit that changes on a tick remounts (char-keyed) and replays the
// pop-in, so the number visibly "picks up" like the transitions.dev demo.
function PopNumber({ n, format = String, delay = 0.15, duration = 1100 }: {
  n: number;
  format?: (v: number) => string;
  delay?: number;
  duration?: number;
}) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setDisplay(n);
      return;
    }
    const STEP = 90;
    const steps = Math.max(1, Math.round(duration / STEP));
    let i = 0;
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      interval = setInterval(() => {
        i += 1;
        setDisplay(i >= steps ? n : Math.round(n * EASE_OUT_EXPO(i / steps)));
        if (i >= steps) clearInterval(interval);
      }, STEP);
    }, delay * 1000);
    return () => { clearTimeout(timeout); if (interval) clearInterval(interval); };
  }, [n, delay, duration]);
  return (
    // Hidden sizer holds the FINAL value so the box never resizes while the
    // count runs — otherwise everything around the number shifts as digits
    // are added. The live digits animate in an overlay on top of it.
    <span className="wr-pop-num" aria-label={format(n)}>
      <span className="wr-pop-sizer" aria-hidden="true">{format(n)}</span>
      <span className="wr-pop-live" aria-hidden="true">
        {format(display).split('').map((c, i) => (
          <span key={`${i}-${c}`} className="wrapped-digit wrapped-digit--tick">{c === ' ' || c === ' ' ? ' ' : c}</span>
        ))}
      </span>
    </span>
  );
}

// Big stat counted up digit-by-digit.
function BigNumber({ value, format }: { value: number; format: (v: number) => string }) {
  return (
    <div className="wr-giant-number">
      <PopNumber n={value} format={format} delay={0.25} duration={1400} />
    </div>
  );
}

// Ratio arena: mounts at an even 50/50 split, then the columns transition to
// the real proportion — the dominant side visibly grows and claims the arena.
function RatioArena({ killerPct, killersLabel, survivorsLabel }: {
  killerPct: number;
  killersLabel: string;
  survivorsLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [grown, setGrown] = useState(false);
  // Clamp the target split so the losing side keeps its readable minimum
  // (~132px, measured against the real arena width). Animating to the raw
  // percentages would hit a minmax() floor mid-transition and the visible
  // motion would stop dead before the curve finishes.
  const [split, setSplit] = useState({ k: 50, s: 50 });
  useLayoutEffect(() => {
    const w = ref.current?.getBoundingClientRect().width ?? 0;
    const minPct = w > 0 ? Math.min((132 / w) * 100, 45) : 20;
    const k = Math.min(Math.max(killerPct, minPct), 100 - minPct);
    setSplit({ k, s: 100 - k });
  }, [killerPct]);
  useEffect(() => {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setGrown(true);
      return;
    }
    const id = setTimeout(() => setGrown(true), 350);
    return () => clearTimeout(id);
  }, []);
  return (
    <div ref={ref} className="wr-ratio-arena" style={{ gridTemplateColumns: grown ? `${split.k}fr ${split.s}fr` : '50fr 50fr' }}>
      <div className="wr-ratio-half wr-ratio-half--killer">
        <span className="wr-ratio-pct"><PopNumber n={killerPct} /><em>%</em></span>
        <span className="wr-ratio-label">{killersLabel}</span>
      </div>
      <div className="wr-ratio-half wr-ratio-half--survivor">
        <span className="wr-ratio-pct"><PopNumber n={100 - killerPct} /><em>%</em></span>
        <span className="wr-ratio-label">{survivorsLabel}</span>
      </div>
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" /><circle cx="12" cy="12" r="2.5" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3l18 18" /><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 6 10 6a17 17 0 0 1-2.9 3.4M6.6 6.6A16.4 16.4 0 0 0 2 11s3.5 6 10 6c1.4 0 2.7-.3 3.8-.7" />
    </svg>
  );
}

export function WrappedPage({ channel }: { channel: string }) {
  const { t, locale } = useTranslation();
  const { isAuthenticated, user, login } = useAuth();
  const isOwner = isAuthenticated && !!user && user.login.toLowerCase() === channel.toLowerCase();
  const edition = CURRENT_WRAPPED_EDITION.id;

  const [state, setState] = useState<PageState>({ phase: 'loading' });
  const [index, setIndex] = useState(0);
  const stageRef = useRef<HTMLDivElement>(null);

  // Tall slides scroll within the stage; start each slide from its top.
  useLayoutEffect(() => {
    stageRef.current?.scrollTo(0, 0);
  }, [index]);
  const [showMoney, setShowMoney] = useState(false);
  const [generatingMsg, setGeneratingMsg] = useState(0);
  // Language the retrospective will be generated in (owner picks on the CTA).
  const [genLang, setGenLang] = useState<WrappedLanguage>(locale);

  // Once generated, the whole page renders in the payload's language — the
  // narrative is baked in one language, so the UI labels must match it for
  // every viewer, whatever their app locale. Older payloads are pt-BR.
  const pageLang: Locale = state.phase === 'ready' ? (state.payload.language ?? 'pt-BR') : locale;
  const wt = useCallback(
    (key: Parameters<typeof t>[0], params?: Record<string, string | number>) => tLocale(pageLang, key, params),
    [pageLang]
  );

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'loading' });
    const load = async () => {
      try {
        const payload = isOwner ? await fetchOwnerWrapped(edition) : await fetchPublicWrapped(channel, edition);
        if (!cancelled) setState({ phase: 'ready', payload });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof WrappedError && e.code === 'not_generated') {
          setState(isOwner ? { phase: 'generate-cta' } : { phase: 'not-generated' });
        } else {
          setState({ phase: 'error' });
        }
      }
    };
    load();
    return () => { cancelled = true; };
  }, [channel, edition, isOwner]);

  useEffect(() => {
    if (state.phase !== 'generating') return;
    const id = setInterval(() => setGeneratingMsg((m) => (m + 1) % 3), 2200);
    return () => clearInterval(id);
  }, [state.phase]);

  const handleGenerate = useCallback(async () => {
    setState({ phase: 'generating' });
    try {
      const payload = await generateWrapped(edition, genLang);
      setState({ phase: 'ready', payload });
      setIndex(0);
    } catch (e) {
      if (e instanceof WrappedError && e.code === 'not_enough_data') {
        setState({ phase: 'not-enough-data', total: e.detail?.totalRequests ?? 0, min: e.detail?.minRequests ?? 10 });
      } else {
        toast.error(t('wrapped.generateFailed'));
        setState({ phase: 'generate-cta' });
      }
    }
  }, [edition, t, genLang]);

  const shareUrl = `${window.location.origin}${base.replace(/\/$/, '')}/${channel.toLowerCase()}/wrapped`;
  const exportUrl = `${window.location.origin}${base.replace(/\/$/, '')}/${channel.toLowerCase()}/wrapped/export`;
  const canNativeShare = typeof navigator !== 'undefined' && !!navigator.share;

  const [shareOpenFloat, setShareOpenFloat] = useState(false);
  const [shareOpenFinale, setShareOpenFinale] = useState(false);
  const floatShareRef = useRef<HTMLDivElement>(null);
  const finaleShareRef = useRef<HTMLDivElement>(null);

  // Close whichever popover is open on an outside click — the popovers
  // themselves stopPropagation so their own clicks don't trigger this.
  useEffect(() => {
    if (!shareOpenFloat && !shareOpenFinale) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (shareOpenFloat && floatShareRef.current && !floatShareRef.current.contains(target)) setShareOpenFloat(false);
      if (shareOpenFinale && finaleShareRef.current && !finaleShareRef.current.contains(target)) setShareOpenFinale(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [shareOpenFloat, shareOpenFinale]);

  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(shareUrl);
    toast.success(t('wrapped.copied'));
    setShareOpenFloat(false);
    setShareOpenFinale(false);
  }, [shareUrl, t]);

  const nativeShare = useCallback(async () => {
    const payload = state.phase === 'ready' ? state.payload : null;
    const title = payload ? `${payload.editionLabel} — ${payload.channel.displayName} — Fila DBD` : 'Fila DBD';
    try {
      await navigator.share({ title, url: shareUrl });
    } catch { /* user cancelled */ }
    setShareOpenFloat(false);
    setShareOpenFinale(false);
  }, [shareUrl, state]);

  const navigateToExport = useCallback(() => {
    setShareOpenFloat(false);
    setShareOpenFinale(false);
    navigate(`${base.replace(/\/$/, '')}/${channel.toLowerCase()}/wrapped/export`);
  }, [channel]);

  const goToQueue = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigate(`/${channel.toLowerCase()}`);
  }, [channel]);

  const slides = useMemo<Slide[]>(() => {
    if (state.phase !== 'ready') return [];
    const { payload } = state;
    const { stats } = payload;
    const priv = payload.private;
    const vodThumb = payload.media?.vodThumbs?.[0];
    // Same as pageLang — every slide renders in the payload's baked language.
    const lang: Locale = payload.language ?? 'pt-BR';
    // The LLM prose sometimes carries bare digits ("1361 requests") — add the
    // locale's thousands separator to every standalone number, leaving years
    // untouched and never rewriting usernames.
    const localizeDigits = (s: string) => s.replace(/(?<![\d.,])\d{4,}(?![\d.,])/g, (m) => {
      const n = parseInt(m, 10);
      return n >= 1900 && n <= 2099 ? m : n.toLocaleString(lang);
    });
    const narrative: typeof payload.narrative = JSON.parse(
      JSON.stringify(payload.narrative),
      (k, v) => (typeof v === 'string' && k !== 'name' ? localizeDigits(v) : v)
    );
    const built: Slide[] = [];

    // Locale-aware digits everywhere the component renders a number itself.
    const fmt = (n: number) => n.toLocaleString(lang);
    // Twitch avatar for a featured username (absent on older cached payloads).
    const avatarFor = (name: string) => payload.userAvatars?.[name.trim().toLowerCase()];
    // Proportional rank bar, rarity-tinted via the row's wr-rar-N class.
    const rankBar = (count: number, max: number) => (
      <span className="wr-rank-bar" style={{ width: `${Math.max((count / Math.max(max, 1)) * 100, 2)}%` }} aria-hidden="true" />
    );
    // Translated count label ("104 pedidos") with the number itself swapped
    // for pop-in digits: interpolate with the raw count (correct plural),
    // then splice locale-formatted PopDigits where the digits landed.
    const popCount = (key: Parameters<typeof wt>[0], n: number): ReactNode => {
      const s = wt(key, { count: n });
      const idx = s.indexOf(String(n));
      if (idx < 0) return s;
      return (
        <>
          {s.slice(0, idx)}
          <PopNumber n={n} format={fmt} />
          {s.slice(idx + String(n).length)}
        </>
      );
    };

    // "Retrospectiva 2026.1" → stacked wordmark + edition number.
    const labelWords = payload.editionLabel.split(' ');
    const editionNo = labelWords.length > 1 && /[\d.]/.test(labelWords[labelWords.length - 1]) ? labelWords[labelWords.length - 1] : '';
    const editionName = editionNo ? labelWords.slice(0, -1).join(' ') : payload.editionLabel;

    built.push({
      key: 'intro',
      render: () => (
        <div className="wr-poster wr-intro">
          {payload.channel.bannerUrl && (
            <div className="wr-intro-banner" style={{ backgroundImage: `url(${payload.channel.bannerUrl})` }} aria-hidden="true" />
          )}
          <div className="wr-intro-year" aria-hidden="true">{editionNo}</div>
          <div className="wr-intro-head">
            {payload.channel.avatarUrl && <img className="wr-intro-avatar" src={payload.channel.avatarUrl} alt="" />}
            <span className="wr-eyebrow">{payload.channel.displayName}</span>
          </div>
          <h1 className="wr-intro-title">
            <span className="wr-intro-title-name">{editionName}</span>
            {editionNo && <span className="wr-intro-title-no">{editionNo}</span>}
          </h1>
          <p className="wr-body wr-intro-caption">{narrative.intro}</p>
        </div>
      ),
    });

    // Analyzed period, shown beside the requests label. Edition 1 starts in
    // 2000 (all history) — render that as "until <last covered month>".
    const edMeta = getWrappedEdition(payload.edition);
    let period = '';
    if (edMeta) {
      const ey = parseInt(edMeta.end.slice(0, 4), 10);
      const em = parseInt(edMeta.end.slice(5, 7), 10);
      // `end` is exclusive — the last covered month is the one before it.
      const lastYM = em === 1 ? `${ey - 1}-12` : `${ey}-${String(em - 1).padStart(2, '0')}`;
      const endP = monthParts(lastYM, lang);
      if (parseInt(edMeta.start.slice(0, 4), 10) <= 2000) {
        period = wt('wrapped.periodUntil', { month: endP.name, year: endP.year });
      } else {
        const startP = monthParts(edMeta.start.slice(0, 7), lang);
        period = `${startP.name} ${startP.year} – ${endP.name} ${endP.year}`;
      }
    }

    built.push({
      key: 'totals',
      render: () => (
        <div className="wr-poster wr-totals">
          <span className="wr-eyebrow">{wt('wrapped.totalsTitle')}</span>
          <BigNumber value={stats.totalRequests} format={fmt} />
          <div className="wr-totals-label">
            {wt('wrapped.requestsLabel')}
            {period && <span className="wr-totals-period">{period}</span>}
          </div>
          <div className="wr-ledger">
            <div className="wr-ledger-cell"><strong><PopNumber n={stats.distinctRequesters} format={fmt} /></strong><span>{wt('wrapped.peopleLabel')}</span></div>
            <div className="wr-ledger-cell"><strong><PopNumber n={stats.distinctCharacters} format={fmt} /></strong><span>{wt('wrapped.charactersLabel')}</span></div>
            <div className="wr-ledger-cell"><strong><PopNumber n={stats.doneRequests} format={fmt} /></strong><span>{wt('wrapped.doneLabel')}</span></div>
          </div>
          {narrative.captions.totals && <p className="wr-body">{narrative.captions.totals}</p>}
        </div>
      ),
    });

    const champions: Array<{ key: string; title: string; kind: 'killer' | 'survivor'; list: typeof stats.topKillers; cap?: string }> = [];
    if (stats.topKillers[0]) champions.push({ key: 'topKiller', title: wt('wrapped.topKillerTitle'), kind: 'killer', list: stats.topKillers, cap: narrative.captions.topKiller });
    if (stats.topSurvivors[0]) champions.push({ key: 'topSurvivor', title: wt('wrapped.topSurvivorTitle'), kind: 'survivor', list: stats.topSurvivors, cap: narrative.captions.topSurvivor });

    for (const ch of champions) {
      const top = ch.list[0];
      const portraitSmall = getCharacterPortrait(top.character, ch.kind);
      const portraitLarge = getCharacterPortraitLarge(top.character, ch.kind);
      built.push({
        key: ch.key,
        render: () => (
          <div className={`wr-poster wr-champ wr-champ--${ch.kind}`}>
            <div className="wr-champ-ghost" aria-hidden="true">{fmt(top.count)}</div>
            <span className="wr-eyebrow">{ch.title}</span>
            <div className="wr-champ-hero">
              <div className="wr-champ-portrait-wrap">
                {portraitLarge && portraitSmall
                  ? <img className="wr-champ-portrait" src={portraitLarge} onError={fallbackToSmall(portraitSmall)} alt={top.character} />
                  : <img className="wr-champ-portrait wr-champ-portrait-icon" src={`${base}images/${ch.kind === 'killer' ? 'IconKiller-lg' : 'IconSurv-lg'}.webp`} alt="" />}
              </div>
              <div className="wr-champ-titleblock">
                <h2 className="wr-champ-name">{top.character}</h2>
                <div className="wr-champ-count">{popCount('wrapped.requestersCount', top.count)}</div>
              </div>
            </div>
            <ol className="wr-ladder">
              {ch.list.slice(1).map((k, i) => {
                const thumb = getCharacterPortrait(k.character, ch.kind);
                return (
                  <li key={k.character} className={`wr-ladder-row wr-rar-${i + 2}`}>
                    <span className="wr-ladder-pos">{ROMAN[i + 1]}</span>
                    {thumb && <img className="wr-ladder-thumb" src={thumb} alt="" />}
                    <span className="wr-ladder-name">{k.character}</span>
                    <span className="wr-ladder-count"><PopNumber n={k.count} format={fmt} /></span>
                    {rankBar(k.count, top.count)}
                  </li>
                );
              })}
            </ol>
            {ch.cap && <p className="wr-body wr-champ-caption">{ch.cap}</p>}
          </div>
        ),
      });
    }

    const typed = stats.killerCount + stats.survivorCount;
    if (typed > 0) {
      const killerPct = Math.round((stats.killerCount / typed) * 100);
      built.push({
        key: 'ratio',
        render: () => (
          <div className="wr-poster wr-ratio">
            <span className="wr-eyebrow">{wt('wrapped.ratioTitle')}</span>
            <RatioArena killerPct={killerPct} killersLabel={wt('wrapped.ratioKillers')} survivorsLabel={wt('wrapped.ratioSurvivors')} />
            {narrative.captions.ratio && <p className="wr-body">{narrative.captions.ratio}</p>}
          </div>
        ),
      });
    }

    if (stats.topRequesters.length > 0) {
      built.push({
        key: 'requesters',
        render: () => (
          <div className="wr-poster wr-requesters">
            <span className="wr-eyebrow">{wt('wrapped.requestersTitle')}</span>
            <ol className="wr-board">
              {stats.topRequesters.map((r, i) => {
                const avatar = avatarFor(r.donor);
                const max = Math.max(...stats.topRequesters.map((x) => x.count));
                return (
                  <li key={r.donor} className={`wr-board-row wr-rar-${i + 1}`}>
                    <span className="wr-board-pos">{ROMAN[i]}</span>
                    {avatar && <img className="wr-user-avatar" src={avatar} alt="" />}
                    <span className="wr-board-name" style={{ color: `hsl(${chatHue(r.donor)}, 55%, 70%)` }}>{r.donor}</span>
                    <span className="wr-board-count">{popCount('wrapped.requestersCount', r.count)}</span>
                    {rankBar(r.count, max)}
                  </li>
                );
              })}
            </ol>
            {narrative.captions.requesters && <p className="wr-body">{narrative.captions.requesters}</p>}
          </div>
        ),
      });
    }

    const peakMonth = stats.monthly.length > 1
      ? stats.monthly.reduce((a, b) => (b.count > a.count ? b : a))
      : null;
    if (peakMonth || stats.busiestDay) {
      const mp = peakMonth ? monthParts(peakMonth.month, lang) : null;
      built.push({
        key: 'timeline',
        render: () => (
          <div className="wr-poster wr-timeline">
            {vodThumb && <div className="wr-vod-backdrop" style={{ backgroundImage: `url(${vodThumb})` }} aria-hidden="true" />}
            <span className="wr-eyebrow">{wt('wrapped.timelineTitle')}</span>
            {mp && peakMonth && (
              <div className="wr-timeline-peak">
                <div className="wr-timeline-month">{mp.name}</div>
                <div className="wr-timeline-year" aria-hidden="true">{mp.year}</div>
                <div className="wr-timeline-count">{popCount('wrapped.requestersCount', peakMonth.count)}</div>
              </div>
            )}
            {stats.busiestDay && (
              <div className="wr-stamp">
                <span className="wr-stamp-line">{popCount('wrapped.timelineBusiestDay', stats.busiestDay.count)}</span>
                <span className="wr-stamp-date">{formatDay(stats.busiestDay.date, lang)}</span>
              </div>
            )}
            {narrative.captions.timeline && <p className="wr-body">{narrative.captions.timeline}</p>}
          </div>
        ),
      });
    }

    if (narrative.funniestNames?.length > 0) {
      built.push({
        key: 'funniestNames',
        render: () => (
          <div className="wr-poster wr-chat">
            <span className="wr-eyebrow">{wt('wrapped.funniestNamesTitle')}</span>
            <div className="wr-chat-stack">
              {narrative.funniestNames.map((f, i) => {
                const avatar = avatarFor(f.name);
                return (
                  <div className="wr-chat-window" key={f.name} style={{ animationDelay: `${0.15 + i * 0.35}s` }}>
                    <div className="wr-chat-bar" aria-hidden="true"><i /><i /><i /></div>
                    <div className="wr-chat-lines">
                      <div className="wr-chat-line">
                        {avatar && <img className="wr-user-avatar wr-chat-avatar" src={avatar} alt="" />}
                        <span className="wr-chat-user" style={{ color: `hsl(${chatHue(f.name)}, 60%, 68%)` }}>{f.name}</span>
                        <span className="wr-chat-msg">{f.comment}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ),
      });
    }

    for (const [i, h] of narrative.highlights.entries()) {
      // Resolve a character (name + type) for the highlight: explicit field
      // first, then a local match on the title (cached payloads predate
      // `character`). Both the small and large portraits are resolved from
      // the same name/type so they always refer to the same character.
      let resolvedName: string | undefined = h.character;
      let resolvedType: 'killer' | 'survivor' | undefined;
      if (!resolvedName) {
        const match = tryLocalMatch(h.title);
        if (match) { resolvedName = match.character; resolvedType = match.type; }
      }
      const portrait = resolvedName ? getCharacterPortrait(resolvedName, resolvedType) : undefined;
      const portraitLarge = resolvedName ? getCharacterPortraitLarge(resolvedName, resolvedType) : undefined;
      built.push({
        key: `highlight-${i}`,
        render: () => (
          <div className="wr-poster wr-highlight">
            {portrait
              ? <img className="wr-highlight-portrait" src={portraitLarge ?? portrait} onError={fallbackToSmall(portrait)} alt="" />
              : <img className="wr-perk-mark" src={`${base}images/perk.webp`} alt="" />}
            <h3 className="wr-highlight-title">{h.title}</h3>
            <p className="wr-highlight-text">{h.text}</p>
          </div>
        ),
      });
    }

    if (priv && priv.donationCount > 0) {
      // Redacted in STATE, not CSS: when hidden, the real digits are never
      // rendered into the DOM (devtools / a11y tree / entrance-animation safe).
      const amount = (v: number) => (showMoney ? formatBRL(v) : 'R$ •••••');
      built.push({
        key: 'money',
        render: () => (
          <div className="wr-poster wr-money">
            <span className="wr-eyebrow">{wt('wrapped.moneyTitle')}</span>
            <div className={`wr-money-amount ${showMoney ? '' : 'redacted'}`}>
              {showMoney ? <PopNumber n={priv.totalAmount} format={formatBRL} /> : <PopDigits value={'R$ •••••'} />}
            </div>
            <div className="wr-money-label">{wt('wrapped.moneyTotal')}</div>
            {priv.topDonors.length > 0 && (
              <div className="wr-money-donors">
                <div className="wr-money-donors-head">{wt('wrapped.moneyTopDonors')}</div>
                <ol className="wr-money-list">
                  {priv.topDonors.map((d, i) => {
                    const avatar = avatarFor(d.donor);
                    const max = Math.max(...priv.topDonors.map((x) => x.total));
                    return (
                      <li key={d.donor} className={`wr-rar-${i + 1}`}>
                        <span className="wr-board-pos">{ROMAN[i]}</span>
                        {avatar && <img className="wr-user-avatar" src={avatar} alt="" />}
                        <span className="wr-money-donor">{d.donor}</span>
                        <span className="wr-money-leader" aria-hidden="true" />
                        <span className={`wr-money-total ${showMoney ? '' : 'redacted'}`}>{showMoney ? <PopNumber n={d.total} format={formatBRL} /> : <PopDigits value={'R$ •••••'} />}</span>
                        {rankBar(d.total, max)}
                      </li>
                    );
                  })}
                </ol>
              </div>
            )}
            <div className="wr-money-actions">
              <button className="wrapped-money-toggle" onClick={(e) => { e.stopPropagation(); setShowMoney((s) => !s); }}>
                <EyeIcon open={!showMoney} />
                {showMoney ? wt('wrapped.moneyHide') : wt('wrapped.moneyReveal')}
              </button>
              <div className="wr-money-stamp">{wt('wrapped.moneyPrivate')}</div>
            </div>
            {narrative.captions.money && <p className="wr-body">{narrative.captions.money}</p>}
          </div>
        ),
      });
    }

    built.push({
      key: 'persona',
      render: () => (
        <div className="wr-poster wr-persona">
          <span className="wr-eyebrow">{wt('wrapped.personaTitle')}</span>
          <h2 className="wr-persona-title">{narrative.personaTitle}</h2>
          <p className="wr-body wr-persona-text">{narrative.personaText}</p>
        </div>
      ),
    });

    built.push({
      key: 'finale',
      render: () => (
        <div className="wr-poster wr-finale">
          <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
          <span className="wr-eyebrow">{wt('wrapped.superlativeTitle')}</span>
          <h2 className="wr-finale-title">{narrative.superlative.title}</h2>
          <p className="wr-body wr-finale-text">{narrative.superlative.text}</p>
          <div className="wrapped-finale-actions" ref={finaleShareRef}>
            <button className="wrapped-share-btn" onClick={(e) => { e.stopPropagation(); setShareOpenFinale((v) => !v); }}>
              {wt('wrapped.share')}
            </button>
            {shareOpenFinale && (
              <SharePopover
                wt={wt}
                exportUrl={exportUrl}
                onCopyLink={copyLink}
                canNativeShare={canNativeShare}
                onNativeShare={nativeShare}
                onNavigateExport={navigateToExport}
                align="finale"
              />
            )}
            <a className="wrapped-back-link" href={`${base.replace(/\/$/, '')}/${channel.toLowerCase()}`} onClick={goToQueue}>
              {wt('wrapped.backToQueue')}
            </a>
          </div>
          <div className="wrapped-branding">Fila DBD</div>
        </div>
      ),
    });

    return built;
  }, [state, showMoney, wt, channel, isOwner, handleGenerate, goToQueue, shareOpenFinale, exportUrl, copyLink, canNativeShare, nativeShare, navigateToExport]);

  const goTo = useCallback((next: number) => {
    setIndex((_) => Math.max(0, Math.min(slides.length - 1, next)));
  }, [slides.length]);

  const handleTap = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (state.phase !== 'ready') return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < rect.width * 0.3) goTo(index - 1);
    else goTo(index + 1);
  }, [state.phase, index, goTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') goTo(index + 1);
      else if (e.key === 'ArrowLeft') goTo(index - 1);
      else if (e.key === 'Escape') navigate(`/${channel.toLowerCase()}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, goTo, channel]);

  const generatingKeys = ['wrapped.generating', 'wrapped.generating2', 'wrapped.generating3'] as const;

  return (
    <div className="wrapped-root">
      <div className="wrapped-fog" aria-hidden="true" />
      <button className="wrapped-close" onClick={goToQueue} aria-label={t('wrapped.backToQueue')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <div className="wrapped-stage" ref={stageRef} onClick={handleTap}>
        {state.phase === 'loading' && (
          <div className="wrapped-slide-content wrapped-status">
            <div className="wrapped-spinner" />
            <p className="wrapped-shimmer">{t('wrapped.loading')}</p>
          </div>
        )}

        {state.phase === 'not-generated' && (
          <div className="wrapped-slide-content wrapped-status">
            <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            <h2>{t('wrapped.notGenerated')}</h2>
            <p className="wrapped-caption">{t('wrapped.notGeneratedHint', { channel })}</p>
            {!isAuthenticated && (
              <button className="wrapped-share-btn" onClick={(e) => { e.stopPropagation(); login(); }}>
                {t('wrapped.ownerCta')}
              </button>
            )}
            <a className="wrapped-back-link" href={`${base.replace(/\/$/, '')}/${channel.toLowerCase()}`} onClick={goToQueue}>
              {t('wrapped.backToQueue')}
            </a>
          </div>
        )}

        {state.phase === 'generate-cta' && (
          <div className="wrapped-slide-content wrapped-status">
            <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            <h2>{t('wrapped.generateTitle')}</h2>
            <p className="wrapped-caption">{t('wrapped.generateHint')}</p>
            <div className="wrapped-lang-pick" onClick={(e) => e.stopPropagation()}>
              <span className="wrapped-lang-label">{t('wrapped.generateLangLabel')}</span>
              <div className="wrapped-lang-options" role="radiogroup">
                <button className={genLang === 'pt-BR' ? 'active' : ''} role="radio" aria-checked={genLang === 'pt-BR'} onClick={() => setGenLang('pt-BR')}>Português</button>
                <button className={genLang === 'en' ? 'active' : ''} role="radio" aria-checked={genLang === 'en'} onClick={() => setGenLang('en')}>English</button>
              </div>
            </div>
            <button className="wrapped-share-btn" onClick={(e) => { e.stopPropagation(); handleGenerate(); }}>
              {t('wrapped.generateButton')}
            </button>
          </div>
        )}

        {state.phase === 'generating' && (
          <div className="wrapped-slide-content wrapped-status">
            <div className="wrapped-spinner" />
            <p key={generatingMsg} className="wrapped-shimmer wrapped-generating-msg">{t(generatingKeys[generatingMsg])}</p>
          </div>
        )}

        {state.phase === 'not-enough-data' && (
          <div className="wrapped-slide-content wrapped-status">
            <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            <p className="wrapped-caption">{t('wrapped.notEnoughData', { count: state.total, min: state.min })}</p>
            <a className="wrapped-back-link" href={`${base.replace(/\/$/, '')}/${channel.toLowerCase()}`} onClick={goToQueue}>
              {t('wrapped.backToQueue')}
            </a>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="wrapped-slide-content wrapped-status">
            <img className="wr-emblem" src={`${base}images/Dead-by-Daylight-Emblem.webp`} alt="" />
            <p className="wrapped-caption">{t('wrapped.generateFailed')}</p>
          </div>
        )}

        {state.phase === 'ready' && slides[index] && (
          <>
            <div className="wrapped-progress">
              {slides.map((s, i) => (
                <div key={s.key} className={`wrapped-progress-seg ${i < index ? 'past' : ''} ${i === index ? 'active' : ''}`} />
              ))}
            </div>
            <div className="wrapped-slide" key={slides[index].key}>
              {slides[index].render()}
            </div>
            {index < slides.length - 1 && <div className="wrapped-hint wrapped-tap-hint">{wt('wrapped.tapHint')}</div>}
            <button
              className="wrapped-nav prev"
              disabled={index === 0}
              onClick={(e) => { e.stopPropagation(); goTo(index - 1); }}
              aria-label="previous"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
            </button>
            <button
              className="wrapped-nav next"
              disabled={index === slides.length - 1}
              onClick={(e) => { e.stopPropagation(); goTo(index + 1); }}
              aria-label="next"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
            </button>
            <div className="wr-share-root" ref={floatShareRef}>
              <button className="wrapped-share-float" onClick={(e) => { e.stopPropagation(); setShareOpenFloat((v) => !v); }} aria-label={wt('wrapped.share')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
                  <path d="M8.6 13.5l6.8 3.9M15.4 6.6L8.6 10.5" />
                </svg>
                <span>{wt('wrapped.share')}</span>
              </button>
              {shareOpenFloat && (
                <SharePopover
                  wt={wt}
                  exportUrl={exportUrl}
                  onCopyLink={copyLink}
                  canNativeShare={canNativeShare}
                  onNativeShare={nativeShare}
                  onNavigateExport={navigateToExport}
                  align="float"
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
