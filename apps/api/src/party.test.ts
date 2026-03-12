import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PartyServer from './party';
import type { SerializedRequest, SourcesSettings, PartyMessage } from '@dbd-utils/shared';
import { MAX_PENDING_REQUESTS } from '@dbd-utils/shared';

// Mock jwt module
vi.mock('./jwt', () => ({
  verifyJwt: vi.fn(),
}));

import { verifyJwt } from './jwt';

// Helper to create mock Party.Room
function createMockRoom(id: string = 'testchannel') {
  const connections = new Map<string, MockConnection>();
  const store = new Map<string, unknown>();

  return {
    id,
    env: { JWT_SECRET: 'test-secret' },
    storage: {
      get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? null)),
      put: vi.fn((keyOrEntries: string | Record<string, unknown>, value?: unknown) => {
        if (typeof keyOrEntries === 'string') {
          store.set(keyOrEntries, value);
        } else {
          for (const [k, v] of Object.entries(keyOrEntries)) store.set(k, v);
        }
        return Promise.resolve();
      }),
      delete: vi.fn((keyOrKeys: string | string[]) => {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const k of keys) store.delete(k);
        return Promise.resolve();
      }),
      list: vi.fn(({ prefix }: { prefix: string }) => {
        const result = new Map<string, unknown>();
        for (const [k, v] of store) {
          if (k.startsWith(prefix)) result.set(k, v);
        }
        return Promise.resolve(result);
      }),
      _store: store,
    },
    getConnections: () => connections.values(),
    _connections: connections,
  };
}

// Helper to create mock connection
class MockConnection {
  id: string;
  messages: string[] = [];

  constructor(id: string) {
    this.id = id;
  }

  send(message: string) {
    this.messages.push(message);
  }

  getLastMessage(): PartyMessage | null {
    if (this.messages.length === 0) return null;
    return JSON.parse(this.messages[this.messages.length - 1]);
  }

  getAllMessages(): PartyMessage[] {
    return this.messages.map(m => JSON.parse(m));
  }
}

function createMockContext(token: string | null = null) {
  const url = token
    ? `https://party.example.com/room?token=${token}`
    : 'https://party.example.com/room';
  return {
    request: { url },
  };
}

