import { useState, useEffect, useLayoutEffect, useRef, useCallback, Suspense } from 'react';
import { ChannelHeader } from './components/ChannelHeader';
import { HeaderMenu } from './components/HeaderMenu';
import { CharacterRequestList } from './components/CharacterRequestList';
import { LandingPage } from './components/LandingPage';
import { ManualEntry } from './components/ManualEntry';
import { SourcesBadges } from './components/SourcesBadges';
import { SettingsPanel } from './components/SettingsPanel';
import { Panel, PanelHeader } from './components/Panel';
import { SyncSweep } from './components/SyncSweep';
import { Toaster } from 'sonner';
import { useWhatsNew } from './hooks/useWhatsNew';
import { identifyCharacter } from './services';
import { eligibleExtras } from './services/extras';
import { tryLocalMatch } from './data/characters';
import type { VODInfo } from './services/vod';
import { DONATE_BOT_NAMES } from './services/twitch';
import { lazyWithReload } from './utils/lazyWithReload';

// Off the first-paint path — each is its own async chunk loaded on demand: the
// debug panel (#debug) and the recovery/review dialogs (on first open).
// lazyWithReload recovers from a stale-deploy chunk 404 by reloading once.
// services/vod is dynamically imported at its call sites below.
const DebugDevTools = lazyWithReload(() => import('./components/DebugDevTools').then((m) => ({ default: m.DebugDevTools })));
const ImportRequestsDialog = lazyWithReload(() => import('./components/ImportRequestsDialog').then((m) => ({ default: m.ImportRequestsDialog })));
const VODSelectionDialog = lazyWithReload(() => import('./components/VODSelectionDialog').then((m) => ({ default: m.VODSelectionDialog })));
const RequestsReviewDialog = lazyWithReload(() => import('./components/RequestsReviewDialog').then((m) => ({ default: m.RequestsReviewDialog })));

// True once `value` has ever been true. Defers mounting a lazy dialog until its
// first open, then keeps it mounted so close/exit transitions still play.
function useEverTrue(value: boolean): boolean {
  const ref = useRef(false);
  if (value) ref.current = true;
  return ref.current;
}
import { toast } from 'sonner';
import { useAuth, ChannelProvider, useChannel, useLastChannel } from './store';
import { navigate, handleLinkClick, scrollToTop, isLikelyTruncatedDonation } from './utils/helpers';
import { sortRequests, mergeRequests } from './utils/requests';
import { useTranslation, t } from './i18n';
import type { Request } from './types';
import type { SourcesStoreApi } from './store/channel';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

const getPathSegments = () => {
  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length)
    : window.location.pathname;
  return path.replace(/^\//, '').split('/');
};

const isAuthCallback = () => {
  const segments = getPathSegments();
  return segments[0] === 'auth' && segments[1] === 'callback';
};

const getChannelFromPath = () => {
  if (isAuthCallback()) return null;
  return getPathSegments()[0] || null;
};

const isDebugMode = () => window.location.hash === '#debug' || window.location.hash === '#debug=true';

function makeSourcesConfig(sourcesState: ReturnType<SourcesStoreApi['getState']>, checkpoint?: { vodId: string; offset: number }) {
  return {
    botNames: DONATE_BOT_NAMES,
    minDonation: sourcesState.minDonation,
    sourcesEnabled: sourcesState.enabled,
    chatCommand: sourcesState.chatCommand,
    extrasConfig: sourcesState.extrasConfig,
    ...(checkpoint && { checkpoint }),
  };
}

function useAutoIdentify(
  requests: Request[],
  update: (id: number, updates: Partial<Request>) => void,
  readOnly: boolean,
  useSources: SourcesStoreApi,
) {
  const inFlight = useRef(new Set<number>());
  useEffect(() => {
    if (readOnly) return;
    const pending = requests.filter(r => r.needsIdentification && !inFlight.current.has(r.id));
    for (const req of pending) {
      inFlight.current.add(req.id);
      const extras = eligibleExtras(req.amountVal, useSources.getState().extrasConfig);
      // LivePix cuts long donor messages at 250 chars in chat, so the request may
      // be in the lost tail. Downgrade the LLM's "no request" verdict to
      // "unidentified" for those donates so they stay visible for manual review
      // instead of being hidden by hideNonRequests.
      const guardTruncated = <T extends { character: string; type: string }>(res: T): T =>
        req.source === 'donation' && res.type === 'none' && isLikelyTruncatedDonation(req.message)
          ? { ...res, type: 'unknown', character: '' }
          : res;
      identifyCharacter(req, extras, undefined, (llmResult) => update(req.id, guardTruncated(llmResult)))
        .then(result => update(req.id, { ...guardTruncated(result), needsIdentification: false }))
        .finally(() => inFlight.current.delete(req.id));
    }
  }, [requests, update, readOnly, useSources]);
}

