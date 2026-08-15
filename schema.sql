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
