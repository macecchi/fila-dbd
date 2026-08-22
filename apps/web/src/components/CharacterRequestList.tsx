import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { identifyCharacter } from '../services';
import { eligibleExtras } from '../services/extras';
import { CharacterRequestCard } from './CharacterRequestCard';
import { ContextMenu } from './ContextMenu';
import { ManualEntry } from './ManualEntry';
import { ContextMenuProvider } from '../context/ContextMenuContext';
import { useChannel } from '../store';
import type { Request } from '../types';
import { useTranslation } from '../i18n';

export function CharacterRequestList() {
  const { useRequests, useSources, useChannelInfo, isOwnChannel, canControlConnection } = useChannel();
  const { requests, toggleDone, update, reorder } = useRequests();
  const hideNonRequests = useSources((s) => s.hideNonRequests);
  const sourcesEnabled = useSources((s) => s.enabled);
  const chatCommand = useSources((s) => s.chatCommand);
  const minDonation = useSources((s) => s.minDonation);
  const channelStatus = useChannelInfo((s) => s.status);
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const readOnly = !canControlConnection;

  const groupMap = useMemo(() => {
    const groups = new Map<string, number[]>();
    for (const r of requests) {
      if (!r.originMsgId) continue;
      const arr = groups.get(r.originMsgId) ?? [];
      arr.push(r.id);
      groups.set(r.originMsgId, arr);
    }
    const out = new Map<number, { index: number; total: number }>();
    for (const ids of groups.values()) {
      if (ids.length <= 1) continue;
      ids.forEach((id, i) => out.set(id, { index: i + 1, total: ids.length }));
    }
    return out;
  }, [requests]);

  // Track done/skipped items exiting so they stay in the DOM for the animation
  const [exitingIds, setExitingIds] = useState<Set<number>>(new Set());
  const [skippingIds, setSkippingIds] = useState<Set<number>>(new Set());
  const [enteringIds, setEnteringIds] = useState<Set<number>>(new Set());
  const prevDoneIds = useRef<Set<number>>(new Set());
  const prevNoneIds = useRef<Set<number>>(new Set());
  const prevRequestIds = useRef<Set<number>>(new Set());
  // useLayoutEffect (not useEffect) so the exiting id is registered before paint.
  // Otherwise the done item — already excluded from `filtered` — gets dropped from
  // the DOM for one painted frame, then re-added to animate out (a visible shake).
  useLayoutEffect(() => {
    const currentDone = new Set(requests.filter(r => r.done).map(r => r.id));
    // Only animate items that transitioned to done, not items that arrived as done from sync
    const newlyDone = [...currentDone].filter(id => !prevDoneIds.current.has(id) && prevRequestIds.current.has(id));
    prevDoneIds.current = currentDone;
    if (newlyDone.length === 0) return;
    setExitingIds(prev => new Set([...prev, ...newlyDone]));
    const timer = setTimeout(() => {
      setExitingIds(prev => {
        const next = new Set(prev);
        newlyDone.forEach(id => next.delete(id));
        return next;
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [requests]);

  // useLayoutEffect for the same reason as the done effect above: register the
  // skipping id before paint so the item never blinks out of the DOM.
  useLayoutEffect(() => {
    const currentNone = new Set(requests.filter(r => r.type === 'none').map(r => r.id));
    // Only animate items that transitioned to 'none', not items that arrived as 'none' from sync
    const newlyNone = [...currentNone].filter(id => !prevNoneIds.current.has(id) && prevRequestIds.current.has(id));
    prevNoneIds.current = currentNone;
    if (newlyNone.length === 0) return;
    setSkippingIds(prev => new Set([...prev, ...newlyNone]));
    const timer = setTimeout(() => {
      setSkippingIds(prev => {
        const next = new Set(prev);
        newlyNone.forEach(id => next.delete(id));
        return next;
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [requests]);

  useEffect(() => {
    const currentIds = new Set(requests.map(r => r.id));
    const newIds = [...currentIds].filter(id => !prevRequestIds.current.has(id));
    prevRequestIds.current = currentIds;
    if (newIds.length === 0) return;
    setEnteringIds(prev => new Set([...prev, ...newIds]));
    const timer = setTimeout(() => {
      setEnteringIds(prev => {
        const next = new Set(prev);
        newIds.forEach(id => next.delete(id));
        return next;
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [requests]);

  const filtered = requests.filter(r =>
    (!r.done && (!hideNonRequests || r.type !== 'none')) || exitingIds.has(r.id) || skippingIds.has(r.id)
  );

  const handleToggleDone = useCallback((id: number) => {
    if (readOnly) return;
    toggleDone(id);
  }, [toggleDone, readOnly]);

  const { t } = useTranslation();

  const rerunExtraction = useCallback(async (id: number) => {
    const request = requests.find(r => r.id === id);
    if (request) {
      update(id, { character: t('card.identifying'), type: 'unknown' });
      const extras = eligibleExtras(request.amountVal, useSources.getState().extrasConfig);
      const result = await identifyCharacter(request, extras);
      update(id, result);
    }
  }, [requests, update, t, useSources]);

  const [editingId, setEditingId] = useState<number | null>(null);
  const editingRequest = editingId !== null ? requests.find(r => r.id === editingId) : undefined;
  // Kept so the dialog stays mounted through its exit transition.
  const lastEdited = useRef<Request | undefined>(undefined);
  if (editingRequest) lastEdited.current = editingRequest;

  const handleEdit = useCallback((id: number) => {
    if (readOnly) return;
    setEditingId(id);
  }, [readOnly]);

  const skipRequest = useCallback((id: number) => {
    update(id, { type: 'none', character: '', needsIdentification: false });
  }, [update]);

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
    if (!isOwnChannel && channelStatus !== 'live') {
      return (
        <div className="empty queue-empty">
          <h3 className="queue-empty-title">{t('empty.offline.title')}</h3>
          <p className="queue-empty-desc">{t('empty.offline.desc')}</p>
        </div>
      );
    }
    if (isOwnChannel) {
      return (
        <div className="empty queue-empty">
          <h3 className="queue-empty-title">{t('empty.owner.title')}</h3>
          <p className="queue-empty-desc">{t('empty.owner.desc')}</p>
        </div>
      );
    }
    const ways: string[] = [];
    if (sourcesEnabled.donation) ways.push(t('empty.viewer.donation', { amount: minDonation }));
    if (sourcesEnabled.chat) ways.push(t('empty.viewer.chat', { command: chatCommand }));
    if (sourcesEnabled.resub) ways.push(t('empty.viewer.resub'));
    return (
      <div className="empty queue-empty">
        <h3 className="queue-empty-title">{t('empty.viewer.title')}</h3>
        <p className="queue-empty-desc">{t('empty.viewer.desc')}</p>
        {ways.length > 0 && (
          <ul className="queue-empty-ways">
            {ways.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>
    );
  }

  return (
    <ContextMenuProvider>
      <div onTouchMove={handleTouchMove} onTouchEnd={handleDragEnd}>
        {(() => {
          let activeIndex = 0;
          return filtered.map((r) => {
            const position = r.done ? undefined : ++activeIndex;
            const exiting = exitingIds.has(r.id);
            const skipping = skippingIds.has(r.id);
            return (
              <CharacterRequestCard
                key={r.id}
                request={r}
                position={position}
                onToggleDone={handleToggleDone}
                onEdit={readOnly ? undefined : handleEdit}
                isDragging={draggedId === r.id}
                isDragOver={dragOverId === r.id}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDragEnd={handleDragEnd}
                readOnly={readOnly}
                exiting={exiting}
                skipping={skipping}
                // Never let a just-arrived card play the enter animation while it's
                // also exiting/skipping — the two animations fight and ghost.
                entering={enteringIds.has(r.id) && !exiting && !skipping}
                group={groupMap.get(r.id)}
              />
            );
          });
        })()}
      </div>
      {!readOnly && (
        <ContextMenu
          onToggleDone={handleToggleDone}
          onRerun={rerunExtraction}
          onSkip={skipRequest}
          onEdit={handleEdit}
        />
      )}
      {!readOnly && lastEdited.current && (
        <ManualEntry
          isOpen={!!editingRequest}
          editRequest={editingRequest ?? lastEdited.current}
          onClose={() => setEditingId(null)}
          onSave={(updates) => update(lastEdited.current!.id, updates)}
        />
      )}
    </ContextMenuProvider>
  );
}
