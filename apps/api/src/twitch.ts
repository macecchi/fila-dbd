const APP_TOKEN_KV_KEY = "twitch_app_token";
const BOT_TOKEN_KV_KEY = "bot_token";
const BROADCASTER_ID_PREFIX = "room_uid:";
const BROADCASTER_ID_TTL = 60 * 60 * 24; // 24h

interface TwitchEnv {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  CACHE: KVNamespace;
}

export interface TwitchProfile {
  login: string;
  display_name: string;
  avatar_url: string;
  banner_url: string;
}

export interface TwitchStream {
  user_login: string;
  thumbnail_url: string;
  viewer_count: number;
}

export interface BotToken {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user_id: string;
  login: string;
}

export type SendChatResult =
  | { ok: true; message_id?: string }
  | { ok: false; reason: 'no_bot_token' | 'no_broadcaster' | 'not_mod' | 'token_invalid' | 'message_rejected' | 'unknown'; detail?: string };

export type ModStatusResult =
  | { ok: true; is_mod: boolean; bot_login: string }
  | { ok: false; reason: 'no_bot_token' | 'scope_missing' | 'twitch_error'; detail?: string };

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

  const data = await res.json() as { data: Array<{ login: string; display_name: string; profile_image_url: string; offline_image_url: string }> };
  return data.data.map((u) => ({
    login: u.login.toLowerCase(),
    display_name: u.display_name,
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

// Recent VOD (archive) thumbnails for a channel — visual texture for the
// Wrapped slides. Best-effort: any failure returns [].
export async function fetchRecentVodThumbs(
  login: string,
  token: string,
  clientId: string,
  count = 3
): Promise<string[]> {
  try {
    const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${login}`, { headers: helixHeaders(token, clientId) });
    if (!userRes.ok) return [];
    const userData = await userRes.json() as { data: Array<{ id: string }> };
    const userId = userData.data[0]?.id;
    if (!userId) return [];

    const vodRes = await fetch(
      `https://api.twitch.tv/helix/videos?user_id=${userId}&type=archive&first=${count}`,
      { headers: helixHeaders(token, clientId) }
    );
    if (!vodRes.ok) return [];
    const vodData = await vodRes.json() as { data: Array<{ thumbnail_url: string }> };
    return vodData.data
      .map((v) => v.thumbnail_url.replace("%{width}", "640").replace("%{height}", "360"))
      .filter((u) => u.length > 0);
  } catch {
    return [];
  }
}

export function cacheProfiles(db: D1Database, profiles: TwitchProfile[], ctx: ExecutionContext) {
  if (profiles.length === 0) return;
  const statements = profiles.map((p) =>
    db.prepare(
      "INSERT INTO rooms (id, channel_login, display_name, avatar_url, banner_url) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, avatar_url = excluded.avatar_url, banner_url = excluded.banner_url"
    ).bind(p.login, p.login, p.display_name, p.avatar_url, p.banner_url)
  );
  ctx.waitUntil(db.batch(statements));
}

// ============ BOT (CHAT SENDER) ============

async function readBotToken(env: TwitchEnv): Promise<BotToken | null> {
  const raw = await env.CACHE.get(BOT_TOKEN_KV_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BotToken;
  } catch {
    return null;
  }
}

async function writeBotToken(env: TwitchEnv, token: BotToken): Promise<void> {
  await env.CACHE.put(BOT_TOKEN_KV_KEY, JSON.stringify(token));
}

export async function refreshBotToken(env: TwitchEnv, current: BotToken): Promise<BotToken | null> {
  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: current.refresh_token,
    }),
  });

  if (!res.ok) {
    console.warn("[bot-token] refresh failed", res.status, await res.text());
    return null;
  }

  const data = await res.json() as { access_token: string; refresh_token: string; expires_in: number };
  const refreshed: BotToken = {
    ...current,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
  };
  await writeBotToken(env, refreshed);
  return refreshed;
}

export async function getBotToken(env: TwitchEnv): Promise<BotToken | null> {
  const current = await readBotToken(env);
  if (!current) return null;

  const now = Math.floor(Date.now() / 1000);
  if (current.expires_at - 60 > now) return current;

  return refreshBotToken(env, current);
}

