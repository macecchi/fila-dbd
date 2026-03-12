import { useCallback, useEffect, useRef, useState } from 'react';
import { identifyCharacter } from '../services';
import { CharacterRequestCard } from './CharacterRequestCard';
import { ContextMenu } from './ContextMenu';
import { ContextMenuProvider } from '../context/ContextMenuContext';
import { useChannel } from '../store';

export function CharacterRequestList() {
  const { useRequests, useChannelInfo, isOwnChannel, canControlConnection } = useChannel();
  const { requests, toggleDone, update, reorder } = useRequests();
  const channelStatus = useChannelInfo((s) => s.status);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const readOnly = !canControlConnection;

  // Track done items exiting so they stay in the DOM for the animation
  const [exitingIds, setExitingIds] = useState<Set<number>>(new Set());
  const prevDoneIds = useRef<Set<number>>(new Set());
  useEffect(() => {
    const currentDone = new Set(requests.filter(r => r.done).map(r => r.id));
    const newlyDone = [...currentDone].filter(id => !prevDoneIds.current.has(id));
    prevDoneIds.current = currentDone;
    if (newlyDone.length === 0) return;
    setExitingIds(prev => new Set([...prev, ...newlyDone]));
    const timer = setTimeout(() => {
      setExitingIds(prev => {
        const next = new Set(prev);
        newlyDone.forEach(id => next.delete(id));
        return next;
      });
    }, 800); // matches deleteSlide duration
    return () => clearTimeout(timer);
  }, [requests]);

  const filtered = requests.filter(r => !r.done || exitingIds.has(r.id));

  const handleToggleDone = useCallback((id: number) => {
    if (readOnly) return;
    toggleDone(id);
  }, [toggleDone, readOnly]);

  const rerunExtraction = useCallback(async (id: number) => {
    const request = requests.find(r => r.id === id);
    if (request) {
      update(id, { character: 'Identificando...', type: 'unknown' });
      const result = await identifyCharacter(request);
      update(id, result);
    }
  }, [requests, update]);

  const handleDragStart = useCallback((id: number) => {
    if (readOnly) return;
    setDraggedId(id);
  }, [readOnly]);

  const handleDragOver = useCallback((id: number) => {
    if (draggedId && draggedId !== id) {
      setDragOverId(id);
    }
  }, [draggedId]);

  const handleDragEnd = useCallback(() => {
    if (draggedId && dragOverId && draggedId !== dragOverId) {
      reorder(draggedId, dragOverId);
    }
    setDraggedId(null);
    setDragOverId(null);
  }, [draggedId, dragOverId, reorder]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!draggedId) return;
    const touch = e.touches[0];
    const elementsAtPoint = document.elementsFromPoint(touch.clientX, touch.clientY);
    for (const el of elementsAtPoint) {
      const card = el.closest('.request-card') as HTMLElement;
      if (card) {
        const idAttr = card.dataset.requestId;
        if (idAttr) {
          const id = parseInt(idAttr, 10);
          if (id !== draggedId) {
            setDragOverId(id);
            return;
          }
        }
      }
    }
    setDragOverId(null);
  }, [draggedId]);

  const partySynced = useChannelInfo((s) => s.partySynced);

  if (filtered.length === 0) {
    if (!partySynced) {
      return (
        <div>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="request-card skeleton">
              <div className="request-card-content">
                <span className="request-position skeleton-bone" style={{ width: '2ch', height: '1.2em' }} />
                <div className="char-portrait-wrapper skeleton-bone" />
                <div className="request-card-info">
                  <div className="skeleton-bone" style={{ width: '40%', height: '1em' }} />
                  <div className="request-card-body">
                    <span className="skeleton-bone" style={{ width: '25%', height: '0.8em', display: 'inline-block' }} />
                    <span className="skeleton-bone" style={{ width: '55%', height: '0.8em', display: 'inline-block', marginLeft: '0.4em' }} />
                  </div>
                </div>
                <div className="request-card-meta">
                  <span className="skeleton-bone" style={{ width: '3rem', height: '1.2em', borderRadius: 'var(--radius-sm)' }} />
                  <span className="skeleton-bone" style={{ width: '2rem', height: '0.7em' }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      );
    }
    const emptyMessage = !isOwnChannel && channelStatus !== 'live'
      ? 'Streamer offline'
      : 'Aguardando pedidos...';
    return <div className="empty">{emptyMessage}</div>;
  }

  return (
    <ContextMenuProvider>
      <div onTouchMove={handleTouchMove} onTouchEnd={handleDragEnd}>
        {(() => {
          let activeIndex = 0;
          return filtered.map((r) => {
            const position = r.done ? undefined : ++activeIndex;
            return (
              <CharacterRequestCard
                key={r.id}
                request={r}
                position={position}
                onToggleDone={handleToggleDone}
                isDragging={draggedId === r.id}
                isDragOver={dragOverId === r.id}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                readOnly={readOnly}
                exiting={exitingIds.has(r.id)}
              />
            );
          });
        })()}
      </div>
      {!readOnly && (
        <ContextMenu
          onToggleDone={handleToggleDone}
          onRerun={rerunExtraction}
        />
      )}
    </ContextMenuProvider>
  );
}
