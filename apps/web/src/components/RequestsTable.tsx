import { useState, useEffect, useCallback, useImperativeHandle, forwardRef, type ReactNode, type MouseEvent } from 'react';
import { CharacterAvatar } from './CharacterAvatar';
import { getKillerPortrait } from '../data/characters';
import { useTranslation } from '../i18n';
import { getLocale } from '../i18n';
import type { Request } from '../types';

const SOURCE_LABELS: Record<string, string> = {
  donation: 'Donate',
  chat: 'Chat',
  resub: 'Resub',
  manual: 'Manual',
};

export function formatSourceBadge(req: Pick<Request, 'source' | 'amount' | 'subTier'>): string {
  if (req.source === 'donation' && req.amount) return req.amount;
  if (req.source === 'chat' && req.subTier) return `Tier ${req.subTier}`;
  return SOURCE_LABELS[req.source] ?? req.source;
}

export interface RequestsTableColumn {
  key: string;
  header: ReactNode;
  className?: string;
  render: (req: Request, index: number) => ReactNode;
}

interface Props {
  requests: Request[];
  leadColumns?: RequestsTableColumn[];
  trailColumns?: RequestsTableColumn[];
  showId?: boolean;
  showMessage?: boolean;
  showTimestamp?: boolean;
  onRowClick?: (index: number, e: MouseEvent) => void;
  rowClassName?: (req: Request, index: number) => string | undefined;
  emptyText?: string;
  pageSize?: number;
  initialPage?: 'first' | 'last';
  onPageChange?: (page: number, totalPages: number) => void;
}

export interface RequestsTableHandle {
  setPage: (page: number) => void;
}

const TIME_FMT: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };

export const RequestsTable = forwardRef<RequestsTableHandle, Props>(function RequestsTable({
  requests,
  leadColumns,
  trailColumns,
  showId = false,
  showMessage = true,
  showTimestamp = true,
  onRowClick,
  rowClassName,
  emptyText,
  pageSize,
  initialPage = 'first',
  onPageChange,
}, ref) {
  const { t } = useTranslation();
  const resolvedEmptyText = emptyText ?? t('table.empty');
  const totalPages = pageSize ? Math.max(1, Math.ceil(requests.length / pageSize)) : 1;
  const [page, setPageRaw] = useState(initialPage === 'last' ? totalPages - 1 : 0);

  const setPage = useCallback((p: number) => {
    const clamped = Math.max(0, Math.min(p, totalPages - 1));
    setPageRaw(clamped);
  }, [totalPages]);

  useImperativeHandle(ref, () => ({ setPage }), [setPage]);

  useEffect(() => {
    onPageChange?.(page, totalPages);
  }, [page, totalPages, onPageChange]);

  // Reset page when requests change significantly
  useEffect(() => {
    const maxPage = Math.max(0, totalPages - 1);
    if (page > maxPage) setPageRaw(maxPage);
  }, [totalPages, page]);

  if (requests.length === 0) {
    if (!resolvedEmptyText) return null;
    return (
      <div className="dialog-empty">
        <span>{resolvedEmptyText}</span>
      </div>
    );
  }

  const pageRows = pageSize
    ? requests.slice(page * pageSize, (page + 1) * pageSize)
    : requests;
  const pageOffset = pageSize ? page * pageSize : 0;

  return (
    <>
      <table className="req-table">
        <thead>
          <tr>
            {leadColumns?.map(col => (
              <th key={col.key} className={col.className}>{col.header}</th>
            ))}
            {showId && <th className="req-col-id">ID</th>}
            <th className="req-col-char">{t('table.character')}</th>
            <th className="req-col-donor">{t('table.donor')}</th>
            <th className="req-col-source">{t('table.source')}</th>
            {showMessage && <th className="req-col-msg">{t('table.message')}</th>}
            {showTimestamp && <th className="req-col-dates">{t('table.time')}</th>}
            {trailColumns?.map(col => (
              <th key={col.key} className={col.className}>{col.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((r, localIdx) => {
            const globalIdx = pageOffset + localIdx;
            const portrait = r.type === 'killer' && r.character ? getKillerPortrait(r.character) : undefined;
            return (
              <tr
                key={r.id}
                className={rowClassName?.(r, globalIdx)}
                onClick={onRowClick ? e => onRowClick(globalIdx, e) : undefined}
                style={onRowClick ? { cursor: 'pointer' } : undefined}
              >
                {leadColumns?.map(col => (
                  <td key={col.key} className={col.className}>{col.render(r, globalIdx)}</td>
                ))}
                {showId && <td className="req-col-id mono">{r.id}</td>}
                <td className="req-col-char">
                  <div className="req-char-wrap">
                    <CharacterAvatar portrait={portrait} type={r.type} size="sm" />
                    <span className="req-char-name" title={r.character || undefined}>
                      {r.type === 'none'
                        ? <span className="text-muted">{t('table.skipped')}</span>
                        : r.character || <span className="text-muted">—</span>}
                    </span>
                  </div>
                </td>
                <td className="req-col-donor">{r.donor}</td>
                <td className="req-col-source">
                  <span className={`amount source-${r.source}`}>
                    {formatSourceBadge(r)}
                  </span>
                </td>
                {showMessage && (
                  <td className="req-col-msg">
                    <span className="req-msg-text">{r.message || <span className="text-muted">—</span>}</span>
                  </td>
                )}
                {showTimestamp && (
                  <td className="req-col-dates mono">
                    {r.timestamp.toLocaleString(getLocale(), TIME_FMT)}
                  </td>
                )}
                {trailColumns?.map(col => (
                  <td key={col.key} className={col.className}>{col.render(r, globalIdx)}</td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
});
