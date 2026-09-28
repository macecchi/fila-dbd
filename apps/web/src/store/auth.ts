import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8787';
const TWITCH_CLIENT_ID = import.meta.env.VITE_TWITCH_CLIENT_ID || '';

interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

interface JwtPayload {
  sub: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  exp: number;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: TwitchUser | null;
  isAuthenticated: boolean;
  login: () => void;
  logout: () => void;
  handleCallback: () => Promise<boolean>;
  refresh: () => Promise<boolean>;
  getAccessToken: () => Promise<string | null>;
}

function decodeJwtPayload(token: string): JwtPayload {
  const [, payload] = token.split('.');
  return JSON.parse(atob(payload));
}

// Access tokens are refreshed this long before they expire: the server checks `exp`
// against its own clock, a moment later, so a token only valid by this machine's
// clock would open an unauthenticated socket.
const ACCESS_TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;

function isTokenExpired(token: string, marginMs = 0): boolean {
  try {
    const { exp } = decodeJwtPayload(token);
    return Date.now() + marginMs >= exp * 1000;
  } catch {
    return true;
  }
}

export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isAuthenticated: false,

      login: () => {
        const redirectUri = `${window.location.origin}/auth/callback`;
        const state = crypto.randomUUID();
        sessionStorage.setItem('oauth_state', state);
        const params = new URLSearchParams({
          client_id: TWITCH_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: 'code',
          state,
        });
        window.location.href = `https://id.twitch.tv/oauth2/authorize?${params}`;
      },

      logout: () => {
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          isAuthenticated: false,
        });
      },

      handleCallback: async () => {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('code');
        const state = params.get('state');
        const error = params.get('error');

        if (!code && !error) return false;

        window.history.replaceState(null, '', window.location.pathname);

        if (error) {
          console.error('Auth error:', error);
          return false;
        }

        const savedState = sessionStorage.getItem('oauth_state');
        sessionStorage.removeItem('oauth_state');
        if (state !== savedState) {
          console.error('OAuth state mismatch');
          return false;
        }

        try {
          const redirectUri = `${window.location.origin}/auth/callback`;
          const res = await fetch(`${API_URL}/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, redirect_uri: redirectUri }),
          });

          if (!res.ok) {
            console.error('Token exchange failed:', await res.text());
            return false;
          }

          const data = await res.json() as { access_token: string; refresh_token: string };
          const payload = decodeJwtPayload(data.access_token);
          set({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            user: {
              id: payload.sub,
              login: payload.login,
              display_name: payload.display_name,
              profile_image_url: payload.profile_image_url,
            },
            isAuthenticated: true,
          });
          return true;
        } catch (e) {
          console.error('Token exchange error:', e);
          return false;
        }
      },

      refresh: async () => {
        const { refreshToken } = get();
        if (!refreshToken) return false;

        if (isTokenExpired(refreshToken)) {
          get().logout();
          return false;
        }

        try {
          const res = await fetch(`${API_URL}/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken }),
          });

          if (!res.ok) {
            get().logout();
            return false;
          }

          const data = await res.json();
          set({ accessToken: data.access_token });
          return true;
        } catch {
          return false;
        }
      },

      getAccessToken: async () => {
        const { accessToken, refresh } = get();

        if (!accessToken) return null;

        if (isTokenExpired(accessToken, ACCESS_TOKEN_EXPIRY_MARGIN_MS)) {
          const refreshed = await refresh();
          if (!refreshed) return null;
          return get().accessToken;
        }

        return accessToken;
      },
    }),
    {
      name: 'dbd-auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
