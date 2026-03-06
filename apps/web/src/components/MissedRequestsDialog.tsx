import { useState, useEffect, useRef } from 'react';
import { getKillerPortrait } from '../data/characters';
import { CharacterAvatar } from './CharacterAvatar';
import type { Request } from '../types';

interface Props {
  isOpen: boolean;
  requests: Request[];
  isLoading: boolean;
  loadingStatus: string;
  onConfirm: (selected: Request[]) => void;
  onClose: () => void;
}

export function MissedRequestsDialog({ isOpen, requests, isLoading, loadingStatus, onConfirm, onClose }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const seenIds = useRef<Set<number>>(new Set());

  // Auto-select NEW requests, preserve user unchecks
  useEffect(() => {
    const newIds = requests.filter(r => !seenIds.current.has(r.id)).map(r => r.id);
    if (!newIds.length) return;
    for (const id of newIds) seenIds.current.add(id);
    setSelected(prev => { const next = new Set(prev); for (const id of newIds) next.add(id); return next; });
  }, [requests]);

  // Reset tracking on dialog close/reopen
  useEffect(() => { if (!isOpen) { seenIds.current.clear(); setSelected(new Set()); } }, [isOpen]);

  const toggleAll = (selectAll: boolean) => {
    if (selectAll) {
      setSelected(new Set(requests.map(r => r.id)));
    } else {
      setSelected(new Set());
    }
  };

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    const selectedRequests = requests.filter(r => selected.has(r.id));
    onConfirm(selectedRequests);
  };

  if (!isOpen) return null;

  const allSelected = selected.size === requests.length && requests.length > 0;
  const noneSelected = selected.size === 0;
  const selectedCount = selected.size;

  return (
    <div className="missed-requests-overlay" onClick={onClose}>
      <div className="missed-requests-dialog" onClick={e => e.stopPropagation()}>
        <div className="missed-requests-header">
          <div className="missed-requests-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            Recuperar pedidos
          </div>
          <button className="modal-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {isLoading && requests.length === 0 ? (
          <div className="missed-requests-loading">
            <div className="missed-requests-spinner" />
            <span>{loadingStatus || 'Buscando pedidos perdidos...'}</span>
          </div>
        ) : requests.length === 0 ? (
          <div className="missed-requests-empty">
            <span>Nenhum pedido perdido encontrado na stream atual.</span>
            <button className="btn btn-ghost" onClick={onClose}>Fechar</button>
          </div>
        ) : (
          <>
            <div className="missed-requests-subtitle">
              {isLoading ? (
                <>
                  <span className="missed-requests-spinner-inline" />
                  Analisando stream... <strong>{requests.length}</strong> pedido{requests.length > 1 ? 's' : ''} encontrado{requests.length > 1 ? 's' : ''}
                </>
              ) : (
                <>Encontramos <strong>{requests.length}</strong> pedido{requests.length > 1 ? 's' : ''} na stream atual</>
              )}
            </div>
            <div className="missed-requests-actions">
              <button
                className="btn btn-ghost btn-small"
                onClick={() => toggleAll(!allSelected)}
              >
                {allSelected ? 'Desmarcar todos' : 'Selecionar todos'}
              </button>
              <span className="missed-requests-count">
                {selectedCount} de {requests.length} selecionado{selectedCount !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="missed-requests-list">
              {requests.map(req => {
                const portrait = req.type === 'killer' && req.character ? getKillerPortrait(req.character) : undefined;
                const isIdentifying = req.needsIdentification || req.character === 'Identificando...';
                const charDisplay = isIdentifying ? '' :
                  (!req.character || req.type === 'unknown') ? 'Desconhecido' :
                    req.character;

                const badgeText = req.source === 'donation' ? req.amount :
                  req.source === 'chat' ? `TIER ${req.subTier || 1}` :
                    req.source === 'resub' ? 'RESUB' : '';

                return (
                  <label key={req.id} className={`missed-request-item${selected.has(req.id) ? ' checked' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.has(req.id)}
                      onChange={() => toggle(req.id)}
                    />
                    <CharacterAvatar portrait={portrait} type={req.type} size="sm" />
                    <div className="missed-request-info">
                      {charDisplay && (
                        <div className="character">
                          <img
                            src={`${import.meta.env.BASE_URL}images/${req.type === 'killer' ? 'IconKiller.webp' : req.type === 'survivor' ? 'IconSurv.webp' : 'IconShuffle.webp'}`}
                            alt=""
                            className="char-type-icon"
                          />
                          <span className="char-name">{charDisplay}</span>
                        </div>
                      )}
                      <div className="request-card-body">
                        <span className="donor-name">{req.donor}</span>
                        {req.message}
                      </div>
                    </div>
                    <div className="missed-request-meta">
                      {badgeText && <span className={`amount source-${req.source}`}>{badgeText}</span>}
                      <span className="missed-request-time">
                        {req.timestamp.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </label>
                );
              })}
            </div>
            <div className="missed-requests-footer">
              <button className="btn btn-ghost" onClick={onClose}>
                Ignorar
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={noneSelected}
              >
                Adicionar {selectedCount > 0 ? selectedCount : ''} pedido{selectedCount !== 1 ? 's' : ''}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
