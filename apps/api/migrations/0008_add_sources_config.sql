-- 1. Add the new unified sources_config column to rooms
ALTER TABLE rooms ADD COLUMN sources_config TEXT;

-- 2. Populate sources_config by migrating and serializing the data from the old columns
UPDATE rooms
SET sources_config = json_object(
  'enabled', json_object(
    'donation', json(CASE WHEN enabled_donation = 1 THEN 'true' ELSE 'false' END),
    'chat', json(CASE WHEN enabled_chat = 1 THEN 'true' ELSE 'false' END),
    'resub', json(CASE WHEN enabled_resub = 1 THEN 'true' ELSE 'false' END),
    'manual', json(CASE WHEN enabled_manual = 1 THEN 'true' ELSE 'false' END)
  ),
  'chatCommand', chat_command,
  'chatTiers', json(chat_tiers),
  'priority', json(priority),
  'sortMode', sort_mode,
  'minDonation', min_donation,
  'recoveryVodId', recovery_vod_id,
  'recoveryVodOffset', recovery_vod_offset,
  'extrasConfig', CASE WHEN extras_config IS NOT NULL THEN json(extras_config) ELSE NULL END
);

-- 3. Drop the old flat configuration columns
ALTER TABLE rooms DROP COLUMN enabled_donation;
ALTER TABLE rooms DROP COLUMN enabled_chat;
ALTER TABLE rooms DROP COLUMN enabled_resub;
ALTER TABLE rooms DROP COLUMN enabled_manual;
ALTER TABLE rooms DROP COLUMN chat_command;
ALTER TABLE rooms DROP COLUMN chat_tiers;
ALTER TABLE rooms DROP COLUMN priority;
ALTER TABLE rooms DROP COLUMN sort_mode;
ALTER TABLE rooms DROP COLUMN min_donation;
ALTER TABLE rooms DROP COLUMN recovery_vod_id;
ALTER TABLE rooms DROP COLUMN recovery_vod_offset;
ALTER TABLE rooms DROP COLUMN extras_config;
