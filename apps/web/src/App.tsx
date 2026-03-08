import { useState, useEffect, useRef, useCallback } from 'react';
import { ChatLog } from './components/ChatLog';
import { ChannelHeader } from './components/ChannelHeader';
import { DebugPanel } from './components/DebugPanel';
import { CharacterRequestList } from './components/CharacterRequestList';
import { LandingPage } from './components/LandingPage';
import { ManualEntry } from './components/ManualEntry';
import { MissedRequestsDialog } from './components/MissedRequestsDialog';
import { SourcesBadges } from './components/SourcesBadges';
import { SourcesPanel } from './components/SourcesPanel';
import { Stats } from './components/Stats';
import { ToastContainer } from './components/ToastContainer';
import { identifyCharacter } from './services';
import { recoverMissedRequests } from './services/vod';
import { donateBotName } from './services/twitch';
import { useSettings, useAuth, ChannelProvider, useChannel, useToasts, useLastChannel } from './store';
import { migrateGlobalToChannel } from './utils/migrate';
import type { Request } from './types';

const parseHash = (hash: string) => {
  const parts = hash.replace(/^#\/?/, '').split('/');
  return { channel: parts[0] || null, debug: parts[1] === 'debug' };
};
const getChannelFromHash = (hash: string) => parseHash(hash).channel;
const isDebugMode = () => parseHash(window.location.hash).debug;

function ChannelApp() {
  const { channel, useRequests, useSources, useChannelInfo, canManageChannel } = useChannel();
  const requests = useRequests((s) => s.requests);
  const update = useRequests((s) => s.update);
  const setAll = useRequests((s) => s.setAll);
  const { chatHidden, setChatHidden } = useSettings();
  const { show } = useToasts();
  const sortMode = useSources((s) => s.sortMode);
  const setSortMode = useSources((s) => s.setSortMode);
  const [manualOpen, setManualOpen] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [shownToasts] = useState(() => new Set<number>());
  const isFirstLoad = useRef(true);
  const readOnly = !canManageChannel;

  // Missed requests recovery state
  const ircState = useChannelInfo((s) => s.localIrcConnectionState);
  const partySynced = useChannelInfo((s) => s.partySynced);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState('');
  const [recoveredRequests, setRecoveredRequests] = useState<Request[]>([]);
  const hasTriedRecovery = useRef(false);

  // Trigger recovery when IRC connects
  const recoveryResultRef = useRef<{ vodId: string; lastOffset: number } | null>(null);
  useEffect(() => {
    if (!partySynced || !canManageChannel || hasTriedRecovery.current) return;
    hasTriedRecovery.current = true;

    const sourcesState = useSources.getState();
    const config = {
      botName: donateBotName,
      minDonation: sourcesState.minDonation,
      sourcesEnabled: sourcesState.enabled,
      chatCommand: sourcesState.chatCommand,
      checkpoint: sourcesState.recoveryVodId
        ? { vodId: sourcesState.recoveryVodId, offset: sourcesState.recoveryVodOffset ?? 0 }
        : undefined,
    };

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
  }, [ircState, partySynced, canManageChannel, channel, useSources, useRequests]);

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

    // Filter out any that arrived via IRC during the scan
    const existingIds = new Set(currentRequests.map(r => r.id));
    const existingSigs = new Set(currentRequests.map(r => `${r.donor.toLowerCase()}:${r.message.toLowerCase()}`));
    const deduped = selected.filter(r =>
      !existingIds.has(r.id) && !existingSigs.has(`${r.donor.toLowerCase()}:${r.message.toLowerCase()}`)
    );

    if (deduped.length === 0) {
      setRecoveryOpen(false);
      return;
    }

    const merged = [...currentRequests, ...deduped];
    if (currentSortMode === 'fifo') {
      // Sort all by timestamp for chronological order
      merged.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    } else {
      // Sort by done status, then priority, then timestamp
      merged.sort((a, b) => {
        if (a.done && !b.done) return 1;
        if (!a.done && b.done) return -1;
        const aPri = currentPriority.indexOf(a.source);
        const bPri = currentPriority.indexOf(b.source);
        if (aPri !== bPri) return aPri - bPri;
        return a.timestamp.getTime() - b.timestamp.getTime();
      });
    }

    setAll(merged);
    setRecoveryOpen(false);
    show(
      `${deduped.length} pedido${deduped.length !== 1 ? 's' : ''} recuperado${deduped.length !== 1 ? 's' : ''} da stream`,
      'Pedidos recuperados'
    );
  }, [useRequests, useSources, setAll, show, saveRecoveryCheckpoint]);

  const handleRecoveryClose = useCallback(() => {
    saveRecoveryCheckpoint();
    setRecoveryOpen(false);
  }, [saveRecoveryCheckpoint]);

  // Auto-identify requests that need it (only owner should call extract API)
  useEffect(() => {
    if (readOnly) return;
    const pending = requests.filter(r => r.needsIdentification);
    for (const req of pending) {
      identifyCharacter(
        req,
        undefined,
        (llmResult) => update(req.id, llmResult)
      ).then(result => {
        update(req.id, { ...result, needsIdentification: false });
      });
    }
  }, [requests, update, readOnly]);

  // Handle toasts for ready requests (skip on first load)
  useEffect(() => {
    const ready = requests.filter(r => !shownToasts.has(r.id) && !r.needsIdentification);
    for (const req of ready) {
      shownToasts.add(req.id);
      if (isFirstLoad.current) {
        continue;
      }
      const title = req.source === 'manual' ? 'Novo pedido' :
        req.source === 'donation' ? 'Novo pedido por donate' :
          req.source === 'resub' ? 'Novo pedido por resub' : 'Novo pedido pelo chat';
      const message = req.character
        ? `${req.donor} pediu ${req.character}${req.amount ? ` (${req.amount})` : ''}`
        : `Novo pedido de ${req.donor}${req.amount ? ` (${req.amount})` : ''}`;
      show(message, title);
    }
    if (ready.length > 0) isFirstLoad.current = false;
  }, [requests, show, shownToasts]);

  const pendingCount = requests.filter(d => !d.done).length;

  return (
    <>
      <div className="app">
        <header className="header">
          <a className="brand" href="#/">
            <div className="brand-icon">
              <img src={`${import.meta.env.BASE_URL}images/Dead-by-Daylight-Emblem.webp`} alt="DBD" />
            </div>
            <h1>Fila DBD<span>Fila de pedidos</span></h1>
          </a>
          <Stats />
        </header>

        <ChannelHeader />

        <main className={`grid${chatHidden ? ' chat-hidden' : ''}`}>
          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <img src={`${import.meta.env.BASE_URL}images/IconPlayers.webp`} />
                Fila
                <SourcesBadges />
              </div>
              <div className={readOnly ? 'viewer-mode' : undefined} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => !readOnly && setSortMode(sortMode === 'fifo' ? 'priority' : 'fifo')}
                  title={`${sortMode === 'fifo' ? 'Novos pedidos entram no final' : 'Novos pedidos entram por prioridade de fonte'}. Clique para alternar.`}
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
                  Ordem: {sortMode === 'fifo' ? 'chegada' : 'prioridade'}
                </button>
                <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setManualOpen(true)} title="Adicionar novo pedido" disabled={readOnly}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
                <button className={`btn btn-ghost btn-small btn-small-icon${showDone ? ' active' : ''}`} onClick={() => setShowDone(v => !v)} title={showDone ? 'Esconder feitos' : 'Mostrar feitos'}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    {showDone ? <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /> : <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />}
                    <circle cx="12" cy="12" r="3" style={{ display: showDone ? 'block' : 'none' }} />
                    {!showDone && <line x1="1" y1="1" x2="23" y2="23" />}
                  </svg>
                </button>
                {chatHidden && (
                  <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setChatHidden(false)} title="Mostrar chat">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                    </svg>
                  </button>
                )}
                <span className="panel-count">{pendingCount}</span>
              </div>
            </div>
            <div className="panel-body">
              <CharacterRequestList showDone={showDone} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div className="panel-title">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
                Chat ao Vivo
              </div>
              <button className="btn btn-ghost btn-small btn-small-icon" onClick={() => setChatHidden(true)} title="Esconder chat">
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

        {!readOnly && <SourcesPanel />}
        {(import.meta.env.DEV || isDebugMode()) && <DebugPanel />}

        <footer className="footer">
          <div>Fila DBD</div>
          <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <span>Versão: {__APP_VERSION__}</span>
            <span className="footer-separator">•</span>
            <a href="https://github.com/macecchi/dbd-utils" target="_blank">GitHub</a>
          </span>
        </footer>
      </div>

      <ManualEntry isOpen={manualOpen} onClose={() => setManualOpen(false)} />
      <MissedRequestsDialog
        isOpen={recoveryOpen}
        requests={recoveredRequests}
        isLoading={recoveryLoading}
        loadingStatus={recoveryStatus}
        onConfirm={handleRecoveryConfirm}
        onClose={handleRecoveryClose}
      />
      <ToastContainer />
    </>
  );
}

