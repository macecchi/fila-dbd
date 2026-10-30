import { Hono } from "hono";
import { cors } from "hono/cors";
import { sign } from "hono/jwt";
import { Twitch } from "arctic";
import { verifyJwt, type JwtPayload } from "./jwt";
import { clipMessage, extractCharacters } from "./gemini";
import { DAILY_EXTRACT_LIMIT, roomStatus, roomsSync, PRESENCE_TTL_MS } from "./rooms";
import { MAX_DONATION_REQUESTS, type RequestExtraType } from "@filadbd/shared";
import { getAppToken, fetchProfiles, fetchStreams, cacheProfiles, sendChatMessage, checkBotIsMod } from "./twitch";
import { sendWebPush, isWebPushConfigured, type PushSubscriptionKeys } from "./webpush";
import { verifyEventSubSignature, ensureStreamOnlineSubscription, deleteEventSubSubscription, clearEventSubMarker } from "./eventsub";

const BATCH_CHUNK_SIZE = 80;

async function batchInChunks(db: D1Database, statements: D1PreparedStatement[]) {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK_SIZE) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK_SIZE));
  }
}

type Bindings = {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  JWT_SECRET: string;
  FRONTEND_URL: string;
  GEMINI_API_KEY: string;
  // `bun run dev` passes DEV_MODE=true: any signed-in user may edit any room.
  DEV_MODE?: string;
  // Web Push / EventSub — optional: the live-notification feature degrades to
  // off when they're unset (see /push/vapid-public-key and /twitch/eventsub).
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  EVENTSUB_SECRET?: string;
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

// Exchange Twitch OAuth code for JWT tokens
app.post("/auth/token", async (c) => {
  const body = await c.req.json<{ code: string; redirect_uri: string }>();

  if (!body.code || !body.redirect_uri) {
    return c.json({ error: "missing_code_or_redirect_uri" }, 400);
  }

  const allowed = `${c.env.FRONTEND_URL}/auth/callback`;
  if (body.redirect_uri !== allowed) {
    return c.json({ error: "invalid_redirect_uri" }, 400);
  }

  const twitch = new Twitch(
    c.env.TWITCH_CLIENT_ID,
    c.env.TWITCH_CLIENT_SECRET,
    body.redirect_uri
  );

  try {
    const tokens = await twitch.validateAuthorizationCode(body.code);

    const userRes = await fetch("https://api.twitch.tv/helix/users", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken()}`,
        "Client-Id": c.env.TWITCH_CLIENT_ID,
      },
    });

    if (!userRes.ok) {
      return c.json({ error: "twitch_api_error" }, 502);
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
      return c.json({ error: "no_user" }, 502);
    }

    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.id,
      login: user.login,
      display_name: user.display_name,
      profile_image_url: user.profile_image_url,
    };

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

    return c.json({ access_token: accessToken, refresh_token: refreshToken });
  } catch (error) {
    console.error("Auth error:", error);
    return c.json({ error: "auth_failed" }, 500);
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

api.post("/extract-character", async (c) => {
  const user = c.get("jwtPayload");
  const clientVersion = c.req.header("X-Client-Version") || "unknown";
  const body = await c.req.json<{ message: string; maxCount?: number; extras?: RequestExtraType[] }>();

  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "invalid_input" }, 400);
  }

  const message = clipMessage(body.message);

  const requestedMax = typeof body.maxCount === "number" ? body.maxCount : 1;
  const maxCount = Math.max(1, Math.min(MAX_DONATION_REQUESTS, Math.floor(requestedMax)));

  // Per-user daily rate limit via KV (one extraction call = one unit, regardless of maxCount)
  const today = new Date().toISOString().slice(0, 10);
  const rateLimitKey = `ratelimit:extract:${user.sub}:${today}`;
  const currentCount = parseInt((await c.env.CACHE.get(rateLimitKey)) || "0", 10);

  if (currentCount >= DAILY_EXTRACT_LIMIT) {
    console.warn(`[ratelimit] User ${user.login} (${user.sub}) hit daily extract limit of ${DAILY_EXTRACT_LIMIT}`);
    return c.json({ error: "daily_limit_exceeded", limit: DAILY_EXTRACT_LIMIT }, 429);
  }

  console.log(`[v${clientVersion}] Extract request from ${user.login} (maxCount=${maxCount}): ${message}`);

  try {
    const extras: RequestExtraType[] = Array.isArray(body.extras)
      ? body.extras.filter((e): e is RequestExtraType => e === 'build')
      : [];

    const characters = await extractCharacters(message, c.env.GEMINI_API_KEY, maxCount, extras);

    // Increment counter after successful extraction (TTL: 24h)
    const putPromise = c.env.CACHE.put(rateLimitKey, String(currentCount + 1), { expirationTtl: 86400 });
    try {
      c.executionCtx.waitUntil(putPromise);
    } catch {
      await putPromise;
    }

    // Flat mirror for backward compatibility with older web clients.
    const first = characters[0];
    return c.json({
      characters,
      character: first?.character ?? "",
      type: first?.type ?? "none",
      matchedTerm: first?.matchedTerm,
    });
  } catch (e: any) {
    console.error("Gemini error:", e.message);
    return c.json({ error: "llm_error", message: e.message }, 502);
  }
});

// GET /api/chat/mod-status — verifies @filadbd is a moderator in the room owner's channel.
// Used by the SourcesPanel to surface a ✓ verified / ⚠️ not modded indicator when the
// "confirm in chat" toggle is on. Implicit channel = JWT login (the room owner).
api.get("/chat/mod-status", async (c) => {
  const user = c.get("jwtPayload");
  const broadcasterLogin = user.login.toLowerCase();

  const result = await checkBotIsMod(c.env, broadcasterLogin);
  if (!result.ok) {
    console.warn(`[mod-status] ${broadcasterLogin} → ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
  }
  return c.json(result);
});

// GET /api/rooms/:roomId/requests — authenticated, owner-only, returns all requests from D1
api.get("/rooms/:roomId/requests", async (c) => {
  const roomId = c.req.param("roomId").toLowerCase();
  const user = c.get("jwtPayload");
  const isOwner = user.login.toLowerCase() === roomId;
  const isDev = c.env.FRONTEND_URL === "http://localhost:5173";

  if (!isOwner && !isDev) {
    return c.json({ error: "forbidden" }, 403);
  }

  const { results } = await c.env.DB.prepare(
    "SELECT * FROM requests WHERE room_id = ? AND deleted_at IS NULL ORDER BY position ASC"
  ).bind(roomId).all();

  const requests = (results ?? []).map((r: Record<string, unknown>) => ({
    id: r.id,
    timestamp: r.timestamp,
    donor: r.donor,
    amount: r.amount ?? "",
    amountVal: r.amount_val ?? 0,
    message: r.message ?? "",
    character: r.character ?? "",
    type: r.type ?? "unknown",
    done: !!(r.done),
    doneAt: r.done_at ?? undefined,
    source: r.source,
    subTier: r.sub_tier ?? undefined,
    isBroadcaster: r.source === 'manual' || (r.source === 'chat' && typeof r.donor === 'string' && r.donor.toLowerCase() === roomId.toLowerCase()),
    needsIdentification: !!(r.needs_identification),
    matchedTerm: r.matched_term ?? undefined,
    originMsgId: r.origin_msg_id ?? undefined,
    extras: r.extras ? JSON.parse(r.extras as string) : undefined,
  }));

  return c.json({ requests });
});

// POST /api/push/subscribe — register this browser's Web Push subscription for
// "your channel is live" notifications. The room is always the JWT login (only
// the streamer gets notified about their own channel), so re-subscribing is a
// plain upsert. Also ensures the Twitch EventSub stream.online webhook exists.
api.post("/push/subscribe", async (c) => {
  if (!isWebPushConfigured(c.env)) {
    return c.json({ error: "push_not_configured" }, 503);
  }

  const user = c.get("jwtPayload");
  const roomId = user.login.toLowerCase();
  const body = await c.req
    .json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string }; locale?: string }>()
    .catch(() => null);
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  // The service worker renders the push but can't read the app's language
  // toggle, so the client tells us which language it is reading in and we hand
  // it back with the notification.
  const locale = normalizeLocale(body?.locale);

  if (
    typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 1024 ||
    typeof p256dh !== "string" || !p256dh || p256dh.length > 256 ||
    typeof auth !== "string" || !auth || auth.length > 256
  ) {
    return c.json({ error: "invalid_subscription" }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (room_id, endpoint, p256dh, auth, locale)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (room_id, endpoint) DO UPDATE SET
       p256dh = excluded.p256dh,
       auth = excluded.auth,
       locale = excluded.locale,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
  ).bind(roomId, endpoint, p256dh, auth, locale).run();

  // Same Worker serves the webhook, so derive the callback from this request.
  // Twitch requires a public HTTPS callback: in local dev the create call fails
  // and we still report ok — the push subscription itself is stored.
  const callbackUrl = `${new URL(c.req.url).origin}/twitch/eventsub`;
  const result = await ensureStreamOnlineSubscription(c.env, roomId, callbackUrl);
  if (!result.ok) {
    console.warn(`[push] eventsub subscription for ${roomId} not created: ${result.reason}`);
  }

  return c.json({ ok: true, eventsub: result.ok });
});

