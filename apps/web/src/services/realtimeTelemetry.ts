// Realtime health telemetry for the streamer's own session.
//
// The failure this exists for: every edit is optimistic, so a socket the server no
// longer accepts as the channel owner shows each ✓ as landed while the server refuses
// it (`server-error: not_room_owner`), and only a reload reveals the truth. Each event
// below is one link in that chain, observed at the socket (services/party.ts):
//
//   fila_party_connected / fila_party_disconnected  socket lifecycle, with whether the
//                                                   (re)connect presented a token and how
//                                                   long that token had left to live
//   fila_mutation_acked / _rejected / _unacked /    every edit we send, and what became
//   _dropped                                        of it: echoed, refused (with the
//                                                   code), never answered, or never sent
//   fila_claim_denied / fila_owner_recovered        the lock refused as not-room-owner,
//                                                   and the session coming back from it
//   fila_sync_diverged                              an authoritative sync-full that undoes
//                                                   what this window showed — the ✓ that
//                                                   comes back after F5
//   fila_server_error                               persist_failed, d1_sync_failed, …
//
// Only the streamer's own channel reports (viewers never edit). Nothing here may carry
// a token: the socket URL is reduced to token_present / token_ttl_s before it leaves.
import type { PartyMessage, Request } from '../types';
import { track, type Properties } from './analytics';

export interface TelemetryContext {
  channel: string;
  /** This window is the streamer on their own channel. Nothing is reported otherwise. */
  isOwner: boolean;
  getHasLock: () => boolean;
  getRoomHasOwner: () => boolean;
  /** Current (optimistic) queue, read before a sync-full replaces it. */
  getRequests: () => Request[];
}

export interface OpenInfo {
  tokenPresent: boolean;
  /** Seconds until the presented token's `exp`, by this machine's clock. Null without one. */
  tokenTtlS: number | null;
}

export interface CloseInfo {
  code?: number;
  wasClean?: boolean;
}

type Emit = (event: string, props: Properties) => void;

/** An edit with no echo after this long is reported as unacked. */
export const ACK_TIMEOUT_MS = 15_000;
const SWEEP_INTERVAL_MS = 5_000;
const MAX_REPORTED_IDS = 5;

// Authority rejections: the server refused the edit itself.
const REJECTION_CODES = new Set(['not_room_owner', 'not_lock_holder', 'pending_cap']);

interface PendingMutation {
  kind: string;
  key: string;
  sentAt: number;
  id?: number;
}

/**
 * The key an edit's echo will carry, or null when the server won't echo it (the
 * request isn't in its state — a duplicate add, a pruned id — so waiting for an ack
 * would only report false timeouts) or the message isn't an edit.
 */
function mutationKey(msg: PartyMessage, serverIds: Set<number>): { kind: string; key: string; id?: number } | null {
  switch (msg.type) {
    case 'add-request':
      if (serverIds.has(msg.request.id)) return null; // server skips duplicates silently
      return { kind: msg.type, key: `add:${msg.request.id}`, id: msg.request.id };
    case 'update-request':
      if (!serverIds.has(msg.id)) return null;
      return { kind: msg.type, key: `update:${msg.id}`, id: msg.id };
    case 'toggle-done':
      if (!serverIds.has(msg.id)) return null;
      return { kind: msg.type, key: `toggle:${msg.id}:${msg.done}`, id: msg.id };
    case 'delete-request':
      if (!serverIds.has(msg.id)) return null;
      return { kind: msg.type, key: `delete:${msg.id}`, id: msg.id };
    case 'reorder':
      if (!msg.opId || !serverIds.has(msg.fromId) || !serverIds.has(msg.toId)) return null;
      return { kind: msg.type, key: `reorder:${msg.opId}` };
    case 'set-all':
      return { kind: msg.type, key: 'set-all' };
    case 'update-sources':
      return { kind: msg.type, key: 'sources' };
    default:
      return null;
  }
}

function echoKey(msg: PartyMessage): string | null {
  switch (msg.type) {
    case 'add-request': return `add:${msg.request.id}`;
    case 'update-request': return `update:${msg.id}`;
    case 'toggle-done': return `toggle:${msg.id}:${msg.done}`;
    case 'delete-request': return `delete:${msg.id}`;
    case 'reorder': return msg.opId ? `reorder:${msg.opId}` : null;
    case 'set-all': return 'set-all';
    case 'update-sources': return 'sources';
    default: return null;
  }
}

/** Reads a JWT's `exp` without verifying it — only ever to report a TTL, never the token. */
export function tokenTtlSeconds(token: string | null | undefined, now = Date.now()): number | null {
  if (!token) return null;
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? Math.round(json.exp - now / 1000) : null;
  } catch {
    return null;
  }
}

