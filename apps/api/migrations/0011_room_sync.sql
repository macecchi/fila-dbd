-- Room sync over HTTP (replaces the PartyKit/Durable Object rooms).
-- `version` bumps on every write to the room's queue or settings, so a poll can
-- answer "unchanged" from this one row. The heartbeats are epoch ms: any window of
-- the streamer marks `owner_seen_at`; the one reading chat marks `irc_live_at`.
-- `closed_by_owner` is the queue's open/closed switch (a fresh room starts open).
ALTER TABLE rooms ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN closed_by_owner INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rooms ADD COLUMN owner_seen_at INTEGER;
ALTER TABLE rooms ADD COLUMN irc_live_at INTEGER;

-- Requests needing the LLM are identified by the Worker. `identifying_at` (epoch ms) is
-- the claim on the row while a call runs, taken over after a minute in case the Worker
-- running it was cut off; `identify_attempts` caps the retries after Gemini failures.
ALTER TABLE requests ADD COLUMN identifying_at INTEGER;
ALTER TABLE requests ADD COLUMN identify_attempts INTEGER NOT NULL DEFAULT 0;
