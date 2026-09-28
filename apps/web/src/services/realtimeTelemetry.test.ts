import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RealtimeTelemetry, ACK_TIMEOUT_MS, describeSocketUrl, tokenTtlSeconds, type TelemetryContext } from './realtimeTelemetry';
import type { PartyMessage, Request, SerializedRequest } from '../types';

vi.mock('./analytics', () => ({ track: vi.fn() }));

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64(payload)}.sig`;
}

function req(id: number, over: Partial<Request> = {}): Request {
  return {
    id, timestamp: new Date(0), donor: 'd', amount: '', amountVal: 0, message: '', character: 'Meg',
    type: 'survivor', source: 'chat', done: false, ...over,
  };
}

function ser(id: number, over: Partial<SerializedRequest> = {}): SerializedRequest {
  return {
    id, timestamp: new Date(0).toISOString(), donor: 'd', amount: '', amountVal: 0, message: '', character: 'Meg',
    type: 'survivor', source: 'chat', done: false, ...over,
  };
}

const SOURCES = {} as never;
const CHANNEL = { status: 'online' as const, owner: null };
const syncFull = (requests: SerializedRequest[]): PartyMessage => ({ type: 'sync-full', requests, sources: SOURCES, channel: CHANNEL });

describe('RealtimeTelemetry', () => {
  let now: number;
  let emit: ReturnType<typeof vi.fn<(event: string, props: Record<string, unknown>) => void>>;
  let local: Request[];
  let t: RealtimeTelemetry;

  const ctx = (over: Partial<TelemetryContext> = {}): TelemetryContext => ({
    channel: 'Streamer',
    isOwner: true,
    getHasLock: () => true,
    getRoomHasOwner: () => false,
    getRequests: () => local,
    ...over,
  });
  const events = (name?: string) => emit.mock.calls.filter(([e]) => !name || e === name).map(([e, p]) => ({ event: e, ...p }));

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    emit = vi.fn();
    local = [];
    t = new RealtimeTelemetry(emit, () => now);
    t.setContext(ctx());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports nothing for viewers', () => {
    t.setContext(ctx({ isOwner: false }));
    t.onOpen({ tokenPresent: false, tokenTtlS: null });
    t.onMessage(syncFull([ser(1)]));
    t.onSend({ type: 'toggle-done', id: 1, done: true }, true);
    t.onMessage({ type: 'server-error', code: 'not_room_owner', message: '' });
    t.onClose({});
    expect(emit).not.toHaveBeenCalled();
  });

  it('tags every event with the channel and lock state', () => {
    t.onOpen({ tokenPresent: true, tokenTtlS: 3000 });
    expect(events()[0]).toMatchObject({ event: 'fila_party_connected', channel: 'streamer', has_lock: true, reconnect: false });
  });

  describe('mutations', () => {
    beforeEach(() => {
      t.onMessage(syncFull([ser(1), ser(2)]));
      emit.mockClear();
    });

    it('acks an edit when its echo comes back', () => {
      t.onSend({ type: 'toggle-done', id: 1, done: true }, true);
      now += 40;
      t.onMessage({ type: 'toggle-done', id: 1, done: true, doneAt: 'x' });
      expect(events()).toEqual([expect.objectContaining({ event: 'fila_mutation_acked', mutation: 'toggle-done', latency_ms: 40 })]);
    });

    it("ignores someone else's edits", () => {
      t.onMessage({ type: 'toggle-done', id: 2, done: true });
      expect(emit).not.toHaveBeenCalled();
    });

    it('attributes not_room_owner to the oldest pending edit — the silent ✓', () => {
      t.onSend({ type: 'toggle-done', id: 1, done: true }, true);
      t.onSend({ type: 'toggle-done', id: 2, done: true }, true);
      t.onMessage({ type: 'server-error', code: 'not_room_owner', message: '' });
      expect(events('fila_mutation_rejected')).toEqual([
        expect.objectContaining({ code: 'not_room_owner', mutation: 'toggle-done', room_has_owner: false }),
      ]);
      // The second one is still pending and times out if nothing answers it.
      vi.advanceTimersByTime(5_000);
      now += ACK_TIMEOUT_MS;
      vi.advanceTimersByTime(ACK_TIMEOUT_MS);
      expect(events('fila_mutation_unacked')).toEqual([expect.objectContaining({ mutation: 'toggle-done', reason: 'timeout' })]);
    });

    it('matches pending_cap to the add it names', () => {
      t.onSend({ type: 'toggle-done', id: 1, done: true }, true);
      t.onSend({ type: 'add-request', request: ser(9) }, true);
      t.onMessage({ type: 'server-error', code: 'pending_cap', message: '', id: 9 });
      expect(events('fila_mutation_rejected')[0]).toMatchObject({ code: 'pending_cap', mutation: 'add-request' });
    });

    it('reports an edit made while the socket is down as dropped', () => {
      t.onSend({ type: 'toggle-done', id: 1, done: true }, false);
      expect(events()).toEqual([expect.objectContaining({ event: 'fila_mutation_dropped', mutation: 'toggle-done' })]);
    });

    it("doesn't wait for echoes the server never sends", () => {
      // Duplicate add (server skips it silently) and an id the server doesn't hold.
      t.onSend({ type: 'add-request', request: ser(1) }, true);
      t.onSend({ type: 'toggle-done', id: 99, done: true }, true);
      now += ACK_TIMEOUT_MS * 2;
      vi.advanceTimersByTime(ACK_TIMEOUT_MS * 2);
      expect(emit).not.toHaveBeenCalled();
    });

    it('reports pending edits as unacked when the socket closes under them', () => {
      t.onOpen({ tokenPresent: true, tokenTtlS: 100 });
      t.onSend({ type: 'delete-request', id: 2 }, true);
      t.onClose({ code: 1006, wasClean: false });
      expect(events('fila_party_disconnected')[0]).toMatchObject({ code: 1006, clean: false, pending_mutations: 1 });
      expect(events('fila_mutation_unacked')[0]).toMatchObject({ mutation: 'delete-request', reason: 'disconnected' });
    });

    it('reports other server errors by code', () => {
      t.onMessage({ type: 'server-error', code: 'd1_sync_failed', message: '' });
      expect(events()).toEqual([expect.objectContaining({ event: 'fila_server_error', code: 'd1_sync_failed' })]);
    });
  });

  describe('owner rejection and recovery', () => {
    it('reports a claim denied as not-room-owner, then the recovery when the lock is granted', () => {
      t.onMessage({ type: 'ownership-denied', currentOwner: 'not-room-owner' });
      now += 5_000;
      t.onMessage({ type: 'server-error', code: 'not_room_owner', message: '' });
      now += 55_000;
      t.onMessage({ type: 'ownership-granted' });
      expect(events('fila_claim_denied')[0]).toMatchObject({ reason: 'not-room-owner' });
      expect(events('fila_owner_recovered')[0]).toMatchObject({ via: 'granted', ms_since_rejection: 60_000, rejections: 2 });
    });

    it('treats a hand-over to another window as a transfer, not a rejection', () => {
      t.onMessage({ type: 'ownership-denied', currentOwner: 'streamer' });
      t.onMessage({ type: 'ownership-granted' });
      expect(events('fila_claim_denied')[0]).toMatchObject({ reason: 'transferred' });
      expect(events('fila_owner_recovered')).toHaveLength(0);
    });
  });

  describe('sync divergence', () => {
    it('reports ✓s that the first sync after a reload undoes', () => {
      const doneAt = new Date(now - 3 * 24 * 36e5);
      local = [req(1, { done: true, doneAt }), req(2, { done: true, doneAt: new Date(now - 36e5) }), req(3)];
      t.onMessage(syncFull([ser(1), ser(2), ser(3)]));
      expect(events('fila_sync_diverged')[0]).toMatchObject({
        initial: true,
        reverted_done: 2,
        reverted_undone: 0,
        lost_pending: 0,
        reverted_done_ids: [1, 2],
        oldest_reverted_done_age_h: 72,
      });
    });

    it('reports divergence on a reconnect sync, and edits the server never got', () => {
      t.onMessage(syncFull([ser(1)]));
      local = [req(1, { done: true }), req(5)];
      now += 10_000;
      t.onMessage(syncFull([ser(1)]));
      expect(events('fila_sync_diverged')[0]).toMatchObject({ initial: false, reverted_done: 1, lost_pending: 1, lost_pending_ids: [5], ms_since_last_sync: 10_000 });
    });

    it('ignores what the server prunes on its own', () => {
      // Done rows past the recent window and discarded ('none') rows are pruned server-side.
      local = [req(1, { done: true }), req(2, { type: 'none' }), req(3)];
      t.onMessage(syncFull([ser(3)]));
      expect(events('fila_sync_diverged')).toHaveLength(0);
    });
  });

  describe('connection lifecycle', () => {
    it('reports reconnects with downtime, failed attempts and the token they presented', () => {
      t.onOpen({ tokenPresent: true, tokenTtlS: 3500 });
      now += 60_000;
      t.onClose({ code: 1006, wasClean: false });
      t.onClose({}); // attempt that never opened
      t.onClose({});
      now += 4_000;
      t.onOpen({ tokenPresent: true, tokenTtlS: -120 });
      expect(events('fila_party_disconnected')[0]).toMatchObject({ connected_ms: 60_000 });
      expect(events('fila_party_connected')[1]).toMatchObject({
        reconnect: true,
        downtime_ms: 4_000,
        failed_attempts: 2,
        token_present: true,
        token_ttl_s: -120,
        token_expired: true,
      });
    });

    it('starts over on a channel change', () => {
      t.onOpen({ tokenPresent: true, tokenTtlS: 1 });
      t.setContext(ctx({ channel: 'other' }));
      t.onOpen({ tokenPresent: true, tokenTtlS: 1 });
      expect(events('fila_party_connected')[1]).toMatchObject({ channel: 'other', reconnect: false });
    });
  });
});

describe('token helpers', () => {
  it('reads the TTL without exposing the token', () => {
    const now = Date.UTC(2026, 0, 1);
    const token = jwt({ exp: now / 1000 + 600 });
    expect(tokenTtlSeconds(token, now)).toBe(600);
    const info = describeSocketUrl(`wss://party.example/parties/main/room?token=${token}&v=1`, now);
    expect(info).toEqual({ tokenPresent: true, tokenTtlS: 600 });
    expect(JSON.stringify(info)).not.toContain(token);
  });

  it('handles an anonymous or unreadable socket URL', () => {
    expect(describeSocketUrl('wss://party.example/parties/main/room?v=1')).toEqual({ tokenPresent: false, tokenTtlS: null });
    expect(describeSocketUrl('')).toEqual({ tokenPresent: false, tokenTtlS: null });
    expect(tokenTtlSeconds('garbage')).toBeNull();
  });
});
