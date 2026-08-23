-- Discord bot integration: per-game channels, message tracking, review queue.
--
-- Run once against the live database, BEFORE setting DISCORD_BOT_TOKEN.
-- Safe to run twice: every statement either succeeds or fails on "already
-- exists", and none of them touch a row.

-- Which Discord messages represent a script.
--
-- This table is the whole reason a script can be EDITED or DELETED in Discord
-- later. Without it, publishing is fire-and-forget: the moment a message is
-- sent the site forgets which message it was, and a script taken down on the
-- website lives on in the server forever with a Get Script button that 403s.
--
-- One script has several rows — the game channel and the #all-scripts feed —
-- so every surface it appears on can be updated in one pass.
CREATE TABLE IF NOT EXISTS script_posts (
  script_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'game',   -- 'game' | 'all'
  at         INTEGER NOT NULL,
  PRIMARY KEY (script_id, channel_id)
);
CREATE INDEX IF NOT EXISTS script_posts_script ON script_posts(script_id);

-- A game's channel, created on first publish rather than by hand.
--
-- The slug is derived from the game name the creator typed, the same way the
-- website derives it, so "Blox Fruits" and "blox fruits" land in one channel
-- instead of two. Adding a game to the site is therefore all it takes to get
-- a channel — nobody configures anything.
CREATE TABLE IF NOT EXISTS game_channels (
  game_slug  TEXT PRIMARY KEY,
  game_name  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  at         INTEGER NOT NULL
);

-- The review queue.
--
-- 'approved' is the default so every script that already exists stays visible.
-- 'review' means the checker was not confident: the script is saved, hidden
-- from the public library, and NOT announced, until a human decides. 'rejected'
-- is kept rather than deleted so the moderation log has something to point at.
ALTER TABLE scripts ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
CREATE INDEX IF NOT EXISTS scripts_status ON scripts(status);

-- What the checker thought, kept for the review queue to display.
ALTER TABLE scripts ADD COLUMN check_note TEXT NOT NULL DEFAULT '';

-- The creator's own words, before the AI tidied them.
--
-- Kept because an AI rewrite that drifts from what somebody meant has to be
-- recoverable, and because "show me what I actually typed" is a fair thing for
-- a creator to ask.
ALTER TABLE scripts ADD COLUMN descr_original TEXT NOT NULL DEFAULT '';

-- Executors (staff-published Roblox tools). Run alongside the statements above.
CREATE TABLE IF NOT EXISTS executors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  developer       TEXT NOT NULL,
  logo            TEXT NOT NULL DEFAULT '',
  descr           TEXT NOT NULL,
  descr_original  TEXT NOT NULL DEFAULT '',
  platforms       TEXT NOT NULL DEFAULT '[]',
  roblox_versions TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'working',
  version         TEXT NOT NULL DEFAULT '',
  website         TEXT NOT NULL DEFAULT '',
  discord         TEXT NOT NULL DEFAULT '',
  tags            TEXT NOT NULL DEFAULT '[]',
  screenshots     TEXT NOT NULL DEFAULT '[]',
  removed         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS executors_live ON executors(removed, updated_at);
