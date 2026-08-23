-- Discord support — run this once against the LIVE database.
--
-- schema.sql is CREATE TABLE IF NOT EXISTS, so it does nothing to a database
-- that already has a `users` table. These are the statements that bring an
-- existing database up to it. Safe to run twice: every statement either
-- succeeds or fails on "already exists", and none of them touch a row.
--
-- Paste into the D1 console (Cloudflare → Storage & Databases → D1 → lucrit →
-- Console) and run.

-- Discord's user id, set when an account signs in with Discord.
-- SQLite cannot add a UNIQUE column with ALTER, so the constraint is an index.
ALTER TABLE users ADD COLUMN discord_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_discord ON users(discord_id);

-- Small expiring cache: guild member checks and the member/online counts.
CREATE TABLE IF NOT EXISTS cache (
  k        TEXT PRIMARY KEY,
  v        TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expiry ON cache(expires);
