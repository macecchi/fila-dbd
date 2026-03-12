import { memo } from 'react';
import type { Request } from '../types';
import { useContextMenu } from '../context/ContextMenuContext';
import { getKillerPortrait } from '../data/characters';
import { CharacterAvatar } from './CharacterAvatar';

import { formatRelativeTime } from '../utils/helpers';

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
}

export const CharacterRequestCard = memo(function CharacterRequestCard({
  request, position, onToggleDone,
  isDragging, isDragOver, onDragStart, onDragOver, onDragEnd, readOnly = false, exiting = false
}: Props) {
  const { show: showContextMenu } = useContextMenu();
  const r = request;
  const portrait = r.type === 'killer' && r.character ? getKillerPortrait(r.character) : null;
  const isIdentifying = r.needsIdentification || r.character === 'Identificando...';
  const isValidating = r.validating;
  const charDisplay = isIdentifying ? 'Identificando...' :
    (!r.character || r.type === 'unknown') ? 'Não identificado' :
      r.character;
  const isCollapsed = r.done;

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
    r.source === 'chat' ? `TIER ${r.subTier || 1}` :
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
        <CharacterAvatar portrait={portrait ?? undefined} type={r.type} />
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
            {isValidating && <span className="validating-dot" title="Validando com IA..." />}
          </div>
          <div className="request-card-body">
            <span className="donor-name">{r.donor}</span>
            {r.message}
          </div>
        </div>
        <div className="request-card-meta">
          {badgeText && (
            <span className={`amount source-${r.source}`}>
              {badgeText}
            </span>
          )}
          <span className="time" title={r.timestamp.toLocaleString('pt-BR')}>{formatRelativeTime(r.timestamp)}</span>
        </div>
      </div>
      {!readOnly && (
        <div className="request-actions">
          <button
            className={`request-action-btn ${r.done ? 'undo' : 'done'}`}
            onClick={handleClick}
            title={r.done ? 'Marcar como não feito' : 'Marcar como feito'}
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
