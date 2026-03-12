import type * as Party from 'partykit/server';
import { verifyJwt, type JwtPayload } from './jwt';
import { MAX_PENDING_REQUESTS } from '@dbd-utils/shared';
import type { SerializedRequest, SourcesSettings, ChannelState, PartyMessage } from '@dbd-utils/shared';

const SOURCES_DEFAULTS: SourcesSettings = {
  enabled: { donation: true, chat: true, resub: false, manual: true },
  chatCommand: '!fila',
  chatTiers: [2, 3],
  priority: ['donation', 'chat', 'resub', 'manual'],
  sortMode: 'fifo',
  minDonation: 5,
};

interface ConnectionInfo {
  user: JwtPayload | null;
}

export default class PartyServer implements Party.Server {
  requests: SerializedRequest[] = [];
  sources: SourcesSettings = SOURCES_DEFAULTS;
  channel: ChannelState = { status: 'offline', owner: null };
  connections: Map<string, ConnectionInfo> = new Map();
  activeOwnerConnId: string | null = null;
  private syncRequestsTimer: ReturnType<typeof setTimeout> | null = null;
  private dirtyRequestIds = new Set<number>();
  private needsFullSync = false;
  private lastSyncedStatus: string | null = null;
  private d1SyncFailCount = 0;
  private static readonly D1_SYNC_FAIL_NOTIFY = 3;

  constructor(public room: Party.Room) { }

  async onStart() {
    console.log(`${this.tag} Starting`);

    const legacy = await this.room.storage.get<SerializedRequest[]>('requests');
    if (legacy) {
      await this.migrateLegacyStorage(legacy);
    } else {
      await this.loadPerKeyStorage();
    }

    const storedSources = await this.room.storage.get<Partial<SourcesSettings>>('sources');
    if (storedSources) {
      this.sources = { ...SOURCES_DEFAULTS, ...storedSources };
      console.log(`${this.tag} Loaded sources config:`, JSON.stringify(this.sources.enabled));
    }
  }

  private async migrateLegacyStorage(legacy: SerializedRequest[]) {
    await this.room.storage.delete('requests');
    if (legacy.length === 0) return;

    const pending = legacy.filter(r => !r.done);
    const entries: Record<string, SerializedRequest> = {};
    for (const r of pending) entries[`req:${r.id}`] = r;
    await this.room.storage.put(entries);
    await this.room.storage.put('order', pending.map(r => r.id));
    this.requests = pending;
    console.log(`${this.tag} Migrated ${pending.length} requests to per-key storage`);
  }

  private async loadPerKeyStorage() {
    const entries = await this.room.storage.list<SerializedRequest>({ prefix: 'req:' });
    const order = await this.room.storage.get<number[]>('order');

    if (entries.size > 0) {
      this.requests = this.orderRequests(entries, order ?? null);
      console.log(`${this.tag} Loaded ${this.requests.length} requests from per-key storage`);
    } else {
      const recovered = await this.recoverFromD1();
      if (recovered) {
        this.requests = recovered;
        await this.persistAll();
        console.log(`${this.tag} Recovered ${recovered.length} requests from D1`);
      }
    }
  }

  private orderRequests(entries: Map<string, SerializedRequest>, orderedIds: number[] | null): SerializedRequest[] {
    const byId = new Map<number, SerializedRequest>();
    for (const [, req] of entries) byId.set(req.id, req);
    if (!orderedIds) return [...byId.values()];

    const idSet = new Set(orderedIds);
    const ordered = orderedIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
    const orphans = [...byId.values()].filter(r => !idSet.has(r.id));
    return [...ordered, ...orphans];
  }

  private async persistAll() {
    const entries: Record<string, SerializedRequest> = {};
    for (const r of this.requests) entries[`req:${r.id}`] = r;
    await this.room.storage.put(entries);
    await this.room.storage.put('order', this.requests.map(r => r.id));
  }

