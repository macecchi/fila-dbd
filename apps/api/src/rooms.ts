// Room sync over plain HTTP, straight on D1. Replaces the realtime rooms that ran on
// hosted PartyKit (shut down 2026-10-23).
//
// - GET  /rooms/:roomId/state — anyone. Polled: viewers every few seconds, the streamer's
//   windows a bit faster. `?v=` is the version the client already has; when it matches,
//   only the channel status comes back (one row read).
// - The streamer's edits (JWT login = room), REST on the room: POST/PUT /requests,
//   PATCH/DELETE /requests/:reqId, POST /requests/:reqId/move, PUT /sources, PUT /status.
//   The response carries the messages the client applies as the server's echo.
//
// There is no lock. Every window of the streamer reads chat and sends what it sees; D1 is
// the arbiter. An add is claimed by its insert (`ON CONFLICT DO NOTHING RETURNING` on the
// request id, a hash of the Twitch message id — see CLAUDE.md "Idempotency"), so only the
// first window's add lands and confirms in chat. The LLM runs here too, never in a
// client: the inserter identifies the new request after the response (`identifyRequest`),
// claimed on the row itself. KV can't do either: it has no put-if-absent and propagates
// in ~60s.
//
// The channel status is derived on read from two heartbeats and the open/closed switch,
// so a window that vanishes (closed laptop, crashed tab) simply ages out.
import { Hono, type Context } from "hono";
import {
  MAX_PENDING_REQUESTS,
  PROTOCOL_VERSION,
  RECENT_DONE_KEPT,
  compareRequests,
  computeEntitlement,
  eligibleExtras,
  isLikelyTruncatedDonation,
  normalizeSourcesSettings,
  splitRequestId,
} from "@filadbd/shared";
import type { ChannelState, ChannelStatus, PartyMessage, RequestExtra, SerializedRequest, SourcesSettings } from "@filadbd/shared";
import { clipMessage, extractCharacters } from "./gemini";
import { verifyJwt, type JwtPayload } from "./jwt";
import { sendChatMessage } from "./twitch";

export interface RoomsEnv {
  DB: D1Database;
  CACHE: KVNamespace;
  JWT_SECRET: string;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  GEMINI_API_KEY: string;
  DEV_MODE?: string;
}

// A heartbeat counts for this long. Background tabs get their timers throttled to about
// once a minute, and the window reading chat is usually a background tab during a match,
// so this has to outlive a couple of throttled polls.
export const PRESENCE_TTL_MS = 150_000;
// Heartbeats are written at most this often, so polling doesn't turn into a D1 write each.
const HEARTBEAT_WRITE_MS = 30_000;
// Rows marked done before this were sometimes deletions: the old realtime server's sync
// marked anything missing as done, and `deleted_at` was never written. Since this
// version deletions are recorded, so the "recently played" strip only reads done rows
// from after it — otherwise it could bring a deleted request back.
const DELETES_RECORDED_SINCE = "2026-10-30T00:00:00.000Z";
const RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CHAT_NOT_MOD_NOTIFY_TTL_S = 5 * 60;
// An identification running longer than this is taken over: the Worker running it was
// cut off (waitUntil has a time limit) or died.
const IDENTIFY_TTL_MS = 60_000;
// Gemini failures retried before the request is left unidentified for the streamer.
const IDENTIFY_MAX_ATTEMPTS = 3;
// LLM calls per streamer per day (one call however many requests it returns).
export const DAILY_EXTRACT_LIMIT = 200;
const NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

interface RoomRow {
  id: string;
  channel_login: string;
  display_name: string | null;
  avatar_url: string | null;
  sources_config: string | null;
  version: number;
  closed_by_owner: number;
  owner_seen_at: number | null;
  irc_live_at: number | null;
}

export interface PresenceRow {
  channel_login: string;
  display_name: string | null;
  avatar_url: string | null;
  closed_by_owner: number;
  owner_seen_at: number | null;
  irc_live_at: number | null;
}

const fresh = (at: number | null, now: number) => at !== null && now - at < PRESENCE_TTL_MS;

/** The room's status: closed by the streamer, or how recently their windows checked in. */
export function roomStatus(row: Pick<PresenceRow, "closed_by_owner" | "owner_seen_at" | "irc_live_at"> | null, now = Date.now()): ChannelStatus {
  if (!row || row.closed_by_owner) return "offline";
  if (fresh(row.irc_live_at, now)) return "live";
  if (fresh(row.owner_seen_at, now)) return "online";
  return "offline";
}

export function channelState(row: PresenceRow | null, now = Date.now()): ChannelState {
  const status = roomStatus(row, now);
  const owner = row && status !== "offline"
    ? { login: row.channel_login, displayName: row.display_name ?? row.channel_login, avatar: row.avatar_url ?? "" }
    : null;
  return { status, owner, closedByOwner: !!row?.closed_by_owner };
}

