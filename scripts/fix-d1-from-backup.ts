#!/usr/bin/env bun
/**
 * Upserts requests from a backup JSON file into D1 production.
 *
 * Usage:
 *   bun scripts/fix-d1-from-backup.ts backup.json channel_name
 *
 * What it does:
 *   1. Reads the backup file (sync-full format: { requests: [...] })
 *   2. Upserts all requests into the D1 `requests` table via wrangler d1 execute
 *   3. Batches at 80 statements to stay under D1's 100-statement limit
 *
 * After running, trigger DO recovery:
 *   curl -X POST https://<PARTY_HOST>/parties/main/<roomId> \
 *     -H "Authorization: Bearer internal:<secret>" \
 *     -H "Content-Type: application/json" \
 *     -d '{"action":"recover-from-d1"}'
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const local = args.includes('--local');
const positional = args.filter(a => !a.startsWith('--'));
const [backupPath, roomId] = positional;
if (!backupPath || !roomId) {
  console.error('Usage: bun scripts/fix-d1-from-backup.ts <backup.json> <roomId> [--local]');
  process.exit(1);
}

interface BackupRequest {
  id: number;
  timestamp: string;
  donor: string;
  amount?: string;
  amountVal?: number;
  message?: string;
  character?: string;
  type?: string;
  done?: boolean;
  doneAt?: string;
  source: string;
  subTier?: number;
  needsIdentification?: boolean;
}

const raw = readFileSync(backupPath, 'utf-8');
const data = JSON.parse(raw) as { requests: BackupRequest[] };
const requests = data.requests;

console.log(`${local ? '[LOCAL]' : '[REMOTE]'} Loaded ${requests.length} requests for room "${roomId}"`);
console.log(`  done: ${requests.filter(r => r.done).length}, pending: ${requests.filter(r => !r.done).length}`);

// Build SQL statements
const statements: string[] = [];

// Ensure room exists
statements.push(
  `INSERT INTO rooms (id, channel_login) VALUES ('${roomId}', '${roomId}') ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now');`
);

// Mark ALL existing requests as done before upserting — backup is the source of truth
statements.push(
  `UPDATE requests SET done = 1, done_at = datetime('now') WHERE room_id = '${roomId}' AND done = 0;`
);

// Upsert each request
for (let i = 0; i < requests.length; i++) {
  const r = requests[i];
  const esc = (s: string | undefined) => (s ?? '').replace(/'/g, "''");
  const done = r.done ? 1 : 0;
  const doneAt = r.doneAt ? `'${esc(r.doneAt)}'` : 'NULL';
  const subTier = r.subTier != null ? r.subTier : 'NULL';
  const needsId = r.needsIdentification ? 1 : 0;

  statements.push(
    `INSERT INTO requests (id, room_id, position, timestamp, donor, amount, amount_val, message, character, type, done, done_at, source, sub_tier, needs_identification)
     VALUES (${r.id}, '${roomId}', ${i}, '${esc(r.timestamp)}', '${esc(r.donor)}', '${esc(r.amount)}', ${r.amountVal ?? 0}, '${esc(r.message)}', '${esc(r.character)}', '${esc(r.type ?? 'unknown')}', ${done}, ${doneAt}, '${esc(r.source)}', ${subTier}, ${needsId})
     ON CONFLICT (room_id, id) DO UPDATE SET
       position = excluded.position,
       character = excluded.character,
       type = excluded.type,
       done = excluded.done,
       done_at = excluded.done_at,
       needs_identification = excluded.needs_identification;`
  );
}

console.log(`\nGenerated ${statements.length} SQL statements`);

// Execute in batches of 80
const BATCH = 80;
const batches = Math.ceil(statements.length / BATCH);
console.log(`Executing in ${batches} batch(es)...\n`);

for (let b = 0; b < batches; b++) {
  const chunk = statements.slice(b * BATCH, (b + 1) * BATCH);
  const sql = chunk.join('\n');

  const tmpFile = `/tmp/fix-d1-batch-${b}.sql`;
  Bun.write(tmpFile, sql);

  console.log(`Batch ${b + 1}/${batches} (${chunk.length} statements)...`);
  try {
    execSync(
      `cd apps/api && bunx wrangler d1 execute fila-dbd ${local ? '--local' : '--remote --env production'} --yes --file=${tmpFile}`,
      { stdio: 'inherit', cwd: process.cwd() }
    );
    console.log(`  ✓ batch ${b + 1} done`);
  } catch (e) {
    console.error(`  ✗ batch ${b + 1} failed`);
    process.exit(1);
  }
}

console.log(`\n✓ All ${requests.length} requests upserted into D1 for room "${roomId}"`);
console.log(`\nNext: trigger DO recovery via POST to PartyKit`);
