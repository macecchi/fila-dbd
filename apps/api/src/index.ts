import { Hono } from "hono";
import { cors } from "hono/cors";
import { sign } from "hono/jwt";
import { Twitch } from "arctic";
import { verifyJwt, type JwtPayload } from "./jwt";
import { extractCharacter } from "./gemini";
import { getAppToken, fetchProfiles, fetchStreams, cacheProfiles } from "./twitch";

type Bindings = {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  JWT_SECRET: string;
  FRONTEND_URL: string;
  GEMINI_API_KEY: string;
  INTERNAL_API_SECRET: string;
  PARTY_HOST: string;
  DB: D1Database;
  CACHE: KVNamespace;
};

type Variables = {
  jwtPayload: JwtPayload;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// CORS for frontend (also allows *.filadbd.pages.dev preview subdomains)
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const frontend = new URL(c.env.FRONTEND_URL);
      if (!origin) return frontend.origin;
      const url = new URL(origin);
      if (url.hostname === frontend.hostname || url.hostname.endsWith(`.${frontend.hostname}`)) return origin;
      return frontend.origin;
    },
    credentials: true,
  })
);

// ============ AUTH ROUTES ============

// Redirect to Twitch OAuth
app.get("/auth/login", (c) => {
  const origin = new URL(c.req.url).origin;
  const twitch = new Twitch(
    c.env.TWITCH_CLIENT_ID,
    c.env.TWITCH_CLIENT_SECRET,
    `${origin}/auth/callback`
  );

  const state = crypto.randomUUID();
  const url = twitch.createAuthorizationURL(state, ["user:read:email"]);

  return c.redirect(url.toString());
});

