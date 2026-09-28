import { describe, it, expect, vi, beforeEach } from 'vitest';
import PartySocket from 'partysocket';
import { connectParty, disconnectParty } from './party';

vi.mock('partysocket', () => ({
  default: vi.fn(function (this: Record<string, unknown>) {
    this.addEventListener = vi.fn();
    this.close = vi.fn();
    this.reconnect = vi.fn();
  }),
}));

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
});