export async function getBroadcasterId(env: TwitchEnv, login: string): Promise<string | null> {
  const key = `${BROADCASTER_ID_PREFIX}${login.toLowerCase()}`;
  const cached = await env.CACHE.get(key);
  if (cached) return cached;

  const appToken = await getAppToken(env);
  if (!appToken) return null;

  const res = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
    headers: helixHeaders(appToken, env.TWITCH_CLIENT_ID),
  });
  if (!res.ok) return null;

  const data = await res.json() as { data: Array<{ id: string }> };
  const id = data.data?.[0]?.id;
  if (!id) return null;

  await env.CACHE.put(key, id, { expirationTtl: BROADCASTER_ID_TTL });
  return id;
}

async function postChatMessage(env: TwitchEnv, token: string, broadcasterId: string, senderId: string, message: string) {
  return fetch("https://api.twitch.tv/helix/chat/messages", {
    method: "POST",
    headers: {
      ...helixHeaders(token, env.TWITCH_CLIENT_ID),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      broadcaster_id: broadcasterId,
      sender_id: senderId,
      message,
    }),
  });
}

export async function sendChatMessage(
  env: TwitchEnv,
  broadcasterLogin: string,
  message: string
): Promise<SendChatResult> {
  let bot = await getBotToken(env);
  if (!bot) return { ok: false, reason: 'no_bot_token' };

  const broadcasterId = await getBroadcasterId(env, broadcasterLogin);
  if (!broadcasterId) return { ok: false, reason: 'no_broadcaster' };

  let res = await postChatMessage(env, bot.access_token, broadcasterId, bot.user_id, message);

  if (res.status === 401) {
    // Token might be invalid; force refresh once.
    const refreshed = await refreshBotToken(env, bot);
    if (!refreshed) return { ok: false, reason: 'token_invalid' };
    bot = refreshed;
    res = await postChatMessage(env, bot.access_token, broadcasterId, bot.user_id, message);
  }

  if (res.status === 401) return { ok: false, reason: 'token_invalid' };
  if (res.status === 403) return { ok: false, reason: 'not_mod' };

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, reason: 'unknown', detail: `${res.status} ${detail.slice(0, 200)}` };
  }

  // Twitch returns 200 with `data[0].is_sent`; false means the message was dropped by AutoMod or similar.
  const data = await res.json().catch(() => null) as { data?: Array<{ message_id: string; is_sent: boolean; drop_reason?: { code: string; message: string } | null }> } | null;
  const entry = data?.data?.[0];
  if (entry && entry.is_sent === false) {
    return { ok: false, reason: 'message_rejected', detail: entry.drop_reason?.code };
  }

  return { ok: true, message_id: entry?.message_id };
}

// Verifies the bot account is a moderator in the given channel by querying
// GET /helix/moderation/channels with the bot's own user_id. Paginates because
// the bot may end up modded in many channels — searches until match or exhausted.
//
// Returns { is_mod: false } when the bot is not modded; { ok: false, reason } when
// the token is missing the new scope or another Twitch error occurred (so the UI
// can distinguish "not modded" from "setup is broken").
export async function checkBotIsMod(env: TwitchEnv, broadcasterLogin: string): Promise<ModStatusResult> {
  const bot = await getBotToken(env);
  if (!bot) return { ok: false, reason: 'no_bot_token' };

  const target = broadcasterLogin.trim().toLowerCase();
  let cursor: string | undefined;

  // Cap pagination to avoid runaway loops if Twitch returns unexpected data.
  for (let page = 0; page < 50; page++) {
    const url = new URL('https://api.twitch.tv/helix/moderation/channels');
    url.searchParams.set('user_id', bot.user_id);
    url.searchParams.set('first', '100');
    if (cursor) url.searchParams.set('after', cursor);

    const res = await fetch(url, { headers: helixHeaders(bot.access_token, env.TWITCH_CLIENT_ID) });

    if (res.status === 401) {
      // Could be missing scope (user_id:read:moderated_channels) or invalidated token.
      const text = await res.text().catch(() => '');
      if (text.toLowerCase().includes('scope')) {
        return { ok: false, reason: 'scope_missing', detail: text.slice(0, 200) };
      }
      return { ok: false, reason: 'twitch_error', detail: `401 ${text.slice(0, 200)}` };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: 'twitch_error', detail: `${res.status} ${text.slice(0, 200)}` };
    }

    const data = await res.json() as {
      data?: Array<{ broadcaster_login: string }>;
      pagination?: { cursor?: string };
    };
    const list = data.data ?? [];
    if (list.some((c) => c.broadcaster_login.toLowerCase() === target)) {
      return { ok: true, is_mod: true, bot_login: bot.login };
    }

    cursor = data.pagination?.cursor;
    if (!cursor) break;
  }

  return { ok: true, is_mod: false, bot_login: bot.login };
}