export function rowToRequest(r: Record<string, unknown>, roomId: string): SerializedRequest {
  return {
    id: r.id as number,
    timestamp: r.timestamp as string,
    donor: r.donor as string,
    amount: (r.amount as string) ?? "",
    amountVal: (r.amount_val as number) ?? 0,
    message: (r.message as string) ?? "",
    character: (r.character as string) ?? "",
    type: ((r.type as string) ?? "unknown") as SerializedRequest["type"],
    done: !!r.done,
    doneAt: (r.done_at as string | null) ?? undefined,
    source: r.source as SerializedRequest["source"],
    subTier: (r.sub_tier as number | null) ?? undefined,
    isBroadcaster: r.source === "manual" || (r.source === "chat" && typeof r.donor === "string" && r.donor.toLowerCase() === roomId.toLowerCase()),
    needsIdentification: !!r.needs_identification,
    matchedTerm: (r.matched_term as string | null) ?? undefined,
    ...(r.origin_msg_id ? { originMsgId: r.origin_msg_id as string } : {}),
    extras: r.extras ? JSON.parse(r.extras as string) : undefined,
  } as SerializedRequest;
}

async function loadRoom(db: D1Database, roomId: string): Promise<RoomRow | null> {
  return db.prepare(
    `SELECT id, channel_login, display_name, avatar_url, sources_config, version, closed_by_owner, owner_seen_at, irc_live_at
     FROM rooms WHERE id = ?`
  ).bind(roomId).first<RoomRow>();
}

async function loadPending(db: D1Database, roomId: string): Promise<SerializedRequest[]> {
  const { results } = await db.prepare(
    "SELECT * FROM requests WHERE room_id = ? AND done = 0 AND deleted_at IS NULL ORDER BY position ASC, timestamp ASC"
  ).bind(roomId).all();
  return (results ?? []).map((r) => rowToRequest(r, roomId));
}

/** What a client renders: the pending queue in order, plus the newest few done for the strip. */
async function loadQueue(db: D1Database, roomId: string, now: number): Promise<SerializedRequest[]> {
  const since = new Date(Math.max(now - RECENT_DONE_WINDOW_MS, Date.parse(DELETES_RECORDED_SINCE))).toISOString();
  const [pending, recent] = await db.batch([
    db.prepare("SELECT * FROM requests WHERE room_id = ? AND done = 0 AND deleted_at IS NULL ORDER BY position ASC, timestamp ASC").bind(roomId),
    db.prepare(
      "SELECT * FROM requests WHERE room_id = ? AND done = 1 AND deleted_at IS NULL AND done_at >= ? ORDER BY done_at DESC LIMIT ?"
    ).bind(roomId, since, RECENT_DONE_KEPT),
  ]);
  return [...(pending.results ?? []), ...(recent.results ?? [])].map((r) => rowToRequest(r as Record<string, unknown>, roomId));
}

function roomSources(row: RoomRow | null): SourcesSettings {
  return normalizeSourcesSettings(row?.sources_config ? JSON.parse(row.sources_config) : null);
}

function ensureRoom(db: D1Database, roomId: string, user?: JwtPayload | null) {
  return db.prepare(
    `INSERT INTO rooms (id, channel_login, display_name, avatar_url) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET updated_at = datetime('now')`
  ).bind(roomId, roomId, user?.display_name ?? null, user?.profile_image_url || null);
}

function bumpVersion(db: D1Database, roomId: string) {
  return db.prepare("UPDATE rooms SET version = version + 1 WHERE id = ? RETURNING version").bind(roomId);
}

// Every pending row's position from an ordered list of ids, in one statement whatever
// the queue length (D1 caps a statement at 100 bound parameters).
function writeOrder(db: D1Database, roomId: string, ids: number[]) {
  const json = JSON.stringify(ids);
  return db.prepare(
    `UPDATE requests SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?1) WHERE value = requests.id)
     WHERE room_id = ?2 AND id IN (SELECT value FROM json_each(?1))`
  ).bind(json, roomId);
}

function upsertRequest(db: D1Database, roomId: string, r: SerializedRequest, position: number) {
  return db.prepare(
    `INSERT INTO requests (id, room_id, position, timestamp, donor, amount, amount_val, message, character, type, done, done_at, source, sub_tier, needs_identification, matched_term, origin_msg_id, extras)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (room_id, id) DO UPDATE SET
       position = excluded.position, timestamp = excluded.timestamp, donor = excluded.donor,
       amount = excluded.amount, amount_val = excluded.amount_val, message = excluded.message,
       character = excluded.character, type = excluded.type, done = excluded.done,
       done_at = excluded.done_at, source = excluded.source, sub_tier = excluded.sub_tier,
       needs_identification = excluded.needs_identification, matched_term = excluded.matched_term,
       origin_msg_id = excluded.origin_msg_id, extras = excluded.extras, deleted_at = NULL`
  ).bind(
    r.id, roomId, position, r.timestamp, r.donor, r.amount ?? "", r.amountVal ?? 0, r.message ?? "",
    r.character ?? "", r.type ?? "unknown", r.done ? 1 : 0, r.done ? (r.doneAt ?? null) : null, r.source,
    r.subTier ?? null, r.needsIdentification ? 1 : 0, r.matchedTerm ?? null,
    (r as { originMsgId?: string }).originMsgId ?? null, r.extras ? JSON.stringify(r.extras) : null,
  );
}