// Twitch callback - exchange code, verify identity, issue JWT
app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.redirect(`${c.env.FRONTEND_URL}?error=missing_code`);
  }

  const origin = new URL(c.req.url).origin;
  const twitch = new Twitch(
    c.env.TWITCH_CLIENT_ID,
    c.env.TWITCH_CLIENT_SECRET,
    `${origin}/auth/callback`
  );

  try {
    // Exchange code for Twitch tokens
    const tokens = await twitch.validateAuthorizationCode(code);

    // Get user info from Twitch
    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken()}`,
        "Client-Id": c.env.TWITCH_CLIENT_ID,
      },
    });

    if (!userRes.ok) {
      return c.redirect(`${c.env.FRONTEND_URL}?error=twitch_api_error`);
    }

    const userData = (await userRes.json()) as {
      data: Array<{
        id: string;
        login: string;
        display_name: string;
        profile_image_url: string;
      }>;
    };
    const user = userData.data[0];

    if (!user) {
      return c.redirect(`${c.env.FRONTEND_URL}?error=no_user`);
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.id,
      login: user.login,
      display_name: user.display_name,
      profile_image_url: user.profile_image_url,
    };

    // Issue access token (1 hour) and refresh token (90 days)
    const accessToken = await sign(
      { ...payload, exp: now + 60 * 60 },
      c.env.JWT_SECRET,
      "HS256"
    );
    const refreshToken = await sign(
      { ...payload, exp: now + 60 * 60 * 24 * 90 },
      c.env.JWT_SECRET,
      "HS256"
    );

    // Redirect back to frontend with tokens
    const params = new URLSearchParams({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    return c.redirect(`${c.env.FRONTEND_URL}?${params}`);
  } catch (error) {
    console.error("Auth error:", error);
    return c.redirect(`${c.env.FRONTEND_URL}?error=auth_failed`);
  }
});

// Refresh access token using refresh token
app.post("/auth/refresh", async (c) => {
  const body = await c.req.json<{ refresh_token: string }>();

  if (!body.refresh_token) {
    return c.json({ error: "missing_refresh_token" }, 400);
  }

  const payload = await verifyJwt(body.refresh_token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "invalid_refresh_token" }, 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const accessToken = await sign(
    {
      sub: payload.sub,
      login: payload.login,
      display_name: payload.display_name,
      profile_image_url: payload.profile_image_url,
      exp: now + 60 * 60,
    },
    c.env.JWT_SECRET,
    "HS256"
  );

  return c.json({ access_token: accessToken });
});

// Get current user from token
app.get("/auth/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "invalid_token" }, 401);
  }

  return c.json({
    id: payload.sub,
    login: payload.login,
    display_name: payload.display_name,
    profile_image_url: payload.profile_image_url,
  });
});

// ============ PROTECTED API ROUTES ============

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// JWT middleware for protected routes
api.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const token = authHeader.slice(7);
  const payload = await verifyJwt(token, c.env.JWT_SECRET);
  if (!payload) {
    return c.json({ error: "invalid_token" }, 401);
  }

  c.set("jwtPayload", payload);
  await next();
});

// Twitch chat messages are capped at 500 characters
const MAX_MESSAGE_LENGTH = 500;
const DAILY_EXTRACT_LIMIT = 200;

api.post("/extract-character", async (c) => {
  const user = c.get("jwtPayload");
  const clientVersion = c.req.header("X-Client-Version") || "unknown";
  const body = await c.req.json<{ message: string }>();

  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "invalid_input" }, 400);
  }

  if (body.message.length > MAX_MESSAGE_LENGTH) {
    return c.json({ error: "message_too_long", max: MAX_MESSAGE_LENGTH }, 400);
  }

  // Per-user daily rate limit via KV
  const today = new Date().toISOString().slice(0, 10);
  const rateLimitKey = `ratelimit:extract:${user.sub}:${today}`;
  const currentCount = parseInt((await c.env.CACHE.get(rateLimitKey)) || "0", 10);

  if (currentCount >= DAILY_EXTRACT_LIMIT) {
    console.warn(`[ratelimit] User ${user.login} (${user.sub}) hit daily extract limit of ${DAILY_EXTRACT_LIMIT}`);
    return c.json({ error: "daily_limit_exceeded", limit: DAILY_EXTRACT_LIMIT }, 429);
  }

  console.log(`[v${clientVersion}] Extract request from ${user.login}: ${body.message.slice(0, 100)}`);

  try {
    const result = await extractCharacter(body.message, c.env.GEMINI_API_KEY);

    // Increment counter after successful extraction (TTL: 24h)
    const putPromise = c.env.CACHE.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 86400 });
    try {
      c.executionCtx.waitUntil(putPromise);
    } catch {
      await putPromise;
    }

    return c.json(result);
  } catch (e: any) {
    console.error("Gemini error:", e.message);
    return c.json({ error: "llm_error", message: e.message }, 502);
  }
});

app.route("/api", api);

// ============ INTERNAL API ROUTES (PartyKit → D1) ============

const internal = new Hono<{ Bindings: Bindings }>();

// Internal auth middleware — validates shared secret
internal.use("*", async (c, next) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer internal:")) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const secret = authHeader.slice("Bearer internal:".length);
  if (!c.env.INTERNAL_API_SECRET || secret !== c.env.INTERNAL_API_SECRET) {
    return c.json({ error: "invalid_secret" }, 401);
  }

  await next();
});

// PUT /internal/rooms/:roomId/requests — bulk upsert all requests
internal.put("/rooms/:roomId/requests", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{ requests: Array<Record<string, unknown>> }>();

  if (!Array.isArray(body.requests)) {
    return c.json({ error: "invalid_input" }, 400);
  }

  const statements: D1PreparedStatement[] = [];

  // Ensure room exists
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO rooms (id, channel_login) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')"
    ).bind(roomId, roomId)
  );

  // Delete existing requests for this room
  statements.push(
    c.env.DB.prepare("DELETE FROM requests WHERE room_id = ?").bind(roomId)
  );

  // Insert all current requests with position
  for (let i = 0; i < body.requests.length; i++) {
    const r = body.requests[i];
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO requests (id, room_id, position, timestamp, donor, amount, amount_val, message, character, type, done, source, sub_tier, needs_identification)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        r.id,
        roomId,
        i,
        r.timestamp,
        r.donor,
        r.amount ?? "",
        r.amountVal ?? 0,
        r.message ?? "",
        r.character ?? "",
        r.type ?? "unknown",
        r.done ? 1 : 0,
        r.source,
        r.subTier ?? null,
        r.needsIdentification ? 1 : 0
      )
    );
  }

  await c.env.DB.batch(statements);
  return c.json({ ok: true, count: body.requests.length });
});

// PUT /internal/rooms/:roomId/sources — upsert room sources settings
internal.put("/rooms/:roomId/sources", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{
    enabled: Record<string, boolean>;
    chatCommand: string;
    chatTiers: number[];
    priority: string[];
    sortMode: string;
    minDonation: number;
    recoveryVodId?: string;
    recoveryVodOffset?: number;
  }>();

  await c.env.DB.prepare(
    `INSERT INTO rooms (id, channel_login, enabled_donation, enabled_chat, enabled_resub, enabled_manual, chat_command, chat_tiers, priority, sort_mode, min_donation, recovery_vod_id, recovery_vod_offset, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       enabled_donation = excluded.enabled_donation,
       enabled_chat = excluded.enabled_chat,
       enabled_resub = excluded.enabled_resub,
       enabled_manual = excluded.enabled_manual,
       chat_command = excluded.chat_command,
       chat_tiers = excluded.chat_tiers,
       priority = excluded.priority,
       sort_mode = excluded.sort_mode,
       min_donation = excluded.min_donation,
       recovery_vod_id = excluded.recovery_vod_id,
       recovery_vod_offset = excluded.recovery_vod_offset,
       updated_at = datetime('now')`
  ).bind(
    roomId,
    roomId,
    body.enabled?.donation ? 1 : 0,
    body.enabled?.chat ? 1 : 0,
    body.enabled?.resub ? 1 : 0,
    body.enabled?.manual ? 1 : 0,
    body.chatCommand ?? "!fila",
    JSON.stringify(body.chatTiers ?? [2, 3]),
    JSON.stringify(body.priority ?? ["donation", "chat", "resub", "manual"]),
    body.sortMode ?? "fifo",
    body.minDonation ?? 5,
    body.recoveryVodId ?? null,
    body.recoveryVodOffset ?? null
  ).run();

  return c.json({ ok: true });
});

// PUT /internal/rooms/:roomId/status — update room status
internal.put("/rooms/:roomId/status", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{ status: string }>();

  await c.env.DB.prepare(
    `INSERT INTO rooms (id, channel_login, status) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`
  ).bind(roomId, roomId, body.status).run();

  return c.json({ ok: true });
});

app.route("/internal", internal);

// ============ PUBLIC API ROUTES ============

interface RoomRow {
  id: string;
  channel_login: string;
  avatar_url: string | null;
  banner_url: string | null;
  status: string;
  updated_at: string;
  request_count?: number;
  pending_count?: number;
}

app.get("/rooms/active", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.channel_login, r.avatar_url, r.banner_url, r.status,
            COUNT(req.id) AS request_count,
            SUM(CASE WHEN req.done = 0 THEN 1 ELSE 0 END) AS pending_count,
            r.updated_at
     FROM rooms r
     LEFT JOIN requests req ON req.room_id = r.id
     WHERE r.updated_at > datetime('now', '-24 hours')
     GROUP BY r.id
     ORDER BY r.updated_at DESC
     LIMIT 20`
  ).all<RoomRow>();

  if (results.length === 0) return c.json({ rooms: [] });

  const token = await getAppToken(c.env);
  if (!token) return c.json({ rooms: results });

  const logins = results.map((r) => r.channel_login);

  // Fetch missing profiles from Twitch and cache in D1
  const missingLogins = results.filter((r) => !r.avatar_url).map((r) => r.channel_login);
  const profiles = await fetchProfiles(missingLogins, token, c.env.TWITCH_CLIENT_ID);
  const profileMap = new Map(profiles.map((p) => [p.login, p]));
  cacheProfiles(c.env.DB, profiles, c.executionCtx);

  // Fetch live streams
  const streams = await fetchStreams(logins, token, c.env.TWITCH_CLIENT_ID);
  const streamMap = new Map(streams.map((s) => [s.user_login, s]));

  // For rooms that D1 claims are non-offline, ask PartyKit for authoritative status
  const partyHost = c.env.PARTY_HOST;
  const partyStatusMap = new Map<string, { status: string; pending_count: number }>();
  if (partyHost) {
    const nonOffline = results.filter((r) => r.status !== 'offline');
    const protocol = partyHost.startsWith('localhost') ? 'http' : 'https';
    const fetches = nonOffline.map(async (r) => {
      try {
        const res = await fetch(`${protocol}://${partyHost}/parties/main/${r.id}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const data = await res.json<{ status: string; connections: number; pending_count: number }>();
          // If no connections remain, the room is definitively offline regardless of stored status
          const effectiveStatus = data.connections === 0 ? 'offline' : data.status;
          if (effectiveStatus !== r.status) {
            console.log(`[rooms/active] ${r.id}: D1 status="${r.status}" → PartyKit status="${effectiveStatus}" (connections=${data.connections})`);
          }
          partyStatusMap.set(r.id, { status: effectiveStatus, pending_count: data.pending_count });
        } else {
          console.warn(`[rooms/active] PartyKit returned ${res.status} for ${r.id}`);
        }
      } catch (e) {
        console.warn(`[rooms/active] PartyKit unreachable for ${r.id}, falling back to D1:`, e);
      }
    });
    await Promise.all(fetches);
  }

  // Staleness check: if PartyKit was unreachable and D1 says non-offline,
  // but updated_at is older than 1 hour, treat as offline (D1 sync likely failed)
  const STALE_MS = 60 * 60 * 1000; // 1 hour
  const now = Date.now();

  const enriched = results.map((r) => {
    const login = r.channel_login.toLowerCase();
    const fresh = profileMap.get(login);
    const stream = streamMap.get(login);
    const isLive = !!stream;

    // Use PartyKit as source of truth for status and pending count when available
    const partyInfo = partyStatusMap.get(r.id);
    let status = partyInfo?.status ?? r.status;
    const pendingCount = partyInfo ? partyInfo.pending_count : (r.pending_count ?? 0);

    // If PartyKit was unreachable and D1 says non-offline, check staleness
    if (!partyInfo && status !== 'offline') {
      const updatedAt = new Date(r.updated_at + 'Z').getTime();
      if (now - updatedAt > STALE_MS) {
        console.log(`[rooms/active] ${r.id}: D1 status="${status}" is stale (updated ${Math.round((now - updatedAt) / 60000)}m ago), treating as offline`);
        status = 'offline';
      }
    }

    return {
      ...r,
      status,
      pending_count: pendingCount,
      avatar_url: r.avatar_url ?? fresh?.avatar_url ?? null,
      banner_url: r.banner_url ?? fresh?.banner_url ?? null,
      is_live: isLive,
      thumbnail_url: stream?.thumbnail_url ?? null,
      viewer_count: stream?.viewer_count ?? null,
    };
  });

  // Sort: online/live first, then by viewer count, then by pending requests
  enriched.sort((a, b) => {
    const aOnline = a.status !== 'offline' ? 1 : 0;
    const bOnline = b.status !== 'offline' ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    if ((a.viewer_count ?? 0) !== (b.viewer_count ?? 0)) return (b.viewer_count ?? 0) - (a.viewer_count ?? 0);
    return (b.pending_count ?? 0) - (a.pending_count ?? 0);
  });

  return c.json({ rooms: enriched.slice(0, 12) });
});

app.get("/rooms/:roomId", async (c) => {
  const roomId = c.req.param("roomId").toLowerCase();
  const row = await c.env.DB.prepare(
    "SELECT id, channel_login, avatar_url, status, updated_at FROM rooms WHERE id = ?"
  ).bind(roomId).first<RoomRow>();

  const room = row ?? { id: roomId, channel_login: roomId, avatar_url: null as string | null, banner_url: null, status: "offline", updated_at: null };

  if (!room.avatar_url) {
    const token = await getAppToken(c.env);
    if (token) {
      const profiles = await fetchProfiles([roomId], token, c.env.TWITCH_CLIENT_ID);
      if (profiles[0]) {
        room.avatar_url = profiles[0].avatar_url;
        cacheProfiles(c.env.DB, profiles, c.executionCtx);
      }
    }
  }

  return c.json({ room });
});

export default app;
