import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatLog } from './components/ChatLog';
import { ChannelHeader } from './components/ChannelHeader';
import { DebugPanel } from './components/DebugPanel';
import { CharacterRequestList } from './components/CharacterRequestList';
import { LandingPage } from './components/LandingPage';
import { ManualEntry } from './components/ManualEntry';
import { ImportRequestsDialog } from './components/ImportRequestsDialog';
import { VODSelectionDialog } from './components/VODSelectionDialog';
import { RequestsReviewDialog } from './components/RequestsReviewDialog';
import { SourcesBadges } from './components/SourcesBadges';
import { SourcesPanel } from './components/SourcesPanel';
import { Stats } from './components/Stats';
import { ToastContainer } from './components/ToastContainer';
import { identifyCharacter } from './services';
import { recoverMissedRequests, scanVODForRequests, type VODInfo } from './services/vod';
import { donateBotName } from './services/twitch';
import { useSettings, useAuth, ChannelProvider, useChannel, useToasts, useLastChannel } from './store';
import { navigate, handleLinkClick } from './utils/helpers';
import { sortRequests, mergeRequests } from './utils/requests';
import { useTranslation, t } from './i18n';
import type { Request } from './types';
import type { SourcesStoreApi } from './store/channel';

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

const getChannelFromPath = () => {
  const path = window.location.pathname.startsWith(basePath)
    ? window.location.pathname.slice(basePath.length)
    : window.location.pathname;
  return path.replace(/^\//, '').split('/')[0] || null;
};
const isDebugMode = () => window.location.hash === '#debug' || window.location.hash === '#debug=true';

function makeSourcesConfig(sourcesState: ReturnType<SourcesStoreApi['getState']>, checkpoint?: { vodId: string; offset: number }) {
  return {
    botName: donateBotName,
    minDonation: sourcesState.minDonation,
    sourcesEnabled: sourcesState.enabled,
    chatCommand: sourcesState.chatCommand,
    ...(checkpoint && { checkpoint }),
  };
}

function useAutoIdentify(requests: Request[], update: (id: number, updates: Partial<Request>) => void, readOnly: boolean) {
  const inFlight = useRef(new Set<number>());
  useEffect(() => {
    if (readOnly) return;
    const pending = requests.filter(r => r.needsIdentification && !inFlight.current.has(r.id));
    for (const req of pending) {
      inFlight.current.add(req.id);
      identifyCharacter(req, undefined, (llmResult) => update(req.id, llmResult))
        .then(result => update(req.id, { ...result, needsIdentification: false }))
        .finally(() => inFlight.current.delete(req.id));
    }
  }, [requests, update, readOnly]);
}

function useRequestToasts(requests: Request[], update: (id: number, updates: Partial<Request>) => void, hideNonRequests: boolean) {
  const { show, showUndo } = useToasts();
  const shownToasts = useRef(new Set<number>());
  const isFirstLoad = useRef(true);
  useEffect(() => {
    const ready = requests.filter(r => !shownToasts.current.has(r.id) && !r.needsIdentification);
    for (const req of ready) {
      shownToasts.current.add(req.id);
      if (isFirstLoad.current) continue;
      if (hideNonRequests && req.type === 'none') {
        const msg = req.message.length > 50 ? req.message.slice(0, 50) + '…' : req.message;
        showUndo(
          t('toast.ignored', { donor: req.donor, message: msg }),
          () => update(req.id, { type: 'unknown', character: '' })
        );
        continue;
      }
      const title = req.source === 'manual' ? t('toast.newRequest') :
        req.source === 'donation' ? t('toast.newRequestDonation') :
          req.source === 'resub' ? t('toast.newRequestResub') : t('toast.newRequestChat');
      const message = req.character
        ? (req.amount ? t('toast.requestedCharAmount', { donor: req.donor, character: req.character, amount: req.amount }) : t('toast.requestedChar', { donor: req.donor, character: req.character }))
        : (req.amount ? t('toast.newRequestFromAmount', { donor: req.donor, amount: req.amount }) : t('toast.newRequestFrom', { donor: req.donor }));
      show(message, title);
    }
    if (ready.length > 0) isFirstLoad.current = false;
  }, [requests, show, showUndo, update, hideNonRequests]);
}

function ChannelApp() {
  const { t } = useTranslation();
  const { channel, useRequests, useSources, useChannelInfo, canControlConnection } = useChannel();
  const requests = useRequests((s) => s.requests);
  const update = useRequests((s) => s.update);
  const setAll = useRequests((s) => s.setAll);
  const { chatHidden, setChatHidden } = useSettings();
  const { show } = useToasts();
  const sortMode = useSources((s) => s.sortMode);
  const setSortMode = useSources((s) => s.setSortMode);
  const [manualOpen, setManualOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);

  useEffect(() => {
    const open = () => setReviewOpen(true);
    window.addEventListener('dbd:open-review', open);
    return () => window.removeEventListener('dbd:open-review', open);
  }, []);
  const readOnly = !canControlConnection;

  // Missed requests recovery state
  const ircState = useChannelInfo((s) => s.localIrcConnectionState);
  const partySynced = useChannelInfo((s) => s.partySynced);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveredRequests, setRecoveredRequests] = useState<Request[]>([]);
  const hasTriedRecovery = useRef(false);

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
    if (!partySynced || !canControlConnection || hasTriedRecovery.current) return;
    hasTriedRecovery.current = true;

    const sourcesState = useSources.getState();
    const checkpoint = sourcesState.recoveryVodId
      ? { vodId: sourcesState.recoveryVodId, offset: sourcesState.recoveryVodOffset ?? 0 }
      : undefined;
    const config = makeSourcesConfig(sourcesState, checkpoint);

    setRecoveredRequests([]);
    setRecoveryLoading(true);

    const controller = new AbortController();
    const currentRequests = useRequests.getState().requests;
    console.log('[recovery] starting scan', { channel, config, existingCount: currentRequests.length });
    recoverMissedRequests(channel, config, currentRequests, {
      onProgress: (s) => { console.log('[recovery] progress:', s); setRecoveryStatus(s); },
      onRequest: (req) => {
        console.log('[recovery] found request:', req);
        setRecoveryOpen(true);
        setRecoveredRequests(prev => [...prev, req]);
      },
    }, controller.signal)
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
      });

    return () => controller.abort();
  }, [ircState, partySynced, canControlConnection, channel]);

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
    const { sortMode: currentSortMode, priority: currentPriority } = useSources.getState();
    const { merged, added, skipped } = mergeRequests(selected, currentRequests, currentSortMode, currentPriority);

    if (added > 0) {
      setAll(merged);
    }

    setRecoveryOpen(false);
    const parts = [t('toast.added', { count: added })];
    if (skipped > 0) parts.push(t('toast.alreadyInQueue', { count: skipped }));
    show(parts.join('\n'), t('toast.recoveredRequests'));
  }, [useRequests, useSources, setAll, show, saveRecoveryCheckpoint]);

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
      if (!controller.signal.aborted) console.error('VOD scan failed:', err);
    } finally {
      setVodRecoveryLoading(false);
      vodRecoveryAbort.current = null;
    }
  }, [useSources]);


  const handleVodRecoveryConfirm = useCallback((selected: Request[]) => {
    if (selected.length === 0) { setVodRecoveryOpen(false); return; }

    const currentRequests = useRequests.getState().requests;
    const { sortMode: currentSortMode, priority: currentPriority } = useSources.getState();
    const selectedIds = new Set(selected.map(r => r.id));
    const existingIds = new Set(currentRequests.map(r => r.id));
    const newRequests = selected.filter(r => !existingIds.has(r.id));

    // Un-done existing requests that were selected
    const updated = currentRequests.map(r =>
      selectedIds.has(r.id) && r.done ? { ...r, done: false, doneAt: undefined } : r
    );
    const undoneCount = currentRequests.filter(r => selectedIds.has(r.id) && r.done).length;

    if (newRequests.length > 0 || undoneCount > 0) {
      setAll(sortRequests([...updated, ...newRequests], currentSortMode, currentPriority));
    }

    setVodRecoveryOpen(false);
    const skipped = selected.filter(r => existingIds.has(r.id) && !currentRequests.find(c => c.id === r.id && c.done)).length;
    const parts = [t('toast.added', { count: newRequests.length })];
    if (undoneCount > 0) parts.push(t('toast.reactivated', { count: undoneCount }));
    if (skipped > 0) parts.push(t('toast.alreadyInQueue', { count: skipped }));
    show(parts.join(' | '), t('toast.recoveredRequests'));
  }, [useRequests, useSources, setAll, show]);

  const handleVodRecoveryClose = useCallback(() => {
    vodRecoveryAbort.current?.abort();
    setVodRecoveryOpen(false);
  }, []);

  const hideNonRequests = useSources((s) => s.hideNonRequests);

  useAutoIdentify(requests, update, readOnly);
  useRequestToasts(requests, update, hideNonRequests);

  const pendingCount = requests.filter(d => !d.done && (!hideNonRequests || d.type !== 'none')).length;

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
          <Stats />
        </header>

        <ChannelHeader />

        <main className={`grid${chatHidden ? ' chat-hidden' : ''}`}>
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <img src={`${import.meta.env.BASE_URL}images/IconPlayers.webp`} />
                {t('queue.title')}
                <SourcesBadges />
              </div>
              <div className={readOnly ? 'viewer-mode' : undefined} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => !readOnly && setSortMode(sortMode === 'fifo' ? 'priority' : 'fifo')}
                  title={sortMode === 'fifo' ? t('queue.sortFifoTooltip') : t('queue.sortPriorityTooltip')}
                  disabled={readOnly}
                >
                  {sortMode === 'fifo' ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 5v14M5 12l7 7 7-7" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M3 6h18M3 12h12M3 18h6" />
                    </svg>
                  )}
                  {t('queue.sortLabel', { mode: sortMode === 'fifo' ? t('queue.sortFifo') : t('queue.sortPriority') })}
                </button>
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
                {chatHidden && (
                  <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setChatHidden(false)} title={t('queue.showChat')}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                  </button>
                )}
                <span className="panel-count">{pendingCount}</span>
              </div>
            </div>
            <div className="panel-body">
              <CharacterRequestList />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
                {t('queue.liveChat')}
              </div>
              <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setChatHidden(true)} title={t('queue.hideChat')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <div className="panel-body chat-body">
              <ChatLog />
            </div>
          </div>
        </main>

        {!readOnly && <SourcesPanel onRecover={() => setVodSelectOpen(true)} onReview={() => setReviewOpen(true)} />}
        {(import.meta.env.DEV || isDebugMode()) && <DebugPanel />}

        <footer className="footer">
          <div>{t('app.title')}</div>
          <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span>{t('app.version', { version: __APP_VERSION__ })}</span>
            <span className="footer-separator">•</span>
            <a href="https://github.com/macecchi/dbd-utils" target="_blank">GitHub</a>
            <span className="footer-separator">•</span>
            <a href="https://discord.gg/6pY7Efhxd" target="_blank">Discord</a>
          </span>
        </footer>
      </div>

      <ManualEntry isOpen={manualOpen} onClose={() => setManualOpen(false)} />
      <RequestsReviewDialog
        isOpen={reviewOpen}
        requests={requests}
        channel={channel}
        onApply={(edited) => { setAll(edited); setReviewOpen(false); }}
        onClose={() => setReviewOpen(false)}
      />
      <ImportRequestsDialog
        isOpen={recoveryOpen}
        requests={recoveredRequests}
        isLoading={recoveryLoading}
        loadingStatus={recoveryStatus}
        onConfirm={handleRecoveryConfirm}
        onClose={handleRecoveryClose}
      />
      <VODSelectionDialog
        isOpen={vodSelectOpen}
        channel={channel}
        onConfirm={handleVodSelect}
        onClose={() => setVodSelectOpen(false)}
      />
      <ImportRequestsDialog
        isOpen={vodRecoveryOpen}
        requests={vodRecoveredRequests}
        isLoading={vodRecoveryLoading}
        loadingStatus={vodRecoveryStatus}
        onConfirm={handleVodRecoveryConfirm}
        onClose={handleVodRecoveryClose}
        onBack={() => { handleVodRecoveryClose(); setVodSelectOpen(true); }}
        emptyText={t('import.emptyVod')}
        loadingText={t('import.analyzingVods')}
        doneText={t('import.found')}
      />
      <ToastContainer />
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

    // Handle OAuth callback
    const success = useAuth.getState().handleCallback();
    if (success) {
      const freshUser = useAuth.getState().user;
      if (freshUser?.login) {
        const ch = freshUser.login.toLowerCase();
        useLastChannel.getState().setLastChannel(ch);
        navigate(`/${ch}`);
        return ch;
      }
    }

    // Set channel from path — if none, show landing page
    const pathChannel = getChannelFromPath();
    if (pathChannel) {
      const ch = pathChannel.toLowerCase();
      useLastChannel.getState().setLastChannel(ch);
      return ch;
    }
    return null;
  });

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

  if (!channel) return <LandingPage />;

  return (
    <ChannelProvider channel={channel}>
      <ChannelApp />
    </ChannelProvider>
  );
}
