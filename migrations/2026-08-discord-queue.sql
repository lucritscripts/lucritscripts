-- Discord events that failed, so they can be retried instead of lost.
--
-- Before this, `bot()` returned null on any failure and the caller simply
-- missed that one. A Discord outage, a rate limit, or a token hiccup during a
-- publish meant the script went live on the website and never appeared in the
-- server, with nothing anywhere recording that it should have.
--
-- The retry is REQUEST-DRIVEN, not scheduled, and that is a platform
-- constraint rather than a preference: Cloudflare Pages does not support Cron
-- Triggers, so there is no timer to hang a background job on. Instead the
-- queue is drained inside `ctx.waitUntil` on ordinary requests, which on a
-- live site means "within seconds" and on a dead one means "when someone next
-- visits" — the same moment anybody would have noticed anyway.
CREATE TABLE IF NOT EXISTS discord_queue (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What to do, and to what. `kind` is the operation ('publish', 'sync',
  -- 'retire'); `script_id` is the subject. Together they are enough to rebuild
  -- the call from current data rather than from a stale snapshot — which is
  -- deliberate: a retry an hour later should post what the script says NOW.
  kind       TEXT    NOT NULL,
  script_id  TEXT    NOT NULL,

  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT    NOT NULL DEFAULT '',
  next_try   INTEGER NOT NULL DEFAULT 0,     -- unix seconds; backoff
  created_at INTEGER NOT NULL
);

-- One pending row per script per operation. A publish that fails, gets
-- retried, and fails again must not stack up three rows that later post three
-- messages.
CREATE UNIQUE INDEX IF NOT EXISTS discord_queue_one ON discord_queue(kind, script_id);
CREATE INDEX IF NOT EXISTS discord_queue_due ON discord_queue(next_try);