/** token_present / token_ttl_s from a socket URL. The URL itself is never reported. */
export function describeSocketUrl(url: string | undefined, now = Date.now()): OpenInfo {
  if (!url) return { tokenPresent: false, tokenTtlS: null };
  try {
    const token = new URL(url).searchParams.get('token');
    return { tokenPresent: !!token, tokenTtlS: tokenTtlSeconds(token, now) };
  } catch {
    return { tokenPresent: false, tokenTtlS: null };
  }
}

export class RealtimeTelemetry {
  private ctx: TelemetryContext | null = null;
  private pending: PendingMutation[] = [];
  private serverIds = new Set<number>();
  private sweepTimer: ReturnType<typeof setTimeout> | null = null;

  private isOpen = false;
  private openedAt = 0;
  private closedAt = 0;
  private everOpened = false;
  private failedAttempts = 0;
  private syncsSeen = 0;
  private lastSyncAt = 0;

  // Since the server first refused this session as the owner, until it accepts it again.
  private rejectedSince: number | null = null;
  private rejections = 0;

  constructor(private emit: Emit, private now: () => number = Date.now) {}

  setContext(ctx: TelemetryContext | null): void {
    const channelChanged = ctx?.channel !== this.ctx?.channel;
    this.ctx = ctx;
    if (channelChanged) this.resetSession();
  }

  private resetSession() {
    this.pending = [];
    this.serverIds.clear();
    this.clearSweep();
    this.isOpen = false;
    this.everOpened = false;
    this.failedAttempts = 0;
    this.syncsSeen = 0;
    this.rejectedSince = null;
    this.rejections = 0;
  }

  private get active(): boolean {
    return !!this.ctx?.isOwner;
  }

  private report(event: string, props: Properties = {}) {
    if (!this.ctx?.isOwner) return;
    this.emit(event, {
      channel: this.ctx.channel.toLowerCase(),
      has_lock: this.ctx.getHasLock(),
      ...props,
    });
  }

  // ---------- outgoing ----------

  /** Called for every message this window tries to send, before the open check. */
  onSend(msg: PartyMessage, socketOpen: boolean): void {
    if (!this.active) return;
    const m = mutationKey(msg, this.serverIds);
    if (!socketOpen) {
      // The optimistic change is already on screen; the edit itself goes nowhere.
      if (m) this.report('fila_mutation_dropped', { mutation: m.kind });
      return;
    }
    if (!m) return;
    this.pending.push({ ...m, sentAt: this.now() });
    this.armSweep();
  }

  // ---------- incoming ----------

  /** Called for every message from the server, before the stores apply it. */
  onMessage(msg: PartyMessage): void {
    if (!this.ctx) return;
    switch (msg.type) {
      case 'sync-full':
        if (this.active) this.checkDivergence(msg.requests.map((r) => ({ id: r.id, done: !!r.done, type: r.type })));
        this.serverIds = new Set(msg.requests.map((r) => r.id));
        this.syncsSeen++;
        this.lastSyncAt = this.now();
        return;
      case 'set-all':
        this.serverIds = new Set(msg.requests.map((r) => r.id));
        break;
      case 'add-request':
        this.serverIds.add(msg.request.id);
        break;
      case 'delete-request':
        this.serverIds.delete(msg.id);
        break;
      case 'ownership-granted':
        this.recovered('granted');
        return;
      case 'ownership-denied': {
        const notOwner = msg.currentOwner === 'not-room-owner';
        this.report('fila_claim_denied', { reason: notOwner ? 'not-room-owner' : 'transferred' });
        if (notOwner) this.markRejected();
        return;
      }
      case 'server-error':
        this.onServerError(msg);
        return;
    }
    const key = echoKey(msg);
    if (!key) return;
    const idx = this.pending.findIndex((p) => p.key === key);
    if (idx === -1) return; // someone else's edit
    const [p] = this.pending.splice(idx, 1);
    this.report('fila_mutation_acked', { mutation: p.kind, latency_ms: this.now() - p.sentAt });
    this.recovered('ack');
  }

  private onServerError(msg: Extract<PartyMessage, { type: 'server-error' }>) {
    if (!REJECTION_CODES.has(msg.code)) {
      this.report('fila_server_error', { code: msg.code });
      return;
    }
    let mutation = 'unknown';
    let latency: number | undefined;
    if (msg.code === 'not_lock_holder') {
      // Only irc-status is lock-gated, and it has no echo to wait for.
      mutation = 'irc-status';
    } else {
      // pending_cap names its request; not_room_owner answers our oldest edit (the
      // server handles one socket's messages in order).
      const idx = typeof msg.id === 'number'
        ? this.pending.findIndex((p) => p.id === msg.id && p.kind === 'add-request')
        : 0;
      const p = idx >= 0 ? this.pending.splice(idx, 1)[0] : undefined;
      if (p) {
        mutation = p.kind;
        latency = this.now() - p.sentAt;
      }
    }
    this.report('fila_mutation_rejected', {
      code: msg.code,
      mutation,
      ...(latency !== undefined ? { latency_ms: latency } : {}),
      room_has_owner: this.ctx?.getRoomHasOwner() ?? null,
    });
    if (msg.code === 'not_room_owner') this.markRejected();
  }