function useRequestToasts(requests: Request[], update: (id: number, updates: Partial<Request>) => void, hideNonRequests: boolean, readOnly: boolean) {
  const shownToasts = useRef(new Set<number>());
  const isFirstLoad = useRef(true);
  useEffect(() => {
    // `!r.done` matters: the room keeps the newest done requests in sync-full, and a
    // stale localStorage cache can flip `isFirstLoad` before that arrives — without
    // this guard those land as "new request" toasts for something already finished.
    const ready = requests.filter(r => !shownToasts.current.has(r.id) && !r.needsIdentification && !r.done);
    for (const req of ready) {
      shownToasts.current.add(req.id);
      if (isFirstLoad.current || readOnly) continue;
      if (hideNonRequests && req.type === 'none') {
        const msg = req.message.length > 50 ? req.message.slice(0, 50) + '…' : req.message;
        toast(t('toast.ignored', { donor: req.donor, message: msg }), {
          action: { label: t('toast.undo'), onClick: () => update(req.id, { type: 'unknown', character: '' }) },
        });
        continue;
      }
      const activeRequests = requests.filter(r => !r.done && (!hideNonRequests || r.type !== 'none'));
      const index = activeRequests.findIndex(r => r.id === req.id);
      const position = index !== -1 ? index + 1 : undefined;

      const title = req.source === 'manual' ? t('toast.newRequest') :
        req.source === 'donation' ? t('toast.newRequestDonation') :
          req.source === 'resub' ? t('toast.newRequestResub') : t('toast.newRequestChat');
      const titleWithPos = position !== undefined ? `${title} (#${String(position).padStart(2, '0')})` : title;
      const message = req.character
        ? (req.amount ? t('toast.requestedCharAmount', { donor: req.donor, character: req.character, amount: req.amount }) : t('toast.requestedChar', { donor: req.donor, character: req.character }))
        : (req.amount ? t('toast.newRequestFromAmount', { donor: req.donor, amount: req.amount }) : t('toast.newRequestFrom', { donor: req.donor }));
      toast(titleWithPos, { description: message });
    }
    if (ready.length > 0) isFirstLoad.current = false;
  }, [requests, update, hideNonRequests, readOnly]);
}

