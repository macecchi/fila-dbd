import { describe, it, expect, vi, beforeEach } from 'vitest';
import PartySocket from 'partysocket';
import { connectParty, disconnectParty } from './party';

vi.mock('partysocket', () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    const listeners: Record<string, ((e?: unknown) => void)[]> = {};
    this.listeners = listeners;
    this.addEventListener = vi.fn((type: string, fn: (e?: unknown) => void) => { (listeners[type] ??= []).push(fn); });
    this.close = vi.fn();
    this.reconnect = vi.fn();
  }),
}));

type MockSocket = { listeners: Record<string, ((e?: unknown) => void)[]> };
const emit = (sock: MockSocket, type: string, e: unknown = {}) => sock.listeners[type]?.forEach((fn) => fn(e));

type Query = () => Promise<Record<string, string>>;

function queryOfLastSocket(): Query {
  const calls = vi.mocked(PartySocket).mock.calls;
  return (calls[calls.length - 1][0] as { query: Query }).query;
}

describe('connectParty — every connection presents a current token', () => {
  beforeEach(() => {
    disconnectParty();
    vi.mocked(PartySocket).mockClear();
  });

  it('asks for the token again on each connect, so a reconnect is not stuck with an expired one', async () => {
    // Access tokens live an hour. The socket reconnects on its own (a blip, a deploy),
    // and the server only authenticates at connect — reusing the page-load token would
    // bring the streamer back anonymous and every edit would be refused.
    const getToken = vi.fn()
      .mockResolvedValueOnce('token-at-page-load')
      .mockResolvedValueOnce('token-after-refresh');

    connectParty('Streamer', getToken, vi.fn());
    const query = queryOfLastSocket();

    expect(await query()).toMatchObject({ token: 'token-at-page-load' });
    expect(await query()).toMatchObject({ token: 'token-after-refresh' });
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  it('connects without a token param when there is none', async () => {
    connectParty('streamer', async () => null, vi.fn());
    const params = await queryOfLastSocket()();
    expect(params).not.toHaveProperty('token');
    expect(params).toHaveProperty('v');
  });

  it('lets a failed token lookup fail the attempt, for the socket to retry', async () => {
    connectParty('streamer', async () => { throw new Error('offline'); }, vi.fn());
    await expect(queryOfLastSocket()()).rejects.toThrow('offline');
  });

  it('ignores events from a socket that has been replaced or closed', () => {
    // partysocket resolves `query` after its reconnect wait even once closed, and a failed
    // lookup then emits close + error on the dead socket: those must not touch state.
    const first = { onMessage: vi.fn(), onOpen: vi.fn(), onClose: vi.fn(), onError: vi.fn() };
    connectParty('streamer', async () => null, first.onMessage, first.onOpen, first.onClose, first.onError);
    const oldSocket = vi.mocked(PartySocket).mock.instances.at(-1) as unknown as MockSocket;

    connectParty('streamer', async () => null, vi.fn());
    emit(oldSocket, 'close', { code: 1006, wasClean: false });
    emit(oldSocket, 'error');
    emit(oldSocket, 'open');
    emit(oldSocket, 'message', { data: JSON.stringify({ type: 'ownership-granted' }) });

    expect(first.onClose).not.toHaveBeenCalled();
    expect(first.onError).not.toHaveBeenCalled();
    expect(first.onOpen).not.toHaveBeenCalled();
    expect(first.onMessage).not.toHaveBeenCalled();

    disconnectParty();
  });
});