export function App() {
  const [channel, setChannel] = useState<string | null>(() => {
    migrateGlobalToChannel();

    // Handle OAuth callback
    const success = useAuth.getState().handleCallback();
    if (success) {
      const freshUser = useAuth.getState().user;
      if (freshUser?.login) {
        const ch = freshUser.login.toLowerCase();
        useLastChannel.getState().setLastChannel(ch);
        window.location.hash = `#/${ch}`;
        return ch;
      }
    }

    // Set channel from hash — if none, show landing page
    const hashChannel = getChannelFromHash(window.location.hash);
    if (hashChannel) {
      const ch = hashChannel.toLowerCase();
      useLastChannel.getState().setLastChannel(ch);
      return ch;
    }
    return null;
  });

  // Handle navigation (hashchange + popstate for browser back)
  useEffect(() => {
    const syncChannel = () => {
      const hashChannel = getChannelFromHash(window.location.hash);
      if (hashChannel) {
        const ch = hashChannel.toLowerCase();
        setChannel(ch);
        useLastChannel.getState().setLastChannel(ch);
      } else {
        setChannel(null);
      }
    };
    window.addEventListener('hashchange', syncChannel);
    window.addEventListener('popstate', syncChannel);
    return () => {
      window.removeEventListener('hashchange', syncChannel);
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