function ChannelApp() {
  const { t, locale, setLocale } = useTranslation();
  const { channel, useRequests, useSources, useChannelInfo, canEditQueue } = useChannel();
  const requests = useRequests((s) => s.requests);
  const update = useRequests((s) => s.update);
  const setAll = useRequests((s) => s.setAll);
  const [manualOpen, setManualOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const open = () => setReviewOpen(true);
    window.addEventListener('dbd:open-review', open);
    return () => window.removeEventListener('dbd:open-review', open);
  }, []);
  const readOnly = !canEditQueue;

  // Missed requests recovery state
  const ircState = useChannelInfo((s) => s.localIrcConnectionState);
  const partySynced = useChannelInfo((s) => s.partySynced);
  // Work that must happen exactly once (identification, VOD scan) follows the lock,
  // so a second tab can still be a full editor.
  const hasLock = useChannelInfo((s) => s.hasLock);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveredRequests, setRecoveredRequests] = useState<Request[]>([]);
  const hasTriedRecovery = useRef(false);
  const recoveryAbort = useRef<AbortController | null>(null);

  // VOD recovery (past VODs) state
  const [vodSelectOpen, setVodSelectOpen] = useState(false);
  const [vodRecoveryOpen, setVodRecoveryOpen] = useState(false);
  const [vodRecoveryLoading, setVodRecoveryLoading] = useState(false);
  const [vodRecoveryStatus, setVodRecoveryStatus] = useState('');
  const [vodRecoveredRequests, setVodRecoveredRequests] = useState<Request[]>([]);
  const vodRecoveryAbort = useRef<AbortController | null>(null);

  // Trigger recovery when IRC connects
  const recoveryResultRef = useRef<{ vodId: string; lastOffset: number } | null>(null);
  useEffect(() => {
    if (!partySynced || !hasLock || hasTriedRecovery.current) return;
    hasTriedRecovery.current = true;

    const sourcesState = useSources.getState();
    const checkpoint = sourcesState.recoveryVodId
      ? { vodId: sourcesState.recoveryVodId, offset: sourcesState.recoveryVodOffset ?? 0 }
      : undefined;
    const config = makeSourcesConfig(sourcesState, checkpoint);

    setRecoveredRequests([]);
    setRecoveryLoading(true);

    const controller = new AbortController();
    recoveryAbort.current = controller;
    const currentRequests = useRequests.getState().requests;
    console.log('[recovery] starting scan', { channel, config, existingCount: currentRequests.length });
    import('./services/vod')
      .then(({ recoverMissedRequests }) => recoverMissedRequests(channel, config, currentRequests, {
        onProgress: (s) => { console.log('[recovery] progress:', s); setRecoveryStatus(s); },
        onRequest: (req) => {
          console.log('[recovery] found request:', req);
          setRecoveryOpen(true);
          setRecoveredRequests(prev => [...prev, req]);
        },
      }, controller.signal))
      .then((result) => {
        if (controller.signal.aborted) return;
        console.log('[recovery] done', result);
        setRecoveryLoading(false);
        if (!result || result.requests.length === 0) {
          if (result) {
            useSources.getState().setRecoveryCheckpoint(result.vodId, result.lastOffset);
          }
        } else {
          recoveryResultRef.current = { vodId: result.vodId, lastOffset: result.lastOffset };
        }
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error('VOD recovery failed:', err);
        setRecoveryLoading(false);
        toast.error(t('toast.vodRecoveryFailed'));
      });

    return () => controller.abort();
  }, [ircState, partySynced, hasLock, channel]);

  // Reset recovery state when IRC disconnects
  useEffect(() => {
    if (ircState === 'disconnected') {
      hasTriedRecovery.current = false;
      recoveryResultRef.current = null;
    }
  }, [ircState]);

  const saveRecoveryCheckpoint = useCallback(() => {
    if (recoveryResultRef.current) {
      const { vodId, lastOffset } = recoveryResultRef.current;
      useSources.getState().setRecoveryCheckpoint(vodId, lastOffset);
      recoveryResultRef.current = null;
    }
  }, [useSources]);

  const handleRecoveryConfirm = useCallback((selected: Request[]) => {
    saveRecoveryCheckpoint();

    if (selected.length === 0) {
      setRecoveryOpen(false);
      return;
    }

    const currentRequests = useRequests.getState().requests;
    const { sortMode: currentSortMode, priority: currentPriority, prioritizeTiers, prioritizeDonations } = useSources.getState();
    const { merged, added, skipped } = mergeRequests(selected, currentRequests, currentSortMode, currentPriority, prioritizeTiers, prioritizeDonations);

    if (added > 0) {
      setAll(merged);
    }

    setRecoveryOpen(false);
    const parts = [t('toast.added', { count: added })];
    if (skipped > 0) parts.push(t('toast.alreadyInQueue', { count: skipped }));
    toast.success(t('toast.recoveredRequests'), { description: parts.join('\n') });
  }, [useRequests, useSources, setAll, saveRecoveryCheckpoint]);

  // Interrupts the scan but keeps the dialog (and everything found so far) open.
  const handleRecoveryStop = useCallback(() => {
    recoveryAbort.current?.abort();
    recoveryAbort.current = null;
    setRecoveryLoading(false);
  }, []);

  const handleRecoveryClose = useCallback(() => {
    saveRecoveryCheckpoint();
    setRecoveryOpen(false);
  }, [saveRecoveryCheckpoint]);

  const handleVodSelect = useCallback(async (vods: VODInfo[]) => {
    setVodSelectOpen(false);
    setVodRecoveredRequests([]);
    setVodRecoveryLoading(true);
    setVodRecoveryOpen(true);

    const config = makeSourcesConfig(useSources.getState());

    const controller = new AbortController();
    vodRecoveryAbort.current = controller;

    const { scanVODForRequests } = await import('./services/vod');

    try {
      for (const vod of vods) {
        if (controller.signal.aborted) break;
        setVodRecoveryStatus(t('vod.analyzingVod', { title: vod.title || vod.id }));
        await scanVODForRequests(vod.id, vod.createdAt, config, {
          onProgress: (s) => setVodRecoveryStatus(s),
          onRequest: (req) => setVodRecoveredRequests(prev => [...prev, req])
        }, controller.signal);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('VOD scan failed:', err);
        toast.error(t('toast.vodRecoveryFailed'));
      }
    } finally {
      setVodRecoveryLoading(false);
      vodRecoveryAbort.current = null;
    }
  }, [useSources]);


  const handleVodRecoveryConfirm = useCallback((selected: Request[]) => {
    if (selected.length === 0) { setVodRecoveryOpen(false); return; }

    const currentRequests = useRequests.getState().requests;
    const { sortMode: currentSortMode, priority: currentPriority, prioritizeTiers, prioritizeDonations } = useSources.getState();
    const selectedIds = new Set(selected.map(r => r.id));
    const existingIds = new Set(currentRequests.map(r => r.id));
    const newRequests = selected.filter(r => !existingIds.has(r.id));

    // Un-done existing requests that were selected
    const updated = currentRequests.map(r =>
      selectedIds.has(r.id) && r.done ? { ...r, done: false, doneAt: undefined } : r
    );
    const undoneCount = currentRequests.filter(r => selectedIds.has(r.id) && r.done).length;

    if (newRequests.length > 0 || undoneCount > 0) {
      setAll(sortRequests([...updated, ...newRequests], currentSortMode, currentPriority, prioritizeTiers, prioritizeDonations));
    }

    setVodRecoveryOpen(false);
    const skipped = selected.filter(r => existingIds.has(r.id) && !currentRequests.find(c => c.id === r.id && c.done)).length;
    const parts = [t('toast.added', { count: newRequests.length })];
    if (undoneCount > 0) parts.push(t('toast.reactivated', { count: undoneCount }));
    if (skipped > 0) parts.push(t('toast.alreadyInQueue', { count: skipped }));
    toast.success(t('toast.recoveredRequests'), { description: parts.join(' | ') });
  }, [useRequests, useSources, setAll]);

  const handleVodRecoveryStop = useCallback(() => {
    vodRecoveryAbort.current?.abort();
    vodRecoveryAbort.current = null;
    setVodRecoveryLoading(false);
  }, []);

  const handleVodRecoveryClose = useCallback(() => {
    vodRecoveryAbort.current?.abort();
    setVodRecoveryOpen(false);
  }, []);

  const hideNonRequests = useSources((s) => s.hideNonRequests);

  useAutoIdentify(requests, update, !hasLock, useSources);
  useRequestToasts(requests, update, hideNonRequests, readOnly);
  useWhatsNew(canEditQueue);

  const pendingCount = requests.filter(d => !d.done && (!hideNonRequests || d.type !== 'none')).length;

  // Gate each lazy dialog on first-open so its chunk loads then, not at app start.
  const showReview = useEverTrue(reviewOpen);
  const showRecovery = useEverTrue(recoveryOpen);
  const showVodSelect = useEverTrue(vodSelectOpen);
  const showVodRecovery = useEverTrue(vodRecoveryOpen);

  return (
    <>
      <div className="app">
          <header className="header">
            <a className="brand" href="/" onClick={handleLinkClick}>
              <div className="brand-icon">
                <img src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="DBD" />
              </div>
              <h1>{t('app.title')}<span>{t('app.subtitle')}</span></h1>
            </a>
            <HeaderMenu />
          </header>

          <ChannelHeader />

        <main className="grid">
          <Panel as="div" className="panel">
            <PanelHeader
              icon={<img src={`${import.meta.env.BASE_URL}images/IconPlayers.webp`} />}
              indicator={<SyncSweep active={!partySynced} className="panel-header-sync" />}
              actions={
                <div className={readOnly ? 'viewer-mode' : undefined} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setManualOpen(true)} title={t('queue.addRequest')} disabled={readOnly}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5v14M5 12h14" />
                    </svg>
                  </button>
                  <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setReviewOpen(true)} title={t('queue.reviewRequests')} disabled={readOnly || requests.length === 0}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <path d="M3 9h18M9 3v18" />
                    </svg>
                  </button>
                </div>
              }
            >
              {t('queue.title')}
              <span className="panel-title-count">({pendingCount})</span>
              <SourcesBadges />
            </PanelHeader>
            <div className="panel-body">
              <CharacterRequestList />
            </div>
          </Panel>

          {!readOnly && (
            <aside className="sidebar">
              <SettingsPanel onRecover={() => setVodSelectOpen(true)} onReview={() => setReviewOpen(true)} />
            </aside>
          )}
        </main>

        <footer className="footer">
          <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            {t('app.title')}
            <span className="footer-separator">•</span>
            <span className="footer-lang">
              {t('lang.label')}:{' '}
              {locale === 'en'
                ? <>English / <button className="btn-link" onClick={() => setLocale('pt-BR')}>Português</button></>
                : <><button className="btn-link" onClick={() => setLocale('en')}>English</button> / Português</>
              }
            </span>
          </span>
          <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span>{t('app.version', { version: __APP_VERSION__ })}</span>
            <span className="footer-separator">•</span>
            <a href={`${basePath}/#faq`}>{t('landing.faq.link')}</a>
            <span className="footer-separator">•</span>
            <a href="https://github.com/macecchi/fila-dbd" target="_blank">GitHub</a>
            <span className="footer-separator">•</span>
            <a href="https://discord.gg/hXsAgk5KnX" target="_blank">Discord</a>
          </span>
        </footer>
      </div>

      <ManualEntry isOpen={manualOpen} onClose={() => setManualOpen(false)} />

      <Suspense fallback={null}>
        {showReview && (
          <RequestsReviewDialog
            isOpen={reviewOpen}
            requests={requests}
            channel={channel}
            onApply={(edited) => { setAll(edited); setReviewOpen(false); }}
            onClose={() => setReviewOpen(false)}
          />
        )}
        {showRecovery && (
          <ImportRequestsDialog
            isOpen={recoveryOpen}
            requests={recoveredRequests}
            isLoading={recoveryLoading}
            loadingStatus={recoveryStatus}
            onConfirm={handleRecoveryConfirm}
            onClose={handleRecoveryClose}
            onStop={handleRecoveryStop}
          />
        )}
        {showVodSelect && (
          <VODSelectionDialog
            isOpen={vodSelectOpen}
            channel={channel}
            onConfirm={handleVodSelect}
            onClose={() => setVodSelectOpen(false)}
          />
        )}
        {showVodRecovery && (
          <ImportRequestsDialog
            isOpen={vodRecoveryOpen}
            requests={vodRecoveredRequests}
            isLoading={vodRecoveryLoading}
            loadingStatus={vodRecoveryStatus}
            onConfirm={handleVodRecoveryConfirm}
            onClose={handleVodRecoveryClose}
            onStop={handleVodRecoveryStop}
            onBack={() => { handleVodRecoveryClose(); setVodSelectOpen(true); }}
            emptyText={t('import.emptyVod')}
            loadingText={t('import.analyzingVods')}
            doneText={t('import.found')}
          />
        )}
        {(import.meta.env.DEV || isDebugMode()) && <DebugDevTools />}
      </Suspense>
      <Toaster
        theme="dark"
        position="bottom-center"
        closeButton
        toastOptions={{
          style: {
            background: 'rgba(30, 30, 30, 0.9)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
            color: 'var(--text)',
            fontFamily: "'DM Sans', 'DM Sans Fallback', sans-serif",
            fontSize: '0.85rem',
          },
        }}
      />
    </>
  );
}