// A new row at the end of the queue, unless the id exists (pending, done or deleted: a
// replayed message must not come back) or the pending queue is full — both decided by
// D1 inside the statement, so concurrent windows can't both pass. RETURNING yields a
// row only for the inserter.
// `whileId` only inserts once that request was just identified and is still pending (a
// split of a donation the streamer skipped, played or deleted meanwhile is dropped).
function insertRequest(db: D1Database, roomId: string, r: SerializedRequest, whileId?: number) {
  const guard = whileId === undefined ? "" : " AND EXISTS (SELECT 1 FROM requests WHERE room_id = ?2 AND id = ?17 AND identifying_at IS NULL AND needs_identification = 0 AND done = 0 AND deleted_at IS NULL)";
  return db.prepare(
    `INSERT INTO requests (id, room_id, position, timestamp, donor, amount, amount_val, message, character, type, done, done_at, source, sub_tier, needs_identification, matched_term, origin_msg_id, extras)
     SELECT ?1, ?2, (SELECT COALESCE(MAX(position), -1) + 1 FROM requests WHERE room_id = ?2), ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, NULL, ?10, ?11, ?12, ?13, ?14, ?15
     WHERE (SELECT COUNT(*) FROM requests WHERE room_id = ?2 AND done = 0 AND deleted_at IS NULL) < ?16${guard}
     ON CONFLICT (room_id, id) DO NOTHING
     RETURNING id`
  ).bind(
    r.id, roomId, r.timestamp, r.donor, r.amount ?? "", r.amountVal ?? 0, r.message ?? "",
    r.character ?? "", r.type ?? "unknown", r.source, r.subTier ?? null, r.needsIdentification ? 1 : 0,
    r.matchedTerm ?? null, (r as { originMsgId?: string }).originMsgId ?? null, r.extras ? JSON.stringify(r.extras) : null,
    MAX_PENDING_REQUESTS, ...(whileId === undefined ? [] : [whileId]),
  );
}

// Columns an update-request may set, by request field. Anything else (id, validating,
// isBroadcaster) is ignored.
const UPDATABLE: Record<string, { column: string; encode?: (v: unknown) => unknown }> = {
  timestamp: { column: "timestamp" },
  donor: { column: "donor" },
  amount: { column: "amount" },
  amountVal: { column: "amount_val" },
  message: { column: "message" },
  character: { column: "character" },
  type: { column: "type" },
  done: { column: "done", encode: (v) => (v ? 1 : 0) },
  doneAt: { column: "done_at" },
  source: { column: "source" },
  subTier: { column: "sub_tier" },
  needsIdentification: { column: "needs_identification", encode: (v) => (v ? 1 : 0) },
  matchedTerm: { column: "matched_term" },
  extras: { column: "extras", encode: (v) => (v ? JSON.stringify(v) : null) },
};

// Only the fields the edit names, on a row that still exists: a snapshot written back
// would undo what another window did in between (a ✓, a delete).
function updateFields(db: D1Database, roomId: string, id: number, updates: Partial<SerializedRequest>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(updates)) {
    const field = UPDATABLE[key];
    if (!field) continue;
    sets.push(`${field.column} = ?`);
    values.push(field.encode ? field.encode(value) : (value ?? null));
  }
  if (!sets.length) return null;
  return db.prepare(`UPDATE requests SET ${sets.join(", ")} WHERE room_id = ? AND id = ? AND deleted_at IS NULL`)
    .bind(...values, roomId, id);
}

function insertIndex(pending: SerializedRequest[], req: SerializedRequest, sources: SourcesSettings): number {
  if (sources.sortMode === "fifo") return pending.length;
  let idx = 0;
  for (let i = 0; i < pending.length; i++) {
    if (compareRequests(req, pending[i], sources.priority, sources.prioritizeTiers ?? false, sources.prioritizeDonations ?? false) >= 0) idx = i + 1;
  }
  return idx;
}

// Same position the queue shows, so the chat confirmation matches what people see.
function queuePosition(pending: SerializedRequest[], req: SerializedRequest, sources: SourcesSettings): number {
  const visible = pending.filter((r) => !sources.hideNonRequests || r.type !== "none");
  const ordered = sources.sortMode === "fifo"
    ? visible
    : [...visible].sort((a, b) => compareRequests(a, b, sources.priority, sources.prioritizeTiers ?? false, sources.prioritizeDonations ?? false));
  const idx = ordered.findIndex((r) => r.id === req.id);
  return idx === -1 ? ordered.length : idx + 1;
}

