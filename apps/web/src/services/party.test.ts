import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { connectParty, disconnectParty, broadcastToggleDone, broadcastIrcStatus } from './party';
import type { PartyMessage } from '../types';

const channel = { status: 'online', owner: { login: 'streamer', displayName: 'Streamer', avatar: '' }, closedByOwner: false };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const fetchMock = vi.fn((url: string, init?: RequestInit) => Promise.resolve(handler(url, init)));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const full = (version: number, requests: unknown[] = []) => json({ version, channel, requests, sources: { enabled: {} } });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
});

afterEach(() => {
  disconnectParty();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function connect(getToken: () => Promise<string | null> = async () => 'tok') {
  const messages: PartyMessage[] = [];
  const onOpen = vi.fn();
  const onClose = vi.fn();
  connectParty('Streamer', getToken, (m) => messages.push(m), onOpen, onClose, undefined, { isOwner: true });
  return { messages, onOpen, onClose };
}

const polls = () => fetchMock.mock.calls.filter(([url]) => url.includes('/state'));

describe('room transport', () => {
  it('presents a current token on every poll, so the heartbeat never goes stale', async () => {
    handler = () => full(1);
    const getToken = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    connect(getToken);
    await flush();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls().map(([, init]) => (init?.headers as Record<string, string>).Authorization)).toEqual(['Bearer first', 'Bearer second']);
  });

  it('syncs in full first, then only when the version moves', async () => {
    let version = 1;
    handler = (url) => (url.includes(`v=${version}`) ? json({ version, channel }) : full(version));
    const { messages, onOpen } = connect();
    await flush();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(messages.map((m) => m.type)).toEqual(['sync-full']);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages).toHaveLength(1);

    version = 2;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages.map((m) => m.type)).toEqual(['sync-full', 'sync-full']);
  });

  it('tells the stores when the channel status changes between versions', async () => {
    let status = 'online';
    handler = (url) => (url.includes('v=1') ? json({ version: 1, channel: { ...channel, status } }) : full(1));
    const { messages } = connect();
    await flush();
    status = 'live';
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages[1]).toEqual({ type: 'update-channel', channel: { ...channel, status: 'live' } });
  });

  it('marks the window reading chat in its polls', async () => {
    handler = () => full(1);
    connect();
    await flush();
    handler = (url) => (!url.includes('/state') ? json({ messages: [] }) : full(1));
    broadcastIrcStatus(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls().at(-1)![0]).toContain('irc=1');
  });

  it('delivers the server echo of an edit, and drops a poll that predates it', async () => {
    handler = () => full(1, [{ id: 7, done: false }]);
    const { messages } = connect();
    await flush();

    let release!: () => void;
    handler = (url) => {
      if (!url.includes('/state')) {
        return new Promise<Response>((r) => { release = () => r(json({ version: 2, messages: [{ type: 'toggle-done', id: 7, done: true }] })); });
      }
      return full(1, [{ id: 7, done: false }]);
    };
    broadcastToggleDone(7, true);
    await vi.advanceTimersByTimeAsync(5_000); // a poll answers while the edit is in flight
    expect(messages.map((m) => m.type)).toEqual(['sync-full']);

    release();
    await flush();
    expect(messages.at(-1)).toEqual({ type: 'toggle-done', id: 7, done: true });

    // A slow replica answering with the old version doesn't undo it either.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(messages.at(-1)).toEqual({ type: 'toggle-done', id: 7, done: true });
  });

  it('retries a failed edit, then reports it as not saved', async () => {
    handler = () => full(1);
    const { messages } = connect();
    await flush();
    handler = (url) => (!url.includes('/state') ? json({}, 503) : full(1));
    broadcastToggleDone(7, true);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchMock.mock.calls.filter(([url]) => !url.includes('/state'))).toHaveLength(4);
    expect(messages.at(-1)).toMatchObject({ type: 'server-error', code: 'persist_failed' });

    // The next poll is a full one, so the unsaved optimistic change goes away.
    const before = polls().length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(polls().length).toBeGreaterThan(before);
    expect(polls().at(-1)![0]).not.toContain('v=');
  });

  it('reports an outage once and syncs in full when the room is back', async () => {
    handler = () => full(1);
    const { messages, onOpen, onClose } = connect();
    await flush();
    handler = () => { throw new TypeError('offline'); };
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onClose).toHaveBeenCalledTimes(1);

    handler = (url) => (url.includes('v=') ? json({ version: 1, channel }) : full(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(messages.filter((m) => m.type === 'sync-full')).toHaveLength(2);
  });

  it('retries a poll whose token lookup failed instead of polling anonymously', async () => {
    handler = () => full(1);
    const getToken = vi.fn().mockRejectedValueOnce(new Error('no token')).mockResolvedValue('tok');
    const { onOpen } = connect(getToken);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('asks for a reload when the server no longer speaks this protocol', async () => {
    handler = () => json({ error: 'version_mismatch' }, 426);
    const { messages } = connect();
    await flush();
    expect(messages).toEqual([expect.objectContaining({ type: 'server-error', code: 'version_mismatch' })]);
  });

  it('stops for good once disconnected', async () => {
    handler = () => full(1);
    const { messages } = connect();
    disconnectParty();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(messages).toEqual([]);
  });
});
