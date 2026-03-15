import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
import type { Request } from '../types';
import { deserializeRequests } from '../types';
import { fetchRequestsHistory } from '../services/api';
import { RequestsTable, type RequestsTableColumn, type RequestsTableHandle } from './RequestsTable';
import { useTranslation, getLocale } from '../i18n';

interface Props {
  isOpen: boolean;
  requests: Request[];
  channel: string;
  onApply: (requests: Request[]) => void;
  onClose: () => void;
}

type Tab = 'current' | 'changes';

const DATETIME_FMT: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };

export function RequestsReviewDialog({ isOpen, requests: storeRequests, channel, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('current');
  const [edits, setEdits] = useState<Map<number, Partial<Request>>>(new Map);
  const [d1Requests, setD1Requests] = useState<Request[] | null>(null);
  const [loading, setLoading] = useState(false);
  const lastClickedIdx = useRef<number | null>(null);
  const tableRef = useRef<RequestsTableHandle>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const needsScrollBottom = useRef(false);
  const [pageInfo, setPageInfo] = useState({ page: 0, totalPages: 1 });
  const handlePageChange = useCallback((page: number, totalPages: number) => setPageInfo({ page, totalPages }), []);

  // Scroll to bottom after loading finishes
  useLayoutEffect(() => {
    if (!loading && isOpen && needsScrollBottom.current && tableWrapRef.current) {
      needsScrollBottom.current = false;
      tableWrapRef.current.scrollTop = tableWrapRef.current.scrollHeight;
    }
  }, [loading, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    needsScrollBottom.current = true;
    setLoading(true);
    setD1Requests(null);
    fetchRequestsHistory(channel)
      .then(serialized => setD1Requests(deserializeRequests(serialized)))
      .catch(err => {
        console.warn('[review] D1 fetch failed, using store data:', err);
        setD1Requests(null);
      })
      .finally(() => setLoading(false));
  }, [isOpen, channel]);

  const requests = d1Requests ?? storeRequests;

  const handleClose = useCallback(() => {
    setEdits(new Map());
    setTab('current');
    setD1Requests(null);
    lastClickedIdx.current = null;
    onClose();
  }, [onClose]);

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
      if ((edit.done !== undefined && edit.done !== orig.done) || (edit.type !== undefined && edit.type !== orig.type)) ids.add(id);
    }
    return ids;
  }, [requests, edits]);

  const setDone = useCallback((id: number, done: boolean) => {
    setEdits(prev => {
      const next = new Map(prev);
      const orig = requests.find(r => r.id === id);
      if (!orig) return prev;
      const isRestore = !done && orig.type === 'none';
      if (done === !!orig.done && !isRestore) {
        next.delete(id);
      } else {
        const current = next.get(id);
        next.set(id, {
          ...current,
          done,
          doneAt: done ? new Date() : undefined,
          ...(isRestore && { type: 'unknown' as const, character: '' }),
        });
      }
      return next;
    });
  }, [requests]);

  const toggleDone = useCallback((id: number) => {
    const orig = requests.find(r => r.id === id);
    if (!orig) return;
    const edit = edits.get(id);

    // For dismissed requests, toggle restores to queue instead of toggling done
    const currentType = edit?.type ?? orig.type;
    if (currentType === 'none') {
      setEdits(prev => {
        const next = new Map(prev);
        next.set(id, { ...prev.get(id), type: 'unknown' as const, character: '' });
        return next;
      });
      return;
    }
    // If already restored, allow toggling back to dismissed
    if (orig.type === 'none' && currentType === 'unknown') {
      setEdits(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      return;
    }

    const currentDone = edit?.done !== undefined ? edit.done : orig.done;
    setDone(id, !currentDone);
  }, [requests, edits, setDone]);

  const handleRowClick = useCallback((idx: number, e: React.MouseEvent) => {
    const list = tab === 'changes'
      ? editedRequests.filter(r => changedIds.has(r.id))
      : editedRequests;
    const clickedReq = list[idx];
    if (!clickedReq) return;

    if (e.shiftKey && lastClickedIdx.current !== null && lastClickedIdx.current !== idx) {
      const from = Math.min(lastClickedIdx.current, idx);
      const to = Math.max(lastClickedIdx.current, idx);
      const orig = requests.find(r => r.id === clickedReq.id);
      if (!orig) return;
      const edit = edits.get(clickedReq.id);
      const currentDone = edit?.done !== undefined ? edit.done : orig.done;
      const targetDone = !currentDone;
      for (let i = from; i <= to; i++) {
        const r = list[i];
        if (r) setDone(r.id, targetDone);
      }
    } else {
      toggleDone(clickedReq.id);
    }
    lastClickedIdx.current = idx;
  }, [tab, editedRequests, changedIds, requests, edits, setDone, toggleDone]);

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

  const leadColumns: RequestsTableColumn[] = [
    {
      key: 'num',
      header: '#',
      className: 'req-col-num',
      render: (r) => editedRequests.indexOf(r),
    },
  ];

  const trailColumns: RequestsTableColumn[] = [
    {
      key: 'done',
      header: t('review.done'),
      className: 'req-col-done',
      render: (r, i) => {
        const orig = requests.find(o => o.id === r.id)!;
        const doneNow = !!r.done;
        const doneBefore = !!orig.done;
        const changed = changedIds.has(r.id);
        const isDismissed = r.type === 'none';
        const isRestored = orig.type === 'none' && r.type !== 'none';

        if (changesTab) {
          if (isRestored) {
            return (
              <span className="review-done-diff">
                <span className="review-diff-old">{t('review.skipped')}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
                <span className="review-diff-new">{t('review.no')}</span>
              </span>
            );
          }
          return (
            <span className="review-done-diff">
              <span className={doneBefore ? 'review-diff-old done' : 'review-diff-old'}>{doneBefore ? t('review.yes') : t('review.no')}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              <span className={doneNow ? 'review-diff-new done' : 'review-diff-new'}>{doneNow ? t('review.yes') : t('review.no')}</span>
            </span>
          );
        }

        if (isDismissed || isRestored) {
          return (
            <button
              className={`review-done-btn${isRestored ? ' changed' : ''}`}
              onClick={e => { e.stopPropagation(); toggleDone(r.id); }}
              title={isDismissed ? t('review.restoreToQueue') : t('review.undoRestore')}
            >
              {isDismissed ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              )}
            </button>
          );
        }

        return (
          <button
            className={`review-done-btn${doneNow ? ' checked' : ''}${changed ? ' changed' : ''}`}
            onClick={e => handleRowClick(i, e)}
            title={doneNow ? t('review.markUndone') : t('review.markDone')}
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
        );
      },
    },
    {
      key: 'dates',
      header: t('review.datesHeader'),
      className: 'req-col-dates',
      render: (r) => (
        <div className="review-dates-wrap">
          <span className="review-date-icon"></span>
          <span>{r.timestamp.toLocaleString(getLocale(), DATETIME_FMT)}</span>
          {r.doneAt && (<>
            <span className="review-date-icon review-done-time">✓</span>
            <span className="review-done-time">{r.doneAt.toLocaleString(getLocale(), DATETIME_FMT)}</span>
          </>)}
        </div>
      ),
    },
  ];

  return (
    <div className="modal-overlay open" onClick={handleClose}>
      <div className="review-dialog" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18M9 3v18" />
            </svg>
            {t('review.title')}
          </div>
          <button className="modal-close" onClick={handleClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <p className="dialog-help-text">{t('review.helpText')}</p>

        {loading ? (
          <div className="req-table-wrap" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3rem' }}>
            <span className="loading-spinner" />
          </div>
        ) : (<>
          <div className="review-tabs">
            <button
              className={`review-tab${tab === 'current' ? ' active' : ''}`}
              onClick={() => setTab('current')}
            >
              {t('review.tabAll', { count: requests.length })}
            </button>
            <button
              className={`review-tab${tab === 'changes' ? ' active' : ''}`}
              onClick={() => setTab('changes')}
            >
              {t('review.tabChanges')} {changedIds.size > 0 && <span className="review-tab-badge">{changedIds.size}</span>}
            </button>
          </div>

          <div className="req-table-wrap" ref={tableWrapRef}>
            <RequestsTable
              ref={tableRef}
              requests={displayRequests}
              leadColumns={leadColumns}
              trailColumns={trailColumns}
              showId
              showTimestamp={false}
              rowClassName={(r) => changedIds.has(r.id) ? 'review-row-changed' : undefined}
              emptyText={changesTab ? t('review.emptyChanges') : t('review.emptyQueue')}
              pageSize={50}
              initialPage="last"
              onPageChange={handlePageChange}
            />
          </div>
        </>)}

        <div className="modal-footer">
          {pageInfo.totalPages > 1 && (
            <div className="req-table-pagination">
              <button className="btn btn-ghost btn-small" onClick={() => tableRef.current?.setPage(pageInfo.page - 1)} disabled={pageInfo.page === 0}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <span className="req-table-page-info">{pageInfo.page + 1} / {pageInfo.totalPages}</span>
              <button className="btn btn-ghost btn-small" onClick={() => tableRef.current?.setPage(pageInfo.page + 1)} disabled={pageInfo.page >= pageInfo.totalPages - 1}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={handleClose}>{t('review.cancel')}</button>
          <button
            className="btn btn-ghost"
            onClick={markAllDone}
            disabled={undoneCount === 0}
            title={t('review.markAllDone')}
          >
            {undoneCount > 0 ? t('review.markAllDoneCount', { count: undoneCount }) : t('review.markAllDone')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleApply}
            disabled={changedIds.size === 0}
          >
            {changedIds.size > 0 ? t('review.applyChanges', { count: changedIds.size }) : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
