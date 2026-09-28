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
