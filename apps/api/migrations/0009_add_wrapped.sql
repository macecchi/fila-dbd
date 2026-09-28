-- Wrapped ("Retrospectiva") editions: one generated payload per room per edition.
-- payload is the full JSON (stats + narrative + private money stats); the public
-- endpoint strips the private section before returning it.
CREATE TABLE IF NOT EXISTS wrapped (
  room_id TEXT NOT NULL,
  edition TEXT NOT NULL,
  payload TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- LLM model that produced the narrative (internal bookkeeping, never exposed)
  model TEXT,
  PRIMARY KEY (room_id, edition),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);
