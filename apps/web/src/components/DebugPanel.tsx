import { useState, FormEvent } from 'react';
import { testExtraction, loadAndReplayVOD, cancelVODReplay, identifyCharacter } from '../services';
import type { VODCallbacks } from '../services';
import type { Request } from '../types';
import { loadMockData } from '../data/mock-requests';
import { useChannel, useChat, useToasts, useAuth } from '../store';
import { donateBotName, simulateDisconnect } from '../services/twitch';
import { useTranslation } from '../i18n';

export function DebugPanel() {
  const { useRequests, useSources, canControlConnection } = useChannel();
  const { requests, update, setAll: setRequests, add: addRequest } = useRequests();
  const { clear: clearChat, add: addChat } = useChat();
  const { isAuthenticated } = useAuth();
  const { enabled: sourcesEnabled, chatTiers, chatCommand, minDonation } = useSources();
  const readOnly = !canControlConnection;
  const { show: showToast } = useToasts();
  const { t } = useTranslation();

  const testMessages = ['Trapper', 'Nurse', 'Huntress', 'Wraith', 'Hillbilly'];
  const randomMsg = () => testMessages[Math.floor(Math.random() * testMessages.length)];
  const randomDonor = () => `TestUser${Math.floor(Math.random() * 1000)}`;

  const simulateIRC = (type: 'donation-above' | 'donation-below' | 'resub' | 'chat-sub' | 'chat-nosub') => {
    const msg = randomMsg();
    const donor = randomDonor();
    const before = useRequests.getState().requests.length;

    switch (type) {
      case 'donation-above':
        window.dbdDebug.donate(donor, minDonation + 10, msg);
        break;
      case 'donation-below':
        window.dbdDebug.donate(donor, Math.max(minDonation - 5, 1), msg);
        break;
      case 'resub':
        window.dbdDebug.resub(donor, msg);
        break;
      case 'chat-sub': {
        const tier = chatTiers.length > 0 ? Math.min(...chatTiers) : 1;
        window.dbdDebug.chat(donor, `${chatCommand} ${msg}`, { sub: true, tier });
        break;
      }
      case 'chat-nosub':
        window.dbdDebug.chat(donor, `${chatCommand} ${msg}`, { sub: false });
        break;
    }

    const after = useRequests.getState().requests.length;
    const added = after > before;
    setSimResult({
      text: `<span style="color:${added ? 'var(--green)' : 'var(--text-muted)'}">${type}: ${added ? 'added' : 'filtered'}</span> <span style="color:var(--text-muted)">(${msg})</span>`,
      show: true
    });
  };

  const [input, setInput] = useState('');
  const [addToQueue, setAddToQueue] = useState(true);
  const [result, setResult] = useState<{ text: string; show: boolean }>({ text: '', show: false });
  const [simResult, setSimResult] = useState<{ text: string; show: boolean }>({ text: '', show: false });
  const [vodId, setVodId] = useState('');
  const [speed, setSpeed] = useState(0);
  const [vodStatus, setVodStatus] = useState('');
  const [isReplaying, setIsReplaying] = useState(false);

  const vodConfig = { botName: donateBotName, minDonation, sourcesEnabled };

  const handleTest = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    const requestId = Date.now();
    const message = input;

    // Add to queue immediately if enabled
    if (addToQueue) {
      const request: Request = {
        id: requestId,
        timestamp: new Date(),
        donor: 'Teste',
        amount: 'R$ 0,00',
        amountVal: 0,
        message,
        character: 'Identificando...',
        type: 'unknown',
        source: 'manual',
        needsIdentification: true
      };
      addRequest(request);
      setInput('');
    }

    setResult({ text: t('card.identifying'), show: true });

    const formatResult = (res: { character: string; type: string }, isLocal: boolean, llmSuffix = '') => {
      const prefix = isLocal ? '[local]' : '[IA]';
      const color = res.type === 'survivor' ? 'var(--blue)' : res.type === 'killer' ? 'var(--red)' : 'var(--text-muted)';
      const display = res.character || res.type;
      return `<span style="color:var(--text-muted)">${prefix}</span> <span style="color:${color}">${res.type}</span> → <strong>${display}</strong>${llmSuffix}`;
    };

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
        if (addToQueue && isDiff) {
          update(requestId, { character: llmRes.character, type: llmRes.type, needsIdentification: false });
        }
      }
    );

    // Update the request with identification result
    if (addToQueue) {
      update(requestId, { character: res.character || '', type: res.type, needsIdentification: false });
    }

    // Only show "validando" for ambiguous local matches that will get AI validation
    const showValidating = res.isLocal && res.ambiguous && isAuthenticated;
    setResult({ text: formatResult(res, res.isLocal, showValidating ? ' <span style="color:var(--text-muted)">⏳ validando...</span>' : ''), show: true });
  };

  const handleReidentifyAll = async () => {
    for (const d of requests) {
      update(d.id, { character: 'Identificando...', type: 'unknown' });
    }
    for (const d of requests) {
      const result = await identifyCharacter(d, (msg) => showToast(msg, t('debug.errorLlm'), 'red'));
      update(d.id, result);
    }
  };

  const handleClearAll = () => {
    setRequests([]);
    clearChat();
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
      onChat: addChat,
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
    <section className="settings open">
      <div className="settings-header">
        <span className="settings-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          {t('debug.title')}
        </span>
      </div>
      <div className="settings-body">
        <form className="debug-row" onSubmit={handleTest}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder={t('debug.testPlaceholder')}
          />
          {!readOnly && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={addToQueue} onChange={e => setAddToQueue(e.target.checked)} />
              {t('debug.addToQueue')}
            </label>
          )}
          <button className="btn btn-ghost" type="submit">{t('debug.test')}</button>
        </form>
        {result.show && (
          <div className="debug-result show" dangerouslySetInnerHTML={{ __html: result.text }} />
        )}
        {!readOnly && (
          <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem' }}>{t('debug.simulateRequest')}</div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button className="btn btn-ghost" onClick={() => simulateIRC('donation-above')}>
                {t('debug.donateAbove')}
              </button>
              <button className="btn btn-ghost" onClick={() => simulateIRC('donation-below')}>
                {t('debug.donateBelow')}
              </button>
              <button className="btn btn-ghost" onClick={() => simulateIRC('resub')}>
                {t('debug.resub')}
              </button>
              <button className="btn btn-ghost" onClick={() => simulateIRC('chat-sub')}>
                {t('debug.chatSub')}
              </button>
              <button className="btn btn-ghost" onClick={() => simulateIRC('chat-nosub')}>
                {t('debug.chatNoSub')}
              </button>
            </div>
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
    </section>
  );
}
