import { useState, useEffect, useRef, useCallback } from 'react';
import type { Request } from '../types';
import { RequestsTable, type RequestsTableColumn } from './RequestsTable';
import { useTranslation } from '../i18n';

interface Props {
  isOpen: boolean;
  requests: Request[];
  isLoading: boolean;
  loadingStatus?: string;
  onConfirm: (selected: Request[]) => void;
  onClose: () => void;
  onBack?: () => void;
  emptyText?: string;
  loadingText?: string;
  doneText?: string;
}

export function ImportRequestsDialog({ isOpen, requests, isLoading, loadingStatus, onConfirm, onClose, onBack, emptyText, loadingText, doneText }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const seenIds = useRef<Set<number>>(new Set());

  // Auto-select NEW requests, preserve user unchecks
  useEffect(() => {
    const newReqs = requests.filter(r => !seenIds.current.has(r.id));
    if (!newReqs.length) return;
    for (const r of newReqs) seenIds.current.add(r.id);
    setSelected(prev => {
      const next = new Set(prev);
      for (const r of newReqs) { if (r.type !== 'none') next.add(r.id); }
      return next;
    });
  }, [requests]);

  // Reset tracking on dialog close/reopen
  useEffect(() => { if (!isOpen) { seenIds.current.clear(); setSelected(new Set()); } }, [isOpen]);

  const toggleAll = (selectAll: boolean) => {
    setSelected(selectAll ? new Set(requests.map(r => r.id)) : new Set());
  };

  const toggle = useCallback((id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleConfirm = () => {
    onConfirm(requests.filter(r => selected.has(r.id)));
  };

  const handleRowClick = useCallback((idx: number) => {
    const req = requests[idx];
    if (req) toggle(req.id);
  }, [requests, toggle]);

  if (!isOpen) return null;

  const allSelected = selected.size === requests.length && requests.length > 0;
  const noneSelected = selected.size === 0;
  const selectedCount = selected.size;

  const leadColumns: RequestsTableColumn[] = [
    {
      key: 'check',
      className: 'req-col-check',
      header: (
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => toggleAll(!allSelected)}
          disabled={requests.length === 0}
        />
      ),
      render: (req) => (
        <input
          type="checkbox"
          checked={selected.has(req.id)}
          onChange={() => toggle(req.id)}
          onClick={e => e.stopPropagation()}
        />
      ),
    },
  ];

  return (
    <div className="modal-overlay open" onClick={onClose}>
      <div className="recovery-dialog recovery-dialog-wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12,6 12,12 16,14" />
            </svg>
            {t('import.title')}
          </div>
          <button className="modal-close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {!isLoading && requests.length === 0 ? (
          <div className="dialog-empty">
            <span>{emptyText || t('import.emptyDefault')}</span>
            <button className="btn btn-ghost" onClick={onClose}>{t('import.close')}</button>
          </div>
        ) : (
          <>
            <div className="recovery-subtitle">
              {isLoading ? (
                <>
                  <span className="recovery-spinner-inline" />
                  {loadingStatus || loadingText || t('import.analyzing')}
                </>
              ) : (
                <>{doneText || t('import.found')} <strong>{requests.length}</strong> {t('import.request', { count: requests.length })}</>
              )}
            </div>
            <div className="recovery-actions">
              <button
                className="btn btn-ghost btn-small"
                onClick={() => toggleAll(!allSelected)}
                disabled={requests.length === 0}
              >
                {allSelected ? t('import.deselectAll') : t('import.selectAll')}
              </button>
              <span className="recovery-count">
                {t('import.selectedCount', { selected: selectedCount, total: requests.length, count: selectedCount })}
              </span>
            </div>
            <div className="req-table-wrap">
              <RequestsTable
                requests={requests}
                leadColumns={leadColumns}
                onRowClick={handleRowClick}
                emptyText=""
              />
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost" onClick={onBack ?? onClose}>
                {onBack ? t('import.back') : t('import.ignore')}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={noneSelected || isLoading}
              >
                {isLoading
                  ? <span className="recovery-spinner-inline" />
                  : t('import.addRequests', { count: selectedCount || '' })
                }
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
