import { Hono } from "hono";
import { cors } from "hono/cors";
import { sign } from "hono/jwt";
import { Twitch } from "arctic";
import { verifyJwt, type JwtPayload } from "./jwt";
import { extractCharacters } from "./gemini";
import type { RequestExtraType } from "@filadbd/shared";
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
  INTERNAL_API_SECRET: string;
  PARTY_HOST: string;
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

// Twitch caps chat messages at 500 characters, but JS `length` counts UTF-16
// code units (emoji count 2+ each), so a legitimate emoji-heavy message can
// exceed 500. Cap at 1000 units — enough for any real Twitch message — and
// truncate instead of rejecting so long donates still get an extraction.
const MAX_MESSAGE_LENGTH = 1000;
const DAILY_EXTRACT_LIMIT = 200;
const MAX_DONATION_REQUESTS = 10;

api.post("/extract-character", async (c) => {
  const user = c.get("jwtPayload");
  const clientVersion = c.req.header("X-Client-Version") || "unknown";
  const body = await c.req.json<{ message: string; maxCount?: number; extras?: RequestExtraType[] }>();

  if (!body.message || typeof body.message !== "string") {
    return c.json({ error: "invalid_input" }, 400);
  }

  let message = body.message;
  if (message.length > MAX_MESSAGE_LENGTH) {
    console.warn(`[extract] Truncating message from ${message.length} to ${MAX_MESSAGE_LENGTH} chars`);
    message = message.slice(0, MAX_MESSAGE_LENGTH);
    // Don't leave half a surrogate pair (e.g. a split emoji) at the cut point.
    const last = message.charCodeAt(message.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) message = message.slice(0, -1);
  }

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
  // set up and a "open your queue" ping would just be noise. The same call
  // gives us how many requests are already waiting, which goes in the title.
  // Best-effort: if PartyKit can't answer, notify anyway (without the count).
  let pending = 0;
  if (env.PARTY_HOST) {
    try {
      const protocol = env.PARTY_HOST.startsWith("localhost") ? "http" : "https";
      const res = await fetch(`${protocol}://${env.PARTY_HOST}/parties/main/${login}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json<{ status: string; connections: number; pending_count?: number }>();
        if (data.status !== "offline" && data.connections > 0) {
          console.log(`[push] ${login} went live but queue is already ${data.status}, skipping`);
          return;
        }
        pending = data.pending_count ?? 0;
      }
    } catch {
      // PartyKit unreachable — proceed with the notification.
    }
  }

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

// PUT /internal/rooms/:roomId/requests — upsert requests (full or partial mode)
internal.put("/rooms/:roomId/requests", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json<{ requests: Array<Record<string, unknown>>; mode?: string }>();

  if (!Array.isArray(body.requests)) {
    return c.json({ error: "invalid_input" }, 400);
  }

  const isPartial = body.mode === 'partial';
  const statements: D1PreparedStatement[] = [];

  // Ensure room exists
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO rooms (id, channel_login) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')"
    ).bind(roomId, roomId)
  );

  // Full mode: mark requests not in incoming list as done
  if (!isPartial) {
    const incomingIds = body.requests.map((r: Record<string, unknown>) => r.id);
    if (incomingIds.length === 0) {
      // No incoming → mark all pending as done
      statements.push(
        c.env.DB.prepare(
          "UPDATE requests SET done = 1, done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE room_id = ? AND done = 0"
        ).bind(roomId)
      );
    } else if (incomingIds.length <= 99) {
      // Fits in one NOT IN clause (99 IDs + 1 roomId = 100 bound params)
      statements.push(
        c.env.DB.prepare(
          `UPDATE requests SET done = 1, done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE room_id = ? AND done = 0 AND id NOT IN (${incomingIds.map(() => '?').join(',')})`
        ).bind(roomId, ...incomingIds)
      );
    } else {
      // >99 IDs: mark ALL pending as done, then un-done the incoming ones in chunks
      statements.push(
        c.env.DB.prepare(
          "UPDATE requests SET done = 1, done_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE room_id = ? AND done = 0"
        ).bind(roomId)
      );
      const CHUNK = 99;
      for (let i = 0; i < incomingIds.length; i += CHUNK) {
        const chunk = incomingIds.slice(i, i + CHUNK);
        statements.push(
          c.env.DB.prepare(
            `UPDATE requests SET done = 0, done_at = NULL WHERE room_id = ? AND id IN (${chunk.map(() => '?').join(',')})`
          ).bind(roomId, ...chunk)
        );
      }
    }
  }

  // Upsert requests (use _position if provided, else array index)
  for (let i = 0; i < body.requests.length; i++) {
    const r = body.requests[i];
    const position = typeof r._position === 'number' ? r._position : i;
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO requests (id, room_id, position, timestamp, donor, amount, amount_val, message, character, type, done, done_at, source, sub_tier, needs_identification, matched_term, origin_msg_id, extras)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id, id) DO UPDATE SET
           position = excluded.position,
           character = excluded.character,
           type = excluded.type,
           done = excluded.done,
           done_at = excluded.done_at,
           needs_identification = excluded.needs_identification,
           matched_term = excluded.matched_term,
           origin_msg_id = excluded.origin_msg_id,
           extras = excluded.extras`
      ).bind(
        r.id,
        roomId,
        position,
        r.timestamp,
        r.donor,
        r.amount ?? "",
        r.amountVal ?? 0,
        r.message ?? "",
        r.character ?? "",
        r.type ?? "unknown",
        r.done ? 1 : 0,
        r.doneAt ?? null,
        r.source,
        r.subTier ?? null,
        r.needsIdentification ? 1 : 0,
        r.matchedTerm ?? null,
        r.originMsgId ?? null,
        r.extras ? JSON.stringify(r.extras) : null
      )
    );
  }

  await batchInChunks(c.env.DB, statements);
  return c.json({ ok: true, count: body.requests.length, mode: isPartial ? 'partial' : 'full' });
});

