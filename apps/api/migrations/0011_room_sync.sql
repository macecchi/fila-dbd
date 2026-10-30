-- Room sync over HTTP (replaces the PartyKit/Durable Object rooms).
-- `version` bumps on every write to the room's queue or settings, so a poll can
-- answer "unchanged" from this one row. The heartbeats are epoch ms: any window of
-- the streamer marks `owner_seen_at`; the one reading chat marks `irc_live_at`.
-- `closed_by_owner` is the queue's open/closed switch (a fresh room starts open).
ALTER TABLE rooms ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN closed_by_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN owner_seen_at INTEGER;
ALTER TABLE rooms ADD COLUMN irc_live_at INTEGER;

-- Every window of the streamer reads chat, so the same message reaches the LLM endpoint
-- from each of them. The first to claim (room, key) runs the call; the others get 409.
-- A claim older than a minute can be taken over, in case its window went away mid-call.
CREATE TABLE llm_claims (
  room_id TEXT NOT NULL,
  key TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, key)
);