const errorMsg = (code: string, message: string, id?: number): PartyMessage =>
  ({ type: "server-error", code, message, ...(id !== undefined ? { id } : {}) });

async function authenticate(env: RoomsEnv, header: string | undefined): Promise<JwtPayload | null> {
  if (!header?.startsWith("Bearer ") || !env.JWT_SECRET) return null;
  return verifyJwt(header.slice("Bearer ".length), env.JWT_SECRET);
}

const isRoomOwner = (env: RoomsEnv, user: JwtPayload | null, roomId: string) =>
  !!user && (user.login.toLowerCase() === roomId || env.DEV_MODE === "true");

type Ctx = { waitUntil(p: Promise<unknown>): void };

export const roomsSync = new Hono<{ Bindings: RoomsEnv }>();

roomsSync.get("/:roomId/state", async (c) => {
  const roomId = c.req.param("roomId").toLowerCase();
  const db = c.env.DB;
  const now = Date.now();
  c.header("Cache-Control", "no-store");

  if (Number(c.req.query("p") ?? 0) < PROTOCOL_VERSION) {
    return c.json({ error: "version_mismatch" }, 426);
  }

  let row = await loadRoom(db, roomId);

  // The streamer's windows check in through their polls; the one reading chat says so.
  const user = await authenticate(c.env, c.req.header("Authorization"));
  if (isRoomOwner(c.env, user, roomId)) {
    // A closed queue isn't reading chat, whatever a straggling window says.
    const irc = c.req.query("irc") === "1" && !row?.closed_by_owner;
    const seenStale = !row?.owner_seen_at || now - row.owner_seen_at > HEARTBEAT_WRITE_MS;
    const liveStale = irc && (!row?.irc_live_at || now - row.irc_live_at > HEARTBEAT_WRITE_MS);
    if (!row || seenStale || liveStale) {
      await db.batch([
        ensureRoom(db, roomId, user),
        db.prepare(
          `UPDATE rooms SET owner_seen_at = ?, irc_live_at = CASE WHEN ? THEN ? ELSE irc_live_at END WHERE id = ?`
        ).bind(now, irc ? 1 : 0, now, roomId),
      ]);
      row = await loadRoom(db, roomId);
      // The heartbeat is also when what an add left unidentified gets retried.
      if (row && !row.closed_by_owner) c.executionCtx.waitUntil(identifyPending(c.env, c.executionCtx, roomId, user!));
    }
  }

  const version = row?.version ?? 0;
  const channel = channelState(row, now);
  if (c.req.query("v") === String(version)) {
    return c.json({ version, channel });
  }
  return c.json({
    version,
    channel,
    requests: await loadQueue(db, roomId, now),
    sources: roomSources(row),
  });
});

// The streamer's edits, as REST on the room. Each route builds the PartyMessage the
// room logic (and the client stores) already speak; the response is
// `{ version?, messages }`, the server's echo for the client to apply.
type Build = (body: any, reqId: number | null) => PartyMessage | null;