// PUT /internal/rooms/:roomId/sources — upsert room sources settings
internal.put("/rooms/:roomId/sources", async (c) => {
  const roomId = c.req.param("roomId");
  const body = await c.req.json<Record<string, unknown>>();

  await c.env.DB.prepare(
    `INSERT INTO rooms (id, channel_login, sources_config, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       sources_config = excluded.sources_config,
       updated_at = datetime('now')`
  ).bind(
    roomId,
    roomId,
    JSON.stringify(body)
  ).run();

  return c.json({ ok: true });
});

// GET /internal/rooms/:roomId/sources — return room sources settings for D1 recovery
internal.get("/rooms/:roomId/sources", async (c) => {
  const roomId = c.req.param("roomId").toLowerCase();
  const row = await c.env.DB.prepare(
    "SELECT sources_config FROM rooms WHERE id = ?"
  ).bind(roomId).first<{ sources_config: string | null }>();

  if (!row || !row.sources_config) {
    return c.json({ sources: null });
  }

  return c.json({ sources: JSON.parse(row.sources_config) });
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

// POST /internal/chat/send — send a chat message from the @filadbd bot account.
// Sender identity comes from the bot user token stored in KV (see scripts/authorize-bot.ts).
internal.post("/chat/send", async (c) => {
  const body = await c.req.json<{ broadcaster_login?: string; message?: string }>();
  const broadcasterLogin = body.broadcaster_login?.trim().toLowerCase();
  const message = body.message?.trim();

  if (!broadcasterLogin || !message) {
    return c.json({ ok: false, reason: 'bad_request' }, 400);
  }

  // Twitch hard-caps chat messages at 500 chars.
  if (message.length > 500) {
    return c.json({ ok: false, reason: 'message_too_long' }, 400);
  }

  const result = await sendChatMessage(c.env, broadcasterLogin, message);
  if (!result.ok) {
    console.warn(`[chat-send] ${broadcasterLogin} failed: ${result.reason}${result.detail ? ` (${result.detail})` : ''}`);
  }
  return c.json(result, result.ok ? 200 : 502);
});

// GET /internal/rooms/:roomId/requests — return pending requests for D1 recovery.
//
// Pending only, deliberately: a request the streamer DELETED is not recorded as
// deleted anywhere (`deleted_at` is never written — see the full-sync sweep below,
// which marks anything missing from the DO as `done`, a conflation the tests pin
// down). So "newest done rows" in D1 also means "most recently deleted", and
// recovering them here would resurrect a deleted request into the header's
// "recently played" strip, undo button and all. The strip is fed from DO retention
// instead (`RECENT_DONE_KEPT` in party.ts); after a storage loss it simply starts
// empty again.
internal.get("/rooms/:roomId/requests", async (c) => {
  const roomId = c.req.param("roomId");
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM requests WHERE room_id = ? AND done = 0 AND deleted_at IS NULL ORDER BY position ASC"
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
    done: false,
    doneAt: undefined,
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

app.route("/internal", internal);

// ============ PUBLIC API ROUTES ============

interface RoomRow {
  id: string;
  channel_login: string;
  display_name: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  status: string;
  updated_at: string;
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
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.channel_login, r.display_name, r.avatar_url, r.banner_url, r.status,
            COUNT(req.id) AS request_count,
            SUM(CASE WHEN req.done = 0 AND COALESCE(req.type, '') != 'none' THEN 1 ELSE 0 END) AS pending_count,
            r.updated_at
     FROM rooms r
     LEFT JOIN requests req ON req.room_id = r.id AND req.deleted_at IS NULL
     WHERE r.updated_at > datetime('now', '-7 days')
     GROUP BY r.id
     ORDER BY CASE WHEN r.status != 'offline' THEN 0 ELSE 1 END,
              SUM(CASE WHEN req.done = 0 AND COALESCE(req.type, '') != 'none' THEN 1 ELSE 0 END) DESC,
              r.updated_at DESC
     LIMIT 30`
  ).all<RoomRow>();

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
    "SELECT id, channel_login, display_name, avatar_url, status, updated_at FROM rooms WHERE id = ?"
  ).bind(roomId).first<RoomRow>();

  // `registered` tells the client whether this channel ever used the app (has a
  // D1 row) — without it an unknown Twitch login renders exactly like a real
  // channel with a closed queue. The profile enrichment below still runs either
  // way so the "not using Fila DBD yet" page can show the streamer's identity.
  const registered = !!row;
  const room = row ?? { id: roomId, channel_login: roomId, display_name: null as string | null, avatar_url: null as string | null, banner_url: null, status: "offline", updated_at: null };

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

export default app;