  async onRequest(req: Party.Request) {
    if (req.method === 'POST') {
      const secret = this.room.env.INTERNAL_API_SECRET as string | undefined;
      const authHeader = req.headers.get('Authorization');
      if (!secret || authHeader !== `Bearer internal:${secret}`) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      const body = await req.json<{ action: string }>();
      if (body.action === 'recover-from-d1') {
        const existing = await this.room.storage.list({ prefix: 'req:' });
        if (existing.size > 0) {
          await this.room.storage.delete([...existing.keys()]);
        }
        await this.room.storage.delete('order');
        const recovered = await this.recoverFromD1();
        if (recovered) {
          this.requests = recovered;
          await this.persistAll();
        } else {
          this.requests = [];
        }
        // Broadcast to connected clients
        const msg: PartyMessage = { type: 'sync-full', requests: this.requests, sources: this.sources, channel: this.channel };
        for (const conn of this.room.getConnections()) conn.send(JSON.stringify(msg));
        console.log(`${this.tag} Forced D1 recovery: ${this.requests.length} requests`);
        return Response.json({ ok: true, recovered: this.requests.length });
      }
      return Response.json({ error: 'unknown_action' }, { status: 400 });
    }
    return Response.json({
      status: this.channel.status,
      connections: this.connections.size,
      pending_count: this.requests.filter(r => !r.done).length,
    });
  }

  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const url = new URL(ctx.request.url);
    const token = url.searchParams.get('token');
    const clientVersion = url.searchParams.get('v') || 'unknown';
    const roomOwner = this.room.id.toLowerCase();

    let user: JwtPayload | null = null;

    if (token) {
      const jwtSecret = this.room.env.JWT_SECRET as string;
      if (!jwtSecret) {
        console.warn(`${this.tag} JWT_SECRET not configured`);
      } else {
        user = await verifyJwt(token, jwtSecret);
        if (user) {
          console.log(`${this.tag} Auth: ${user.login.toLowerCase()}`);
        } else {
          console.warn(`${this.tag} JWT verification failed for conn ${conn.id}`);
        }
      }
    } else {
      console.log(`${this.tag} Anonymous connection ${conn.id}`);
    }

    this.connections.set(conn.id, { user });
    console.log(`${this.tag} Connected: ${conn.id} (${user?.login ?? 'anon'}) v${clientVersion} - ${this.connections.size} total`);

    // Version check — outdated clients get an error and no sync
    const expectedVersion = this.room.env.APP_VERSION as string | undefined;
    if (expectedVersion && clientVersion !== expectedVersion) {
      const errorMsg: PartyMessage = {
        type: 'server-error',
        code: 'version_mismatch',
        message: 'Nova versão disponível. Recarregue a página.',
      };
      conn.send(JSON.stringify(errorMsg));
      console.warn(`${this.tag} Version mismatch: client=${clientVersion}, server=${expectedVersion}`);
      return;
    }