// POST /api/push/unsubscribe — drop this browser's subscription (e.g. sign-out).
api.post("/push/unsubscribe", async (c) => {
  const user = c.get("jwtPayload");
  const body = await c.req.json<{ endpoint?: string }>().catch(() => null);
  if (typeof body?.endpoint !== "string") return c.json({ error: "invalid_subscription" }, 400);

  await c.env.DB.prepare(
    "DELETE FROM push_subscriptions WHERE room_id = ? AND endpoint = ?"
  ).bind(user.login.toLowerCase(), body.endpoint).run();

  return c.json({ ok: true });
});

app.route("/api", api);

// ============ WEB PUSH / TWITCH EVENTSUB ============

// Public: the VAPID application server key the browser subscribes with. An
// empty key tells the client the feature isn't configured in this deployment.
app.get("/push/vapid-public-key", (c) => {
  return c.json({ key: c.env.VAPID_PUBLIC_KEY ?? "" });
});

// Twitch EventSub webhook (stream.online). Verifies the HMAC signature, answers
// the verification challenge, and fans a Web Push out to the streamer's
// registered browsers when their stream starts.
app.post("/twitch/eventsub", async (c) => {
  const secret = c.env.EVENTSUB_SECRET;
  if (!secret) return c.json({ error: "eventsub_not_configured" }, 503);

  const messageId = c.req.header("Twitch-Eventsub-Message-Id") ?? "";
  const timestamp = c.req.header("Twitch-Eventsub-Message-Timestamp") ?? "";
  const signature = c.req.header("Twitch-Eventsub-Message-Signature") ?? "";
  const messageType = c.req.header("Twitch-Eventsub-Message-Type") ?? "";
  const rawBody = await c.req.text();

  if (!(await verifyEventSubSignature(secret, messageId, timestamp, rawBody, signature))) {
    return c.json({ error: "invalid_signature" }, 403);
  }

  let body: {
    challenge?: string;
    subscription?: { id: string; type: string; condition?: Record<string, string> };
    event?: { broadcaster_user_id?: string; broadcaster_user_login?: string };
  };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_body" }, 400);
  }

  if (messageType === "webhook_callback_verification") {
    return c.text(body.challenge ?? "", 200, { "Content-Type": "text/plain" });
  }

  if (messageType === "revocation") {
    const login = body.event?.broadcaster_user_login ?? body.subscription?.condition?.broadcaster_user_login;
    console.warn(`[eventsub] subscription revoked (${body.subscription?.type}, login=${login ?? "?"})`);
    if (login) await clearEventSubMarker(c.env, login);
    return c.body(null, 204);
  }

  if (messageType !== "notification" || body.subscription?.type !== "stream.online") {
    return c.body(null, 204);
  }

  const login = body.event?.broadcaster_user_login?.toLowerCase();
  const subscriptionId = body.subscription.id;
  if (!login) return c.body(null, 204);

  // Twitch retries on timeouts — dedupe by message id.
  const dedupeKey = `eventsub_msg:${messageId}`;
  if (await c.env.CACHE.get(dedupeKey)) return c.body(null, 204);
  await c.env.CACHE.put(dedupeKey, "1", { expirationTtl: 600 });

  c.executionCtx.waitUntil(notifyChannelLive(c.env, login, subscriptionId));
  return c.body(null, 204);
});

