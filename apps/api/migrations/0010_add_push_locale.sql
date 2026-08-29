-- Language for the "you're live" push. The service worker can't read the app's
-- language toggle (localStorage is off-limits there), so the copy is rendered
-- server-side per subscription. NULL = written before this column existed;
-- treated as English.
ALTER TABLE push_subscriptions ADD COLUMN locale TEXT;
