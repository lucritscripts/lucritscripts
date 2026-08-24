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

  -- Discord's stable user id (a snowflake). Set when an account signs in with
  -- Discord, and the only thing the members-only gate has to check against.
  -- UNIQUE so one Discord account cannot quietly become two site accounts.
  discord_id          TEXT UNIQUE,

  username            TEXT NOT NULL,
  username_lower      TEXT NOT NULL UNIQUE,   -- the whole claim system, in one word
  username_changed_at TEXT,

  bio                 TEXT NOT NULL DEFAULT '',
  avatar              TEXT,
  youtube             TEXT NOT NULL DEFAULT '',
  tiktok              TEXT NOT NULL DEFAULT '',

  -- Suspended by the site owner. A banned account cannot sign in, its existing
  -- sessions are deleted the moment one is used, and its scripts drop out of
  -- every public listing and board. Nothing is erased — a ban is reversible,
  -- which is the whole reason it exists alongside deletion.
  banned              INTEGER NOT NULL DEFAULT 0,

  created_at          TEXT NOT NULL
);

-- A live /admin session, minted by the passcode and nothing else.
--
-- Deliberately unrelated to `sessions`: signing in to the site is not what
-- opens the admin page, and being the owner of an account is not either. One
-- passcode, one short-lived ticket, revocable on its own.
--
-- The passcode itself is nowhere in this database. The browser stretches it
-- with PBKDF2 and the Worker compares a SHA-256 of the result against
-- ADMIN_PASS_HASH, so what is stored is a verifier, not a password.
CREATE TABLE IF NOT EXISTS admin_gate (
  token_hash TEXT PRIMARY KEY,
  expires    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_gate_expiry ON admin_gate(expires);

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

-- A small key/value cache with expiry.
--
-- Exists because Discord rate-limits per bot rather than per visitor: a member
-- check on every code fetch would start refusing everybody at once during a
-- busy hour. The values here are all cheap to recompute and stale-tolerant —
-- a member count, whether somebody is in the server — so a miss costs one
-- outbound request and nothing else.
CREATE TABLE IF NOT EXISTS cache (
  k        TEXT PRIMARY KEY,
  v        TEXT NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cache_expiry ON cache(expires);

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

  -- The review queue. 'approved' is the default so anything published before
  -- the checker existed stays visible. 'review' means the checker was not
  -- confident: saved, hidden from the library, not announced, waiting on a
  -- human. 'rejected' is kept rather than deleted so a moderation log has
  -- something to point at.
  status      TEXT NOT NULL DEFAULT 'approved',
  check_note  TEXT NOT NULL DEFAULT '',

  -- The creator's own words, before the AI tidied them. An AI rewrite that
  -- drifts from what somebody meant has to be recoverable.
  descr_original TEXT NOT NULL DEFAULT '',

  -- Where a visitor gets the script when the publisher hosts it themselves.
  -- Gated exactly like `code`: a public link beside a paywalled code field
  -- would be a hole straight through the paywall.
  link        TEXT    NOT NULL DEFAULT '',

  -- The site's own review verdict. Never derived from submitted content — the
  -- moment it can be, a publisher can arrange to satisfy it. Admin sets it.
  verified    INTEGER NOT NULL DEFAULT 0,

  -- Whether the server detected Luau syntax in the submitted code at publish
  -- time. A DIFFERENT claim from `verified`, and the UI must never merge them:
  -- this one says "this looks like code", not "we checked it".
  lua         INTEGER NOT NULL DEFAULT 0,

  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scripts_status ON scripts(status);
CREATE INDEX IF NOT EXISTS scripts_author ON scripts(author_id);
CREATE INDEX IF NOT EXISTS scripts_live ON scripts(removed, created_at);
CREATE INDEX IF NOT EXISTS scripts_category ON scripts(removed, category);

-- Which Discord messages represent a script.
--
-- This table is the whole reason a script can be edited or deleted in Discord
-- later. Without it, publishing is fire-and-forget: the moment a message is
-- sent the site forgets which message it was, and a script taken down here
-- keeps a live "Get Script" button in the server forever.
CREATE TABLE IF NOT EXISTS script_posts (
  script_id  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'game',
  at         INTEGER NOT NULL,
  PRIMARY KEY (script_id, channel_id)
);
CREATE INDEX IF NOT EXISTS script_posts_script ON script_posts(script_id);

-- A game's Discord channel, created on first publish rather than by hand.
-- Feed channels (#all-scripts, #moderation-logs) are stored under a "~"
-- prefix so a game can never collide with one.
CREATE TABLE IF NOT EXISTS game_channels (
  game_slug  TEXT PRIMARY KEY,
  game_name  TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  at         INTEGER NOT NULL
);

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

-- Executors: Roblox tools, published by STAFF ONLY.
--
-- Deliberately its own table rather than a flag on `scripts`. The two have
-- almost nothing in common — an executor has a version, a platform, a status
-- and a download link, and no code, no unlock and no author account. Sharing a
-- table would have meant a dozen nullable columns and a permission check
-- threaded through every query that touches scripts.
--
-- Publishing is gated on the /admin passcode ticket, not on being signed in.
-- No creator account can reach it by any path the site offers.
CREATE TABLE IF NOT EXISTS executors (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  developer       TEXT NOT NULL,
  logo            TEXT NOT NULL DEFAULT '',
  descr           TEXT NOT NULL,
  descr_original  TEXT NOT NULL DEFAULT '',   -- before the AI tidied it
  platforms       TEXT NOT NULL DEFAULT '[]', -- JSON array
  roblox_versions TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'working',  -- working | updating | unavailable
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

-- Every completed unlock, appended, one row each.
--
-- This is the payout ledger, and it exists because `grants` cannot be one.
-- A grant is keyed (subject, script_id) and upserted, so the same person
-- unlocking the same script a second time UPDATES the row rather than adding
-- one — correct for "may this person read the code", useless for "how many
-- unlocks did this author earn". Counting grants would quietly undercount.
--
-- author_id is denormalised on purpose: earnings must still be attributable
-- after a script is deleted, and a soft-deleted script should not erase the
-- history of what it earned.
CREATE TABLE IF NOT EXISTS unlock_events (
  id         TEXT PRIMARY KEY,
  script_id  TEXT NOT NULL,
  author_id  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  provider   TEXT NOT NULL DEFAULT '',
  verified   INTEGER NOT NULL DEFAULT 0,   -- 1 only when a provider confirmed it
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS unlock_events_author ON unlock_events(author_id, at);
CREATE INDEX IF NOT EXISTS unlock_events_script ON unlock_events(script_id);