    // Send current state - client will see channel.owner to know if someone else has ownership
    const syncMsg: PartyMessage = { type: 'sync-full', requests: this.requests, sources: this.sources, channel: this.channel };
    conn.send(JSON.stringify(syncMsg));
  }

  onClose(conn: Party.Connection) {
    const info = this.connections.get(conn.id);
    this.connections.delete(conn.id);
    console.log(`${this.tag} Disconnected: ${conn.id} (${info?.user?.login ?? 'anon'}) - ${this.connections.size} remaining`);

    if (this.activeOwnerConnId === conn.id) {
      this.activeOwnerConnId = null;
      this.channel = { status: 'offline', owner: null };
      this.flushAndSyncOffline();
    }
  }

  onError(conn: Party.Connection, error: unknown) {
    console.error(`${this.tag} Error on ${conn.id}:`, error);
    this.connections.delete(conn.id);

    if (this.activeOwnerConnId === conn.id) {
      this.activeOwnerConnId = null;
      this.channel = { status: 'offline', owner: null };
      this.flushAndSyncOffline();
    }
  }

  async onMessage(message: string, sender: Party.Connection) {
    let msg: PartyMessage;
    try {
      msg = JSON.parse(message);
    } catch (e) {
      console.error(`${this.tag} Invalid JSON from ${sender.id}:`, e);
      return;
    }

    const connInfo = this.connections.get(sender.id);
    const isRoomOwner = connInfo?.user?.login.toLowerCase() === this.room.id.toLowerCase();
    const isLockHolder = this.activeOwnerConnId === sender.id;

    // Handle claim-ownership - anyone can send this
    if (msg.type === 'claim-ownership') {
      if (!isRoomOwner && !(this.isDev && connInfo?.user)) {
        const denyMsg: PartyMessage = { type: 'ownership-denied', currentOwner: 'not-room-owner' };
        sender.send(JSON.stringify(denyMsg));
        console.log(`${this.tag} Denied ownership to ${connInfo?.user?.login ?? sender.id}: not room owner`);
        return;
      }
      if (this.activeOwnerConnId && this.activeOwnerConnId !== sender.id) {
        const owner = this.connections.get(this.activeOwnerConnId);
        const denyMsg: PartyMessage = { type: 'ownership-denied', currentOwner: owner?.user?.login || 'unknown' };
        sender.send(JSON.stringify(denyMsg));
        console.log(`${this.tag} Denied ownership to ${connInfo?.user?.login}: ${owner?.user?.login} holds the lock`);
        return;
      }
      // Grant ownership
      this.activeOwnerConnId = sender.id;
      const login = connInfo?.user?.login ?? 'dev';
      this.channel = {
        status: 'online',
        owner: { login, displayName: connInfo?.user?.display_name ?? login, avatar: connInfo?.user?.profile_image_url ?? '' }
      };
      const grantMsg: PartyMessage = { type: 'ownership-granted' };
      sender.send(JSON.stringify(grantMsg));
      this.broadcastChannel();
      this.needsFullSync = true;
      this.syncRequestsToD1();
      this.syncSourcesToD1();
      console.log(`${this.tag} Granted ownership to ${login}`);
      return;
    }

    // Handle release-ownership - only lock holder can release
    if (msg.type === 'release-ownership') {
      if (isLockHolder) {
        this.activeOwnerConnId = null;
        this.channel = { status: 'offline', owner: null };
        this.flushAndSyncOffline();
        console.log(`${this.tag} ${connInfo?.user?.login} released ownership`);
      }
      return;
    }

    // Lock-only: IRC status (controls channel live/online state)
    if (msg.type === 'irc-status' && !isLockHolder) {
      const errorMsg: PartyMessage = {
        type: 'server-error',
        code: 'not_lock_holder',
        message: 'Você precisa estar conectado para gerenciar a fila.',
      };
      sender.send(JSON.stringify(errorMsg));
      console.warn(`${this.tag} Rejected ${msg.type} from non-lock-holder ${connInfo?.user?.login ?? sender.id}`);
      return;
    }

    // Everything else: room owner required
    if (msg.type !== 'irc-status' && !isRoomOwner && !(this.isDev && connInfo?.user)) {
      const errorMsg: PartyMessage = {
        type: 'server-error',
        code: 'not_room_owner',
        message: 'Apenas o dono do canal pode gerenciar a fila.',
      };
      sender.send(JSON.stringify(errorMsg));
      console.warn(`${this.tag} Rejected ${msg.type} from non-owner ${connInfo?.user?.login ?? sender.id}`);
      return;
    }

    const user = connInfo?.user?.login ?? 'unknown';
    switch (msg.type) {
      case 'add-request': {
        if (this.requests.some(r => r.id === msg.request.id)) {
          console.log(`${this.tag} ${user}: add-request #${msg.request.id} skipped (duplicate)`);
          break;
        }
        const pendingCount = this.requests.filter(r => !r.done).length;
        if (pendingCount >= MAX_PENDING_REQUESTS) {
          this.sendError('pending_cap', `Fila cheia (${MAX_PENDING_REQUESTS}). Marque pedidos como feitos para liberar espaço.`);
          console.warn(`${this.tag} ${user}: add-request #${msg.request.id} rejected (pending cap ${MAX_PENDING_REQUESTS})`);
          break;
        }
        this.requests.push(msg.request);
        this.dirtyRequestIds.add(msg.request.id);
        await this.persist();
        this.broadcast(message);
        console.log(`${this.tag} ${user}: add-request #${msg.request.id} "${msg.request.character}" (${msg.request.source})`);
        break;
      }
      case 'update-request': {
        const idx = this.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          this.requests[idx] = { ...this.requests[idx], ...msg.updates };
          this.dirtyRequestIds.add(msg.id);
          await this.persist();
          this.broadcast(message);
          console.log(`${this.tag} ${user}: update-request #${msg.id}`, Object.keys(msg.updates));
        }
        break;
      }
      case 'toggle-done': {
        const idx = this.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          this.requests[idx].done = msg.done;
          this.requests[idx].doneAt = msg.done
            ? (msg.doneAt ?? new Date().toISOString())
            : undefined;
          this.dirtyRequestIds.add(msg.id);
          await this.persist();
          this.broadcast(JSON.stringify({ type: 'toggle-done', id: msg.id, done: msg.done, doneAt: this.requests[idx].doneAt }));
          console.log(`${this.tag} ${user}: toggle-done #${msg.id} → ${msg.done}`);
        }
        break;
      }
      case 'reorder': {
        const fromIdx = this.requests.findIndex(r => r.id === msg.fromId);
        const toIdx = this.requests.findIndex(r => r.id === msg.toId);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = this.requests.splice(fromIdx, 1);
          this.requests.splice(toIdx, 0, moved);
          this.needsFullSync = true;
          await this.persist(true);
          this.broadcast(message);
          console.log(`${this.tag} ${user}: reorder #${msg.fromId} → position of #${msg.toId}`);
        }
        break;
      }
      case 'delete-request': {
        const idx = this.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          this.requests.splice(idx, 1);
          await this.room.storage.delete(`req:${msg.id}`);
          this.needsFullSync = true;
          await this.persist();
          this.broadcast(message);
          console.log(`${this.tag} ${user}: delete-request #${msg.id}`);
        }
        break;
      }
      case 'set-all': {
        const oldKeys = this.requests.map(r => `req:${r.id}`);
        if (oldKeys.length > 0) await this.room.storage.delete(oldKeys);
        this.requests = msg.requests;
        this.needsFullSync = true;
        await this.persistAll();
        this.scheduleSyncRequests();
        this.broadcast(message);
        console.log(`${this.tag} ${user}: set-all (${msg.requests.length} requests)`);
        break;
      }
      case 'update-sources': {
        this.sources = msg.sources;
        await this.room.storage.put('sources', this.sources);
        this.syncSourcesToD1();
        this.broadcast(message);
        console.log(`${this.tag} ${user}: update-sources`, JSON.stringify(msg.sources.enabled));
        break;
      }
      case 'irc-status': {
        const status = msg.connected ? 'live' : 'online';
        if (this.channel.status !== status) {
          this.channel.status = status;
          this.broadcastChannel();
        }
        console.log(`${this.tag} ${user}: irc-status ${msg.connected}`);
        break;
      }
    }
  }

  private async persist(reorderOnly?: boolean) {
    try {
      if (reorderOnly) {
        await this.room.storage.put('order', this.requests.filter(r => !r.done).map(r => r.id));
      } else {
        const pending = this.requests.filter(r => !r.done);
        const entries: Record<string, SerializedRequest> = {};
        for (const id of this.dirtyRequestIds) {
          const req = pending.find(r => r.id === id);
          if (req) entries[`req:${req.id}`] = req;
        }
        if (Object.keys(entries).length > 0) {
          await this.room.storage.put(entries);
        }
        await this.room.storage.put('order', pending.map(r => r.id));
      }
      this.scheduleSyncRequests(reorderOnly);
    } catch (e) {
      console.error(`${this.tag} PERSIST FAILED (${this.requests.length} requests):`, e);
      this.sendError('persist_failed', 'Erro ao salvar dados localmente. Tentando sincronizar com o banco de dados.');
      this.needsFullSync = true;
      this.scheduleSyncRequests();
    }
  }

  private scheduleSyncRequests(reorderOnly?: boolean) {
    if (this.syncRequestsTimer) clearTimeout(this.syncRequestsTimer);
    const delay = reorderOnly ? 30_000 : 2_000;
    this.syncRequestsTimer = setTimeout(() => this.syncRequestsToD1(), delay);
  }

  private async syncRequestsToD1() {
    const apiUrl = this.room.env.API_URL as string | undefined;
    const secret = this.room.env.INTERNAL_API_SECRET as string | undefined;
    if (!apiUrl || !secret) return;

    // Snapshot and clear dirty IDs — new mutations during sync accumulate fresh
    const syncingIds = new Set(this.dirtyRequestIds);
    this.dirtyRequestIds = new Set();
    const wasFullSync = this.needsFullSync || syncingIds.size === 0;
    if (wasFullSync) this.needsFullSync = false;
    const mode = wasFullSync ? 'full' : 'partial';
    const allWithPositions = this.requests.map((r, i) => ({ ...r, _position: i }));
    const requestsToSync = wasFullSync
      ? allWithPositions
      : allWithPositions.filter(r => syncingIds.has(r.id));

    try {
      const res = await fetch(`${apiUrl}/internal/rooms/${this.room.id}/requests`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer internal:${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ requests: requestsToSync, mode }),
      });
      if (res.ok) {
        this.d1SyncFailCount = 0;
        // Delete done request keys from DO (unless re-dirtied during sync)
        const doneKeys = this.requests
          .filter(r => r.done && !this.dirtyRequestIds.has(r.id))
          .map(r => `req:${r.id}`);
        if (doneKeys.length > 0) {
          await this.room.storage.delete(doneKeys);
        }
        const before = this.requests.length;
        this.requests = this.requests.filter(r => !r.done || this.dirtyRequestIds.has(r.id));
        if (this.requests.length < before) {
          await this.room.storage.put('order', this.requests.map(r => r.id));
          console.log(`${this.tag} Pruned ${before - this.requests.length} done requests`);
        }
        console.log(`${this.tag} D1 synced ${requestsToSync.length} requests (${mode})`);
      } else {
        console.error(`${this.tag} D1 sync requests failed: ${res.status}`);
        for (const id of syncingIds) this.dirtyRequestIds.add(id);
        this.needsFullSync = true;
        this.handleD1SyncFailure();
      }
    } catch (e) {
      console.error(`${this.tag} D1 sync requests error:`, e);
      for (const id of syncingIds) this.dirtyRequestIds.add(id);
      this.needsFullSync = true;
      this.handleD1SyncFailure();
    }
  }

  private handleD1SyncFailure() {
    this.d1SyncFailCount++;
    if (this.d1SyncFailCount === PartyServer.D1_SYNC_FAIL_NOTIFY) {
      this.sendError('d1_sync_failed', 'Sincronização com o banco de dados falhou repetidamente. Dados estão seguros localmente, mas podem ser perdidos se o servidor reiniciar.');
    }
    // Schedule retry with backoff
    this.scheduleSyncRequests();
  }

  private async recoverFromD1(): Promise<SerializedRequest[] | null> {
    const apiUrl = this.room.env.API_URL as string | undefined;
    const secret = this.room.env.INTERNAL_API_SECRET as string | undefined;
    if (!apiUrl || !secret) return null;

    try {
      const res = await fetch(`${apiUrl}/internal/rooms/${this.room.id}/requests`, {
        headers: { 'Authorization': `Bearer internal:${secret}` },
      });
      if (!res.ok) {
        console.error(`${this.tag} D1 recovery failed: ${res.status}`);
        return null;
      }
      const data = await res.json<{ requests: SerializedRequest[] }>();
      return data.requests.length > 0 ? data.requests : null;
    } catch (e) {
      console.error(`${this.tag} D1 recovery error:`, e);
      return null;
    }
  }

  private async syncSourcesToD1() {
    const apiUrl = this.room.env.API_URL as string | undefined;
    const secret = this.room.env.INTERNAL_API_SECRET as string | undefined;
    if (!apiUrl || !secret) return;

    try {
      const res = await fetch(`${apiUrl}/internal/rooms/${this.room.id}/sources`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer internal:${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.sources),
      });
      if (!res.ok) {
        console.error(`${this.tag} D1 sync sources failed: ${res.status}`);
      } else {
        console.log(`${this.tag} D1 synced sources`);
      }
    } catch (e) {
      console.error(`${this.tag} D1 sync sources error:`, e);
    }
  }

  private sendToOwner(msg: PartyMessage) {
    if (!this.activeOwnerConnId) return;
    for (const conn of this.room.getConnections()) {
      if (conn.id === this.activeOwnerConnId) {
        conn.send(JSON.stringify(msg));
        break;
      }
    }
  }

  private sendError(code: string, message: string) {
    this.sendToOwner({ type: 'server-error', code, message });
    console.error(`${this.tag} Error sent to owner: [${code}] ${message}`);
  }

  private broadcast(message: string, excludeId?: string) {
    let count = 0;
    for (const conn of this.room.getConnections()) {
      if (conn.id !== excludeId) {
        conn.send(message);
        count++;
      }
    }
    if (count > 0) {
      console.log(`${this.tag} Broadcast to ${count} client(s)`);
    }
  }

  private get tag() {
    return `[${this.room.id}]`;
  }

  private get isDev() {
    return this.room.env.DEV_MODE === 'true';
  }

  private flushAndSyncOffline() {
    this.broadcastChannel();
    // Cancel pending debounced sync and flush immediately as full sync
    if (this.syncRequestsTimer) {
      clearTimeout(this.syncRequestsTimer);
      this.syncRequestsTimer = null;
    }
    this.needsFullSync = true;
    this.syncRequestsToD1();
  }

  private broadcastChannel() {
    const msg = JSON.stringify({ type: 'update-channel', channel: this.channel });
    let count = 0;
    for (const conn of this.room.getConnections()) {
      conn.send(msg);
      count++;
    }
    console.log(`${this.tag} Broadcast channel state to ${count} client(s): status=${this.channel.status}, owner=${this.channel.owner?.login ?? 'null'}`);
    if (this.channel.status !== this.lastSyncedStatus) {
      this.lastSyncedStatus = this.channel.status;
      this.syncStatusToD1();
    }
  }

  private async syncStatusToD1() {
    const apiUrl = this.room.env.API_URL as string | undefined;
    const secret = this.room.env.INTERNAL_API_SECRET as string | undefined;
    if (!apiUrl || !secret) return;

    try {
      const res = await fetch(`${apiUrl}/internal/rooms/${this.room.id}/status`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer internal:${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: this.channel.status }),
      });
      if (!res.ok) {
        console.error(`${this.tag} D1 sync status failed: ${res.status}`);
      }
    } catch (e) {
      console.error(`${this.tag} D1 sync status error:`, e);
    }
  }
}
