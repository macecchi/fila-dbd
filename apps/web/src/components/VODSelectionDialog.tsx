import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchRecentVods, type VODInfo } from '../services/vod';
import { useTranslation, getLocale } from '../i18n';

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
  return new Date(iso).toLocaleDateString(getLocale(), { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function VODSelectionDialog({ isOpen, channel, onConfirm, onClose }: Props) {
  const { t } = useTranslation();
  const [vods, setVods] = useState<VODInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const cursorRef = useRef<string | null>(null);

  const loadVods = useCallback(async (append = false) => {
    const cur = append ? cursorRef.current : null;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const result = await fetchRecentVods(channel, 10, cur || undefined);
      setVods(prev => append ? [...prev, ...result.vods] : result.vods);
      setHasMore(result.hasMore);
      cursorRef.current = result.endCursor;
      setCursor(result.endCursor);
      setLoaded(true);
    } catch {
      setError(t('vod.error'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [channel]);

  useEffect(() => {
    if (isOpen && !loaded && !loading && !error) loadVods();
  }, [isOpen, loaded, loading, error, loadVods]);

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
    cursorRef.current = null;
    setLoaded(false);
    setHasMore(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={handleClose}>
      <div className="recovery-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" />
            </svg>
            {t('vod.title')}
          </div>
          <button className="modal-close" onClick={handleClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="recovery-loading">
            <div className="recovery-spinner" />
            <span>{t('vod.loading', { channel })}</span>
          </div>
        ) : error ? (
          <div className="dialog-empty">
            <span>{error}</span>
            <button className="btn btn-ghost" onClick={() => loadVods()}>{t('vod.retry')}</button>
          </div>
        ) : vods.length === 0 ? (
          <div className="dialog-empty">
            <span>{t('vod.empty', { channel })}</span>
            <button className="btn btn-ghost" onClick={handleClose}>{t('import.close')}</button>
          </div>
        ) : (
          <>
            <p className="dialog-help-text">{t('vod.helpText')}</p>
            <div className="recovery-list">
              {vods.map(vod => (
                <label key={vod.id} className={`vod-item${selected.has(vod.id) ? ' checked' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(vod.id)}
                    onChange={() => toggle(vod.id)}
                  />
                  <div className="vod-item-info">
                    <div className="vod-item-title">{vod.title || t('vod.fallbackTitle', { id: vod.id })}</div>
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
                    <><span className="recovery-spinner-inline" /> {t('vod.loadingMore')}</>
                  ) : (
                    t('vod.loadMore')
                  )}
                </button>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={handleClose}>{t('vod.cancel')}</button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={selected.size === 0}
              >
                {selected.size > 0 ? t('vod.searchCount', { count: selected.size }) : t('vod.search')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
