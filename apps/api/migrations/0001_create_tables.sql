-- Rooms table: flattened sources settings per channel
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  channel_login TEXT NOT NULL,
  enabled_donation INTEGER NOT NULL DEFAULT 1,
  enabled_chat INTEGER NOT NULL DEFAULT 1,
  enabled_resub INTEGER NOT NULL DEFAULT 0,
  enabled_manual INTEGER NOT NULL DEFAULT 1,
  chat_command TEXT NOT NULL DEFAULT '!fila',
  chat_tiers TEXT NOT NULL DEFAULT '[2,3]',
  priority TEXT NOT NULL DEFAULT '["donation","chat","resub","manual"]',
  sort_mode TEXT NOT NULL DEFAULT 'fifo',
  min_donation REAL NOT NULL DEFAULT 5,
  recovery_vod_id TEXT,
  recovery_vod_offset INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Character requests: one row per request, ordered by position
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  donor TEXT NOT NULL,
  amount TEXT NOT NULL DEFAULT '',
  amount_val REAL NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  character TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'unknown',
  done INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  sub_tier INTEGER,
  needs_identification INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (room_id, id),
  FOREIGN KEY (room_id) REFERENCES rooms(id)
);

CREATE INDEX idx_requests_room ON requests(room_id);
CREATE INDEX idx_requests_room_position ON requests(room_id, position);
