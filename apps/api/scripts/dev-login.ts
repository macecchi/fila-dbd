#!/usr/bin/env bun
// Mints a local JWT so you can exercise channel-owner paths without a Twitch login.
// Run from `apps/api/`:
//
//   bun run dev:login <channel>          # e.g. bun run dev:login meriw_
//
// Why this exists: every owner-only path (opening the queue, ✓ / undo, editing
// sources) is gated on a JWT the party server verifies with JWT_SECRET, so anyone
// without a Twitch OAuth round trip — an agent, a fresh clone, a CI box — simply
// cannot reach that half of the app. This signs the same payload `/auth/token`
// signs once Twitch has confirmed identity; it only skips the trip to Twitch.
//
// Pass the channel you're testing as the login. The party server's owner check is
// `user.login === room.id` (party.ts), so a matching login makes you the room owner
// for real and the DEV_MODE bypass is never taken — what runs is the production
// path. A mismatched login still works in dev, but only via that bypass, which
// means you'd be testing a branch that does not exist in production.
//
// The token is signed with the JWT_SECRET in apps/api/.env — your local dev secret.
// It is worthless against production, which signs with a different one. Nothing here
// can mint a token for the deployed app, and that is deliberate.
import { sign } from 'hono/jwt';
import { join } from 'node:path';

const TTL_HOURS = 24;

const login = process.argv[2]?.trim().toLowerCase() || process.env.DEV_LOGIN?.trim().toLowerCase();

if (!login) {
  console.error('Usage: bun run dev:login <channel>\n');
  console.error('Pass the channel you are testing, so the token owns that room:');
  console.error('  bun run dev:login meriw_\n');
  console.error('Or set DEV_LOGIN in apps/api/.env to skip the argument.');
  process.exit(1);
}

// Bun auto-loads .env from the cwd, which covers the documented `apps/api/` case.
// Read it explicitly as well so the script still works when run from the repo root.
async function jwtSecret(): Promise<string | undefined> {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const envPath = join(import.meta.dir, '..', '.env');
  const file = Bun.file(envPath);
  if (!(await file.exists())) return undefined;
  const line = (await file.text())
    .split('\n')
    .find(l => l.trimStart().startsWith('JWT_SECRET='));
  return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || undefined;
}

const secret = await jwtSecret();

if (!secret) {
  console.error('No JWT_SECRET found in the environment or apps/api/.env.');
  console.error('Copy .env.example to .env and set JWT_SECRET to any random string —');
  console.error('it just has to match what `wrangler dev` and `partykit dev` read.');
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const exp = now + TTL_HOURS * 60 * 60;

const payload = {
  sub: `dev-${login}`,
  login,
  display_name: login,
  profile_image_url: '',
};

const accessToken = await sign({ ...payload, exp }, secret, 'HS256');
// Same value: `refresh()` only round-trips to /auth/refresh once the access token
// expires, and this one outlives any test session.
const refreshToken = accessToken;

// The shape zustand's `persist` middleware expects for the `dbd-auth` key
// (store/auth.ts `partialize`) — version 0 is persist's default.
const authState = JSON.stringify({
  state: {
    accessToken,
    refreshToken,
    user: { id: payload.sub, login, display_name: login, profile_image_url: '' },
    isAuthenticated: true,
  },
  version: 0,
});

const snippet = `localStorage.setItem('dbd-auth', ${JSON.stringify(authState)}); location.reload()`;

console.log(`\n✅ Signed a ${TTL_HOURS}h token for @${login} (owner of /${login})\n`);
console.log('Paste this into the DevTools console on http://localhost:5173 and you are signed in:\n');
console.log(snippet);
console.log('\nThen open http://localhost:5173/' + login + ' — the owner UI is live and');
console.log('mutations will be accepted by the party server.\n');
console.log('Raw token, if you need it for a curl against the Worker:\n');
console.log(accessToken + '\n');
console.log('To sign out again: localStorage.removeItem(\'dbd-auth\'); location.reload()');
