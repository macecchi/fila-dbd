const APP_TOKEN_KV_KEY = "twitch_app_token";

interface TwitchEnv {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  CACHE: KVNamespace;
}

export interface TwitchProfile {
  login: string;
  avatar_url: string;
  banner_url: string;
}

export interface TwitchStream {
  user_login: string;
  thumbnail_url: string;
  viewer_count: number;
}

export async function getAppToken(env: TwitchEnv): Promise<string | null> {
  const cached = await env.CACHE.get(APP_TOKEN_KV_KEY);
  if (cached) return cached;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) return null;

  const data = await res.json() as { access_token: string; expires_in: number };
  await env.CACHE.put(APP_TOKEN_KV_KEY, data.access_token, { expirationTtl: data.expires_in - 300 });
  return data.access_token;
}

function helixHeaders(token: string, clientId: string) {
  return { Authorization: `Bearer ${token}`, "Client-Id": clientId };
}

export async function fetchProfiles(logins: string[], token: string, clientId: string): Promise<TwitchProfile[]> {
  if (logins.length === 0) return [];
  const param = logins.map((l) => `login=${l}`).join("&");
  const res = await fetch(`https://api.twitch.tv/helix/users?${param}`, { headers: helixHeaders(token, clientId) });
  if (!res.ok) return [];

  const data = await res.json() as { data: Array<{ login: string; profile_image_url: string; offline_image_url: string }> };
  return data.data.map((u) => ({
    login: u.login.toLowerCase(),
    avatar_url: u.profile_image_url,
    banner_url: u.offline_image_url,
  }));
}

export async function fetchStreams(logins: string[], token: string, clientId: string): Promise<TwitchStream[]> {
  if (logins.length === 0) return [];
  const param = logins.map((l) => `user_login=${l}`).join("&");
  const res = await fetch(`https://api.twitch.tv/helix/streams?${param}`, { headers: helixHeaders(token, clientId) });
  if (!res.ok) return [];

  const data = await res.json() as { data: Array<{ user_login: string; thumbnail_url: string; viewer_count: number }> };
  return data.data.map((s) => ({
    user_login: s.user_login.toLowerCase(),
    thumbnail_url: s.thumbnail_url.replace("{width}", "440").replace("{height}", "248"),
    viewer_count: s.viewer_count,
  }));
}

export function cacheProfiles(db: D1Database, profiles: TwitchProfile[], ctx: ExecutionContext) {
  if (profiles.length === 0) return;
  const statements = profiles.map((p) =>
    db.prepare(
      "INSERT INTO rooms (id, channel_login, avatar_url, banner_url) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET avatar_url = excluded.avatar_url, banner_url = excluded.banner_url"
    ).bind(p.login, p.login, p.avatar_url, p.banner_url)
  );
  ctx.waitUntil(db.batch(statements));
}
