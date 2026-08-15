-- Lucrit Script — D1 schema.
--
-- This replaces Firebase Auth and Firestore. Everything the site knows about a
-- person lives here, and the only way in is through the Worker in _worker.js.
-- There is no client SDK talking to the database, so there are no security
-- rules to get wrong: if an endpoint does not exist, the operation cannot
-- happen.
--
-- Apply with:  wrangler d1 execute lucrit --file=schema.sql --remote
-- or paste into the D1 console in the Cloudflare dashboard.

CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL,
  email_lower         TEXT NOT NULL UNIQUE,

  -- The password never reaches this server. The browser stretches it with
  -- PBKDF2 and sends the derived key; we store a fast hash of that key with a
  -- per-user salt. An attacker holding this table still has to pay the full
  -- PBKDF2 cost per guess, and we never learn the password itself.
  -- NULL for accounts that only ever signed in with Google.
  auth_hash           TEXT,
  auth_salt           TEXT,

  -- Google's stable subject id. Set when an account is linked to Google.
  google_sub          TEXT UNIQUE,

  username            TEXT NOT NULL,
  username_lower      TEXT NOT NULL UNIQUE,   -- the whole claim system, in one word
  username_changed_at TEXT,

  bio                 TEXT NOT NULL DEFAULT '',
  avatar              TEXT,
  youtube             TEXT NOT NULL DEFAULT '',
  tiktok              TEXT NOT NULL DEFAULT '',

  created_at          TEXT NOT NULL
);

-- Sessions are opaque random tokens. We store only their hash, so a leak of
-- this table does not hand anybody a working login.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- Password reset tickets. Single use, short lived, stored hashed for the same
-- reason sessions are.
CREATE TABLE IF NOT EXISTS resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);

-- Fixed-window rate limiting. Cloudflare's own binding is better, but this
-- works everywhere and needs no extra configuration.
CREATE TABLE IF NOT EXISTS ratelimits (
  k        TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  expires  INTEGER NOT NULL
);

/* ═══════════════════════════════════════════════════════════════ scripts ══ */

-- Published scripts. This is the whole library — the site ships with none.
--
-- `code` is the reason this table exists. It used to live in a JavaScript
-- array in the browser, which meant the paywall was decoration: anyone could
-- read every script straight out of the page source. Now the code is here, and
-- the only route to it is /api/scripts/:id/code, which asks for a grant first.
-- Nothing that lists scripts is allowed to select this column.
CREATE TABLE IF NOT EXISTS scripts (
  id          TEXT PRIMARY KEY,
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  game        TEXT NOT NULL,
  category    TEXT NOT NULL,
  descr       TEXT NOT NULL,
  code        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',       -- JSON array, at most 6
  keyless     INTEGER NOT NULL DEFAULT 1,
  thumbnail   TEXT NOT NULL DEFAULT '',
  views       INTEGER NOT NULL DEFAULT 0,
  copies      INTEGER NOT NULL DEFAULT 0,       -- completed unlocks
  removed     INTEGER NOT NULL DEFAULT 0,       -- soft delete, so counts survive
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scripts_author ON scripts(author_id);
CREATE INDEX IF NOT EXISTS scripts_live ON scripts(removed, created_at);
CREATE INDEX IF NOT EXISTS scripts_category ON scripts(removed, category);

-- Likes get their own table rather than a counter, so one person cannot like
-- the same script a thousand times.
CREATE TABLE IF NOT EXISTS likes (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script_id  TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL,
  PRIMARY KEY (user_id, script_id)
);
CREATE INDEX IF NOT EXISTS likes_script ON likes(script_id);

-- A completed unlock. Holding one of these is what buys the code.
--
-- `subject` is the session token hash for a signed-in person, or a hash of the
-- IP for a signed-out one — never a raw address. `verified` records whether a
-- sponsor provider actually confirmed the completion, so an unlock granted
-- before the provider is configured is still distinguishable later.
CREATE TABLE IF NOT EXISTS grants (
  subject    TEXT NOT NULL,
  script_id  TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT '',
  verified   INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL,
  expires    INTEGER NOT NULL,
  PRIMARY KEY (subject, script_id)
);
CREATE INDEX IF NOT EXISTS grants_expiry ON grants(expires);

-- Sponsor click ids the provider has told us completed. The claim step looks
-- a click id up here; finding it is the proof.
CREATE TABLE IF NOT EXISTS unlock_clicks (
  click_id   TEXT PRIMARY KEY,
  script_id  TEXT NOT NULL DEFAULT '',
  subject    TEXT NOT NULL DEFAULT '',
  provider   TEXT NOT NULL DEFAULT '',
  done       INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL,
  expires    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS unlock_clicks_expiry ON unlock_clicks(expires);

-- Reports from visitors. Live-instantly publishing needs a way for people to
-- flag what slipped through.
CREATE TABLE IF NOT EXISTS reports (
  id         TEXT PRIMARY KEY,
  script_id  TEXT NOT NULL,
  reporter   TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_script ON reports(script_id);
