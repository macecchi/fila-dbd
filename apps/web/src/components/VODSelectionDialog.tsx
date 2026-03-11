import { useState, useCallback } from 'react';
import { fetchRecentVods, type VODInfo } from '../services/vod';

interface Props {
  isOpen: boolean;
  channel: string;
  onConfirm: (vods: VODInfo[]) => void;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}` : `${m}min`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function VODSelectionDialog({ isOpen, channel, onConfirm, onClose }: Props) {
  const [vods, setVods] = useState<VODInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const loadVods = useCallback(async (append = false) => {
    const isMore = append && cursor;
    if (isMore) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const result = await fetchRecentVods(channel, 10, isMore ? cursor! : undefined);
      setVods(prev => append ? [...prev, ...result.vods] : result.vods);
      setHasMore(result.hasMore);
      setCursor(result.endCursor);
      setLoaded(true);
    } catch {
      setError('Erro ao buscar VODs');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [channel, cursor]);

  const handleOpen = useCallback(() => {
    if (!loaded) loadVods();
  }, [loaded, loadVods]);

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleConfirm = () => {
    const selectedVods = vods.filter(v => selected.has(v.id));
    onConfirm(selectedVods);
  };

  const handleClose = () => {
    setVods([]);
    setSelected(new Set());
    setCursor(null);
    setLoaded(false);
    setHasMore(false);
    onClose();
  };

  if (!isOpen) return null;

  // Trigger load on render (if not loaded)
  if (!loaded && !loading && !error) {
    handleOpen();
  }

  return (
    <div className="missed-requests-overlay" onClick={handleClose}>
      <div className="missed-requests-dialog" onClick={e => e.stopPropagation()}>
        <div className="missed-requests-header">
          <div className="missed-requests-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" />
            </svg>
            Selecionar VODs
          </div>
          <button className="modal-close" onClick={handleClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="missed-requests-loading">
            <div className="missed-requests-spinner" />
            <span>Buscando VODs de {channel}...</span>
          </div>
        ) : error ? (
          <div className="missed-requests-empty">
            <span>{error}</span>
            <button className="btn btn-ghost" onClick={() => loadVods()}>Tentar novamente</button>
          </div>
        ) : vods.length === 0 ? (
          <div className="missed-requests-empty">
            <span>Nenhuma VOD encontrada para {channel}.</span>
            <button className="btn btn-ghost" onClick={handleClose}>Fechar</button>
          </div>
        ) : (
          <>
            <div className="missed-requests-subtitle">
              Selecione as VODs para buscar pedidos
            </div>
            <div className="missed-requests-list">
              {vods.map(vod => (
                <label key={vod.id} className={`missed-request-item${selected.has(vod.id) ? ' checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(vod.id)}
                    onChange={() => toggle(vod.id)}
                  />
                  <div className="missed-request-info">
                    <div className="vod-item-title">{vod.title || `VOD ${vod.id}`}</div>
                    <div className="vod-item-meta">
                      {formatDate(vod.createdAt)} · {formatDuration(vod.lengthSeconds)}
                    </div>
                  </div>
                </label>
              ))}
              {hasMore && (
                <button
                  className="btn btn-ghost vod-load-more"
                  onClick={() => loadVods(true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <><span className="missed-requests-spinner-inline" /> Carregando...</>
                  ) : (
                    'Carregar mais'
                  )}
                </button>
              )}
            </div>
            <div className="missed-requests-footer">
              <button className="btn btn-ghost" onClick={handleClose}>Cancelar</button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={selected.size === 0}
              >
                Buscar pedidos {selected.size > 0 ? `(${selected.size} VOD${selected.size > 1 ? 's' : ''})` : ''}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
