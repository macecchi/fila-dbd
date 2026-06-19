import { memo, useMemo } from 'react';
import type { Request } from '../types';
import { useContextMenu } from '../context/ContextMenuContext';
import { getKillerPortrait, tryLocalMatch } from '../data/characters';
import { CharacterAvatar } from './CharacterAvatar';
import { useTranslation } from '../i18n';
import { getLocale } from '../i18n';
import { formatRelativeTime, highlightTerms } from '../utils/helpers';
import { renderTwitchSubBadge, renderDonationBadge, renderBroadcasterBadge } from './UserBadges';



function getMatchedTerm(r: Request): string | undefined {
  if (r.matchedTerm) return r.matchedTerm;
  if (!r.message || !r.character || r.type === 'unknown' || r.type === 'none') return undefined;
  return tryLocalMatch(r.message)?.matchedTerm;
}

interface Props {
  request: Request;
  position?: number;
  onToggleDone: (id: number) => void;
  isDragging?: boolean;
  isDragOver?: boolean;
  onDragStart?: (id: number) => void;
  onDragOver?: (id: number) => void;
  onDragEnd?: () => void;
  readOnly?: boolean;
  exiting?: boolean;
  skipping?: boolean;
  entering?: boolean;
  group?: { index: number; total: number };
}

export const CharacterRequestCard = memo(function CharacterRequestCard({
  request, position, onToggleDone,
  isDragging, isDragOver, onDragStart, onDragOver, onDragEnd, readOnly = false, exiting = false, skipping = false, entering = false,
  group,
}: Props) {
  const { show: showContextMenu } = useContextMenu();
  const { t } = useTranslation();
  const r = request;
  const portrait = r.type === 'killer' && r.character ? getKillerPortrait(r.character) : null;
  const isIdentifying = r.needsIdentification || r.character === 'Identificando...' || r.character === 'Identifying...';
  const isValidating = r.validating;
  const charDisplay = isIdentifying ? t('card.identifying') :
    (!r.character || r.type === 'unknown') ? t('card.unidentified') :
      r.character;
  const isCollapsed = r.done;
  const matchedTerm = useMemo(() => getMatchedTerm(r), [r.matchedTerm, r.message, r.character, r.type]);

  const buildMatchedTerms = useMemo(() => {
    const build = r.extras?.find(e => e.type === 'build');
    return build?.matchedTerms ?? [];
  }, [r.extras]);

  const allTerms = useMemo(() => {
    const terms: string[] = [];
    if (matchedTerm) terms.push(matchedTerm);
    terms.push(...buildMatchedTerms);
    return terms;
  }, [matchedTerm, buildMatchedTerms]);

  const handleClick = () => {
    if (readOnly) return;
    onToggleDone(r.id);
  };
  const handleContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (readOnly) return;
    showContextMenu(r.id, e.clientX, e.clientY, !!r.done);
  };

  const badgeText = r.source === 'donation' ? r.amount :
    r.source === 'chat' ? 'CHAT' :
      r.source === 'resub' ? 'RESUB' : '';

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    onDragStart?.(r.id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    onDragOver?.(r.id);
  };

  const handleDragEnd = () => {
    onDragEnd?.();
  };

  const className = [
    'request-card',
    isCollapsed && 'collapsed',
    `source-${r.source || 'donation'}`,
    isDragging && 'dragging',
    isDragOver && 'drag-over',
    exiting && 'deleting',
    skipping && 'skipping',
    entering && 'entering',
    readOnly && 'read-only'
  ].filter(Boolean).join(' ');

  const handleMouseDown = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('button')) {
      e.currentTarget.setAttribute('draggable', 'true');
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    e.currentTarget.setAttribute('draggable', 'false');
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest('button')) {
      onDragStart?.(r.id);
    }
  };

  return (
    <div
      className={className}
      data-request-id={r.id}
      onContextMenu={handleContext}
      {...(!readOnly && {
        onDragOver: handleDragOver,
        onDragStart: handleDragStart,
        onDragEnd: handleDragEnd,
        onMouseDown: handleMouseDown,
        onMouseUp: handleMouseUp,
        onMouseLeave: handleMouseUp,
        onTouchStart: handleTouchStart,
      })}
    >
      <div className="request-card-content">
        <span className="request-position">{position ? String(position).padStart(2, '0') : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>}</span>
        <CharacterAvatar portrait={portrait ?? undefined} type={r.type} extras={r.extras} />
        <div className="request-card-info">
          <div className="character">
            <img
              src={`${import.meta.env.BASE_URL}images/${r.type === 'killer' ? 'IconKiller.webp' : r.type === 'survivor' ? 'IconSurv.webp' : 'IconShuffle.webp'}`}
              alt=""
              className="char-type-icon"
            />
            <span className={`char-name${isIdentifying ? ' identifying' : ''}${!r.character && r.type !== 'unknown' ? ' type-only' : ''}`}>
              {charDisplay}
            </span>
            {isValidating && <span className="validating-dot" title={t('card.validatingAI')} />}
          </div>
          <div className="request-card-body">
            <span className="donor-name" style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' }}>
              {r.source === 'manual' && renderBroadcasterBadge()}
              {r.source === 'donation' && renderDonationBadge()}
              {(r.source === 'chat' || r.source === 'resub') && (r.subTier || r.source === 'resub') && renderTwitchSubBadge(r.subTier || 1)}
              <span style={{ verticalAlign: 'middle' }}>{r.donor}</span>
              {group && <span className="donation-group-chip" title="Pedidos da mesma doação" style={{ marginLeft: '4px' }}>{group.index}/{group.total}</span>}
            </span>
            {allTerms.length > 0 ? highlightTerms(r.message, allTerms) : r.message}
          </div>
        </div>
        <div className="request-card-meta">
          {badgeText && (
            <span className={`amount source-${r.source}`}>
              {badgeText}
            </span>
          )}
          <span className="time" title={r.timestamp.toLocaleString(getLocale())}>{formatRelativeTime(r.timestamp)}</span>
        </div>
      </div>
      {!readOnly && (
        <div className="request-actions">
          <button
            className={`request-action-btn ${r.done ? 'undo' : 'done'}`}
            onClick={handleClick}
            title={r.done ? t('card.markUndone') : t('card.markDone')}
          >
            {r.done ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            )}
          </button>
        </div>
      )}
    </div>
  );
});
