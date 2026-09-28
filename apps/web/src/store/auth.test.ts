import { describe, it, expect, vi, afterEach } from 'vitest';
import { useAuth } from './auth';

function tokenExpiringIn(seconds: number): string {
  const payload = { sub: '1', login: 'streamer', display_name: 'Streamer', profile_image_url: '', exp: Math.floor(Date.now() / 1000) + seconds };
  return `header.${btoa(JSON.stringify(payload))}.sig`;
}

function signIn(accessToken: string) {
  useAuth.setState({
    accessToken,
    refreshToken: tokenExpiringIn(90 * 24 * 60 * 60),
    user: { id: '1', login: 'streamer', display_name: 'Streamer', profile_image_url: '' },
    isAuthenticated: true,
  });
}

describe('getAccessToken', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAuth.getState().logout();
  });

  it('refreshes a token about to expire, before the server stops accepting it', async () => {
    // The socket authenticates at connect, against the server's clock: a token with a
    // minute left here can already be expired by the time the handshake lands.
    signIn(tokenExpiringIn(60));
    const fresh = tokenExpiringIn(3600);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: fresh })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(useAuth.getState().getAccessToken()).resolves.toBe(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps using a token with plenty of time left', async () => {
    const current = tokenExpiringIn(30 * 60);
    signIn(current);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(useAuth.getState().getAccessToken()).resolves.toBe(current);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useAuth.getState().logout();
  });

  it('keeps the streamer signed in when the Worker errors', async () => {
    // Refresh runs on every reconnect near expiry: a Worker 500 must not sign every live
    // streamer out at once.
    signIn(tokenExpiringIn(60));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    await expect(useAuth.getState().refresh()).resolves.toBe(false);
    expect(useAuth.getState().isAuthenticated).toBe(true);
  });

  it('signs out when the server rejects the refresh token', async () => {
    signIn(tokenExpiringIn(60));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_refresh_token"}', { status: 401 })));

    await expect(useAuth.getState().refresh()).resolves.toBe(false);
    expect(useAuth.getState().isAuthenticated).toBe(false);
  });

  it('shares one request between concurrent callers', async () => {
    signIn(tokenExpiringIn(60));
    const fresh = tokenExpiringIn(3600);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: fresh })));
    vi.stubGlobal('fetch', fetchMock);

    const results = await Promise.all([useAuth.getState().refresh(), useAuth.getState().refresh(), useAuth.getState().getAccessToken()]);
    expect(results).toEqual([true, true, fresh]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect a session signed out while the refresh was in flight', async () => {
    signIn(tokenExpiringIn(60));
    let respond!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { respond = r; })));

    const pending = useAuth.getState().refresh();
    useAuth.getState().logout();
    respond(new Response(JSON.stringify({ access_token: tokenExpiringIn(3600) })));

    await expect(pending).resolves.toBe(false);
    expect(useAuth.getState().accessToken).toBeNull();
  });
});
