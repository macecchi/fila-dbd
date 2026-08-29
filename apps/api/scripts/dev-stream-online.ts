#!/usr/bin/env bun
// Fires a signed Twitch EventSub `stream.online` webhook at the local Worker, so
// the "your channel is live" push can be exercised end to end without Twitch.
// Run from `apps/api/`:
//
//   bun run dev:live <channel>          # e.g. bun run dev:live meriw_
//
// Twitch can't reach localhost, which is the only reason the real webhook never
// arrives in dev. Everything downstream of the request is the production path:
// the same HMAC verification, the same dedupe and PartyKit "is the queue
// already open" check, and a real Web Push to whatever endpoint the
// browser registered (that call goes out to FCM/Mozilla over the internet, so it
// reaches your browser even though the Worker is local).
//
// Prerequisites — see README "Testing the live notification locally":
//   1. VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / EVENTSUB_SECRET in apps/api/.env
//   2. the app served from a *production build* (the dev server registers no
//      service worker, so there is nothing to receive a push)
//   3. notifications granted on your own channel, so a subscription row exists
import { join } from 'node:path';

const login = process.argv[2]?.trim().toLowerCase();
const target = process.env.API_URL || 'http://localhost:8787';

if (!login) {
  console.error('Usage: bun run dev:live <channel>   # e.g. bun run dev:live meriw_');
  process.exit(1);
}

async function envValue(key: string): Promise<string | undefined> {
  if (process.env[key]) return process.env[key];
  const file = Bun.file(join(import.meta.dir, '..', '.env'));
  if (!(await file.exists())) return undefined;
  const line = (await file.text()).split('\n').find(l => l.trimStart().startsWith(`${key}=`));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || undefined;
}

const secret = await envValue('EVENTSUB_SECRET');
if (!secret) {
  console.error('No EVENTSUB_SECRET in the environment or apps/api/.env.');
  console.error('Set one (any random string) — wrangler dev reads it via dotenv:');
  console.error("  echo \"EVENTSUB_SECRET=$(openssl rand -hex 32)\" >> apps/api/.env");
  process.exit(1);
}

const messageId = crypto.randomUUID();
const timestamp = new Date().toISOString();
const body = JSON.stringify({
  subscription: {
    id: `dev-${messageId}`,
    type: 'stream.online',
    version: '1',
    condition: { broadcaster_user_id: `dev-${login}` },
    created_at: timestamp,
  },
  event: {
    id: `dev-event-${messageId}`,
    broadcaster_user_id: `dev-${login}`,
    broadcaster_user_login: login,
    broadcaster_user_name: login,
    type: 'live',
    started_at: timestamp,
  },
});

// Twitch signs messageId + timestamp + raw body with HMAC-SHA256.
const key = await crypto.subtle.importKey(
  'raw',
  new TextEncoder().encode(secret),
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign']
);
const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(messageId + timestamp + body));
const signature = `sha256=${[...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('')}`;

const res = await fetch(`${target}/twitch/eventsub`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Twitch-Eventsub-Message-Id': messageId,
    'Twitch-Eventsub-Message-Timestamp': timestamp,
    'Twitch-Eventsub-Message-Signature': signature,
    'Twitch-Eventsub-Message-Type': 'notification',
    'Twitch-Eventsub-Subscription-Type': 'stream.online',
  },
  body,
});

console.log(`POST ${target}/twitch/eventsub → ${res.status} ${res.statusText}`);
const text = await res.text();
if (text) console.log(text);
if (res.status === 204) {
  console.log(`\nAccepted. The push itself is sent in the background — watch the wrangler dev log for [push]/[eventsub] lines.`);
  console.log('Nothing arrives if: notifications are not granted, no subscription row exists');
  console.log(`for ${login}, or the queue is already open (pushes are skipped then).`);
}