  private markRejected() {
    this.rejections++;
    if (this.rejectedSince === null) this.rejectedSince = this.now();
  }

  private recovered(via: 'granted' | 'ack') {
    if (this.rejectedSince === null) return;
    this.report('fila_owner_recovered', {
      via,
      ms_since_rejection: this.now() - this.rejectedSince,
      rejections: this.rejections,
    });
    this.rejectedSince = null;
    this.rejections = 0;
  }

  private checkDivergence(server: { id: number; done: boolean; type: string }[]) {
    const local = this.ctx!.getRequests();
    const byId = new Map(server.map((r) => [r.id, r]));
    const now = this.now();
    const revertedDone: number[] = [];
    const revertedUndone: number[] = [];
    const lostPending: number[] = [];
    let oldestRevertedDoneAt: number | null = null;
    for (const r of local) {
      const s = byId.get(r.id);
      if (!s) {
        // Done rows are pruned server-side and 'none' rows on close — both expected.
        if (!r.done && r.type !== 'none') lostPending.push(r.id);
        continue;
      }
      if (r.done && !s.done) {
        revertedDone.push(r.id);
        const at = r.doneAt?.getTime();
        if (at && (oldestRevertedDoneAt === null || at < oldestRevertedDoneAt)) oldestRevertedDoneAt = at;
      } else if (!r.done && s.done) {
        revertedUndone.push(r.id);
      }
    }
    if (!revertedDone.length && !revertedUndone.length && !lostPending.length) return;
    this.report('fila_sync_diverged', {
      // First sync of this page: the local side is the queue cache, i.e. what the
      // streamer saw before reloading.
      initial: this.syncsSeen === 0,
      reverted_done: revertedDone.length,
      reverted_undone: revertedUndone.length,
      lost_pending: lostPending.length,
      reverted_done_ids: revertedDone.slice(0, MAX_REPORTED_IDS),
      lost_pending_ids: lostPending.slice(0, MAX_REPORTED_IDS),
      ...(oldestRevertedDoneAt !== null ? { oldest_reverted_done_age_h: Math.round((now - oldestRevertedDoneAt) / 36e5 * 10) / 10 } : {}),
      ...(this.syncsSeen > 0 ? { ms_since_last_sync: now - this.lastSyncAt } : {}),
      local_count: local.length,
      server_count: server.length,
    });
  }

  // ---------- socket lifecycle ----------

  onOpen(info: OpenInfo): void {
    const now = this.now();
    const reconnect = this.everOpened;
    this.report('fila_party_connected', {
      reconnect,
      token_present: info.tokenPresent,
      token_ttl_s: info.tokenTtlS,
      token_expired: info.tokenTtlS !== null && info.tokenTtlS <= 0,
      failed_attempts: this.failedAttempts,
      ...(reconnect ? { downtime_ms: now - this.closedAt } : {}),
    });
    this.isOpen = true;
    this.everOpened = true;
    this.openedAt = now;
    this.failedAttempts = 0;
  }

  onClose(info: CloseInfo = {}): void {
    if (!this.isOpen) {
      // A reconnect attempt that never opened.
      this.failedAttempts++;
      return;
    }
    const now = this.now();
    this.isOpen = false;
    this.closedAt = now;
    this.report('fila_party_disconnected', {
      connected_ms: now - this.openedAt,
      code: info.code ?? null,
      clean: info.wasClean ?? null,
      pending_mutations: this.pending.length,
    });
    // Their echo, if any, went to a socket that no longer exists. The next sync-full
    // shows whether they landed (fila_sync_diverged if not).
    for (const p of this.pending) {
      this.report('fila_mutation_unacked', { mutation: p.kind, reason: 'disconnected', age_ms: now - p.sentAt });
    }
    this.pending = [];
    this.clearSweep();
  }

  // ---------- timeouts ----------

  sweep(): void {
    this.sweepTimer = null;
    const now = this.now();
    const expired = this.pending.filter((p) => now - p.sentAt >= ACK_TIMEOUT_MS);
    if (expired.length) {
      this.pending = this.pending.filter((p) => now - p.sentAt < ACK_TIMEOUT_MS);
      for (const p of expired) {
        this.report('fila_mutation_unacked', { mutation: p.kind, reason: 'timeout', age_ms: now - p.sentAt });
      }
    }
    this.armSweep();
  }

  private armSweep() {
    if (this.sweepTimer || this.pending.length === 0) return;
    this.sweepTimer = setTimeout(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  private clearSweep() {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }
}

export const realtimeTelemetry = new RealtimeTelemetry(track);
