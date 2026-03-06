import { useCallback, useState } from 'react';
import { identifyCharacter } from '../services';
import { CharacterRequestCard } from './CharacterRequestCard';
import { ContextMenu } from './ContextMenu';
import { ContextMenuProvider } from '../context/ContextMenuContext';
import { useChannel, useToasts } from '../store';

interface Props {
  showDone?: boolean;
}

export function CharacterRequestList({ showDone = false }: Props) {
  const { useRequests, useChannelInfo, isOwnChannel, canManageChannel } = useChannel();
  const { requests, toggleDone, update, reorder } = useRequests();
  const channelStatus = useChannelInfo((s) => s.status);
  const { showUndo } = useToasts();
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const readOnly = !canManageChannel;
  const filtered = showDone ? requests : requests.filter(r => !r.done);

  const handleToggleDone = useCallback((id: number) => {
    if (readOnly) return;
    const request = requests.find(r => r.id === id);
    if (request && !request.done && !showDone) {
      showUndo('Marcado como feito', () => toggleDone(id));
    }
    toggleDone(id);
  }, [requests, toggleDone, showDone, showUndo, readOnly]);

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
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="request-card skeleton">
              <div className="request-card-content">
                <span className="request-position skeleton-bone" style={{ width: '2ch', height: '1.2em' }} />
                <div className="char-portrait-wrapper skeleton-bone" />
                <div className="request-card-info">
                  <div className="skeleton-bone" style={{ width: '40%', height: '1em' }} />
                  <div className="skeleton-bone" style={{ width: '70%', height: '0.8em', marginTop: '0.5em' }} />
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
    const emptyMessage = showDone
      ? 'Nenhum pedido'
      : !isOwnChannel && channelStatus !== 'live'
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
                showDone={showDone}
                isDragging={draggedId === r.id}
                isDragOver={dragOverId === r.id}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                readOnly={readOnly}
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
