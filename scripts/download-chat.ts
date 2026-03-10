#!/usr/bin/env bun

import { writeFileSync } from 'fs';
import { parseArgs } from 'util';

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// ── GQL helpers ──

async function fetchGQL(query: object) {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!res.ok) throw new Error(`GQL request failed: ${res.status}`);
  return res.json();
}

interface VODInfo {
  id: string;
  title: string;
  createdAt: string;
  lengthSeconds: number;
}

async function fetchRecentVods(channel: string, count: number): Promise<VODInfo[]> {
  const data = await fetchGQL({
    query: `query($login:String!,$first:Int!){user(login:$login){videos(first:$first,type:ARCHIVE,sort:TIME){edges{node{id title createdAt lengthSeconds}}}}}`,
    variables: { login: channel, first: count },
  });
  const edges = data?.data?.user?.videos?.edges;
  if (!edges?.length) return [];
  return edges.map((e: { node: VODInfo }) => e.node);
}

interface ChatComment {
  id: string;
  offsetSeconds: number;
  username: string;
  displayName: string;
  message: string;
}

async function fetchVODChat(vodId: string, offset = 0) {
  const data = await fetchGQL({
    query: `query($videoID:ID!,$contentOffsetSeconds:Int){video(id:$videoID){comments(contentOffsetSeconds:$contentOffsetSeconds,first:100){edges{node{id contentOffsetSeconds commenter{login displayName}message{fragments{text}}}}}}}`,
    variables: { videoID: vodId, contentOffsetSeconds: offset },
  });
  return data?.data?.video?.comments?.edges || [];
}

async function downloadVODChat(vodId: string, vodStart: Date): Promise<ChatComment[]> {
  const messages: ChatComment[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (true) {
    const edges = await fetchVODChat(vodId, offset);
    if (!edges.length) break;

    let newCount = 0;
    let lastOffset = offset;
    for (const { node } of edges) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      newCount++;

      const offsetSec = node.contentOffsetSeconds || 0;
      lastOffset = offsetSec;

      messages.push({
        id: node.id,
        offsetSeconds: offsetSec,
        username: node.commenter?.login || '',
        displayName: node.commenter?.displayName || '',
        message: node.message?.fragments?.map((f: { text: string }) => f.text).join('') || '',
      });
    }

    process.stderr.write(`\r  VOD ${vodId}: ${messages.length} messages fetched...`);

    if (!newCount) break;
    offset = lastOffset + 1;
  }

  process.stderr.write(`\r  VOD ${vodId}: ${messages.length} messages total    \n`);
  return messages;
}

// ── CSV helpers ──

function escapeCSV(val: string): string {
  if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
    return `"${val.replace(/"/g, '""')}"`;
  }
  return val;
}

function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── CLI ──

function printUsage() {
  console.log(`Usage: bun scripts/download-chat.ts <channel|vodId> [options]

Arguments:
  channel    Twitch channel name (fetches recent VODs)
  vodId      Numeric VOD ID (fetches that specific VOD)

Options:
  --last N        Last N VODs (default: 1)
  --since DATE    All VODs since date (YYYY-MM-DD)
  --out FILE      Output file (default: chat-<channel|vod>.csv)

Examples:
  bun scripts/download-chat.ts mandymess
  bun scripts/download-chat.ts mandymess --last 3
  bun scripts/download-chat.ts mandymess --since 2025-03-01
  bun scripts/download-chat.ts 2345678901`);
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    last: { type: 'string' },
    since: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  printUsage();
  process.exit(0);
}

const input = positionals[0];
const isVodId = /^\d+$/.test(input);

let vods: VODInfo[];

if (isVodId) {
  // Specific VOD — we don't have metadata, fabricate minimal info
  console.log(`Fetching VOD ${input}...`);
  vods = [{ id: input, title: '', createdAt: '', lengthSeconds: 0 }];
} else {
  const channel = input.toLowerCase();

  if (values.since) {
    const sinceDate = new Date(values.since);
    if (isNaN(sinceDate.getTime())) {
      console.error(`Invalid date: ${values.since}`);
      process.exit(1);
    }
    // Fetch up to 100 VODs and filter by date
    console.log(`Fetching VODs for ${channel} since ${values.since}...`);
    const all = await fetchRecentVods(channel, 100);
    vods = all.filter((v) => new Date(v.createdAt) >= sinceDate);
    if (!vods.length) {
      console.error(`No VODs found since ${values.since}`);
      process.exit(1);
    }
  } else {
    const count = parseInt(values.last || '1', 10);
    console.log(`Fetching last ${count} VOD(s) for ${channel}...`);
    vods = await fetchRecentVods(channel, count);
    if (!vods.length) {
      console.error(`No VODs found for ${channel}`);
      process.exit(1);
    }
  }

  // Show VODs we'll download
  for (const v of vods) {
    const date = new Date(v.createdAt).toLocaleDateString();
    const dur = formatDuration(v.lengthSeconds);
    console.log(`  ${v.id} | ${date} | ${dur} | ${v.title}`);
  }
}

// Download chat from all VODs (oldest first)
vods.reverse();

const CSV_HEADER = 'vod_id,timestamp,offset,username,display_name,message';
const rows: string[] = [CSV_HEADER];

for (const vod of vods) {
  const vodStart = vod.createdAt ? new Date(vod.createdAt) : new Date();
  const messages = await downloadVODChat(vod.id, vodStart);

  for (const msg of messages) {
    const ts = new Date(vodStart.getTime() + msg.offsetSeconds * 1000);
    rows.push(
      [
        vod.id,
        escapeCSV(formatTimestamp(ts)),
        formatDuration(msg.offsetSeconds),
        escapeCSV(msg.username),
        escapeCSV(msg.displayName),
        escapeCSV(msg.message),
      ].join(',')
    );
  }
}

const totalMessages = rows.length - 1;
const outFile = values.out || `chat-${input}.csv`;
writeFileSync(outFile, rows.join('\n') + '\n');
console.log(`\nWrote ${totalMessages} messages to ${outFile}`);
