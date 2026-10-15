-- Staff labels, staff note and the admin activity log (15 Oct 2026).
--
-- You do NOT need to run this by hand: the Worker adds these on the first
-- admin request that needs them (ensureAdminSchema in _worker.js). It is kept
-- here as the record of what changed, and for a fresh database.
ALTER TABLE scripts ADD COLUMN labels     TEXT NOT NULL DEFAULT '[]';
ALTER TABLE scripts ADD COLUMN admin_note TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS admin_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
