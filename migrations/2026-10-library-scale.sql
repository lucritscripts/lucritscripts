-- The homepage now asks the server for one page (20) of scripts at a time,
-- sorted by newest / views / unlocks, instead of downloading the whole library.
-- These keep those queries fast once the site has thousands of scripts.
CREATE INDEX IF NOT EXISTS scripts_live_new    ON scripts(removed, created_at);
CREATE INDEX IF NOT EXISTS scripts_live_views  ON scripts(removed, views);
CREATE INDEX IF NOT EXISTS scripts_live_copies ON scripts(removed, copies);
