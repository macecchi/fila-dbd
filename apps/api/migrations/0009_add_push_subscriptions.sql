-- Web Push subscriptions: one row per (streamer, browser). Used to notify the
-- streamer when their channel goes live on Twitch (EventSub stream.online).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  room_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (room_id, endpoint)
);