export function App() {
  const [channel, setChannel] = useState<string | null>(() => {
    // Migrate hash routes to path routes
    if (window.location.hash.startsWith('#/')) {
      const path = window.location.hash.slice(1);
      window.history.replaceState(null, '', path);
    }

    // If handling auth callback, don't set channel yet — useEffect will handle it
    if (isAuthCallback()) return null;

    // Set channel from path — if none, show landing page
    const pathChannel = getChannelFromPath();
    if (pathChannel) {
      const ch = pathChannel.toLowerCase();
      useLastChannel.getState().setLastChannel(ch);
      return ch;
    }
    return null;
  });

  // Handle OAuth callback (async token exchange)
  const [authPending, setAuthPending] = useState(isAuthCallback);
  useEffect(() => {
    if (!isAuthCallback()) return;
    useAuth.getState().handleCallback().then((success) => {
      setAuthPending(false);
      if (success) {
        const freshUser = useAuth.getState().user;
        if (freshUser?.login) {
          const ch = freshUser.login.toLowerCase();
          useLastChannel.getState().setLastChannel(ch);
          navigate(`/${ch}`);
          setChannel(ch);
          return;
        }
      }
      navigate('/');
    });
  }, []);

  // Handle navigation (popstate for browser back/forward + programmatic navigate)
  useEffect(() => {
    const syncChannel = () => {
      const pathChannel = getChannelFromPath();
      if (pathChannel) {
        const ch = pathChannel.toLowerCase();
        setChannel(ch);
        useLastChannel.getState().setLastChannel(ch);
      } else {
        setChannel(null);
      }
    };
    window.addEventListener('popstate', syncChannel);
    return () => {
      window.removeEventListener('popstate', syncChannel);
    };
  }, []);

  // Start at the top on initial load/reload and whenever the channel changes
  // (including back/forward, which doesn't go through navigate()). Runs before
  // paint so there's no jump, and skips when a hash anchor (#faq, #debug) should
  // position the page itself.
  useLayoutEffect(() => {
    if (window.location.hash) return;
    scrollToTop();
  }, [channel]);

  if (authPending) return null;
  if (!channel) return <LandingPage />;

  return (
    <ChannelProvider channel={channel}>
      <ChannelApp />
    </ChannelProvider>
  );
}