// The strings live in apps/web/src/i18n/pushCopy.ts; the server only carries
// the language each subscription registered with. NULL (rows written before the
// column existed) falls back to English.
function normalizeLocale(locale: string | null | undefined): string {
  return locale?.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

async function notifyChannelLive(env: Bindings, login: string, eventSubId: string) {
  const { results } = await env.DB.prepare(
    "SELECT endpoint, p256dh, auth, locale FROM push_subscriptions WHERE room_id = ?"
  ).bind(login).all<PushSubscriptionKeys>();
  const subs = results ?? [];

  // Nobody to notify → the EventSub subscription is dead weight; remove it so
  // Twitch stops calling us. It comes back on the next /api/push/subscribe.
  if (subs.length === 0) {
    console.log(`[push] ${login} went live but has no push subscriptions; deleting eventsub sub`);
    await deleteEventSubSubscription(env, eventSubId, login);
    return;
  }

  // Skip the notification when the queue is already running — the streamer is
  // set up and a "open your queue" ping would just be noise. The pending count
  // goes in the title.
  const room = await env.DB.prepare(
    `SELECT closed_by_owner, owner_seen_at, irc_live_at,
            (SELECT COUNT(*) FROM requests WHERE room_id = rooms.id AND done = 0 AND deleted_at IS NULL AND type != 'none') AS pending
     FROM rooms WHERE id = ?`
  ).bind(login).first<{ closed_by_owner: number; owner_seen_at: number | null; irc_live_at: number | null; pending: number }>();
  const status = roomStatus(room);
  if (status !== "offline") {
    console.log(`[push] ${login} went live but queue is already ${status}, skipping`);
    return;
  }
  const pending = room?.pending ?? 0;

  const outcomes = await Promise.all(
    subs.map(async (sub) => {
      const result = await sendWebPush(env, sub, {
        type: "stream-online",
        channel: login,
        locale: normalizeLocale(sub.locale),
        pending,
      });
      if (!result.ok && result.gone) {
        await env.DB.prepare(
          "DELETE FROM push_subscriptions WHERE room_id = ? AND endpoint = ?"
        ).bind(login, sub.endpoint).run();
      }
      if (!result.ok && !result.gone) {
        console.warn(`[push] send to ${login} failed: ${result.status ?? ""} ${result.detail ?? ""}`);
      }
      return result;
    })
  );

  const sent = outcomes.filter((o) => o.ok).length;
  console.log(`[push] ${login} went live: notified ${sent}/${subs.length} subscription(s)`);
}

// ============ PUBLIC API ROUTES ============

interface RoomRow {
  id: string;
  channel_login: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  status: string;
  updated_at: string;
  closed_by_owner?: number;
  owner_seen_at?: number | null;
  irc_live_at?: number | null;
  request_count?: number;
  pending_count?: number;
}

app.get("/rooms/active", async (c) => {
  // v3: besides `rooms`, the response carries `recent` (recently-active-but-closed
  // rooms, so the landing page always has channels to feature) and `total_channels`
  // (all-time room count — a vanity stat, 60s-stale by design via the KV cache).
  // Additive — old clients keep reading `rooms` — but the cache key is versioned so
  // an older cached body can't be served without the new fields.
  const cached = await c.env.CACHE.get("rooms_active_v3", "json");
  if (cached) return c.json(cached);

  const totalRow = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM rooms").first<{ n: number }>();
  const totalChannels = totalRow?.n ?? 0;

  // 7-day window: rooms past it fall off the landing page entirely; rooms inside
  // it but with a closed queue and no pending requests feed the `recent` strip.
  // "Open" here is only a hint for the ordering; the status itself is derived below.
  const seenSince = Date.now() - PRESENCE_TTL_MS;
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.channel_login, r.display_name, r.avatar_url, r.banner_url,
            r.closed_by_owner, r.owner_seen_at, r.irc_live_at,
            COUNT(req.id) AS request_count,
            SUM(CASE WHEN req.done = 0 AND COALESCE(req.type, '') != 'none' THEN 1 ELSE 0 END) AS pending_count,
            r.updated_at
     FROM rooms r
     LEFT JOIN requests req ON req.room_id = r.id AND req.deleted_at IS NULL
     WHERE r.updated_at > datetime('now', '-7 days')
     GROUP BY r.id
     ORDER BY CASE WHEN r.closed_by_owner = 0 AND r.owner_seen_at > ? THEN 0 ELSE 1 END,
              SUM(CASE WHEN req.done = 0 AND COALESCE(req.type, '') != 'none' THEN 1 ELSE 0 END) DESC,
              r.updated_at DESC
     LIMIT 30`
  ).bind(seenSince).all<RoomRow>();

  if (results.length === 0) return c.json({ rooms: [], recent: [], total_channels: totalChannels });

  const token = await getAppToken(c.env);
  if (!token) return c.json({ rooms: results, recent: [], total_channels: totalChannels });

  const logins = results.map((r) => r.channel_login);

  // Fetch missing profiles from Twitch and cache in D1
  const missingLogins = results.filter((r) => !r.avatar_url).map((r) => r.channel_login);
  const profiles = await fetchProfiles(missingLogins, token, c.env.TWITCH_CLIENT_ID);
  const profileMap = new Map(profiles.map((p) => [p.login, p]));
  cacheProfiles(c.env.DB, profiles, c.executionCtx);

  // Fetch live streams
  const streams = await fetchStreams(logins, token, c.env.TWITCH_CLIENT_ID);
  const streamMap = new Map(streams.map((s) => [s.user_login, s]));

  const now = Date.now();

  const enriched = results.map((r) => {
    const login = r.channel_login.toLowerCase();
    const fresh = profileMap.get(login);
    const stream = streamMap.get(login);
    const isLive = !!stream;

    const status = roomStatus({ closed_by_owner: r.closed_by_owner ?? 0, owner_seen_at: r.owner_seen_at ?? null, irc_live_at: r.irc_live_at ?? null }, now);
    const pendingCount = r.pending_count ?? 0;

    const { closed_by_owner: _c, owner_seen_at: _s, irc_live_at: _i, ...rest } = r;
    return {
      ...rest,
      status,
      pending_count: pendingCount,
      display_name: r.display_name ?? fresh?.display_name ?? null,
      avatar_url: r.avatar_url ?? fresh?.avatar_url ?? null,
      banner_url: r.banner_url ?? fresh?.banner_url ?? null,
      is_live: isLive,
      thumbnail_url: stream?.thumbnail_url ?? null,
      viewer_count: stream?.viewer_count ?? null,
    };
  });

  // Only show rooms with an active queue or pending requests
  const active = enriched.filter((r) => r.status !== 'offline' || (r.pending_count ?? 0) > 0);

  // Sort: online/live first, then by viewer count, then by pending requests
  active.sort((a, b) => {
    const aOnline = a.status !== 'offline' ? 1 : 0;
    const bOnline = b.status !== 'offline' ? 1 : 0;
    if (aOnline !== bOnline) return bOnline - aOnline;
    if ((a.viewer_count ?? 0) !== (b.viewer_count ?? 0)) return (b.viewer_count ?? 0) - (a.viewer_count ?? 0);
    return (b.pending_count ?? 0) - (a.pending_count ?? 0);
  });

  const rooms = active.slice(0, 10);

  // Everything else in the window is "recently active": closed queue, nothing
  // pending, but used within the last 7 days. Newest activity first. Kept slim —
  // the strip only needs identity + a couple of stats.
  const activeIds = new Set(rooms.map((r) => r.id));
  const recent = enriched
    .filter((r) => !activeIds.has(r.id))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
    .slice(0, 12)
    .map((r) => ({
      id: r.id,
      channel_login: r.channel_login,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      banner_url: r.banner_url,
      request_count: r.request_count ?? 0,
      updated_at: r.updated_at,
      is_live: r.is_live,
      thumbnail_url: r.thumbnail_url,
      viewer_count: r.viewer_count,
    }));

  const response = { rooms, recent, total_channels: totalChannels };

  try {
    c.executionCtx.waitUntil(
      c.env.CACHE.put("rooms_active_v3", JSON.stringify(response), { expirationTtl: 60 })
    );
  } catch {
    await c.env.CACHE.put("rooms_active_v3", JSON.stringify(response), { expirationTtl: 60 });
  }

  return c.json(response);
});

// GET /rooms/search?q= — channel discovery for the landing page. Substring match
// against login and display name over every room that ever opened a queue (the
// `rooms` table only gains rows via the owner flow, so this can't be used to
// enumerate arbitrary Twitch channels). LIKE wildcards in the query are escaped.
app.get("/rooms/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  if (q.length < 2 || q.length > 30) return c.json({ rooms: [] });

  const escaped = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.channel_login, r.display_name, r.avatar_url, r.updated_at,
            (SELECT COUNT(*) FROM requests req WHERE req.room_id = r.id AND req.deleted_at IS NULL) AS request_count
     FROM rooms r
     WHERE r.channel_login LIKE ? ESCAPE '\\' OR LOWER(COALESCE(r.display_name, '')) LIKE ? ESCAPE '\\'
     ORDER BY CASE WHEN r.channel_login = ? THEN 0 ELSE 1 END, r.updated_at DESC
     LIMIT 8`
  ).bind(`%${escaped}%`, `%${escaped}%`, q).all<RoomRow>();

  return c.json({ rooms: results ?? [] });
});

