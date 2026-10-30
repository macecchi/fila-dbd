import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sign } from 'hono/jwt';
import { PROTOCOL_VERSION, editRoute, type PartyMessage, type SerializedRequest } from '@filadbd/shared';
import app from './index';
import { PRESENCE_TTL_MS } from './rooms';
import { extractCharacters } from './gemini';
import { createTestD1 } from './test/d1';

vi.mock('./twitch', async (orig) => ({
  ...(await orig<typeof import('./twitch')>()),
  sendChatMessage: vi.fn().mockResolvedValue({ ok: true }),
  getAppToken: vi.fn().mockResolvedValue(null),
}));
vi.mock('./gemini', async (orig) => ({
  ...(await orig<typeof import('./gemini')>()),
  extractCharacters: vi.fn(),
}));

const SECRET = 'test-secret';
const ROOM = 'streamer';

function kv() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
  };
}

let env: Record<string, unknown>;
let pending: Promise<unknown>[];
const ctx = () => ({ waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

async function token(login = ROOM) {
  return sign({ sub: '1', login, display_name: login, profile_image_url: '', exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
}

// What the client sends for an edit: the REST call `editRoute` maps it to.
async function op(msg: PartyMessage, login = ROOM) {
  const route = editRoute(msg)!;
  const res = await app.fetch(new Request(`http://x/rooms/${ROOM}${route.path}?p=${PROTOCOL_VERSION}`, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(login)}` },
    ...(route.body !== undefined ? { body: JSON.stringify(route.body) } : {}),
  }), env, ctx());
  return { status: res.status, body: await res.json() as { version?: number; messages: PartyMessage[] } };
}

async function state(query = '', auth?: string) {
  const res = await app.fetch(new Request(`http://x/rooms/${ROOM}/state?p=${PROTOCOL_VERSION}${query}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  }), env, ctx());
  return { status: res.status, body: await res.json() as any };
}

let nextId = 1;
function req(over: Partial<SerializedRequest> = {}): SerializedRequest {
  const id = nextId++;
  return { id, timestamp: new Date(Date.now() + id).toISOString(), donor: `d${id}`, amount: '', amountVal: 0, message: 'meg', character: 'Meg Thomas', type: 'survivor', source: 'chat', ...over };
}

beforeEach(async () => {
  const { d1 } = await createTestD1();
  env = { DB: d1, CACHE: kv(), JWT_SECRET: SECRET, FRONTEND_URL: 'http://localhost:5173', TWITCH_CLIENT_ID: 'x', TWITCH_CLIENT_SECRET: 'x' };
  pending = [];
  nextId = 1;
  vi.mocked(extractCharacters).mockReset().mockResolvedValue([{ character: 'Meg Thomas', type: 'survivor' }]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('GET /rooms/:id/state', () => {
  it('answers an unknown room as an empty, offline queue', async () => {
    const { body } = await state();
    expect(body.version).toBe(0);
    expect(body.channel).toEqual({ status: 'offline', owner: null, closedByOwner: false });
    expect(body.requests).toEqual([]);
    expect(body.sources.chatCommand).toBe('!fila');
  });

  it('refuses a client on an older protocol', async () => {
    const res = await app.fetch(new Request(`http://x/rooms/${ROOM}/state`), env, ctx());
    expect(res.status).toBe(426);
  });

  it('omits the queue when the client already has this version', async () => {
    await op({ type: 'add-request', request: req() });
    const { body: full } = await state();
    const { body } = await state(`&v=${full.version}`);
    expect(body.requests).toBeUndefined();
    expect(body.version).toBe(full.version);
  });
});

describe('presence', () => {
  it('derives online / live / offline from the heartbeats and the switch', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = await token();
    expect((await state('', t)).body.channel.status).toBe('online');
    expect((await state('', await token('someone'))).body.channel.status).toBe('online');
    expect((await state('&irc=1', t)).body.channel.status).toBe('live');

    vi.setSystemTime(Date.now() + PRESENCE_TTL_MS + 1);
    expect((await state()).body.channel.status).toBe('offline');
    expect((await state('&irc=1', t)).body.channel.status).toBe('live');

    const closed = await op({ type: 'close-queue' });
    expect(closed.body.messages).toEqual([{ type: 'update-channel', channel: { status: 'offline', owner: null, closedByOwner: true } }]);
    expect((await state('&irc=1', t)).body.channel).toMatchObject({ status: 'offline', closedByOwner: true });

    await op({ type: 'open-queue' });
    expect((await state('', t)).body.channel).toMatchObject({ status: 'online', closedByOwner: false, owner: { login: ROOM } });
  });

  it("one window losing chat doesn't take the room off live for the others", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await op({ type: 'irc-status', connected: true });
    expect((await state()).body.channel.status).toBe('live');
    const { body } = await op({ type: 'irc-status', connected: false });
    expect(body.messages[0]).toMatchObject({ type: 'update-channel', channel: { status: 'live' } });
    // Nobody refreshes it: it ages out.
    vi.setSystemTime(Date.now() + PRESENCE_TTL_MS + 1);
    expect((await state()).body.channel.status).toBe('offline');
  });

  it('closing drops the hidden non-requests so they never fill the queue', async () => {
    const none = req({ type: 'none', character: '' });
    const real = req();
    await op({ type: 'add-request', request: none });
    await op({ type: 'add-request', request: real });
    await op({ type: 'close-queue' });
    expect((await state()).body.requests.map((x: SerializedRequest) => x.id)).toEqual([real.id]);
  });

  it('refuses adds into a closed queue from a window that missed the close, but not manual ones', async () => {
    await op({ type: 'close-queue' });
    const r = req();
    const { body } = await op({ type: 'add-request', request: r });
    expect(body.messages).toEqual([
      expect.objectContaining({ type: 'server-error', code: 'queue_closed', id: r.id }),
      expect.objectContaining({ type: 'update-channel', channel: expect.objectContaining({ closedByOwner: true }) }),
    ]);
    const manual = req({ source: 'manual' });
    expect((await op({ type: 'add-request', request: manual })).body.messages[0]).toMatchObject({ type: 'add-request' });
    expect((await state()).body.requests.map((x: SerializedRequest) => x.id)).toEqual([manual.id]);
  });

  it("writes no heartbeat while the queue is closed", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await op({ type: 'close-queue' });
    const before = await (env.DB as D1Database).prepare('SELECT owner_seen_at FROM rooms').first();
    vi.setSystemTime(Date.now() + 31_000);
    await state('&irc=1', await token());
    expect(await (env.DB as D1Database).prepare('SELECT owner_seen_at FROM rooms').first()).toEqual(before);
  });
});

describe('owner edits (REST on /rooms/:id)', () => {
  it('only accepts the room owner', async () => {
    const res = await app.fetch(new Request(`http://x/rooms/${ROOM}/requests?p=${PROTOCOL_VERSION}`, {
      method: 'POST', body: JSON.stringify(req()),
    }), env, ctx());
    expect(res.status).toBe(401);
    const other = await op({ type: 'add-request', request: req() }, 'someone');
    expect(other.status).toBe(403);
    expect(other.body.messages[0]).toMatchObject({ type: 'server-error', code: 'not_room_owner' });
    expect((await state()).body.requests).toEqual([]);
  });

  it('rejects a malformed edit', async () => {
    const res = await app.fetch(new Request(`http://x/rooms/${ROOM}/requests/abc?p=${PROTOCOL_VERSION}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ character: 'Meg Thomas' }),
    }), env, ctx());
    expect(res.status).toBe(400);
  });

  it('edits a manual request, whose id is fractional', async () => {
    const manual = req({ id: 1761830400000.4219 });
    await op({ type: 'add-request', request: manual });
    const { body } = await op({ type: 'toggle-done', id: manual.id, done: true, doneAt: '2026-10-30T13:00:00.000Z' });
    expect(body.messages).toEqual([{ type: 'toggle-done', id: manual.id, done: true, doneAt: '2026-10-30T13:00:00.000Z' }]);
    expect((await op({ type: 'delete-request', id: manual.id })).status).toBe(200);
  });

  it('lets only the first of several windows add the same message', async () => {
    const r = req();
    const results = await Promise.all([1, 2, 3].map(() => op({ type: 'add-request', request: r })));
    expect(results.filter((x) => x.body.messages.length > 0)).toHaveLength(1);
    const { body } = await state();
    expect(body.requests.map((x: SerializedRequest) => x.id)).toEqual([r.id]);
    // The losers moved nothing on: one write, one version.
    expect(body.version).toBe(1);
  });

  it('never brings back a request that was played or deleted', async () => {
    const a = req();
    const b = req();
    await op({ type: 'add-request', request: a });
    await op({ type: 'add-request', request: b });
    await op({ type: 'toggle-done', id: a.id, done: true });
    await op({ type: 'delete-request', id: b.id });
    expect((await op({ type: 'add-request', request: a })).body.messages).toEqual([]);
    expect((await op({ type: 'add-request', request: b })).body.messages).toEqual([]);
    const { body } = await state();
    expect(body.requests.map((x: SerializedRequest) => [x.id, !!x.done])).toEqual([[a.id, true]]);
  });

  it('keeps the newest done requests for the strip, deleted ones out', async () => {
    const ids = [];
    for (let i = 0; i < 7; i++) {
      const r = req();
      ids.push(r.id);
      await op({ type: 'add-request', request: r });
      await op({ type: 'toggle-done', id: r.id, done: true, doneAt: new Date(Date.now() + i * 1000).toISOString() });
    }
    await op({ type: 'delete-request', id: ids[6] });
    const { body } = await state();
    expect(body.requests.map((x: SerializedRequest) => x.id)).toEqual([ids[5], ids[4], ids[3], ids[2], ids[1]]);
  });

  it('inserts by priority and reorders the whole queue', async () => {
    await op({ type: 'update-sources', sources: { sortMode: 'priority', priority: ['donation', 'chat', 'resub', 'manual'], enabled: { donation: true, chat: true, resub: true, manual: true } } as never });
    const chat1 = req();
    const chat2 = req();
    const dono = req({ source: 'donation', amountVal: 10 });
    for (const r of [chat1, chat2, dono]) await op({ type: 'add-request', request: r });
    const order = async () => (await state()).body.requests.map((x: SerializedRequest) => x.id);
    expect(await order()).toEqual([dono.id, chat1.id, chat2.id]);

    const res = await op({ type: 'reorder', fromId: chat2.id, toId: dono.id, opId: 'op1' });
    expect(res.body.messages).toEqual([{ type: 'reorder', fromId: chat2.id, toId: dono.id, opId: 'op1' }]);
    expect(await order()).toEqual([chat2.id, dono.id, chat1.id]);
  });

  it("an edit doesn't undo a ✓ or a delete another window made meanwhile", async () => {
    const a = req();
    const b = req();
    await op({ type: 'add-request', request: a });
    await op({ type: 'add-request', request: b });
    await op({ type: 'toggle-done', id: a.id, done: true });
    await op({ type: 'delete-request', id: b.id });
    await op({ type: 'update-request', id: a.id, updates: { character: 'Nea Karlsson' } });
    await op({ type: 'update-request', id: b.id, updates: { character: 'Nea Karlsson' } });
    const { body } = await state();
    expect(body.requests.map((x: SerializedRequest) => [x.id, x.character, !!x.done])).toEqual([[a.id, 'Nea Karlsson', true]]);
  });

  it('caps the pending queue', async () => {
    for (let i = 0; i < 99; i++) await op({ type: 'add-request', request: req() });
    const extra = req();
    const { body } = await op({ type: 'add-request', request: extra });
    expect(body.messages[0]).toMatchObject({ type: 'server-error', code: 'pending_cap', id: extra.id });
  });

  it('set-all replaces the pending queue', async () => {
    const old = req();
    await op({ type: 'add-request', request: old });
    const imported = [req(), req()];
    await op({ type: 'set-all', requests: imported });
    expect((await state()).body.requests.map((x: SerializedRequest) => x.id)).toEqual(imported.map((r) => r.id));
  });

  it('bumps the version on every write', async () => {
    const r = req();
    const a = await op({ type: 'add-request', request: r });
    const b = await op({ type: 'update-request', id: r.id, updates: { character: 'Nea Karlsson' } });
    expect(b.body.version).toBe(a.body.version! + 1);
    expect((await state()).body.requests[0].character).toBe('Nea Karlsson');
  });

  it('confirms in chat once, from the window whose add landed', async () => {
    const { sendChatMessage } = await import('./twitch');
    await op({ type: 'update-sources', sources: { confirmInChat: true } as never });
    const r = req();
    await op({ type: 'add-request', request: r });
    await op({ type: 'add-request', request: r });
    await Promise.all(pending);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendChatMessage).mock.calls[0][2]).toBe(`@${r.donor} seu pedido de Meg Thomas entrou na fila na posição 1! 🎯`);
  });
});

describe('identification', () => {
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  const unidentified = (over: Partial<SerializedRequest> = {}) =>
    req({ character: 'Identificando...', type: 'unknown', needsIdentification: true, message: 'quero a meg', ...over });
  const queue = async () => (await state()).body.requests as SerializedRequest[];

  it('runs the LLM once however many windows add the same message', async () => {
    const r = unidentified();
    await Promise.all([1, 2, 3].map(() => op({ type: 'add-request', request: r })));
    await settle();
    expect(extractCharacters).toHaveBeenCalledTimes(1);
    expect(await queue()).toEqual([expect.objectContaining({ id: r.id, character: 'Meg Thomas', type: 'survivor', needsIdentification: false })]);
  });

  it('splits a donation that pays for several requests, right after it', async () => {
    let answer!: () => void;
    vi.mocked(extractCharacters).mockImplementationOnce(() => new Promise((res) => {
      answer = () => res([{ character: 'Trapper', type: 'killer' }, { character: 'Trapper', type: 'killer' }, { character: 'Nurse', type: 'killer' }]);
    }));
    await op({ type: 'update-sources', sources: { minDonation: 5 } as never });
    const donation = unidentified({ source: 'donation', amount: 'R$ 15', amountVal: 15, message: '2 de trapper e 1 de nurse' });
    const added = op({ type: 'add-request', request: donation });
    await vi.waitFor(() => expect(answer).toBeDefined());
    const later = req();
    await op({ type: 'add-request', request: later });
    answer();
    // The add answers once identified, with the whole queue as it now stands.
    const { body } = await added;
    expect(body.messages.map((m) => m.type)).toEqual(['add-request', 'sync-full']);
    const sync = body.messages[1] as Extract<PartyMessage, { type: 'sync-full' }>;
    expect(sync.requests.map((r) => r.character)).toEqual(['Trapper', 'Trapper', 'Nurse', 'Meg Thomas']);
    expect(vi.mocked(extractCharacters).mock.calls[0][2]).toBe(3);
    const q = await queue();
    expect(q.map((r) => r.character)).toEqual(['Trapper', 'Trapper', 'Nurse', 'Meg Thomas']);
    expect(q[0].id).toBe(donation.id);
    expect(q.at(-1)!.id).toBe(later.id);
    expect(q.every((r) => !r.needsIdentification)).toBe(true);
  });

  it('keeps a cut-off LivePix donate visible when the LLM finds no request', async () => {
    vi.mocked(extractCharacters).mockResolvedValueOnce([]);
    const r = unidentified({ source: 'donation', amountVal: 5, message: 'x'.repeat(250) });
    await op({ type: 'add-request', request: r });
    await settle();
    expect((await queue())[0]).toMatchObject({ type: 'unknown', character: '', needsIdentification: false });
  });

  it('retries on the heartbeat after a failure, then leaves it to the streamer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(extractCharacters).mockRejectedValue(new Error('503'));
    const r = unidentified();
    await op({ type: 'add-request', request: r });
    await settle();
    expect((await queue())[0].needsIdentification).toBe(true);
    const t = await token();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 31_000);
      await state('', t);
      await settle();
    }
    expect(extractCharacters).toHaveBeenCalledTimes(3);
    expect((await queue())[0]).toMatchObject({ character: '', needsIdentification: false });
  });

  it('takes over an identification whose Worker went away', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(extractCharacters).mockImplementationOnce(() => new Promise(() => {})); // never answers
    const r = unidentified();
    void op({ type: 'add-request', request: r }); // its window went away mid-call
    await vi.waitFor(() => expect(extractCharacters).toHaveBeenCalledTimes(1));
    const t = await token();
    vi.setSystemTime(Date.now() + 31_000);
    await state('', t);
    await settle();
    expect(extractCharacters).toHaveBeenCalledTimes(1); // still claimed
    vi.setSystemTime(Date.now() + 61_000);
    await state('', t);
    await settle();
    expect(extractCharacters).toHaveBeenCalledTimes(2);
    expect((await queue())[0]).toMatchObject({ character: 'Meg Thomas', needsIdentification: false });
  });

  it("doesn't let a call that was taken over add its answer", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let late!: () => void;
    vi.mocked(extractCharacters).mockImplementationOnce(() => new Promise((res) => {
      late = () => res([{ character: 'Trapper', type: 'killer' }, { character: 'Nurse', type: 'killer' }]);
    }));
    await op({ type: 'update-sources', sources: { minDonation: 5 } as never });
    const donation = unidentified({ source: 'donation', amountVal: 10, message: 'trapper e nurse' });
    const slow = op({ type: 'add-request', request: donation });
    await vi.waitFor(() => expect(late).toBeDefined());
    vi.mocked(extractCharacters).mockResolvedValueOnce([{ character: 'Huntress', type: 'killer' }]);
    vi.setSystemTime(Date.now() + 61_000);
    await state('', await token());
    await settle();
    late();
    await slow;
    expect((await queue()).map((r) => r.character)).toEqual(['Huntress']);
  });

  it('gives up without another call when the last attempt went away too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.mocked(extractCharacters).mockImplementation(() => new Promise(() => {})); // never answers
    const r = unidentified();
    void op({ type: 'add-request', request: r });
    await vi.waitFor(() => expect(extractCharacters).toHaveBeenCalledTimes(1));
    const t = await token();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(Date.now() + 61_000);
      await state('', t);
      pending.length = 0;
    }
    expect(extractCharacters).toHaveBeenCalledTimes(3);
    await vi.waitFor(async () => expect((await queue())[0]).toMatchObject({ character: '', needsIdentification: false }));
  });

  it("doesn't split a donation the streamer deleted meanwhile", async () => {
    let answer!: () => void;
    vi.mocked(extractCharacters).mockImplementationOnce(() => new Promise((res) => {
      answer = () => res([{ character: 'Trapper', type: 'killer' }, { character: 'Nurse', type: 'killer' }]);
    }));
    await op({ type: 'update-sources', sources: { minDonation: 5 } as never });
    const donation = unidentified({ source: 'donation', amountVal: 10, message: 'trapper e nurse' });
    const added = op({ type: 'add-request', request: donation });
    await vi.waitFor(() => expect(answer).toBeDefined());
    await op({ type: 'delete-request', id: donation.id });
    answer();
    await added;
    expect(await queue()).toEqual([]);
  });
});
