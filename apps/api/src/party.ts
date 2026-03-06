import type * as Party from 'partykit/server';
import { verifyJwt, type JwtPayload } from './jwt';
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

  constructor(public room: Party.Room) { }

  async onStart() {
    console.log(`${this.tag} Starting`);
    const storedRequests = await this.room.storage.get<SerializedRequest[]>('requests');
    if (storedRequests) {
      this.requests = storedRequests;
      console.log(`${this.tag} Loaded ${storedRequests.length} requests from storage`);
    }
    const storedSources = await this.room.storage.get<Partial<SourcesSettings>>('sources');
    if (storedSources) {
      this.sources = { ...SOURCES_DEFAULTS, ...storedSources };
      console.log(`${this.tag} Loaded sources config:`, JSON.stringify(this.sources.enabled));
    }
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
      this.broadcastChannel();
    }
  }

  onError(conn: Party.Connection, error: unknown) {
    console.error(`${this.tag} Error on ${conn.id}:`, error);
    this.connections.delete(conn.id);

    if (this.activeOwnerConnId === conn.id) {
      this.activeOwnerConnId = null;
      this.channel = { status: 'offline', owner: null };
      this.broadcastChannel();
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
      if (!this.isDev && !isRoomOwner) {
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
      this.channel = {
        status: 'online',
        owner: { login: connInfo!.user!.login, displayName: connInfo!.user!.display_name, avatar: connInfo!.user!.profile_image_url }
      };
      const grantMsg: PartyMessage = { type: 'ownership-granted' };
      sender.send(JSON.stringify(grantMsg));
      this.broadcastChannel(); // All clients see updated channel.owner
      console.log(`${this.tag} Granted ownership to ${connInfo!.user!.login}`);
      return;
    }

    // Handle release-ownership - only lock holder can release
    if (msg.type === 'release-ownership') {
      if (isLockHolder) {
        this.activeOwnerConnId = null;
        this.channel = { status: 'offline', owner: null };
        this.broadcastChannel();
        console.log(`${this.tag} ${connInfo?.user?.login} released ownership`);
      }
      return;
    }

    if (!this.isDev && !isLockHolder) {
      console.warn(`${this.tag} Rejected msg from non-owner ${sender.id}`);
      return;
    }

    const user = connInfo?.user?.login ?? 'unknown';
    switch (msg.type) {
      case 'add-request': {
        if (!this.requests.some(r => r.id === msg.request.id)) {
          this.requests.push(msg.request);
          await this.persist();
          this.broadcast(message, sender.id);
          console.log(`${this.tag} ${user}: add-request #${msg.request.id} "${msg.request.character}" (${msg.request.source})`);
        } else {
          console.log(`${this.tag} ${user}: add-request #${msg.request.id} skipped (duplicate)`);
        }
        break;
      }
      case 'update-request': {
        const idx = this.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          this.requests[idx] = { ...this.requests[idx], ...msg.updates };
          await this.persist();
          this.broadcast(message, sender.id);
          console.log(`${this.tag} ${user}: update-request #${msg.id}`, Object.keys(msg.updates));
        }
        break;
      }
      case 'toggle-done': {
        const idx = this.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          this.requests[idx].done = !this.requests[idx].done;
          await this.persist();
          this.broadcast(message, sender.id);
          console.log(`${this.tag} ${user}: toggle-done #${msg.id} → ${this.requests[idx].done}`);
        }
        break;
      }
      case 'reorder': {
        const fromIdx = this.requests.findIndex(r => r.id === msg.fromId);
        const toIdx = this.requests.findIndex(r => r.id === msg.toId);
        if (fromIdx !== -1 && toIdx !== -1) {
          const [moved] = this.requests.splice(fromIdx, 1);
          this.requests.splice(toIdx, 0, moved);
          await this.persist();
          this.broadcast(message, sender.id);
          console.log(`${this.tag} ${user}: reorder #${msg.fromId} → position of #${msg.toId}`);
        }
        break;
      }
      case 'delete-request': {
        const idx = this.requests.findIndex(r => r.id === msg.id);
        if (idx !== -1) {
          this.requests.splice(idx, 1);
          await this.persist();
          this.broadcast(message, sender.id);
          console.log(`${this.tag} ${user}: delete-request #${msg.id}`);
        }
        break;
      }
      case 'set-all': {
        this.requests = msg.requests;
        await this.persist();
        this.broadcast(message, sender.id);
        console.log(`${this.tag} ${user}: set-all (${msg.requests.length} requests)`);
        break;
      }
      case 'update-sources': {
        this.sources = msg.sources;
        await this.room.storage.put('sources', this.sources);
        this.broadcast(message, sender.id);
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

  private async persist() {
    await this.room.storage.put('requests', this.requests);
    console.log(`${this.tag} Persisted ${this.requests.length} requests`);
  }

  private broadcast(message: string, excludeId: string) {
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

  private broadcastChannel() {
    const msg = JSON.stringify({ type: 'update-channel', channel: this.channel });
    let count = 0;
    for (const conn of this.room.getConnections()) {
      conn.send(msg);
      count++;
    }
    console.log(`${this.tag} Broadcast channel state to ${count} client(s): status=${this.channel.status}, owner=${this.channel.owner?.login ?? 'null'}`);
  }
}