app.get("/rooms/:roomId", async (c) => {
  const roomId = c.req.param("roomId").toLowerCase();
  const row = await c.env.DB.prepare(
    "SELECT id, channel_login, display_name, avatar_url, updated_at, closed_by_owner, owner_seen_at, irc_live_at FROM rooms WHERE id = ?"
  ).bind(roomId).first<RoomRow>();

  // `registered` tells the client whether this channel ever used the app (has a
  // D1 row) — without it an unknown Twitch login renders exactly like a real
  // channel with a closed queue. The profile enrichment below still runs either
  // way so the "not using Fila DBD yet" page can show the streamer's identity.
  const registered = !!row;
  const room = {
    id: roomId,
    channel_login: row?.channel_login ?? roomId,
    display_name: row?.display_name ?? null,
    avatar_url: row?.avatar_url ?? null,
    updated_at: row?.updated_at ?? null,
    status: roomStatus(row ? { closed_by_owner: row.closed_by_owner ?? 0, owner_seen_at: row.owner_seen_at ?? null, irc_live_at: row.irc_live_at ?? null } : null),
  };

  const token = await getAppToken(c.env);
  if (token && (!room.avatar_url || !room.display_name)) {
    const profiles = await fetchProfiles([roomId], token, c.env.TWITCH_CLIENT_ID);
    if (profiles[0]) {
      room.display_name = profiles[0].display_name;
      room.avatar_url = profiles[0].avatar_url;
      cacheProfiles(c.env.DB, profiles, c.executionCtx);
    }
  }

  // Live-on-Twitch status, so the channel page can say the streamer is live even
  // when the queue is closed. KV-cached per channel (60s) because this runs on
  // every channel page view — same freshness the featured grid already has.
  let isLive = false;
  let viewerCount: number | null = null;
  if (token) {
    const liveKey = `room_live_${roomId}`;
    const cachedLive = await c.env.CACHE.get<{ is_live: boolean; viewer_count: number | null }>(liveKey, "json");
    if (cachedLive) {
      isLive = cachedLive.is_live;
      viewerCount = cachedLive.viewer_count;
    } else {
      const streams = await fetchStreams([roomId], token, c.env.TWITCH_CLIENT_ID);
      isLive = !!streams[0];
      viewerCount = streams[0]?.viewer_count ?? null;
      c.executionCtx.waitUntil(
        c.env.CACHE.put(liveKey, JSON.stringify({ is_live: isLive, viewer_count: viewerCount }), { expirationTtl: 60 })
      );
    }
  }

  return c.json({ room: { ...room, registered, is_live: isLive, viewer_count: viewerCount } });
});

app.route("/rooms", roomsSync as unknown as Hono<{ Bindings: Bindings; Variables: Variables }>);

export default app;