function edit(build: Build) {
  return async (c: Context<{ Bindings: RoomsEnv }>) => {
    const roomId = c.req.param("roomId")!.toLowerCase();
    if (Number(c.req.query("p") ?? 0) < PROTOCOL_VERSION) {
      return c.json({ messages: [errorMsg("version_mismatch", "Nova versão disponível. Recarregue a página.")] }, 426);
    }
    const user = await authenticate(c.env, c.req.header("Authorization"));
    if (!isRoomOwner(c.env, user, roomId)) {
      return c.json({ messages: [errorMsg("not_room_owner", "Apenas o dono do canal pode gerenciar a fila.")] }, user ? 403 : 401);
    }
    const body = c.req.method === "DELETE" ? {} : await c.req.json().catch(() => null);
    const rawId = c.req.param("reqId");
    const reqId = rawId === undefined ? null : Number(rawId);
    const msg = body && (reqId === null || Number.isFinite(reqId)) ? build(body, reqId) : null;
    if (!msg) return c.json({ error: "invalid_input" }, 400);
    return c.json(await applyOp(c.env, c.executionCtx, roomId, user!, msg));
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

roomsSync.post("/:roomId/requests", edit((body) =>
  isObject(body) && typeof body.id === "number" ? { type: "add-request", request: body as unknown as SerializedRequest } : null));

roomsSync.put("/:roomId/requests", edit((body) =>
  isObject(body) && Array.isArray(body.requests) ? { type: "set-all", requests: body.requests } : null));

// A PATCH that only sets `done` (and its time) is the ✓ / undo; anything else is an edit.
roomsSync.patch("/:roomId/requests/:reqId", edit((body, id) => {
  if (!isObject(body) || id === null) return null;
  const keys = Object.keys(body);
  if (keys.includes("done") && keys.every((k) => k === "done" || k === "doneAt")) {
    return { type: "toggle-done", id, done: !!body.done, ...(typeof body.doneAt === "string" ? { doneAt: body.doneAt } : {}) };
  }
  return { type: "update-request", id, updates: body as Partial<SerializedRequest> };
}));

roomsSync.delete("/:roomId/requests/:reqId", edit((_body, id) => (id === null ? null : { type: "delete-request", id })));

// A move, not a state: POST, since repeating it moves the request again.
roomsSync.post("/:roomId/requests/:reqId/move", edit((body, id) =>
  isObject(body) && id !== null && typeof body.before === "number"
    ? { type: "reorder", fromId: id, toId: body.before, ...(typeof body.opId === "string" ? { opId: body.opId } : {}) }
    : null));

roomsSync.put("/:roomId/sources", edit((body) => (isObject(body) ? { type: "update-sources", sources: body as unknown as SourcesSettings } : null)));

// `{ open }` is the queue switch; `{ chat }` is whether this window reads chat.
roomsSync.put("/:roomId/status", edit((body) => {
  if (!isObject(body)) return null;
  if (typeof body.open === "boolean") return { type: body.open ? "open-queue" : "close-queue" };
  if (typeof body.chat === "boolean") return { type: "irc-status", connected: body.chat };
  return null;
}));

export async function applyOp(
  env: RoomsEnv,
  ctx: Ctx,
  roomId: string,
  user: JwtPayload,
  msg: PartyMessage,
): Promise<{ version?: number; messages: PartyMessage[] }> {
  const db = env.DB;
  const now = Date.now();
  const row = await loadRoom(db, roomId);
  const sources = roomSources(row);
  const tag = `[${roomId}]`;

  const commit = async (statements: D1PreparedStatement[]) => {
    const results = await db.batch([ensureRoom(db, roomId, user), ...statements, bumpVersion(db, roomId)]);
    const last = results[results.length - 1].results?.[0] as { version: number } | undefined;
    return last?.version;
  };
  const presence = async () => channelState(await loadRoom(db, roomId), Date.now());

  switch (msg.type) {
    case "add-request": {
      const req = msg.request;
      const pending = await loadPending(db, roomId);
      if (pending.some((r) => r.id === req.id)) return { messages: [] };
      const idx = insertIndex(pending, req, sources);
      const next = [...pending];
      next.splice(idx, 0, req);
      // One transaction. The insert is the claim: another window (or a VOD replay) that
      // sent the same message gets no row back. The order and the version only follow an
      // insert that happened: `changes()` is the previous statement's row count (the
      // insert's for the order, the order's for the version).
      const results = await db.batch([
        ensureRoom(db, roomId, user),
        insertRequest(db, roomId, { ...req, done: false }),
        db.prepare(
          `UPDATE requests SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?1) WHERE value = requests.id)
           WHERE room_id = ?2 AND id IN (SELECT value FROM json_each(?1)) AND changes() > 0`
        ).bind(JSON.stringify(next.map((r) => r.id)), roomId),
        db.prepare("UPDATE rooms SET version = version + 1 WHERE id = ? AND changes() > 0 RETURNING version").bind(roomId),
      ]);
      if (!results[1].results?.length) {
        const exists = await db.prepare("SELECT 1 FROM requests WHERE room_id = ? AND id = ?").bind(roomId, req.id).first();
        if (exists) return { messages: [] };
        console.warn(`${tag} add-request #${req.id} rejected (pending cap ${MAX_PENDING_REQUESTS})`);
        return { messages: [errorMsg("pending_cap", `Fila cheia (${MAX_PENDING_REQUESTS}). Marque pedidos como feitos para liberar espaço.`, req.id)] };
      }
      const version = (results[3].results?.[0] as { version: number } | undefined)?.version;
      console.log(`${tag} add-request #${req.id} "${req.character}" (${req.source})`);
      // Only the inserter identifies it, so the LLM runs once however many windows sent it.
      // Synchronously: the answer goes back as a full sync (a donation may have split into
      // several requests), and while this window waits the Worker has no time limit.
      if (req.needsIdentification) {
        const identified = await identifyRequest(env, ctx, roomId, req.id, user);
        if (identified !== null) {
          const room = await loadRoom(db, roomId);
          const sync: PartyMessage = {
            type: "sync-full", requests: await loadQueue(db, roomId, Date.now()), sources: roomSources(room), channel: channelState(room, Date.now()),
          };
          return { version: identified, messages: [msg, sync] };
        }
      }
      const notice = await confirmInChat(env, ctx, roomId, sources, req, next);
      return { version, messages: [msg, ...notice] };
    }
    case "update-request": {
      const current = await db.prepare("SELECT * FROM requests WHERE room_id = ? AND id = ? AND deleted_at IS NULL").bind(roomId, msg.id).first();
      if (!current) return { messages: [] };
      const before = rowToRequest(current, roomId);
      const after = { ...before, ...msg.updates, id: before.id } as SerializedRequest;
      const update = updateFields(db, roomId, msg.id, msg.updates);
      if (!update) return { messages: [] };
      const version = await commit([update]);
      let notice: PartyMessage[] = [];
      if (before.needsIdentification && !after.needsIdentification && !after.done) {
        notice = await confirmInChat(env, ctx, roomId, sources, after, await loadPending(db, roomId));
      }
      return { version, messages: [msg, ...notice] };
    }
    case "toggle-done": {
      const doneAt = msg.done ? (msg.doneAt ?? new Date(now).toISOString()) : undefined;
      const res = await db.prepare("SELECT 1 FROM requests WHERE room_id = ? AND id = ? AND deleted_at IS NULL").bind(roomId, msg.id).first();
      if (!res) return { messages: [] };
      const version = await commit([
        db.prepare("UPDATE requests SET done = ?, done_at = ? WHERE room_id = ? AND id = ?").bind(msg.done ? 1 : 0, doneAt ?? null, roomId, msg.id),
      ]);
      console.log(`${tag} toggle-done #${msg.id} → ${msg.done}`);
      return { version, messages: [{ type: "toggle-done", id: msg.id, done: msg.done, doneAt }] };
    }
    case "reorder": {
      const ids = (await loadPending(db, roomId)).map((r) => r.id);
      const from = ids.indexOf(msg.fromId);
      const to = ids.indexOf(msg.toId);
      if (from === -1 || to === -1) return { messages: [] };
      ids.splice(to, 0, ...ids.splice(from, 1));
      const version = await commit([writeOrder(db, roomId, ids)]);
      return { version, messages: [msg] };
    }
    case "delete-request": {
      const version = await commit([
        db.prepare(`UPDATE requests SET deleted_at = ${NOW_ISO} WHERE room_id = ? AND id = ? AND deleted_at IS NULL`).bind(roomId, msg.id),
      ]);
      console.log(`${tag} delete-request #${msg.id}`);
      return { version, messages: [msg] };
    }
    case "set-all": {
      // An import replaces the queue: whatever pending isn't in it is gone, not played.
      const ids = JSON.stringify(msg.requests.map((r) => r.id));
      const statements: D1PreparedStatement[] = [
        db.prepare(
          `UPDATE requests SET deleted_at = ${NOW_ISO}
           WHERE room_id = ? AND done = 0 AND deleted_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))`
        ).bind(roomId, ids),
        ...msg.requests.map((r, i) => upsertRequest(db, roomId, r, i)),
      ];
      // A long import doesn't fit one batch (D1 caps a batch at 100 statements): write the
      // rows first, then commit the sweep and the version together.
      const head = statements.slice(0, 1);
      const rows = statements.slice(1);
      for (let i = 0; i < rows.length; i += 80) await db.batch(rows.slice(i, i + 80));
      const version = await commit(head);
      console.log(`${tag} set-all (${msg.requests.length} requests)`);
      return { version, messages: [msg] };
    }
    case "update-sources": {
      const normalized = normalizeSourcesSettings(msg.sources);
      const version = await commit([
        db.prepare("UPDATE rooms SET sources_config = ? WHERE id = ?").bind(JSON.stringify(normalized), roomId),
      ]);
      return { version, messages: [{ type: "update-sources", sources: normalized }] };
    }
    case "irc-status": {
      // A window that lost chat doesn't clear the heartbeat: another window may still be
      // reading it, and an unrefreshed one ages out on its own (PRESENCE_TTL_MS).
      await db.batch([
        ensureRoom(db, roomId, user),
        db.prepare("UPDATE rooms SET owner_seen_at = ?, irc_live_at = CASE WHEN ? THEN ? ELSE irc_live_at END WHERE id = ?")
          .bind(now, msg.connected ? 1 : 0, now, roomId),
      ]);
      return { messages: [{ type: "update-channel", channel: await presence() }] };
    }
    case "open-queue":
    case "close-queue": {
      const closing = msg.type === "close-queue";
      await db.batch([
        ensureRoom(db, roomId, user),
        db.prepare("UPDATE rooms SET closed_by_owner = ?, owner_seen_at = ?, irc_live_at = CASE WHEN ? THEN NULL ELSE irc_live_at END WHERE id = ?")
          .bind(closing ? 1 : 0, now, closing ? 1 : 0, roomId),
        // Closing drops the messages that weren't requests (type 'none', hidden by
        // hideNonRequests), as the old rooms did: otherwise they'd pile up toward the
        // pending cap across streams while the visible queue looks short.
        ...(closing ? [
          db.prepare(`UPDATE requests SET deleted_at = ${NOW_ISO} WHERE room_id = ? AND done = 0 AND deleted_at IS NULL AND type = 'none'`).bind(roomId),
          bumpVersion(db, roomId),
        ] : []),
      ]);
      console.log(`${tag} ${msg.type}`);
      return { messages: [{ type: "update-channel", channel: await presence() }] };
    }
    default:
      return { messages: [] };
  }
}

// Posts a confirmation in chat via the @filadbd bot account. For viewer-originated
// requests it @-mentions the donor; for manual (streamer-added) it drops the mention
// since the donor field is just a placeholder. Skips pending-identification requests
// — the update-request path re-fires once the LLM resolves the character. Runs after
// the response; a "bot isn't a mod" notice is only returned when known in time (cached
// from an earlier failure), at most once per CHAT_NOT_MOD_NOTIFY_TTL_S.
async function confirmInChat(
  env: RoomsEnv,
  ctx: Ctx,
  roomId: string,
  sources: SourcesSettings,
  req: SerializedRequest,
  pending: SerializedRequest[],
  // Off when nobody is waiting on the response to show the "bot isn't a mod" notice.
  notify = true,
): Promise<PartyMessage[]> {
  if (!sources.confirmInChat || req.needsIdentification || !req.character || req.type === "none") return [];
  const position = queuePosition(pending, req, sources);
  const message = req.source === "manual"
    ? `Pedido de ${req.character} entrou na fila na posição ${position}! 🎯`
    : `@${req.donor} seu pedido de ${req.character} entrou na fila na posição ${position}! 🎯`;

  const notifyKey = `chat_not_mod:${roomId}`;
  ctx.waitUntil((async () => {
    const result = await sendChatMessage(env as never, roomId, message).catch((e) => ({ ok: false as const, reason: String(e) }));
    if (result.ok) return;
    console.warn(`[${roomId}] chat-confirm failed: ${result.reason}`);
    // not_mod = Helix rejected (bot isn't a mod); message_rejected = chat modes blocked
    // it, which mods bypass — the same fix either way.
    if (result.reason === "not_mod" || result.reason === "message_rejected") {
      await env.CACHE.put(notifyKey, "pending", { expirationTtl: CHAT_NOT_MOD_NOTIFY_TTL_S });
    }
  })());

  if (!notify) return [];
  const flagged = await env.CACHE.get(notifyKey);
  if (flagged !== "pending") return [];
  await env.CACHE.put(notifyKey, "shown", { expirationTtl: CHAT_NOT_MOD_NOTIFY_TTL_S });
  return [errorMsg("chat_send_not_mod", "Confirme que @filadbd está como mod no seu canal (/mod filadbd) para as mensagens de confirmação funcionarem.")];
}

// Identification. A request that needs the LLM (`needs_identification = 1`: a donation,
// resub or chat message the local match couldn't settle) is identified here, never by a
// client. The add that inserted it runs the call before answering; the streamer's
// heartbeats retry whatever that left behind (the window went away, Gemini failed).
// `identifying_at` is the claim, so one call runs per row at a time.
//
// A donation that pays for several requests ("2 de trapper e 1 de nurse") is one row
// until then; the answer fills it in and adds the rest right after it.

const IDENTIFYING = new Set(["Identificando...", "Identifying..."]);

type Identified = Pick<SerializedRequest, "character" | "type" | "matchedTerm" | "extras">;

/** Identifies the requests the heartbeat finds waiting: never started, failed, or abandoned. */
export async function identifyPending(env: RoomsEnv, ctx: Ctx, roomId: string, user: JwtPayload, now = Date.now()): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM requests
     WHERE room_id = ? AND needs_identification = 1 AND done = 0 AND deleted_at IS NULL
       AND identify_attempts < ? AND (identifying_at IS NULL OR identifying_at < ?)
     ORDER BY position LIMIT 5`
  ).bind(roomId, IDENTIFY_MAX_ATTEMPTS, now - IDENTIFY_TTL_MS).all<{ id: number }>();
  await Promise.all((results ?? []).map((r) => identifyRequest(env, ctx, roomId, r.id, user)));
}

/** The room's version once this request was identified, or null when nothing was written. */
export async function identifyRequest(env: RoomsEnv, ctx: Ctx, roomId: string, id: number, user: JwtPayload): Promise<number | null> {
  const db = env.DB;
  const tag = `[${roomId}]`;
  const claim = Date.now();
  const row = await db.prepare(
    `UPDATE requests SET identifying_at = ?1, identify_attempts = identify_attempts + 1
     WHERE room_id = ?2 AND id = ?3 AND needs_identification = 1 AND done = 0 AND deleted_at IS NULL
       AND identify_attempts < ?4 AND (identifying_at IS NULL OR identifying_at < ?5)
     RETURNING *`
  ).bind(claim, roomId, id, IDENTIFY_MAX_ATTEMPTS, claim - IDENTIFY_TTL_MS).first();
  if (!row) return null;
  const req = rowToRequest(row, roomId);
  const lastAttempt = (row.identify_attempts as number) >= IDENTIFY_MAX_ATTEMPTS;
  const sources = roomSources(await loadRoom(db, roomId));
  const maxCount = req.source === "donation" ? computeEntitlement(req.amountVal, sources.minDonation) : 1;
  const extras = eligibleExtras(req.amountVal, sources.extrasConfig);
  const ours = "room_id = ? AND id = ? AND identifying_at = ?";

  const rateKey = `ratelimit:extract:${user.sub}:${new Date(claim).toISOString().slice(0, 10)}`;
  const calls = parseInt((await env.CACHE.get(rateKey)) || "0", 10);
  let found: Awaited<ReturnType<typeof extractCharacters>> | null = null;
  if (calls >= DAILY_EXTRACT_LIMIT) {
    console.warn(`${tag} daily extract limit (${DAILY_EXTRACT_LIMIT}) reached, #${id} left unidentified`);
  } else {
    try {
      found = await extractCharacters(clipMessage(req.message), env.GEMINI_API_KEY, maxCount, extras);
      await env.CACHE.put(rateKey, String(calls + 1), { expirationTtl: 86400 });
    } catch (e) {
      console.error(`${tag} identify #${id} failed (attempt ${row.identify_attempts}):`, e instanceof Error ? e.message : e);
      if (!lastAttempt) {
        // Free the claim; the next heartbeat retries.
        await db.prepare(`UPDATE requests SET identifying_at = NULL WHERE ${ours}`).bind(roomId, id, claim).run();
        return null;
      }
    }
  }

  if (!found) {
    // Out of attempts (or calls): keep the local guess if there was one, and let the
    // streamer sort it out.
    const leftover: Identified = { character: IDENTIFYING.has(req.character) ? "" : req.character, type: req.type };
    const done = await db.batch([
      db.prepare(`UPDATE requests SET character = ?, needs_identification = 0, identifying_at = NULL WHERE ${ours}`)
        .bind(leftover.character, roomId, id, claim),
      bumpVersion(db, roomId),
    ]);
    return versionOf(done[1]);
  }

  const identified: Identified[] = (found.length ? found : [{ character: "", type: "none" as const }]).slice(0, maxCount).map((c) => {
    const build: RequestExtra[] | undefined = c.build?.text ? [{ type: "build", text: c.build.text, matchedTerms: c.build.matchedTerms }] : undefined;
    // A LivePix donate cut at 250 chars may carry its request in the lost tail: never
    // hide it as "no request", leave it for the streamer to read.
    const hide = c.type === "none" && !(req.source === "donation" && isLikelyTruncatedDonation(req.message));
    return {
      character: c.type === "none" ? "" : c.character || "",
      type: c.type === "none" && !hide ? "unknown" : (c.type || "unknown"),
      matchedTerm: c.matchedTerm,
      extras: build,
    };
  });
  const first: SerializedRequest = { ...req, ...identified[0], needsIdentification: false };
  const split: SerializedRequest[] = identified.slice(1).map((c, i) => ({
    ...req, ...c, id: splitRequestId(req.id, i + 1), needsIdentification: false, done: false, doneAt: undefined,
  }));

  // The split requests go right after the donation they came from, in either sort mode
  // (they share every field priority compares).
  const pending = await loadPending(db, roomId);
  const order = pending.map((r) => r.id).filter((x) => !split.some((r) => r.id === x));
  order.splice(order.indexOf(req.id) + 1, 0, ...split.map((r) => r.id));
  const results = await db.batch([
    db.prepare(
      `UPDATE requests SET character = ?, type = ?, matched_term = ?, extras = ?, needs_identification = 0, identifying_at = NULL
       WHERE ${ours} AND needs_identification = 1 AND deleted_at IS NULL RETURNING id`
    ).bind(first.character, first.type, first.matchedTerm ?? null, first.extras ? JSON.stringify(first.extras) : null, roomId, id, claim),
    ...split.map((r) => insertRequest(db, roomId, r, req.id)),
    writeOrder(db, roomId, order),
    bumpVersion(db, roomId),
  ]);
  const version = versionOf(results[results.length - 1]);
  if (!results[0].results?.length) return version; // edited, played or deleted meanwhile
  const added = split.filter((_, i) => results[i + 1].results?.length);
  if (added.length < split.length) console.warn(`${tag} #${id}: ${split.length - added.length} split requests dropped (pending cap)`);
  console.log(`${tag} identified #${id} → ${[first, ...added].map((r) => r.character || r.type).join(", ")}`);

  const after = await loadPending(db, roomId);
  for (const r of [first, ...added]) await confirmInChat(env, ctx, roomId, sources, r, after, false);
  return version;
}

const versionOf = (result: D1Result) => (result.results?.[0] as { version: number } | undefined)?.version ?? null;
