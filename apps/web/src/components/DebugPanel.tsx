import { useState, FormEvent } from 'react';
import { testExtraction, loadAndReplayVOD, cancelVODReplay, identifyMultiple } from '../services';
import { eligibleExtras } from '../services/extras';
import type { VODCallbacks } from '../services';
import type { Request } from '../types';
import { loadMockData } from '../data/mock-requests';
import { CHARACTERS } from '../data/characters';
import { toast } from 'sonner';
import { useChannel, useAuth } from '../store';
import { DONATE_BOT_NAMES, simulateDisconnect } from '../services/twitch';
import { useTranslation } from '../i18n';
import { Panel, PanelHeader } from './Panel';

export function DebugPanel() {
  const { useRequests, useSources, canEditQueue } = useChannel();
  const { requests, update, setAll: setRequests, add: addRequest } = useRequests();
  const { isAuthenticated } = useAuth();
  const { enabled: sourcesEnabled, chatTiers, chatCommand, minDonation, extrasConfig } = useSources();
  const readOnly = !canEditQueue;
  const showToast = (msg: string, title: string, _color?: string) => toast.error(title, { description: msg });
  const { t } = useTranslation();

  const allNames = CHARACTERS.killers.map(c => c.name);
  const randomMsg = () => allNames[Math.floor(Math.random() * allNames.length)];
  const randomDonor = () => `TestUser${Math.floor(Math.random() * 1000)}`;

  const [simSource, setSimSource] = useState<'donation' | 'chat' | 'resub'>('donation');
  const [simMessage, setSimMessage] = useState(() => randomMsg());
  const [simAmount, setSimAmount] = useState(() => minDonation + 10);
  const [simSub, setSimSub] = useState(true);
  const [simTier, setSimTier] = useState<number>(1);

  const runSimulation = () => {
    const before = useRequests.getState().requests.length;
    const msg = simMessage.trim();
    const donor = randomDonor();

    switch (simSource) {
      case 'donation':
        window.dbdDebug.donate(donor, simAmount, msg);
        break;
      case 'chat': {
        const text = msg.startsWith(chatCommand) ? msg : `${chatCommand} ${msg}`;
        window.dbdDebug.chat(donor, text, { sub: simSub, tier: simTier });
        break;
      }
      case 'resub':
        window.dbdDebug.resub(donor, msg, { tier: simTier });
        break;
    }

    const showResult = (added: boolean) => setSimResult({
      text: `<span style="color:${added ? 'var(--green)' : 'var(--text-muted)'}">${simSource}: ${added ? 'added' : 'filtered'}</span> <span style="color:var(--text-muted)">(${msg})</span>`,
      show: true
    });

    // Store updates async (server roundtrip), so wait briefly for the echo
    const unsub = useRequests.subscribe((s) => {
      if (s.requests.length > before) {
        showResult(true);
        unsub();
        clearTimeout(timer);
      }
    });
    const timer = setTimeout(() => { unsub(); showResult(false); }, 2000);
  };

  const [result, setResult] = useState<{ text: string; show: boolean }>({ text: '', show: false });
  const [simResult, setSimResult] = useState<{ text: string; show: boolean }>({ text: '', show: false });
  const [vodId, setVodId] = useState('');
  const [speed, setSpeed] = useState(0);
  const [vodStatus, setVodStatus] = useState('');
  const [isReplaying, setIsReplaying] = useState(false);

  const vodConfig = { botNames: DONATE_BOT_NAMES, minDonation, sourcesEnabled, extrasConfig };

  const handleTest = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!simMessage.trim()) return;

    const message = simMessage;

    setResult({ text: t('card.identifying'), show: true });

    const formatResult = (res: { character: string; type: string }, isLocal: boolean, llmSuffix = '') => {
      const prefix = isLocal ? '[local]' : '[IA]';
      const color = res.type === 'survivor' ? 'var(--blue)' : res.type === 'killer' ? 'var(--red)' : 'var(--text-muted)';
      const display = res.character || res.type;
      return `<span style="color:var(--text-muted)">${prefix}</span> <span style="color:${color}">${res.type}</span> → <strong>${display}</strong>${llmSuffix}`;
    };

    // Diagnostic only: shows local vs LLM extraction inline. Nothing is added to the queue —
    // use "Send simulated event" for that.
    const res = await testExtraction(
      message,
      (msg) => showToast(msg, t('debug.errorLlm'), 'red'),
      (llmRes) => {
        const isDiff = llmRes.character !== res.character;
        const llmColor = llmRes.type === 'survivor' ? 'var(--blue)' : llmRes.type === 'killer' ? 'var(--red)' : 'var(--text-muted)';
        const llmSuffix = isDiff
          ? ` <span style="color:var(--text-muted)">→ [IA]</span> <span style="color:${llmColor}">${llmRes.type}</span> → <strong>${llmRes.character}</strong>`
          : ' <span style="color:var(--green)">✓ IA confirmou</span>';
        setResult({ text: formatResult(res, res.isLocal, llmSuffix), show: true });
      }
    );

    // Only show "validando" for ambiguous local matches that will get AI validation
    const showValidating = res.isLocal && res.ambiguous && isAuthenticated;
    setResult({ text: formatResult(res, res.isLocal, showValidating ? ' <span style="color:var(--text-muted)">⏳ validando...</span>' : ''), show: true });
  };

  const handleReidentifyAll = async () => {
    for (const d of requests) {
      update(d.id, { character: 'Identificando...', type: 'unknown' });
    }
    for (const d of requests) {
      const extras = eligibleExtras(d.amountVal, useSources.getState().extrasConfig);
      const arr = await identifyMultiple(d.message, 1, extras, (msg) => showToast(msg, t('debug.errorLlm'), 'red'));
      const c = arr[0] ?? { character: '', type: 'unknown' as const };
      update(d.id, { character: c.character, type: c.type, matchedTerm: c.matchedTerm, extras: c.extras });
    }
  };

  const handleClearAll = () => {
    setRequests([]);
  };

  const handleLoadMock = () => {
    loadMockData((fn) => {
      const newRequests = fn([]);
      setRequests(newRequests);
    });
  };

  const handleVODReplay = async () => {
    if (isReplaying) {
      cancelVODReplay();
      setIsReplaying(false);
      setVodStatus('Cancelled');
      return;
    }

    if (!vodId.trim()) return;

    setIsReplaying(true);
    setVodStatus('Fetching...');

    const callbacks: VODCallbacks = {
      onStatus: setVodStatus,
      onRequest: addRequest
    };

    try {
      await loadAndReplayVOD(vodId, speed, vodConfig, callbacks);
    } catch (e: any) {
      setVodStatus(`Error: ${e.message}`);
    }

    setIsReplaying(false);
  };

  return (
    <Panel className="settings">
      <PanelHeader
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m8 2 1.88 1.88" />
            <path d="M14.12 3.88 16 2" />
            <path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1" />
            <path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6" />
            <path d="M12 20v-9" />
            <path d="M6.53 9C4.6 8.8 3 7.1 3 5" />
            <path d="M6 13H2" />
            <path d="M3 21c0-2.1 1.7-3.9 3.8-4" />
            <path d="M20.97 5c0 2.1-1.6 3.8-3.5 4" />
            <path d="M22 13h-4" />
            <path d="M17.2 17c2.1.1 3.8 1.9 3.8 4" />
          </svg>
        }
      >
        {t('debug.title')}
      </PanelHeader>
      <div className="settings-body">
        {!readOnly && (
          <div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>{t('debug.simulateRequest')}</div>

            <div className="segmented" role="tablist" style={{ marginBottom: '0.75rem', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <button
                type="button"
                role="tab"
                aria-selected={simSource === 'donation'}
                className={`segmented-option ${simSource === 'donation' ? 'active' : ''}`}
                onClick={() => setSimSource('donation')}
              >
                {t('sources.donation')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={simSource === 'chat'}
                className={`segmented-option ${simSource === 'chat' ? 'active' : ''}`}
                onClick={() => setSimSource('chat')}
              >
                {t('sources.chat')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={simSource === 'resub'}
                className={`segmented-option ${simSource === 'resub' ? 'active' : ''}`}
                onClick={() => setSimSource('resub')}
              >
                {t('sources.resub')}
              </button>
            </div>

            {/* Consolidated Message Input */}
            <form style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '0.75rem' }} onSubmit={handleTest}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label htmlFor="sim-msg" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('debug.simMessage')}</label>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: '2px 6px', fontSize: '0.7rem', minHeight: 'unset', height: 'auto' }}
                  onClick={() => setSimMessage(randomMsg())}
                >
                  🎲 {t('debug.randomize')}
                </button>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input
                  id="sim-msg"
                  type="text"
                  value={simMessage}
                  onChange={e => setSimMessage(e.target.value)}
                  placeholder={t('debug.testPlaceholder')}
                  style={{ flex: 1 }}
                />
                <button className="btn btn-ghost" type="submit">{t('debug.test')}</button>
              </div>
            </form>

            {result.show && (
              <div className="debug-result show" style={{ marginBottom: '1rem' }} dangerouslySetInnerHTML={{ __html: result.text }} />
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '0.75rem' }}>
              {/* Source-specific controls */}
              {simSource === 'donation' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                  <label htmlFor="sim-amt" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('debug.simAmount')}</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      id="sim-amt"
                      type="number"
                      value={simAmount}
                      onChange={e => setSimAmount(parseFloat(e.target.value) || 0)}
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '0 8px', fontSize: '0.75rem', minHeight: 'unset' }}
                      onClick={() => setSimAmount(minDonation + 10)}
                    >
                      &ge; Min
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ padding: '0 8px', fontSize: '0.75rem', minHeight: 'unset' }}
                      onClick={() => setSimAmount(Math.max(minDonation - 5, 1))}
                    >
                      &lt; Min
                    </button>
                  </div>
                </div>
              )}

              {simSource === 'chat' && (
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                    <input type="checkbox" checked={simSub} onChange={e => setSimSub(e.target.checked)} />
                    {t('debug.simSub')}
                  </label>
                  {simSub && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('debug.simTier')}</span>
                      <select
                        value={simTier}
                        onChange={e => setSimTier(Number(e.target.value))}
                        style={{ padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                      >
                        <option value={1}>Tier 1 / Prime</option>
                        <option value={2}>Tier 2</option>
                        <option value={3}>Tier 3</option>
                      </select>
                    </div>
                  )}
                </div>
              )}

              {simSource === 'resub' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('debug.simTier')}</span>
                  <select
                    value={simTier}
                    onChange={e => setSimTier(Number(e.target.value))}
                    style={{ padding: '4px 8px', borderRadius: '4px', background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  >
                    <option value={1}>Tier 1 / Prime</option>
                    <option value={2}>Tier 2</option>
                    <option value={3}>Tier 3</option>
                  </select>
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn btn-ghost"
              style={{ width: '100%', border: '1px solid var(--text-muted)' }}
              onClick={runSimulation}
            >
              {t('debug.simSend')}
            </button>

            {simResult.show && (
              <div className="debug-result show" style={{ marginTop: '0.5rem' }} dangerouslySetInnerHTML={{ __html: simResult.text }} />
            )}
          </div>
        )}
        {!readOnly && (
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" onClick={handleReidentifyAll}>
              {t('debug.reidentifyAll')}
            </button>
            <button className="btn btn-ghost" onClick={handleClearAll}>
              {t('debug.clearAll')}
            </button>
            <button className="btn btn-ghost" onClick={() => useSources.getState().setRecoveryCheckpoint('', 0)}>
              {t('debug.resetRecovery')}
            </button>
            <button className="btn btn-ghost" onClick={handleLoadMock}>
              {t('debug.loadMock')}
            </button>
            <button className="btn btn-ghost" onClick={() => simulateDisconnect()}>
              {t('debug.simulateDisconnect')}
            </button>
            <button className="btn btn-ghost" onClick={() => setTimeout(() => simulateDisconnect(true), 3000)}>
              {t('debug.simulatePermDisconnect')}
            </button>
          </div>
        )}
        {!readOnly && (
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('debug.vodReplay')}</div>
            <div className="debug-row">
              <input
                type="text"
                value={vodId}
                onChange={e => setVodId(e.target.value)}
                placeholder={t('debug.vodPlaceholder')}
              />
              <select value={speed} onChange={e => setSpeed(Number(e.target.value))} style={{ width: '100px' }}>
                <option value={0}>Instant</option>
                <option value={100}>10x</option>
                <option value={200}>5x</option>
                <option value={1000}>1x</option>
              </select>
              <button className="btn btn-ghost" type="button" onClick={handleVODReplay}>
                {isReplaying ? t('debug.stop') : t('debug.replay')}
              </button>
            </div>
            {vodStatus && <div className="debug-result show">{vodStatus}</div>}
          </div>
        )}
      </div>
    </Panel>
  );
}
