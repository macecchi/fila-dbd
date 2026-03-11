import { useState, useMemo, useCallback } from 'react';
import type { Request } from '../types';
import { CharacterAvatar } from './CharacterAvatar';
import { getKillerPortrait } from '../data/characters';

interface Props {
  isOpen: boolean;
  requests: Request[];
  onApply: (requests: Request[]) => void;
  onClose: () => void;
}

type Tab = 'current' | 'changes';

const SOURCE_LABELS: Record<string, string> = {
  donation: 'Donate',
  chat: 'Chat',
  resub: 'Resub',
  manual: 'Manual',
};

function formatSourceBadge(source: string, amount: string): string {
  const label = SOURCE_LABELS[source] ?? source;
  if (source === 'donation' && amount) return amount;
  return label;
}

const TIME_FMT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };

export function RequestsReviewDialog({ isOpen, requests, onApply, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('current');
  const [edits, setEdits] = useState<Map<number, Partial<Request>>>(new Map);

  // Reset edits when dialog opens/closes
  const handleClose = useCallback(() => {
    setEdits(new Map());
    setTab('current');
    onClose();
  }, [onClose]);

  // Build the "after" snapshot
  const editedRequests = useMemo(() =>
    requests.map(r => {
      const edit = edits.get(r.id);
      return edit ? { ...r, ...edit } : r;
    }),
    [requests, edits],
  );

  const changedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, edit] of edits) {
      const orig = requests.find(r => r.id === id);
      if (!orig) continue;
      if (edit.done !== undefined && edit.done !== orig.done) ids.add(id);
    }
    return ids;
  }, [requests, edits]);

  const toggleDone = useCallback((id: number) => {
    setEdits(prev => {
      const next = new Map(prev);
      const orig = requests.find(r => r.id === id);
      if (!orig) return prev;
      const current = next.get(id);
      const currentDone = current?.done !== undefined ? current.done : orig.done;
      const newDone = !currentDone;
      // If we're reverting to original, remove the edit
      if (newDone === !!orig.done) {
        next.delete(id);
      } else {
        next.set(id, { ...current, done: newDone, doneAt: newDone ? new Date() : undefined });
      }
      return next;
    });
  }, [requests]);

  const handleApply = useCallback(() => {
    if (changedIds.size === 0) return;
    onApply(editedRequests);
    setEdits(new Map());
    setTab('current');
  }, [editedRequests, changedIds, onApply]);

  const undoneCount = useMemo(() => editedRequests.filter(r => !r.done).length, [editedRequests]);

  const markAllDone = useCallback(() => {
    setEdits(prev => {
      const next = new Map(prev);
      for (const r of requests) {
        if (r.done) continue;
        const current = next.get(r.id);
        const currentDone = current?.done !== undefined ? current.done : false;
        if (!currentDone) {
          next.set(r.id, { ...current, done: true, doneAt: new Date() });
        }
      }
      return next;
    });
  }, [requests]);

  if (!isOpen) return null;

  const changesTab = tab === 'changes';
  const displayRequests = changesTab
    ? editedRequests.filter(r => changedIds.has(r.id))
    : editedRequests;

  return (
    <div className="missed-requests-overlay" onClick={handleClose}>
      <div className="review-dialog" onClick={e => e.stopPropagation()}>
        <div className="missed-requests-header">
          <div className="missed-requests-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 3v18" />
            </svg>
            Revisar pedidos
          </div>
          <button className="modal-close" onClick={handleClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <p className="dialog-help-text">Visualize e altere o status dos pedidos. Marque um pedido como feito ou adicione de volta à fila. Revise as alterações na aba "Alterações" e aplique quando estiver pronto.</p>

        <div className="review-tabs">
          <button
            className={`review-tab${tab === 'current' ? ' active' : ''}`}
            onClick={() => setTab('current')}
          >
            Todos ({requests.length})
          </button>
          <button
            className={`review-tab${tab === 'changes' ? ' active' : ''}`}
            onClick={() => setTab('changes')}
          >
            Alterações {changedIds.size > 0 && <span className="review-tab-badge">{changedIds.size}</span>}
          </button>
        </div>

        <div className="review-table-wrap">
          {displayRequests.length === 0 ? (
            <div className="missed-requests-empty">
              <span>{changesTab ? 'Nenhuma alteração ainda. Mude o status na aba "Todos".' : 'Nenhum pedido na fila.'}</span>
            </div>
          ) : (
            <table className="review-table">
              <thead>
                <tr>
                  <th className="review-col-num">#</th>
                  <th className="review-col-id">ID</th>
                  <th className="review-col-char">Personagem</th>
                  <th className="review-col-donor">Doador</th>
                  <th className="review-col-source">Fonte</th>
                  <th className="review-col-msg">Mensagem</th>
                  <th className="review-col-done">Feito</th>
                  <th className="review-col-dates">Recebido / Feito</th>
                </tr>
              </thead>
              <tbody>
                {displayRequests.map((r, i) => {
                  const orig = requests.find(o => o.id === r.id)!;
                  const changed = changedIds.has(r.id);
                  const portrait = r.type === 'killer' && r.character ? getKillerPortrait(r.character) : undefined;
                  const doneNow = !!r.done;
                  const doneBefore = !!orig.done;

                  return (
                    <tr key={r.id} className={changed ? 'review-row-changed' : undefined}>
                      <td className="review-col-num mono">{editedRequests.indexOf(r)}</td>
                      <td className="review-col-id mono">{r.id}</td>
                      <td className="review-col-char">
                        <div className="review-char-wrap">
                          <CharacterAvatar portrait={portrait} type={r.type} size="sm" />
                          <span className="review-char-name" title={r.character || undefined}>
                            {r.character || <span className="text-muted">—</span>}
                          </span>
                        </div>
                      </td>
                      <td className="review-col-donor">{r.donor}</td>
                      <td className="review-col-source">
                        <span className={`amount source-${r.source}`}>
                          {formatSourceBadge(r.source, r.amount)}
                        </span>
                      </td>
                      <td className="review-col-msg">
                        <span className="review-msg-text">{r.message || <span className="text-muted">—</span>}</span>
                      </td>
                      <td className="review-col-done">
                        {changesTab ? (
                          <span className="review-done-diff">
                            <span className={doneBefore ? 'review-diff-old done' : 'review-diff-old'}>{doneBefore ? 'Sim' : 'Não'}</span>
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                            <span className={doneNow ? 'review-diff-new done' : 'review-diff-new'}>{doneNow ? 'Sim' : 'Não'}</span>
                          </span>
                        ) : (
                          <button
                            className={`review-done-btn${doneNow ? ' checked' : ''}${changed ? ' changed' : ''}`}
                            onClick={() => toggleDone(r.id)}
                            title={doneNow ? 'Marcar como não feito' : 'Marcar como feito'}
                          >
                            {doneNow ? (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <rect x="3" y="3" width="18" height="18" rx="3" />
                              </svg>
                            )}
                          </button>
                        )}
                      </td>
                      <td className="review-col-dates mono">
                        <div className="review-dates-wrap">
                          <span>{r.timestamp.toLocaleTimeString('pt-BR', TIME_FMT)}</span>
                          {r.doneAt && (
                            <span className="review-done-time" title="Feito às">
                              {'✓ '}{r.doneAt.toLocaleTimeString('pt-BR', TIME_FMT)}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="missed-requests-footer">
          <button className="btn btn-ghost" onClick={handleClose}>Cancelar</button>
          <button
            className="btn btn-ghost"
            onClick={markAllDone}
            disabled={undoneCount === 0}
            title="Marcar todos como feitos"
          >
            Marcar todos como feitos{undoneCount > 0 ? ` (${undoneCount})` : ''}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={changedIds.size === 0}
          >
            Aplicar {changedIds.size > 0 ? `${changedIds.size} alteraç${changedIds.size === 1 ? 'ão' : 'ões'}` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
