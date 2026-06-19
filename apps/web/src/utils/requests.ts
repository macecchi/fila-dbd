import type { Request } from '../types';
import { compareRequests } from '../types';

type SortMode = 'priority' | 'fifo';

export function sortRequests(
  requests: Request[],
  sortMode: SortMode,
  priority: string[],
  prioritizeTiers?: boolean,
  prioritizeDonations?: boolean
): Request[] {
  const sorted = [...requests];
  if (sortMode === 'fifo') {
    sorted.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  } else {
    sorted.sort((a, b) => compareRequests(a, b, priority, prioritizeTiers ?? false, prioritizeDonations ?? false));
  }
  return sorted;
}

export function mergeRequests(
  selected: Request[],
  existing: Request[],
  sortMode: SortMode,
  priority: string[],
  prioritizeTiers?: boolean,
  prioritizeDonations?: boolean
): { merged: Request[]; added: number; skipped: number } {
  const existingIds = new Set(existing.map(r => r.id));
  const newReqs = selected.filter(r => !existingIds.has(r.id));
  return {
    merged: sortRequests([...existing, ...newReqs], sortMode, priority, prioritizeTiers, prioritizeDonations),
    added: newReqs.length,
    skipped: selected.length - newReqs.length,
  };
}

// ---- Pure queue ops, shared by optimistic actions and the PartyKit echo handlers ----
//
// Each returns the SAME array reference when nothing changes, so a zustand
// `set(() => fn(...))` is a no-op (no re-render) for a duplicate/no-op echo.

/** Insert a request at its sorted position. Dedupes by id (returns input unchanged). */
export function insertRequest(
  requests: Request[],
  req: Request,
  sortMode: SortMode,
  priority: string[],
  prioritizeTiers?: boolean,
  prioritizeDonations?: boolean
): Request[] {
  if (requests.some(r => r.id === req.id)) return requests;
  if (sortMode === 'fifo') return [...requests, req];
  const out = [...requests];
  let insertIdx = 0;
  for (let i = 0; i < out.length; i++) {
    if (compareRequests(req, out[i], priority, prioritizeTiers ?? false, prioritizeDonations ?? false) >= 0) {
      insertIdx = i + 1;
    }
  }
  out.splice(insertIdx, 0, req);
  return out;
}

/** Move the request `fromId` to the position of `toId`. No-op if either is missing. */
export function moveRequest(requests: Request[], fromId: number, toId: number): Request[] {
  const fromIdx = requests.findIndex(r => r.id === fromId);
  const toIdx = requests.findIndex(r => r.id === toId);
  if (fromIdx === -1 || toIdx === -1) return requests;
  const out = [...requests];
  const [moved] = out.splice(fromIdx, 1);
  out.splice(toIdx, 0, moved);
  return out;
}

/** Set a request's done state (and doneAt). No-op if the id is absent. */
export function setRequestDone(requests: Request[], id: number, done: boolean, doneAt?: Date): Request[] {
  let changed = false;
  const out = requests.map(r => {
    if (r.id !== id) return r;
    changed = true;
    return { ...r, done, doneAt: done ? (doneAt ?? new Date()) : undefined };
  });
  return changed ? out : requests;
}
