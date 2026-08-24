import { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../store';
import { useTranslation } from '../i18n';
import type { TranslationKeys } from '../i18n/locales/pt-BR';
import { formatRelativeTime, handleLinkClick, navigate } from '../utils/helpers';
import { getKillerPortrait } from '../data/characters';
import { CharacterAvatar } from './CharacterAvatar';
import { SyncSweep } from './SyncSweep';
import { loadCachedChannels, saveCachedChannels, type ActiveRoom, type RecentRoom } from '../store/channelsCache';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';

// Twitch live-preview thumbnails share a stable URL whose image updates over time,
// so the browser keeps serving its cached copy (stale until a hard refresh). Bust
// the cache once a minute. The profile banner is static, so it's used as-is.
function channelThumbSrc(room: { thumbnail_url?: string | null; banner_url?: string | null }): string | null {
  if (!room.thumbnail_url) return room.banner_url ?? null;
  const sep = room.thumbnail_url.includes('?') ? '&' : '?';
  return `${room.thumbnail_url}${sep}t=${Math.floor(Date.now() / 60000)}`;
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

// Anything that could be a Twitch login — used to offer a direct "go to channel"
// entry for names the search index doesn't know about (any channel page works as
// a viewer, even before its first queue).
const TWITCH_LOGIN_RE = /^[a-zA-Z0-9_]{3,25}$/;

interface SearchRoom {
  id: string;
  channel_login: string;
  display_name: string | null;
  avatar_url: string | null;
  request_count: number;
  updated_at: string;
}

function ChannelSearch() {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchRoom[] | null>(null);
  const [focused, setFocused] = useState(false);
  const seq = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const query = q.trim();

  // Debounced search against /rooms/search; a stale response never overwrites a
  // newer one (seq guard). Under 2 chars the API won't search, so don't ask.
  useEffect(() => {
    const id = ++seq.current;
    if (query.length < 2) { setResults(null); return; }
    const tid = window.setTimeout(() => {
      fetch(`${API_URL}/rooms/search?q=${encodeURIComponent(query)}`)
        .then(r => r.json())
        .then((data: { rooms: SearchRoom[] }) => { if (seq.current === id) setResults(data.rooms ?? []); })
        .catch(() => { if (seq.current === id) setResults([]); });
    }, 250);
    return () => clearTimeout(tid);
  }, [query]);

  // Close on click/tap outside.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setFocused(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  // Direct escape hatch for channels the index doesn't know: only offered when
  // the search came back empty, so it never adds noise under real matches.
  const goToFallback = results?.length === 0 && TWITCH_LOGIN_RE.test(query);

  const open = focused && query.length >= 2;

  const go = (login: string) => {
    setFocused(false);
    setQ('');
    navigate(`/${login.toLowerCase()}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setFocused(false); return; }
    if (e.key === 'Enter') {
      const first = results?.[0]?.channel_login ?? (TWITCH_LOGIN_RE.test(query) ? query : null);
      if (first) go(first);
    }
  };

  return (
    <div className="landing-channel-search" ref={wrapRef}>
      <svg className="landing-channel-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.35-4.35" />
      </svg>
      <input
        type="search"
        value={q}
        placeholder={t('landing.searchPlaceholder')}
        onChange={e => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        onKeyDown={onKeyDown}
        aria-label={t('landing.searchPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        maxLength={30}
      />
      {open && (
        <div className="landing-channel-search-results">
          {results === null ? (
            <div className="landing-channel-search-hint">{t('landing.searchSearching')}</div>
          ) : (
            <>
              {results.map(r => {
                const name = r.display_name || r.channel_login;
                return (
                  <a
                    key={r.id}
                    className="landing-channel-search-result"
                    href={`/${r.channel_login}`}
                    onClick={e => { e.preventDefault(); go(r.channel_login); }}
                  >
                    {r.avatar_url
                      ? <img className="landing-channel-search-avatar" src={r.avatar_url} alt="" />
                      : <span className="landing-channel-search-avatar placeholder" />}
                    <span className="landing-channel-search-name">{name}</span>
                    <span className="landing-channel-search-meta">
                      {t('landing.totalRequests', { count: r.request_count })}
                    </span>
                  </a>
                );
              })}
              {results.length === 0 && !goToFallback && (
                <div className="landing-channel-search-hint">{t('landing.searchNoResults')}</div>
              )}
              {goToFallback && (
                <a
                  className="landing-channel-search-result goto"
                  href={`/${query.toLowerCase()}`}
                  onClick={e => { e.preventDefault(); go(query); }}
                >
                  <span className="landing-channel-search-avatar placeholder">→</span>
                  <span className="landing-channel-search-name">{t('landing.searchGoTo', { channel: query.toLowerCase() })}</span>
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// One featured card can be a live/open room (ActiveRoom) or a recently-active
// one (RecentRoom); `active` tells them apart without duck-typing the shape.
type Featured =
  | { active: true; room: ActiveRoom }
  | { active: false; room: RecentRoom };

// The editorial grid always renders exactly this many slots — a 2×2 hero plus
// four small cards — so the section keeps a stable size no matter how many
// channels are around. Missing channels become "your queue here" CTA slots.
const FEATURED_SLOTS = 5;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function FeaturedCard({ item, hero, loading }: { item: Featured; hero: boolean; loading: boolean }) {
  const { t } = useTranslation();
  const { room, active } = item;
  const displayName = room.display_name || room.channel_login;
  const thumb = channelThumbSrc(room);
  return (
    <a className={`landing-channel-card${hero ? ' hero' : ''}`} href={`/${room.channel_login}`} onClick={handleLinkClick}>
      <div className="landing-channel-thumb">
        {thumb ? (
          <img src={thumb} alt={displayName} />
        ) : (
          <img className="landing-channel-thumb-placeholder" src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="" />
        )}
        {room.is_live && !loading && <span className="landing-channel-live">{t('landing.live')}</span>}
      </div>
      <div className="landing-channel-info">
        <div className="landing-channel-card-header">
          {room.avatar_url && <img className="landing-channel-avatar" src={room.avatar_url} alt="" />}
          <span className="landing-channel-name">{displayName}</span>
          {active && room.status !== 'offline' && <span className="landing-channel-status">{t('landing.queueOpen')}</span>}
        </div>
        <div className="landing-channel-stats">
          <span className="landing-channel-pending">
            {active
              ? t('landing.requestCount', { count: room.pending_count })
              : t('landing.totalRequests', { count: room.request_count })}
          </span>
          <span className="landing-channel-meta">
            {room.viewer_count != null && <span>{room.viewer_count} viewers</span>}
            <span>{formatRelativeTime(new Date(room.updated_at + 'Z'))}</span>
          </span>
        </div>
      </div>
    </a>
  );
}

// Fills an empty featured slot: a quiet CTA card that keeps the grid's shape.
function SlotCard({ hero }: { hero: boolean }) {
  const { isAuthenticated, user, login } = useAuth();
  const { t } = useTranslation();
  const className = `landing-channel-card landing-slot${hero ? ' hero' : ''}`;
  const inner = (
    <>
      <img className="landing-slot-emblem" src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="" />
      <span className="landing-slot-title">{t('landing.slotTitle')}</span>
      <span className="landing-slot-desc">{t('landing.slotDesc')}</span>
    </>
  );
  if (isAuthenticated && user) {
    return <a className={className} href={`/${user.login.toLowerCase()}`} onClick={handleLinkClick}>{inner}</a>;
  }
  return <button className={className} onClick={login}>{inner}</button>;
}

function LiveChannels() {
  const { t } = useTranslation();
  // Read the cache once (stale-while-revalidate): null = cold cache, so show
  // skeletons; otherwise paint the cached list — even an empty one is a real hit,
  // so a genuinely empty response shows the empty state, not skeletons. `loading`
  // is the single in-flight flag: while it's set we show skeletons on a cold cache
  // or the refresh indicator on a warm one, then the response wins.
  const [cache] = useState(loadCachedChannels);
  const [rooms, setRooms] = useState<ActiveRoom[]>(cache?.rooms ?? []);
  const [recent, setRecent] = useState<RecentRoom[]>(cache?.recent ?? []);
  const [totalChannels, setTotalChannels] = useState<number | undefined>(cache?.totalChannels);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API_URL}/rooms/active`)
      .then(r => r.json())
      .then((data: { rooms: ActiveRoom[]; recent?: RecentRoom[]; total_channels?: number }) => {
        const next = data.rooms.filter(r => r.channel_login !== 'meriw_');
        const nextRecent = (data.recent ?? []).filter(r => r.channel_login !== 'meriw_');
        setRooms(next);
        setRecent(nextRecent);
        setTotalChannels(data.total_channels);
        saveCachedChannels(next, nextRecent, data.total_channels);
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  // One featured mix: live/open queues always lead, then a shuffled sample of
  // recently-active channels fills the grid — so there's always something on
  // display and the same regulars don't sit in the same slots all day.
  const featured = useMemo<Featured[]>(() => {
    const activeItems: Featured[] = rooms.map(room => ({ active: true, room }));
    const recentItems: Featured[] = shuffle(recent).map(room => ({ active: false, room }));
    return [...activeItems, ...recentItems].slice(0, FEATURED_SLOTS);
  }, [rooms, recent]);

  let content;
  if (loading && cache === null) {
    // Skeletons mirror the real grid exactly (hero + smalls), so nothing shifts
    // when the response lands.
    content = (
      <div className="landing-featured-grid">
        {Array.from({ length: FEATURED_SLOTS }, (_, i) => (
          <div key={i} className={`landing-channel-card skeleton${i === 0 ? ' hero' : ''}`}>
            <div className="landing-channel-thumb" />
            <div className="landing-channel-info">
              <div className="landing-channel-card-header">
                <div className="skeleton-circle" />
                <div className="skeleton-line" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  } else {
    // Always exactly FEATURED_SLOTS cells: real channels first (hero = top pick),
    // CTA slots pad the rest, so the section never changes shape.
    content = (
      <div className="landing-featured-grid">
        {Array.from({ length: FEATURED_SLOTS }, (_, i) => {
          const item = featured[i];
          if (!item) return <SlotCard key={`slot-${i}`} hero={i === 0} />;
          return <FeaturedCard key={item.room.id} item={item} hero={i === 0} loading={loading} />;
        })}
      </div>
    );
  }

  return (
    <>
      <div className="landing-channels-heading">
        <h2>{t('landing.featuredChannels')}</h2>
        {/* Shown while revalidating a warm cache; its slot is always reserved so
            toggling it never shifts the list below. */}
        <SyncSweep active={loading && cache !== null} />
        <ChannelSearch />
      </div>
      {content}
      {totalChannels != null && totalChannels > 0 && (
        <p className="landing-channels-count">{t('landing.channelCount', { count: totalChannels })}</p>
      )}
    </>
  );
}

const HIGHLIGHT_ICONS = [
  // Automatic detection — chat bubble
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
  </svg>,
  // AI identification — help circle
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
    <circle cx="12" cy="17" r="0.5" fill="currentColor" />
  </svg>,
  // Builds — shield
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>,
  // Real-time sync — lightning
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>,
  // Free — heart
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </svg>,
];

const HIGHLIGHT_KEYS = [
  { title: 'landing.featureDetectionTitle', desc: 'landing.featureDetectionDesc' },
  { title: 'landing.featureAITitle', desc: 'landing.featureAIDesc' },
  { title: 'landing.buildRequestsTitle', desc: 'landing.buildRequestsDesc' },
  { title: 'landing.featureSyncTitle', desc: 'landing.featureSyncDesc' },
  { title: 'landing.featureFreeTitle', desc: 'landing.featureFreeDesc' },
] as const;

const STEP_KEYS = [
  { num: '1', title: 'landing.step1Title', desc: 'landing.step1Desc' },
  { num: '2', title: 'landing.step2Title', desc: 'landing.step2Desc' },
  { num: '3', title: 'landing.step3Title', desc: 'landing.step3Desc' },
] as const;

const base = import.meta.env.BASE_URL;

const FAQ_ITEMS = [
  { q: 'landing.faq.1.q', a: 'landing.faq.1.a' },
  { q: 'landing.faq.4.q', a: 'landing.faq.4.a' },
  { q: 'landing.faq.2.q', a: 'landing.faq.2.a' },
  { q: 'landing.faq.3.q', a: 'landing.faq.3.a' },
  { q: 'landing.faq.5.q', a: 'landing.faq.5.a' },
  { q: 'landing.faq.6.q', a: 'landing.faq.6.a' },
  { q: 'landing.faq.7.q', a: 'landing.faq.7.a' },
  { q: 'landing.faq.8.q', a: 'landing.faq.8.a' },
  { q: 'landing.faq.9.q', a: 'landing.faq.9.a' },
] as const;

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`landing-faq-item${open ? ' open' : ''}`}>
      <button className="landing-faq-q" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span>{q}</span>
        <svg className="landing-faq-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div className="landing-faq-body" style={{ gridTemplateRows: open ? '1fr' : '0fr' }}>
        <div className="landing-faq-body-inner">
          <p className="landing-faq-a" dangerouslySetInnerHTML={{ __html: a }} />
        </div>
      </div>
    </div>
  );
}

function FaqSection() {
  const { t } = useTranslation();
  return (
    <section className="landing-section" id="faq">
      <h2>{t('landing.faq')}</h2>
      <div className="landing-faq">
        {FAQ_ITEMS.map((item, i) => (
          <FaqItem key={i} q={t(item.q)} a={t(item.a)} />
        ))}
      </div>
    </section>
  );
}

type QueueExample = {
  character: string;
  type: 'killer' | 'survivor';
  donor: string;
  source: 'donation' | 'resub' | 'chat';
  amount?: string;
  subTier?: number;
  messageKey: keyof TranslationKeys;
  buildKey?: keyof TranslationKeys;
};

const QUEUE_EXAMPLES: QueueExample[] = [
  { character: 'Trapper', type: 'killer', donor: 'carol', source: 'donation', amount: 'R$ 30', messageKey: 'landing.mockupMessage1', buildKey: 'landing.mockupBuildLine' },
  { character: 'Nurse', type: 'killer', donor: 'mateus', source: 'donation', amount: 'R$ 10', messageKey: 'landing.mockupMessage2' },
  { character: 'Huntress', type: 'killer', donor: 'bia', source: 'resub', messageKey: 'landing.mockupMessage3' },
  { character: 'Dwight', type: 'survivor', donor: 'rafa', source: 'chat', subTier: 1, messageKey: 'landing.mockupMessage4' },
  { character: 'Wraith', type: 'killer', donor: 'lucas', source: 'donation', amount: 'R$ 15', messageKey: 'landing.mockupMessage5', buildKey: 'landing.mockupBuildLine2' },
  { character: 'Clown', type: 'killer', donor: 'duda', source: 'donation', amount: 'R$ 5', messageKey: 'landing.mockupMessage6' },
  { character: 'Meg', type: 'survivor', donor: 'theo', source: 'chat', subTier: 2, messageKey: 'landing.mockupMessage7' },
  { character: 'Spirit', type: 'killer', donor: 'gabi', source: 'donation', amount: 'R$ 8', messageKey: 'landing.mockupMessage8' },
  { character: 'Hillbilly', type: 'killer', donor: 'igor', source: 'resub', messageKey: 'landing.mockupMessage9' },
];

// More cards than fit are rendered on purpose: the container is capped to the
// copy column's height and the overflow fades out at the bottom.
const MOCK_VISIBLE = 7;

const typeIconFor = (type: string) =>
  `${base}images/${type === 'killer' ? 'IconKiller.webp' : type === 'survivor' ? 'IconSurv.webp' : 'IconShuffle.webp'}`;

function badgeFor(ex: QueueExample): { text: string; cls: string } {
  if (ex.source === 'donation') return { text: ex.amount ?? '', cls: 'source-donation' };
  if (ex.source === 'resub') return { text: 'RESUB', cls: 'source-resub' };
  return { text: `TIER ${ex.subTier ?? 1}`, cls: 'source-chat' };
}

interface MockCardProps {
  example: QueueExample;
  position: number;
  entering: boolean;
  exiting: boolean;
  onDone: () => void;
}

function MockCard({ example, position, entering, exiting, onDone }: MockCardProps) {
  const { t } = useTranslation();
  const portrait = example.type === 'killer' ? getKillerPortrait(example.character) : undefined;
  const build = example.buildKey ? t(example.buildKey) : undefined;
  const badge = badgeFor(example);
  const className = [
    'request-card',
    `source-${example.source}`,
    entering && 'entering',
    exiting && 'deleting',
  ].filter(Boolean).join(' ');

  return (
    <div className={className} onClick={onDone}>
      <div className="request-card-content">
        <span className="request-position">{String(position).padStart(2, '0')}</span>
        <CharacterAvatar
          portrait={portrait}
          type={example.type}
          extras={build ? [{ type: 'build', text: build }] : undefined}
        />
        <div className="request-card-info">
          <div className="character">
            <img src={typeIconFor(example.type)} alt="" className="char-type-icon" />
            <span className="char-name">{example.character}</span>
          </div>
          <div className="request-card-body">
            <span className="donor-name">{example.donor}</span>
            {t(example.messageKey)}
          </div>
        </div>
        <div className="request-card-meta">
          <span className={`amount ${badge.cls}`}>{badge.text}</span>
        </div>
      </div>
      <div className="request-actions">
        <button
          className="request-action-btn done"
          tabIndex={-1}
          onClick={(e) => { e.stopPropagation(); onDone(); }}
          title={t('card.markDone')}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </button>
      </div>
    </div>
  );
}

type MockSlot = { poolIndex: number; instanceId: number; entering: boolean; exiting: boolean };

/**
 * Interactive replica of the live queue. Clicking a card (or its check button)
 * marks it done: it slides out like the real card, then the next example from
 * QUEUE_EXAMPLES recycles into its place, keeping a constant card count.
 */
function LandingDonationMockup() {
  const [slots, setSlots] = useState<MockSlot[]>(() =>
    Array.from({ length: MOCK_VISIBLE }, (_, i) => ({
      poolIndex: i % QUEUE_EXAMPLES.length,
      instanceId: i,
      entering: false,
      exiting: false,
    }))
  );
  const nextPoolIndex = useRef(MOCK_VISIBLE % QUEUE_EXAMPLES.length);
  const nextInstanceId = useRef(MOCK_VISIBLE);
  const timers = useRef<number[]>([]);

  useEffect(() => () => { timers.current.forEach(clearTimeout); }, []);

  const handleDone = (instanceId: number) => {
    setSlots(prev => {
      const slot = prev.find(s => s.instanceId === instanceId);
      if (!slot || slot.exiting) return prev;
      return prev.map(s => s.instanceId === instanceId ? { ...s, exiting: true, entering: false } : s);
    });
    const tid = window.setTimeout(() => {
      setSlots(prev => {
        if (!prev.some(s => s.instanceId === instanceId)) return prev;
        const remaining = prev.filter(s => s.instanceId !== instanceId);
        // Pick the next example that isn't already on screen so cards never duplicate.
        const visible = new Set(remaining.map(s => s.poolIndex));
        let poolIndex = nextPoolIndex.current;
        for (let n = 0; n < QUEUE_EXAMPLES.length && visible.has(poolIndex); n++) {
          poolIndex = (poolIndex + 1) % QUEUE_EXAMPLES.length;
        }
        nextPoolIndex.current = (poolIndex + 1) % QUEUE_EXAMPLES.length;
        const newSlot: MockSlot = {
          poolIndex,
          instanceId: nextInstanceId.current,
          entering: true,
          exiting: false,
        };
        nextInstanceId.current += 1;
        return [...remaining, newSlot];
      });
    }, 500);
    timers.current.push(tid);
  };

  return (
    <div className="landing-mock-col">
      <div className="landing-mock-queue">
        {slots.map((slot, i) => (
          <MockCard
            key={slot.instanceId}
            example={QUEUE_EXAMPLES[slot.poolIndex]}
            position={i + 1}
            entering={slot.entering}
            exiting={slot.exiting}
            onDone={() => handleDone(slot.instanceId)}
          />
        ))}
      </div>
    </div>
  );
}

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
        <LiveChannels />
      </section>

      <section className="landing-section">
        <h2>{t('landing.donationsBandTitle')}</h2>
        <div className="landing-donations-band">
          <div className="landing-donations-copy">
            {HIGHLIGHT_KEYS.map((f, i) => (
              <div key={i} className="landing-donations-point">
                <div className="landing-donations-point-icon">{HIGHLIGHT_ICONS[i]}</div>
                <div>
                  <h3>{t(f.title)}</h3>
                  <p>{t(f.desc)}</p>
                </div>
              </div>
            ))}
          </div>
          <LandingDonationMockup />
        </div>
      </section>

      <section className="landing-section">
        <h2>{t('landing.startIn3Steps')}</h2>
        <div className="landing-steps">
          {STEP_KEYS.map((s, i) => (
            <div key={i} className="landing-step" style={{ animationDelay: `${i * 0.1 + 0.3}s` }}>
              <div className="landing-step-num">{s.num}</div>
              <h3>{t(s.title)}</h3>
              <p>{t(s.desc)}</p>
            </div>
          ))}
        </div>
      </section>

      <FaqSection />

      <div className="landing-disclaimer">
        <p>{t('landing.disclaimer1')}</p>
        <p>{t('landing.disclaimer2')}</p>
        <p>{t('landing.madeWith')} <a href="https://github.com/macecchi" target="_blank">macecchi</a> {t('landing.forStreamer')} <a href="https://twitch.tv/mandymess" target="_blank">@MandyMess</a>.</p>
      </div>
      <footer className="landing-footer">
        <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          Fila DBD
          <span>•</span>
          <span className="footer-lang">
            {t('lang.label')}:{' '}
            {locale === 'en'
              ? <>English / <button className="btn-link" onClick={() => setLocale('pt-BR')}>Português</button></>
              : <><button className="btn-link" onClick={() => setLocale('en')}>English</button> / Português</>
            }
          </span>
        </span>
        <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          {t('landing.helpAndFeedback')}
          <a href="#faq">{t('landing.faq.link')}</a>
          <span>•</span>
          <a href="https://github.com/macecchi/fila-dbd" target="_blank">GitHub</a>
          <span>•</span>
          <a href="https://discord.gg/hXsAgk5KnX" target="_blank">Discord</a>
        </span>
      </footer>
    </div>
  );
}
