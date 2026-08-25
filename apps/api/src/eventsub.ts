// Twitch EventSub (webhook transport) helpers: notification signature
// verification and stream.online subscription management on the app token.
import { getAppToken, getBroadcasterId } from "./twitch";

export interface EventSubEnv {
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  EVENTSUB_SECRET?: string;
  CACHE: KVNamespace;
}

// KV marker per room so we don't hit the EventSub API on every push subscribe.
// Value is the Twitch subscription id; cleared on revocation so the next
// subscribe re-creates it. 30-day TTL forces a periodic re-verify.
const EVENTSUB_MARKER_PREFIX = "eventsub_online:";
const EVENTSUB_MARKER_TTL = 60 * 60 * 24 * 30;

const HELIX_EVENTSUB_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

// Signatures older than this are replays per Twitch's docs.
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// HMAC-SHA256 over messageId + timestamp + rawBody, compared via crypto.subtle.verify
// (constant-time) against the `sha256=<hex>` header Twitch sends.
export async function verifyEventSubSignature(
  secret: string,
  messageId: string,
  timestamp: string,
  rawBody: string,
  signatureHeader: string
): Promise<boolean> {
  if (!signatureHeader.startsWith("sha256=")) return false;
  const signature = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!signature || signature.length !== 32) return false;

  const messageAge = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(messageAge) || messageAge > MAX_MESSAGE_AGE_MS) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature as BufferSource,
    encoder.encode(`${messageId}${timestamp}${rawBody}`)
  );
}

// Ensures a stream.online webhook subscription exists for the given channel.
// Idempotent: a KV marker short-circuits, and Twitch's 409 on an existing
// duplicate subscription is treated as success.
export async function ensureStreamOnlineSubscription(
  env: EventSubEnv,
  broadcasterLogin: string,
  callbackUrl: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!env.EVENTSUB_SECRET) return { ok: false, reason: "eventsub_not_configured" };

  const login = broadcasterLogin.toLowerCase();
  const markerKey = `${EVENTSUB_MARKER_PREFIX}${login}`;
  if (await env.CACHE.get(markerKey)) return { ok: true };

  const broadcasterId = await getBroadcasterId(env, login);
  if (!broadcasterId) return { ok: false, reason: "no_broadcaster" };

  const token = await getAppToken(env);
  if (!token) return { ok: false, reason: "no_app_token" };

  const res = await fetch(HELIX_EVENTSUB_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": env.TWITCH_CLIENT_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "stream.online",
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: "webhook", callback: callbackUrl, secret: env.EVENTSUB_SECRET },
    }),
  });

  let subscriptionId = "unknown";
  if (res.ok) {
    const data = (await res.json().catch(() => null)) as { data?: Array<{ id: string }> } | null;
    subscriptionId = data?.data?.[0]?.id ?? "unknown";
  } else if (res.status !== 409) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    console.warn(`[eventsub] subscribe ${login} failed: ${res.status} ${detail}`);
    return { ok: false, reason: `twitch_${res.status}` };
  }

  await env.CACHE.put(markerKey, subscriptionId, { expirationTtl: EVENTSUB_MARKER_TTL });
  return { ok: true };
}

// Deletes a stream.online subscription (used when the last push subscription
// for a room is gone — no point keeping Twitch calling us).
export async function deleteEventSubSubscription(env: EventSubEnv, subscriptionId: string, broadcasterLogin: string) {
  await clearEventSubMarker(env, broadcasterLogin);
  const token = await getAppToken(env);
  if (!token) return;
  await fetch(`${HELIX_EVENTSUB_URL}?id=${encodeURIComponent(subscriptionId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Client-Id": env.TWITCH_CLIENT_ID },
  }).catch(() => {});
}

export async function clearEventSubMarker(env: EventSubEnv, broadcasterLogin: string) {
  await env.CACHE.delete(`${EVENTSUB_MARKER_PREFIX}${broadcasterLogin.toLowerCase()}`);
}