function createTestRequest(overrides: Partial<SerializedRequest> = {}): SerializedRequest {
  return {
    id: Date.now(),
    donor: 'TestUser',
    message: 'Test message',
    character: 'Meg Thomas',
    type: 'survivor',
    amount: '10',
    amountVal: 10,
    source: 'manual',
    done: false,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe('PartyServer', () => {
  let server: PartyServer;
  let mockRoom: ReturnType<typeof createMockRoom>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRoom = createMockRoom();
    server = new PartyServer(mockRoom as any);
  });

  describe('onStart', () => {
    it('initializes with empty state when storage is empty', async () => {
      await server.onStart();

      expect(server.requests).toEqual([]);
      expect(server.channel.status).toBe('offline');
    });

    it('loads requests from storage', async () => {
      const storedRequests = [createTestRequest({ id: 1 }), createTestRequest({ id: 2 })];
      mockRoom.storage.get.mockImplementation((key: string) => {
        if (key === 'requests') return Promise.resolve(storedRequests);
        return Promise.resolve(null);
      });

      await server.onStart();

      expect(server.requests).toEqual(storedRequests);
    });

    it('loads sources from storage with defaults merged', async () => {
      const storedSources = { minDonation: 10 };
      mockRoom.storage.get.mockImplementation((key: string) => {
        if (key === 'sources') return Promise.resolve(storedSources);
        return Promise.resolve(null);
      });

      await server.onStart();

      expect(server.sources.minDonation).toBe(10);
      expect(server.sources.chatCommand).toBe('!fila'); // default
    });
  });

  describe('onConnect', () => {
    it('sends sync-full message to new connection', async () => {
      const conn = new MockConnection('conn1');
      const ctx = createMockContext();

      await server.onConnect(conn as any, ctx as any);

      const msg = conn.getLastMessage();
      expect(msg?.type).toBe('sync-full');
      expect(msg).toHaveProperty('requests');
      expect(msg).toHaveProperty('sources');
      expect(msg).toHaveProperty('channel');
    });

    it('stores user info but does not auto-grant ownership', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const conn = new MockConnection('conn1');
      const ctx = createMockContext('valid-token');

      await server.onConnect(conn as any, ctx as any);

      // User info stored but no ownership granted yet
      expect(server.connections.get('conn1')?.user?.login).toBe('testchannel');
      expect(server.activeOwnerConnId).toBeNull();
      expect(server.channel.status).toBe('offline');
    });

    it('does not store owner info for non-room-owner', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '456',
        login: 'otheruser',
        display_name: 'OtherUser',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const conn = new MockConnection('conn1');
      const ctx = createMockContext('valid-token');

      await server.onConnect(conn as any, ctx as any);

      expect(server.connections.get('conn1')?.user?.login).toBe('otheruser');
      expect(server.channel.status).toBe('offline');
    });

    it('handles anonymous connection', async () => {
      const conn = new MockConnection('conn1');
      const ctx = createMockContext(null);

      await server.onConnect(conn as any, ctx as any);

      expect(server.connections.get('conn1')?.user).toBeNull();
    });

    it('handles invalid JWT', async () => {
      vi.mocked(verifyJwt).mockResolvedValue(null);

      const conn = new MockConnection('conn1');
      const ctx = createMockContext('invalid-token');

      await server.onConnect(conn as any, ctx as any);

      expect(server.connections.get('conn1')?.user).toBeNull();
    });
  });

  describe('onClose', () => {
    it('removes connection from map', async () => {
      const conn = new MockConnection('conn1');
      await server.onConnect(conn as any, createMockContext() as any);

      expect(server.connections.has('conn1')).toBe(true);

      server.onClose(conn as any);

      expect(server.connections.has('conn1')).toBe(false);
    });

    it('sets channel offline when lock holder disconnects', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const conn = new MockConnection('conn1');
      mockRoom._connections.set('conn1', conn);
      await server.onConnect(conn as any, createMockContext('token') as any);

      // Claim ownership
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), conn as any);

      expect(server.channel.status).toBe('online');
      expect(server.activeOwnerConnId).toBe('conn1');

      server.onClose(conn as any);

      expect(server.channel.status).toBe('offline');
      expect(server.channel.owner).toBeNull();
      expect(server.activeOwnerConnId).toBeNull();
    });
  });

  describe('onMessage', () => {
    let ownerConn: MockConnection;
    let viewerConn: MockConnection;

    beforeEach(async () => {
      // Set up owner connection
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      ownerConn = new MockConnection('owner');
      mockRoom._connections.set('owner', ownerConn);
      await server.onConnect(ownerConn as any, createMockContext('owner-token') as any);

      // Owner claims ownership
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), ownerConn as any);

      // Set up viewer connection
      vi.mocked(verifyJwt).mockResolvedValue(null);
      viewerConn = new MockConnection('viewer');
      mockRoom._connections.set('viewer', viewerConn);
      await server.onConnect(viewerConn as any, createMockContext() as any);

      // Clear messages from connect and claim
      ownerConn.messages = [];
      viewerConn.messages = [];
    });

    it('grants ownership to room owner on claim-ownership', async () => {
      // Create a fresh server and connection for this test
      const freshRoom = createMockRoom();
      const freshServer = new PartyServer(freshRoom as any);

      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const conn = new MockConnection('conn1');
      freshRoom._connections.set('conn1', conn);
      await freshServer.onConnect(conn as any, createMockContext('token') as any);

      // Clear sync message
      conn.messages = [];

      // Claim ownership
      await freshServer.onMessage(JSON.stringify({ type: 'claim-ownership' }), conn as any);

      expect(freshServer.activeOwnerConnId).toBe('conn1');
      expect(freshServer.channel.status).toBe('online');
      expect(freshServer.channel.owner?.login).toBe('testchannel');

      // Should receive ownership-granted followed by update-channel broadcast
      const msgs = conn.getAllMessages();
      expect(msgs.some(m => m.type === 'ownership-granted')).toBe(true);
      expect(msgs.some(m => m.type === 'update-channel')).toBe(true);
    });

    it('denies ownership to non-room-owner', async () => {
      const freshRoom = createMockRoom();
      const freshServer = new PartyServer(freshRoom as any);

      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '456',
        login: 'otheruser',
        display_name: 'OtherUser',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const conn = new MockConnection('conn1');
      freshRoom._connections.set('conn1', conn);
      await freshServer.onConnect(conn as any, createMockContext('token') as any);
      conn.messages = [];

      await freshServer.onMessage(JSON.stringify({ type: 'claim-ownership' }), conn as any);

      expect(freshServer.activeOwnerConnId).toBeNull();
      const denyMsg = conn.getLastMessage();
      expect(denyMsg?.type).toBe('ownership-denied');
    });

    it('denies ownership when another owner holds the lock', async () => {
      // viewerConn trying to claim when ownerConn has the lock won't work since they're not room owner
      // Let's create a scenario with two room owner connections

      const freshRoom = createMockRoom();
      const freshServer = new PartyServer(freshRoom as any);

      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const conn1 = new MockConnection('conn1');
      const conn2 = new MockConnection('conn2');
      freshRoom._connections.set('conn1', conn1);
      freshRoom._connections.set('conn2', conn2);

      await freshServer.onConnect(conn1 as any, createMockContext('token1') as any);
      await freshServer.onConnect(conn2 as any, createMockContext('token2') as any);

      // conn1 claims ownership
      await freshServer.onMessage(JSON.stringify({ type: 'claim-ownership' }), conn1 as any);
      expect(freshServer.activeOwnerConnId).toBe('conn1');

      conn2.messages = [];

      // conn2 tries to claim - should be denied
      await freshServer.onMessage(JSON.stringify({ type: 'claim-ownership' }), conn2 as any);

      expect(freshServer.activeOwnerConnId).toBe('conn1'); // Still conn1
      const denyMsg = conn2.getLastMessage();
      expect(denyMsg?.type).toBe('ownership-denied');
    });

    it('rejects messages from non-owner', async () => {
      const msg = JSON.stringify({ type: 'add-request', request: createTestRequest() });

      await server.onMessage(msg, viewerConn as any);

      expect(server.requests).toHaveLength(0);
    });

    it('handles add-request from owner', async () => {
      const request = createTestRequest({ id: 100 });
      const msg = JSON.stringify({ type: 'add-request', request });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].id).toBe(100);
      expect(mockRoom.storage.put).toHaveBeenCalledWith(
        expect.objectContaining({ 'req:100': expect.objectContaining({ id: 100 }) })
      );

      // Should broadcast to all including sender
      expect(viewerConn.messages).toHaveLength(1);
      expect(ownerConn.messages).toHaveLength(1);
    });

    it('prevents duplicate requests', async () => {
      const request = createTestRequest({ id: 100 });
      const msg = JSON.stringify({ type: 'add-request', request });

      await server.onMessage(msg, ownerConn as any);
      await server.onMessage(msg, ownerConn as any);

      expect(server.requests).toHaveLength(1);
    });

    it('handles update-request', async () => {
      server.requests = [createTestRequest({ id: 100, character: 'Meg Thomas' })];
      const msg = JSON.stringify({ type: 'update-request', id: 100, updates: { character: 'Dwight Fairfield' } });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests[0].character).toBe('Dwight Fairfield');
      expect(mockRoom.storage.put).toHaveBeenCalled();
    });

    it('handles toggle-done', async () => {
      server.requests = [createTestRequest({ id: 100, done: false })];
      const msg = JSON.stringify({ type: 'toggle-done', id: 100 });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests[0].done).toBe(true);
    });

    it('handles delete-request', async () => {
      server.requests = [createTestRequest({ id: 100 }), createTestRequest({ id: 200 })];
      const msg = JSON.stringify({ type: 'delete-request', id: 100 });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].id).toBe(200);
      expect(mockRoom.storage.delete).toHaveBeenCalledWith('req:100');
    });

    it('handles reorder', async () => {
      server.requests = [
        createTestRequest({ id: 1 }),
        createTestRequest({ id: 2 }),
        createTestRequest({ id: 3 }),
      ];
      const msg = JSON.stringify({ type: 'reorder', fromId: 3, toId: 1 });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests.map(r => r.id)).toEqual([3, 1, 2]);
    });

    it('handles set-all as authoritative replacement', async () => {
      server.requests = [
        createTestRequest({ id: 10, character: 'Meg Thomas' }),
        createTestRequest({ id: 20, character: 'Dwight Fairfield' }),
      ];
      const incoming = [
        createTestRequest({ id: 10, character: 'Claudette Morel' }),
        createTestRequest({ id: 30, character: 'Jake Park' }),
      ];
      const msg = JSON.stringify({ type: 'set-all', requests: incoming });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].id).toBe(10);
      expect(server.requests[0].character).toBe('Claudette Morel');
      expect(server.requests[1].id).toBe(30);
    });

    it('set-all removes requests not in incoming list', async () => {
      server.requests = [
        createTestRequest({ id: 1 }),
        createTestRequest({ id: 2 }),
        createTestRequest({ id: 3 }),
      ];

      const msg = JSON.stringify({ type: 'set-all', requests: [createTestRequest({ id: 2 })] });

      await server.onMessage(msg, ownerConn as any);

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].id).toBe(2);
    });

    it('set-all broadcasts to other connections', async () => {
      const incoming = [createTestRequest({ id: 1 })];

      await server.onMessage(JSON.stringify({ type: 'set-all', requests: incoming }), ownerConn as any);

      const viewerMsg = viewerConn.getLastMessage();
      expect(viewerMsg?.type).toBe('set-all');
      expect((viewerMsg as any).requests).toHaveLength(1);
    });

    it('handles update-sources', async () => {
      const newSources: SourcesSettings = {
        enabled: { donation: false, chat: true, resub: true, manual: false },
        chatCommand: '!request',
        chatTiers: [1, 2, 3],
        priority: ['chat', 'donation', 'resub', 'manual'],
        sortMode: 'priority',
        minDonation: 20,
      };
      const msg = JSON.stringify({ type: 'update-sources', sources: newSources });

      await server.onMessage(msg, ownerConn as any);

      expect(server.sources).toEqual(newSources);
      expect(mockRoom.storage.put).toHaveBeenCalledWith('sources', newSources);
    });

    it('handles irc-status connected', async () => {
      server.channel.status = 'online';
      const msg = JSON.stringify({ type: 'irc-status', connected: true });

      await server.onMessage(msg, ownerConn as any);

      expect(server.channel.status).toBe('live');
    });

    it('handles irc-status disconnected', async () => {
      server.channel.status = 'live';
      const msg = JSON.stringify({ type: 'irc-status', connected: false });

      await server.onMessage(msg, ownerConn as any);

      expect(server.channel.status).toBe('online');
    });

    it('ignores invalid JSON', async () => {
      await server.onMessage('not valid json', ownerConn as any);

      expect(server.requests).toHaveLength(0);
    });
  });

  describe('onStart — per-key storage', () => {
    it('loads requests from per-key storage', async () => {
      const req1 = createTestRequest({ id: 1 });
      const req2 = createTestRequest({ id: 2 });
      mockRoom.storage._store.set('req:1', req1);
      mockRoom.storage._store.set('req:2', req2);
      mockRoom.storage._store.set('order', [1, 2]);

      await server.onStart();

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].id).toBe(1);
      expect(server.requests[1].id).toBe(2);
    });

    it('migrates legacy single-array format to per-key', async () => {
      const stored = [createTestRequest({ id: 1 }), createTestRequest({ id: 2 })];
      mockRoom.storage._store.set('requests', stored);

      await server.onStart();

      expect(server.requests).toHaveLength(2);
      // Legacy key deleted
      expect(mockRoom.storage._store.has('requests')).toBe(false);
      // Per-key entries created
      expect(mockRoom.storage._store.has('req:1')).toBe(true);
      expect(mockRoom.storage._store.has('req:2')).toBe(true);
      expect(mockRoom.storage._store.get('order')).toEqual([1, 2]);
    });

    it('respects order key for ordering', async () => {
      mockRoom.storage._store.set('req:1', createTestRequest({ id: 1 }));
      mockRoom.storage._store.set('req:2', createTestRequest({ id: 2 }));
      mockRoom.storage._store.set('req:3', createTestRequest({ id: 3 }));
      mockRoom.storage._store.set('order', [3, 1, 2]);

      await server.onStart();

      expect(server.requests.map(r => r.id)).toEqual([3, 1, 2]);
    });

    it('appends orphan requests not in order', async () => {
      mockRoom.storage._store.set('req:1', createTestRequest({ id: 1 }));
      mockRoom.storage._store.set('req:2', createTestRequest({ id: 2 }));
      mockRoom.storage._store.set('order', [1]);

      await server.onStart();

      expect(server.requests).toHaveLength(2);
      expect(server.requests[0].id).toBe(1);
      expect(server.requests[1].id).toBe(2);
    });
  });

  describe('onStart — D1 recovery', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('migrates and prunes done requests from DO on load', async () => {
      const stored = [
        createTestRequest({ id: 1, done: false }),
        createTestRequest({ id: 2, done: true }),
        createTestRequest({ id: 3, done: false }),
        createTestRequest({ id: 4, done: true }),
      ];
      mockRoom.storage._store.set('requests', stored);

      await server.onStart();

      expect(server.requests).toHaveLength(2);
      expect(server.requests.every(r => !r.done)).toBe(true);
      expect(server.requests.map(r => r.id)).toEqual([1, 3]);
      // Legacy key deleted, per-key entries created
      expect(mockRoom.storage._store.has('requests')).toBe(false);
      expect(mockRoom.storage._store.has('req:1')).toBe(true);
      expect(mockRoom.storage._store.has('req:3')).toBe(true);
      expect(mockRoom.storage._store.get('order')).toEqual([1, 3]);
    });

    it('recovers from D1 when DO is empty', async () => {
      const d1Room = createMockRoom();
      d1Room.env = { JWT_SECRET: 'test-secret', API_URL: 'https://api.test', INTERNAL_API_SECRET: 'secret' } as any;
      d1Room.storage.get.mockResolvedValue(null);
      const d1Server = new PartyServer(d1Room as any);

      const recovered = [
        createTestRequest({ id: 10, done: false }),
        createTestRequest({ id: 20, done: false }),
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ requests: recovered }),
      }));

      await d1Server.onStart();

      expect(d1Server.requests).toEqual(recovered);
      expect(d1Room.storage._store.has('req:10')).toBe(true);
      expect(d1Room.storage._store.has('req:20')).toBe(true);
      expect(d1Room.storage._store.get('order')).toEqual([10, 20]);
    });
  });

  describe('persist', () => {
    let ownerConn: MockConnection;

    beforeEach(async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      ownerConn = new MockConnection('owner');
      mockRoom._connections.set('owner', ownerConn);
      await server.onConnect(ownerConn as any, createMockContext('owner-token') as any);
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), ownerConn as any);
      ownerConn.messages = [];
      mockRoom.storage.put.mockClear();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('stores only dirty request keys and order excludes done', async () => {
      server.requests = [
        createTestRequest({ id: 1, done: false }),
        createTestRequest({ id: 2, done: true }),
        createTestRequest({ id: 3, done: false }),
      ];

      const newReq = createTestRequest({ id: 4, done: false });
      await server.onMessage(JSON.stringify({ type: 'add-request', request: newReq }), ownerConn as any);

      // Only dirty request (id: 4) written as per-key entry
      expect(mockRoom.storage.put).toHaveBeenCalledWith(
        expect.objectContaining({ 'req:4': expect.objectContaining({ id: 4 }) })
      );
      // Order contains only pending requests
      expect(mockRoom.storage.put).toHaveBeenCalledWith(
        'order', expect.not.arrayContaining([2])
      );
    });
  });

  describe('add-request — pending cap', () => {
    let ownerConn: MockConnection;
    let viewerConn: MockConnection;

    beforeEach(async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      ownerConn = new MockConnection('owner');
      mockRoom._connections.set('owner', ownerConn);
      await server.onConnect(ownerConn as any, createMockContext('owner-token') as any);
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), ownerConn as any);

      vi.mocked(verifyJwt).mockResolvedValue(null);
      viewerConn = new MockConnection('viewer');
      mockRoom._connections.set('viewer', viewerConn);
      await server.onConnect(viewerConn as any, createMockContext() as any);

      ownerConn.messages = [];
      viewerConn.messages = [];
    });

    it('rejects at pending cap', async () => {
      server.requests = Array.from({ length: MAX_PENDING_REQUESTS }, (_, i) =>
        createTestRequest({ id: i + 1, done: false })
      );

      const extra = createTestRequest({ id: 9999, done: false });
      await server.onMessage(JSON.stringify({ type: 'add-request', request: extra }), ownerConn as any);

      expect(server.requests.filter(r => !r.done)).toHaveLength(MAX_PENDING_REQUESTS);
      expect(server.requests.some(r => r.id === 9999)).toBe(false);
    });

    it('sends server-error when pending cap reached', async () => {
      server.requests = Array.from({ length: MAX_PENDING_REQUESTS }, (_, i) =>
        createTestRequest({ id: i + 1, done: false })
      );

      const extra = createTestRequest({ id: 9999, done: false });
      await server.onMessage(JSON.stringify({ type: 'add-request', request: extra }), ownerConn as any);

      const errorMsg = ownerConn.getAllMessages().find(m => m.type === 'server-error');
      expect(errorMsg).toBeDefined();
      expect((errorMsg as any).code).toBe('pending_cap');
    });

    it('allows add when some are done', async () => {
      const requests: SerializedRequest[] = [];
      for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
        requests.push(createTestRequest({ id: i + 1, done: i < 10 }));
      }
      server.requests = requests;

      const pendingBefore = server.requests.filter(r => !r.done).length;
      expect(pendingBefore).toBe(MAX_PENDING_REQUESTS - 10);

      const extra = createTestRequest({ id: 9999, done: false });
      await server.onMessage(JSON.stringify({ type: 'add-request', request: extra }), ownerConn as any);

      expect(server.requests.some(r => r.id === 9999)).toBe(true);
    });
  });

  describe('syncRequestsToD1', () => {
    let ownerConn: MockConnection;

    beforeEach(async () => {
      vi.useFakeTimers();
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      mockRoom.env = { JWT_SECRET: 'test-secret', API_URL: 'https://api.test', INTERNAL_API_SECRET: 'secret' } as any;

      ownerConn = new MockConnection('owner');
      mockRoom._connections.set('owner', ownerConn);
      await server.onConnect(ownerConn as any, createMockContext('owner-token') as any);
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), ownerConn as any);
      ownerConn.messages = [];
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it('prunes done from memory after successful D1 sync', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      server.requests = [
        createTestRequest({ id: 1, done: false }),
        createTestRequest({ id: 2, done: true }),
        createTestRequest({ id: 3, done: false }),
        createTestRequest({ id: 4, done: true }),
      ];

      await (server as any).syncRequestsToD1();

      expect(server.requests).toHaveLength(2);
      expect(server.requests.every(r => !r.done)).toBe(true);
    });

    it('sends server-error after 3 consecutive D1 failures', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      // 1st failure
      await (server as any).syncRequestsToD1();
      let errors = ownerConn.getAllMessages().filter(m => m.type === 'server-error' && (m as any).code === 'd1_sync_failed');
      expect(errors).toHaveLength(0);

      // 2nd failure
      await (server as any).syncRequestsToD1();
      errors = ownerConn.getAllMessages().filter(m => m.type === 'server-error' && (m as any).code === 'd1_sync_failed');
      expect(errors).toHaveLength(0);

      // 3rd failure — should send error
      await (server as any).syncRequestsToD1();
      errors = ownerConn.getAllMessages().filter(m => m.type === 'server-error' && (m as any).code === 'd1_sync_failed');
      expect(errors).toHaveLength(1);
    });

    it('deletes done request keys from DO after D1 sync', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      server.requests = [
        createTestRequest({ id: 1, done: false }),
        createTestRequest({ id: 2, done: true }),
        createTestRequest({ id: 3, done: false }),
        createTestRequest({ id: 4, done: true }),
      ];
      // Simulate per-key storage
      mockRoom.storage._store.set('req:1', server.requests[0]);
      mockRoom.storage._store.set('req:2', server.requests[1]);
      mockRoom.storage._store.set('req:3', server.requests[2]);
      mockRoom.storage._store.set('req:4', server.requests[3]);

      await (server as any).syncRequestsToD1();

      expect(mockRoom.storage.delete).toHaveBeenCalledWith(['req:2', 'req:4']);
      expect(mockRoom.storage._store.has('req:2')).toBe(false);
      expect(mockRoom.storage._store.has('req:4')).toBe(false);
    });

    it('restores dirty IDs on sync failure', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      server.requests = [
        createTestRequest({ id: 1, done: false }),
        createTestRequest({ id: 2, done: false }),
      ];
      (server as any).dirtyRequestIds = new Set([1, 2]);

      await (server as any).syncRequestsToD1();

      const dirtyIds = (server as any).dirtyRequestIds as Set<number>;
      expect(dirtyIds.has(1)).toBe(true);
      expect(dirtyIds.has(2)).toBe(true);
    });
  });

  describe('server-error', () => {
    it('sends error only to owner connection', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const ownerConn = new MockConnection('owner');
      mockRoom._connections.set('owner', ownerConn);
      await server.onConnect(ownerConn as any, createMockContext('owner-token') as any);
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), ownerConn as any);

      vi.mocked(verifyJwt).mockResolvedValue(null);
      const viewerConn = new MockConnection('viewer');
      mockRoom._connections.set('viewer', viewerConn);
      await server.onConnect(viewerConn as any, createMockContext() as any);

      ownerConn.messages = [];
      viewerConn.messages = [];

      (server as any).sendError('test_code', 'test message');

      const ownerErrors = ownerConn.getAllMessages().filter(m => m.type === 'server-error');
      const viewerErrors = viewerConn.getAllMessages().filter(m => m.type === 'server-error');
      expect(ownerErrors).toHaveLength(1);
      expect((ownerErrors[0] as any).code).toBe('test_code');
      expect(viewerErrors).toHaveLength(0);
    });
  });

  describe('broadcast', () => {
    it('broadcasts to all connections including sender', async () => {
      vi.mocked(verifyJwt).mockResolvedValue({
        sub: '123',
        login: 'testchannel',
        display_name: 'TestChannel',
        profile_image_url: 'https://example.com/avatar.png',
        exp: Math.floor(Date.now() / 1000) + 3600,
      });

      const owner = new MockConnection('owner');
      const viewer1 = new MockConnection('viewer1');
      const viewer2 = new MockConnection('viewer2');

      mockRoom._connections.set('owner', owner);
      mockRoom._connections.set('viewer1', viewer1);
      mockRoom._connections.set('viewer2', viewer2);

      await server.onConnect(owner as any, createMockContext('token') as any);

      // Owner claims ownership
      await server.onMessage(JSON.stringify({ type: 'claim-ownership' }), owner as any);

      vi.mocked(verifyJwt).mockResolvedValue(null);
      await server.onConnect(viewer1 as any, createMockContext() as any);
      await server.onConnect(viewer2 as any, createMockContext() as any);

      // Clear sync and ownership messages
      owner.messages = [];
      viewer1.messages = [];
      viewer2.messages = [];

      // Owner adds a request
      const request = createTestRequest({ id: 1 });
      await server.onMessage(JSON.stringify({ type: 'add-request', request }), owner as any);

      // All connections receive broadcast (no optimistic updates, server is source of truth)
      expect(owner.messages).toHaveLength(1);
      expect(viewer1.messages).toHaveLength(1);
      expect(viewer2.messages).toHaveLength(1);
    });
  });
});
