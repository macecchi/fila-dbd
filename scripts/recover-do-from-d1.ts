#!/usr/bin/env bun
/**
 * Triggers DO recovery from D1 for a PartyKit room.
 * Wipes DO storage and pulls pending requests from D1.
 *
 * Usage:
 *   bun scripts/recover-do-from-d1.ts <roomId> [--local]
 */

const args = process.argv.slice(2);
const local = args.includes('--local');
const roomId = args.find(a => !a.startsWith('--'));

if (!roomId) {
  console.error('Usage: bun scripts/recover-do-from-d1.ts <roomId> [--local]');
  process.exit(1);
}

const partyHost = local ? 'localhost:1999' : 'dbd-tracker-party.macecchi.partykit.dev';
const protocol = local ? 'http' : 'https';
const url = `${protocol}://${partyHost}/parties/main/${roomId}`;

let secret = process.env.INTERNAL_API_SECRET;
if (!secret) {
  console.error('INTERNAL_API_SECRET not found');
  process.exit(1);
}

console.log(`${local ? '[LOCAL]' : '[REMOTE]'} Recovering DO from D1 for room "${roomId}"`);
console.log(`  POST ${url}`);

const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer internal:${secret}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ action: 'recover-from-d1' }),
});

if (!res.ok) {
  console.error(`✗ Failed: ${res.status} ${res.statusText}`);
  const body = await res.text();
  if (body) console.error(body);
  process.exit(1);
}

const data = await res.json() as { ok: boolean; recovered: number };
console.log(`✓ Recovered ${data.recovered} pending requests into DO`);
