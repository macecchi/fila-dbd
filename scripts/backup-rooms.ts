#!/usr/bin/env bun
/**
 * Backs up the rooms table from D1.
 *
 * Usage:
 *   bun scripts/backup-rooms.ts [--local] [output_path.json]
 *
 * Examples:
 *   bun scripts/backup-rooms.ts                               # Backs up production D1 to .data/rooms_backup_<timestamp>.json
 *   bun scripts/backup-rooms.ts --local                       # Backs up local D1 to .data/rooms_backup_<timestamp>.json
 *   bun scripts/backup-rooms.ts my_backup.json                # Backs up production D1 to my_backup.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const local = args.includes('--local');
const customPath = args.find(a => !a.startsWith('--'));

console.log(`${local ? '[LOCAL]' : '[PRODUCTION REMOTE]'} Starting rooms table backup...`);

// Build output filename
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const defaultFilename = `rooms_backup_${timestamp}.json`;
const defaultDir = join(process.cwd(), '.data');
const outputPath = customPath ? join(process.cwd(), customPath) : join(defaultDir, defaultFilename);

// Construct command
const wranglerCmd = `bunx wrangler d1 execute fila-dbd ${local ? '' : '--remote --env production'} --json --command="SELECT * FROM rooms;"`;

try {
  console.log(`Executing wrangler query to fetch rooms...`);
  const output = execSync(wranglerCmd, {
    cwd: join(process.cwd(), 'apps/api'),
    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
    encoding: 'utf-8',
  });

  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed[0].success) {
    console.error('✗ Query failed or returned invalid format:', parsed);
    process.exit(1);
  }

  const rooms = parsed[0].results || [];
  console.log(`✓ Successfully retrieved ${rooms.length} room(s) from D1`);

  // Ensure target directory exists
  const targetDir = dirname(outputPath);
  mkdirSync(targetDir, { recursive: true });

  // Format backup file contents
  const backupData = {
    timestamp: new Date().toISOString(),
    database: 'fila-dbd',
    environment: local ? 'local' : 'production',
    count: rooms.length,
    rooms: rooms,
  };

  writeFileSync(outputPath, JSON.stringify(backupData, null, 2), 'utf-8');
  console.log(`✓ Backup successfully written to: ${outputPath}`);

  if (rooms.length > 0) {
    console.log('\nChannels backed up:');
    rooms.forEach((r: any) => {
      console.log(`  - ${r.id} (Twitch: ${r.channel_login})`);
    });
  }
} catch (e: any) {
  console.error('✗ Failed to perform backup:', e.message || e);
  process.exit(1);
}
