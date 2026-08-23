/**
 * Lucrit Script — the whole backend, on Cloudflare.
 *
 * This is a Pages "advanced mode" worker: every request to the site lands here
 * first. Anything under /api/ is handled below; everything else is handed to
 * env.ASSETS, which serves the static site. Site and API therefore share one
 * origin, which is what makes httpOnly session cookies possible and removes
 * CORS entirely.
 *
 * What it replaces:
 *   Firebase Auth       -> /api/auth/* with sessions in D1
 *   Firestore users     -> the `users` table
 *   Firestore usernames -> a UNIQUE column, which the database enforces for us
 *   Security rules      -> this file being the only way in
 *   App Check           -> Turnstile
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ABOUT PASSWORDS — read this before changing anything in the auth section.
 *
 * The Workers free plan allows 10ms of CPU per request. A password hash worth
 * having (PBKDF2 at hundreds of thousands of iterations, or Argon2) costs far
 * more than that, so hashing on the server is not an option here.
 *
 * So the browser does the expensive part. It derives
 *
 *     authKey = PBKDF2-SHA256(password, salt, 310000)
 *
 * where the salt is derived from the email address, and sends authKey instead
 * of the password. The server then stores a plain SHA-256 of authKey with a
 * random per-user salt, which costs microseconds.
 *
 * This is not a shortcut. The work an attacker must do per guess is identical
 * — they still have to run PBKDF2 310,000 times for every candidate password,
 * because that is what turns a password into an authKey. What changes is only
 * who pays for it during normal use. Two useful side effects: the server never
 * sees the password at all, and the login salt is derived from the email
 * rather than looked up, so asking for it cannot reveal whether an account
 * exists.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Bindings expected:
 *   DB                 D1 database
 *   AI                 Workers AI
 *   TURNSTILE_SECRET   secret — Turnstile server key
 *   RESEND_API_KEY     secret — for password reset email (optional)
 *   GOOGLE_CLIENT_ID   plain var — public by design
 *   SITE_URL           plain var — used in reset links
 *   MAIL_FROM          plain var — the From: address for reset email
 *   LOOTLABS_TOKEN     secret — sponsor unlocks (optional; see the unlock section)
 *   ADMIN_USER_ID      plain var — the one account that can remove any script
 *   DISCORD_*          see the discord section (all optional, all off by default)
 */

/* ══════════════════════════════════════════════════════════ small helpers ══ */

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });

const ok = (data = {}) => json(200, { ok: true, ...data });
/** `extra` carries diagnostic detail — never anything secret. */
const bad = (status, error, extra) =>
  json(status, extra ? { ok: false, error, ...extra } : { ok: false, error });

const enc = new TextEncoder();

const toHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

const randomHex = (bytes = 32) =>
  toHex(crypto.getRandomValues(new Uint8Array(bytes)));

/** Comparison that does not leak where two strings first differ. */
function sameSecret(a, b) {
  const x = String(a ?? ""), y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/* ═══════════════════════════════════════════════════════════════ validation ══ */

const RULES = {
  username: /^[\p{L}\p{N} _.-]{1,32}$/u,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
};

const USERNAME_COOLDOWN_DAYS = 7;

/** authKey is 32 bytes of PBKDF2 output, hex encoded. Anything else is a bug or an attack. */
const AUTH_KEY = /^[0-9a-f]{64}$/;

function checkUsername(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "Pick a username.";
  if (trimmed.length > 32) return "Username can be at most 32 characters.";
  if (!RULES.username.test(trimmed))
    return "Username can use letters, numbers, spaces, dots, dashes and underscores.";
  return null;
}

/** Social links are shown on world-readable profiles, so they are pinned to a host. */
function safeSocial(value, hosts) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); }
  catch { return ""; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hosts.some((h) => host === h || host.endsWith("." + h))) return "";
  url.protocol = "https:";
  url.username = ""; url.password = "";
  return url.toString();
}

/* ══════════════════════════════════════════════════════════════ rate limits ══ */

/**
 * Fixed window, one row per (key, minute). Fails open: a database hiccup must
 * not lock everybody out of their own accounts.
 */
async function underLimit(env, key, limit, windowSec = 60) {
  const bucket = Math.floor(nowSec() / windowSec);
  const k = `${key}:${bucket}`;
  try {
    await env.DB.prepare(
      `INSERT INTO ratelimits (k, count, expires) VALUES (?, 1, ?)
       ON CONFLICT(k) DO UPDATE SET count = count + 1`
    ).bind(k, nowSec() + windowSec * 3).run();

    const row = await env.DB.prepare(`SELECT count FROM ratelimits WHERE k = ?`).bind(k).first();
    return (row?.count ?? 0) <= limit;
  } catch (err) {
    console.warn("rate limit unavailable", err?.message);
    return true;
  }
}

const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "unknown";

/* ═══════════════════════════════════════════════════════════════ sessions ══ */

const SESSION_COOKIE = "__Host-lucrit";
const SESSION_DAYS = 30;

// The second key to /admin. Short-lived by design: the passcode is meant to be
// typed again after a break, not once a month.
const ADMIN_COOKIE = "__Host-lucrit-admin";
const ADMIN_GATE_MINUTES = 30;

// Public on purpose — the browser has to stretch with the same parameters the
// stored verifier was built from. A salt only has to be unique.
const ADMIN_PASS_SALT = "lucrit-admin-v1";
const ADMIN_PASS_ITERATIONS = 310000;

function cookieHeader(token, maxAgeSec, name = SESSION_COOKIE) {
  const parts = [
    `${name}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  return parts.join("; ");
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

async function startSession(env, userId) {
  const token = randomHex(32);
  const hash = await sha256Hex(token);
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(hash, userId, now, now + SESSION_DAYS * 86400).run();
  return token;
}

async function endSession(env, token) {
  if (!token) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`)
    .bind(await sha256Hex(token)).run();
}

/** The signed-in user, or null. Expired rows are swept as they are found. */
async function currentUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.*, s.expires_at AS session_expires
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(hash).first();

  if (!row) return null;
  if (row.session_expires <= nowSec()) {
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(hash).run();
    return null;
  }

  // A banned account is signed out everywhere, immediately — not just refused
  // at the next sign-in. Their existing sessions are deleted rather than
  // ignored, so nothing is left to reactivate if the ban is lifted by hand.
  if (row.banned) {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.id).run();
    return null;
  }
  return row;
}

/** The shape the site's UI already expects. Note there is no email in here. */
/**
 * Whether this account runs the site.
 *
 * One id in an environment variable, compared exactly. Deliberately not a
 * column: an admin flag in the users table is one SQL injection or one
 * mistaken UPDATE away from somebody promoting themselves, and there is
 * exactly one operator here. With ADMIN_USER_ID unset nobody is an admin and
 * every admin route answers 403 — the safe default.
 */
function isAdmin(env, user) {
  return Boolean(env.ADMIN_USER_ID && user && user.id === env.ADMIN_USER_ID);
}

function publicSession(row, env) {
  if (!row) return null;
  return {
    admin: isAdmin(env, row),
    id: row.id,
    email: row.email,
    username: row.username,
    bio: row.bio || "",
    avatar: row.avatar || null,
    youtube: row.youtube || "",
    tiktok: row.tiktok || "",
    createdAt: row.created_at,
    usernameChangedAt: row.username_changed_at || null,
    // Whether this account is linked to Discord — not which account, which is
    // nobody else's business and not needed by anything on the page.
    discord: Boolean(row.discord_id),
    publishes: [],
    remote: true,
  };
}

/* ══════════════════════════════════════════════════════════════ turnstile ══ */

/**
 * Verifies the human check. Fails OPEN when no secret is configured, so the
 * site keeps working before Turnstile is set up; once the secret exists, a
 * missing or bad token is refused.
 */
async function humanOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const body = new FormData();
    body.append("secret", env.TURNSTILE_SECRET);
    body.append("response", token);
    if (ip && ip !== "unknown") body.append("remoteip", ip);

    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body,
    });
    const data = await res.json();
    return Boolean(data.success);
  } catch (err) {
    console.warn("turnstile unreachable", err?.message);
    return true;   // never lock real people out because Cloudflare blinked
  }
}

/**
 * The first-visit gate asks here before letting anyone in.
 *
 * The point of routing it through the server is that the verdict stops being
 * something the browser can simply assert. The client still records a local
 * note so returning visitors aren't asked again — that note is a convenience,
 * not the check, and forging it only skips a challenge this endpoint would
 * have passed anyway.
 *
 * Like everywhere else, this fails open with no secret configured.
 */
async function handleHuman(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `human:${ip}`, 30, 600)))
    return bad(429, "Too many checks from this connection. Try again shortly.");

  const { turnstile } = await request.json().catch(() => ({}));
  if (!(await humanOk(env, turnstile, ip)))
    return bad(400, "That check didn't pass. Please try again.");

  return ok({ data: { human: true } });
}

/* ═════════════════════════════════════════════════════════════════ google ══ */

/**
 * Verifies a Google Identity Services ID token.
 *
 * We use the browser-issued credential rather than an OAuth code exchange
 * specifically so there is no client secret anywhere in this system — only the
 * public client id. Verification is a signature check against Google's
 * published keys, which is cheap enough for the CPU budget.
 */
let jwksCache = { at: 0, keys: null };

async function googleKeys() {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const res = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!res.ok) throw new Error("Could not reach Google.");
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys };
  return keys;
}

const b64urlToBytes = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function verifyGoogleToken(credential, clientId) {
  const [headerB64, payloadB64, sigB64] = String(credential || "").split(".");
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error("That Google sign-in looked wrong.");

  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64)));

  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("That Google sign-in could not be verified.");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sigB64), enc.encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error("That Google sign-in could not be verified.");

  if (payload.aud !== clientId) throw new Error("That sign-in was issued for a different site.");
  if (!/^(https:\/\/)?accounts\.google\.com$/.test(String(payload.iss)))
    throw new Error("That sign-in did not come from Google.");
  if (Number(payload.exp) <= nowSec()) throw new Error("That sign-in expired. Try again.");
  if (!payload.email) throw new Error("Google did not share an email address.");

  return payload;
}

/* ══════════════════════════════════════════════════════════════════ email ══ */

/** Sends the reset mail through Resend. Absent key means the feature is off. */
async function sendResetEmail(env, to, link) {
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.MAIL_FROM || "Lucrit Script <onboarding@resend.dev>",
      to: [to],
      subject: "Reset your Lucrit Script password",
      text: `Someone asked to reset the password for this Lucrit Script account.

Open this link to choose a new one. It works once and expires in an hour:

${link}

If it wasn't you, ignore this — nothing has changed.`,
    }),
  });
  if (!res.ok) {
    console.warn("resend rejected the email", res.status, (await res.text()).slice(0, 200));
    return false;
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════════════ users ══ */

const newId = () => "u_" + randomHex(8);

/** Turns whatever Google calls someone into a username this site accepts. */
function seedUsername(payload) {
  const raw = payload.name || String(payload.email).split("@")[0] || "player";
  const clean = raw.replace(/[^\p{L}\p{N} _.-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 28);
  return clean || "player";
}

/** Finds a free username near the one asked for. */
async function freeUsername(env, base) {
  for (let i = 0; i < 25; i += 1) {
    const candidate = i === 0 ? base : `${base.slice(0, 28)}${i + 1}`;
    const taken = await env.DB.prepare(`SELECT 1 FROM users WHERE username_lower = ?`)
      .bind(candidate.toLowerCase()).first();
    if (!taken) return candidate;
  }
  return `${base.slice(0, 22)}${randomHex(3)}`;
}

/* ════════════════════════════════════════════════════════════════ handlers ══ */

/**
 * The per-account salt the browser needs before it can derive an authKey.
 *
 * Derived from the email rather than stored, so the answer is identical for
 * addresses that have an account and addresses that do not. Asking this
 * question tells an attacker nothing.
 */
async function handleSalt(request, env) {
  const { email } = await request.json().catch(() => ({}));
  if (!RULES.email.test(String(email || "")))
    return bad(400, "That email address doesn't look right.");
  return ok({ salt: await sha256Hex("lucrit:v1:" + String(email).trim().toLowerCase()) });
}

async function handleSignUp(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `signup:${ip}`, 5, 600)))
    return bad(429, "Too many attempts. Wait a few minutes.");

  const { username, email, authKey, turnstile } = await request.json().catch(() => ({}));

  const nameProblem = checkUsername(username);
  if (nameProblem) return bad(400, nameProblem);
  if (!RULES.email.test(String(email || "")))
    return bad(400, "That email address doesn't look right.");
  if (!AUTH_KEY.test(String(authKey || "")))
    return bad(400, "Something went wrong securing your password. Reload and try again.");
  if (!(await humanOk(env, turnstile, ip)))
    return bad(400, "Please complete the human check.");

  const name = String(username).trim();
  const mail = String(email).trim();
  const salt = randomHex(16);
  const hash = await sha256Hex(salt + ":" + authKey);
  const id = newId();

  try {
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_lower, auth_hash, auth_salt, username,
                          username_lower, bio, youtube, tiktok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '', ?)`
    ).bind(id, mail, mail.toLowerCase(), hash, salt, name, name.toLowerCase(),
           new Date().toISOString()).run();
  } catch (err) {
    const msg = String(err?.message || "");
    // The database decides who owns a name, not a read-then-write race.
    if (/username_lower/.test(msg)) return bad(409, "That username is already taken.");
    if (/email_lower/.test(msg)) return bad(409, "An account already exists for that email.");
    console.error("signup failed", msg);
    return bad(500, "Couldn't create that account. Try again.");
  }

  const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  const token = await startSession(env, id);
  return json(200, { ok: true, data: publicSession(row, env) },
    { "Set-Cookie": cookieHeader(token, SESSION_DAYS * 86400) });
}

async function handleSignIn(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `signin:${ip}`, 10, 600)))
    return bad(429, "Too many attempts. Wait a few minutes.");

  const { email, authKey } = await request.json().catch(() => ({}));
  const wrong = "Email or password is incorrect.";   // same answer either way

  if (!RULES.email.test(String(email || "")) || !AUTH_KEY.test(String(authKey || "")))
    return bad(400, wrong);

  const row = await env.DB.prepare(`SELECT * FROM users WHERE email_lower = ?`)
    .bind(String(email).trim().toLowerCase()).first();
  if (!row || !row.auth_hash) return bad(400, wrong);

  const expect = await sha256Hex(row.auth_salt + ":" + authKey);
  if (!sameSecret(expect, row.auth_hash)) return bad(400, wrong);

  // Checked AFTER the password, on purpose. Answering "this account is banned"
  // to any password would turn the sign-in form into a way to find out which
  // emails are registered.
  if (row.banned) return bad(403, "This account has been suspended.");

  const token = await startSession(env, row.id);
  return json(200, { ok: true, data: publicSession(row, env) },
    { "Set-Cookie": cookieHeader(token, SESSION_DAYS * 86400) });
}

async function handleGoogle(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return bad(503, "Google sign-in isn't configured yet.");

  const { credential } = await request.json().catch(() => ({}));
  let payload;
  try { payload = await verifyGoogleToken(credential, env.GOOGLE_CLIENT_ID); }
  catch (err) { return bad(400, err.message); }

  const mail = String(payload.email).trim();
  const lower = mail.toLowerCase();

  // Match on Google's subject first, then fall back to the email so that
  // signing up with a password and later using Google lands on one account
  // rather than two.
  let row = await env.DB.prepare(`SELECT * FROM users WHERE google_sub = ?`)
    .bind(payload.sub).first();

  if (!row) {
    row = await env.DB.prepare(`SELECT * FROM users WHERE email_lower = ?`).bind(lower).first();
    if (row) {
      await env.DB.prepare(`UPDATE users SET google_sub = ? WHERE id = ?`)
        .bind(payload.sub, row.id).run();
    }
  }

  if (!row) {
    const name = await freeUsername(env, seedUsername(payload));
    const id = newId();
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, email, email_lower, google_sub, username, username_lower,
                            bio, avatar, youtube, tiktok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, '', '', ?)`
      ).bind(id, mail, lower, payload.sub, name, name.toLowerCase(),
             payload.picture || null, new Date().toISOString()).run();
    } catch (err) {
      console.error("google signup failed", err?.message);
      return bad(500, "Couldn't finish setting up that account. Try again.");
    }
    row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  }

  // Google proves who they are, not that they are welcome.
  if (row.banned) return bad(403, "This account has been suspended.");

  const token = await startSession(env, row.id);
  return json(200, { ok: true, data: publicSession(row, env) },
    { "Set-Cookie": cookieHeader(token, SESSION_DAYS * 86400) });
}

async function handleSignOut(request, env) {
  await endSession(env, readCookie(request, SESSION_COOKIE));
  return json(200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
}

async function handleSession(request, env) {
  const row = await currentUser(request, env);
  return ok({ data: publicSession(row, env) });
}

async function handleUsername(request, env) {
  const me = await currentUser(request, env);
  if (!me) return bad(401, "You need to be signed in.");

  const { username } = await request.json().catch(() => ({}));
  const problem = checkUsername(username);
  if (problem) return bad(400, problem);

  if (me.username_changed_at) {
    const elapsed = Date.now() - new Date(me.username_changed_at).getTime();
    const left = USERNAME_COOLDOWN_DAYS - elapsed / 86400000;
    if (left > 0) {
      const days = Math.ceil(left);
      return bad(429, `You can change your username again in ${days} day${days === 1 ? "" : "s"}.`);
    }
  }

  const name = String(username).trim();
  const changedAt = new Date().toISOString();
  try {
    await env.DB.prepare(
      `UPDATE users SET username = ?, username_lower = ?, username_changed_at = ? WHERE id = ?`
    ).bind(name, name.toLowerCase(), changedAt, me.id).run();
  } catch (err) {
    if (/username_lower/.test(String(err?.message))) return bad(409, "That username is already taken.");
    throw err;
  }

  const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(me.id).first();
  return ok({ data: publicSession(row, env) });
}

async function handleProfile(request, env) {
  const me = await currentUser(request, env);
  if (!me) return bad(401, "You need to be signed in.");

  const patch = await request.json().catch(() => ({}));
  const bio = patch.bio === undefined ? me.bio : String(patch.bio).slice(0, 300);
  const avatar = patch.avatar === undefined ? me.avatar : patch.avatar;
  const youtube = patch.youtube === undefined ? me.youtube
    : safeSocial(patch.youtube, ["youtube.com", "youtu.be"]);
  const tiktok = patch.tiktok === undefined ? me.tiktok
    : safeSocial(patch.tiktok, ["tiktok.com"]);

  await env.DB.prepare(
    `UPDATE users SET bio = ?, avatar = ?, youtube = ?, tiktok = ? WHERE id = ?`
  ).bind(bio, avatar, youtube, tiktok, me.id).run();

  const row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(me.id).first();
  return ok({ data: publicSession(row, env) });
}

async function handlePassword(request, env) {
  const me = await currentUser(request, env);
  if (!me) return bad(401, "You need to be signed in.");

  const { currentAuthKey, nextAuthKey } = await request.json().catch(() => ({}));
  if (!AUTH_KEY.test(String(nextAuthKey || "")))
    return bad(400, "Something went wrong securing your new password. Reload and try again.");

  // Google-only accounts have no password to prove; they are setting one.
  if (me.auth_hash) {
    if (!AUTH_KEY.test(String(currentAuthKey || "")))
      return bad(400, "Current password is incorrect.");
    const expect = await sha256Hex(me.auth_salt + ":" + currentAuthKey);
    if (!sameSecret(expect, me.auth_hash)) return bad(400, "Current password is incorrect.");
  }

  const salt = randomHex(16);
  const hash = await sha256Hex(salt + ":" + nextAuthKey);
  await env.DB.prepare(`UPDATE users SET auth_hash = ?, auth_salt = ? WHERE id = ?`)
    .bind(hash, salt, me.id).run();

  // Changing a password ends every other session — that is the point of doing it.
  const keep = await sha256Hex(readCookie(request, SESSION_COOKIE) || "");
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash != ?`)
    .bind(me.id, keep).run();

  return ok();
}

async function handleResetRequest(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `reset:${ip}`, 5, 900)))
    return bad(429, "Too many attempts. Wait a few minutes.");

  const { email } = await request.json().catch(() => ({}));
  if (!RULES.email.test(String(email || "")))
    return bad(400, "That email address doesn't look right.");

  const row = await env.DB.prepare(`SELECT * FROM users WHERE email_lower = ?`)
    .bind(String(email).trim().toLowerCase()).first();

  // Always the same answer, whether or not that account exists.
  const pretend = ok({ data: { pending: true } });
  if (!row) return pretend;

  const token = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO resets (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)`
  ).bind(await sha256Hex(token), row.id, nowSec() + 3600).run();

  const base = env.SITE_URL || new URL(request.url).origin;
  const sent = await sendResetEmail(env, row.email, `${base}/#reset=${token}`);
  if (!sent) {
    return ok({ data: { pending: true },
      note: "Reset email isn't switched on yet — add a RESEND_API_KEY to enable it." });
  }
  return pretend;
}

async function handleResetConfirm(request, env) {
  const { token, authKey } = await request.json().catch(() => ({}));
  if (!AUTH_KEY.test(String(authKey || "")))
    return bad(400, "Something went wrong securing your new password. Reload and try again.");

  const row = await env.DB.prepare(
    `SELECT * FROM resets WHERE token_hash = ?`
  ).bind(await sha256Hex(String(token || ""))).first();

  if (!row || row.used || row.expires_at <= nowSec())
    return bad(400, "That reset link has expired. Ask for a new one.");

  const salt = randomHex(16);
  const hash = await sha256Hex(salt + ":" + authKey);

  await env.DB.batch([
    env.DB.prepare(`UPDATE users SET auth_hash = ?, auth_salt = ? WHERE id = ?`)
      .bind(hash, salt, row.user_id),
    env.DB.prepare(`UPDATE resets SET used = 1 WHERE token_hash = ?`).bind(row.token_hash),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(row.user_id),
  ]);

  return ok();
}

/* ══════════════════════════════════════════════════════════════════════ AI ══ */

const CF_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
];
const MAX_TOKENS = 4000;
const MAX_QUESTION = 14000;
const MAX_HISTORY = 12;

const SYSTEM_PROMPT = `You are the Lucrit Script assistant, built into a Roblox
script library. You help people write Luau.

EVERYTHING YOU WRITE IS A LOCALSCRIPT. Client-side, every time. This is not a
preference to weigh against others — it is the one format this library ships,
and it holds even when the task fights it:

- Say where it goes in the first comment: StarterPlayerScripts, or
  StarterCharacterScripts when it needs the character, or StarterGui when it
  owns a UI.
- Use the client's own surface confidently: Players.LocalPlayer, PlayerGui,
  the Camera, UserInputService, ContextActionService, RunService.RenderStepped
  and .Heartbeat, TweenService, reads from ReplicatedStorage.
- When a job would normally live on the server — DataStores, granting
  currency, anything authoritative — still write the LocalScript. Fire a
  RemoteEvent or call a RemoteFunction for that one step, and add a single
  comment line naming the remote it expects. Never switch to a server Script,
  never split the answer into two files, and never refuse on these grounds.
- Never call a service the client cannot reach. DataStoreService,
  ServerStorage, ServerScriptService, MessagingService, :SetAsync, :GetAsync
  and Player:Kick all throw from a LocalScript, so a script using them is
  broken no matter how good it looks. Route those through a remote instead.
- If a request truly has no client-side form at all, write the closest
  LocalScript that does work and say in one line what the server still has to
  provide. Keep going; do not stop at the obstacle.

This is a conversation, not a series of unrelated requests. When someone
follows up, they are almost always talking about the script you just wrote:

- Change that script. Do not start a different one, and do not go back to an
  earlier version they have moved on from.
- Return the COMPLETE updated script every time, not a diff, not a fragment,
  not "...rest unchanged". They paste the whole thing into Roblox.
- Keep everything they did not ask you to change — variable names, comments,
  settings, the placement comment. A follow-up is an edit, not a rewrite.
- A revision is still a LocalScript. Every rule above still applies.
- If they ask a plain question about the script, answer it in a sentence or
  two and only re-send the code if it changed.

How to answer:
- Lead with working code. A short sentence of context, then the script.
- Write modern Luau: type annotations where they help, task.wait over wait,
  :Connect stored so it can be disconnected, no deprecated API.
- Prefer a complete, ambitious script over a minimal one. Handle the edge
  cases a real game hits: the character respawning, the player leaving, the
  GUI already existing, a connection needing cleanup.
- If the request is vague, write the most useful version you can and note the
  one assumption you made. Do not interrogate the person first.
- Be brief between code blocks. No filler, no restating the question.

Never claim to know a specific script, author, or statistic on this site; you
cannot see the library. Point people at the search box for that.`;

function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
}

/**
 * Both Workers AI and every OpenAI-compatible provider stream Server-Sent
 * Events, but they disagree about where the text sits in each frame. This
 * unwraps either shape and emits plain text, which is all the browser wants.
 */
function sseToText(upstream) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      // Keep reading until there is actually something to emit, or the upstream
      // ends. Frames that carry no text must not leave the consumer waiting on
      // a pull that never comes — that reads as the reply freezing.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let emitted = false;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const frame = JSON.parse(data);
            let text = frame.response ?? frame.choices?.[0]?.delta?.content;
            // Occasionally a token arrives already parsed rather than as a
            // string: a model emitting `{}` comes back as an empty object.
            // Encoding that directly writes "[object Object]" into somebody's
            // script, so put it back first.
            if (text != null && typeof text !== "string") {
              try { text = JSON.stringify(text); } catch { text = null; }
            }
            if (typeof text === "string" && text) {
              controller.enqueue(encoder.encode(text));
              emitted = true;
            }
          } catch { /* a partial frame — the next chunk completes it */ }
        }
        if (emitted) return;
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
}

async function handleAI(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `ai:${ip}`, 12, 60)))
    return bad(429, "You're asking faster than I can answer — give it a few seconds.");

  const body = await request.json().catch(() => null);
  const question = String(body?.question || "").trim();
  if (!question) return bad(400, "Ask me something.");
  if (question.length > MAX_QUESTION)
    return bad(413, "That's too long — trim it to the part you need help with.");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...cleanHistory(body?.history),
    { role: "user", content: question },
  ];

  const models = env.AI_MODEL ? [env.AI_MODEL] : CF_MODELS;
  let stream = null, lastErr;
  for (const model of models) {
    try {
      stream = await env.AI.run(model, {
        messages, stream: true, max_tokens: MAX_TOKENS, temperature: 0.3,
      });
      if (stream) break;
    } catch (err) {
      console.warn("model unavailable", model, err?.message);
      lastErr = err;
    }
  }

  if (!stream) {
    const message = /neuron|quota|limit|capacity/i.test(String(lastErr?.message))
      ? "The AI has hit today's free limit. It resets tomorrow."
      : "Couldn't reach the model. Try again in a moment.";
    return bad(502, message);
  }

  return new Response(sseToText(stream), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/* ══════════════════════════════════════════════════════════════════ scripts ══ */

/**
 * The library.
 *
 * The rule this whole section exists to enforce: `code` leaves the database
 * through exactly one door, handleScriptCode, and that door asks for a grant.
 * Every other query names its columns explicitly rather than using SELECT *,
 * so adding a listing endpoint later cannot leak the code by accident.
 */
const SCRIPT_COLUMNS = `s.id, s.author_id, s.title, s.game, s.category, s.descr,
  s.tags, s.keyless, s.thumbnail, s.views, s.copies, s.removed, s.created_at,
  u.username AS author`;

const SCRIPT_LIMITS = { title: 70, game: 90, descr: 6000, code: 200000, tag: 24 };
const MIN_DESC_WORDS = 100;
/**
 * How long an unlock lasts before the sponsor step has to be repeated.
 *
 * Short on purpose: the grant is the thing being sold, so a long one means one
 * completed step pays for unlimited returns. Five minutes is enough to copy the
 * script and paste it, and not much more.
 *
 * Note this does NOT re-lock code someone already copied — nothing can. What it
 * limits is how long the door stays open on this server.
 */
const GRANT_MINUTES_DEFAULT = 5;
const grantMinutes = (env) => clampInt(env.UNLOCK_MINUTES, 1, 10080, GRANT_MINUTES_DEFAULT);

/** The row shape the site's cards and script page already expect. */
function publicScript(row, extra = {}) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags || "[]"); } catch { tags = []; }
  return {
    id: row.id,
    // The half of the id that shows up in a URL.
    //
    // Script ids are `s_<8 hex>`; the prefix is a database convention and says
    // nothing to a person reading an address bar. The slug is what
    // /creations/<creator>/<slug> carries, and it comes from here rather than
    // being sliced off the id in the browser, so the shape of an id stays the
    // server's business.
    slug: String(row.id).replace(/^s_/, ""),
    title: row.title,
    game: row.game,
    category: row.category,
    desc: row.descr,
    tags: Array.isArray(tags) ? tags : [],
    keyless: Boolean(row.keyless),
    thumbnail: row.thumbnail || "",
    author: row.author || "",
    authorId: row.author_id,
    views: row.views || 0,
    copies: row.copies || 0,
    likes: row.likes || 0,
    added: String(row.created_at || "").slice(0, 10),
    // Deliberately absent: code. The listing must never carry it.
    ...extra,
  };
}

/**
 * Who a grant belongs to.
 *
 * Signed in, it is tied to the session so it follows you between devices as
 * long as you stay signed in. Signed out, there is nothing to tie it to but
 * the connection, so it is a hash of the IP — hashed because a raw address in
 * a table we query by is more personal data than this feature needs.
 */
async function grantSubject(request, env, user) {
  if (user) return "u:" + user.id;
  return "a:" + (await sha256Hex("grant-subject:" + clientIp(request)));
}

/**
 * Whether a grant row may actually open the code.
 *
 * Expiry is handled by the query that fetched it. This is the other half:
 * `verified = 0` means the unlock happened while no sponsor step existed, so
 * nobody was paid for it. Those rows were written freely during the free era
 * and outlived it — one of them was still serving code to a signed-out
 * visitor after LootLabs went live. Once a provider is configured they stop
 * counting and the gate comes back.
 *
 * Both the listing flag and the code endpoint go through here, so the page
 * cannot show "unlocked" while the code request answers 403.
 */
function grantOpens(env, grant) {
  if (!grant) return false;
  return Boolean(grant.verified) || unlockProviders(env).length === 0;
}

async function handleScriptList(request, env) {
  const url = new URL(request.url);
  const category = String(url.searchParams.get("category") || "").slice(0, 40);
  const author = String(url.searchParams.get("author") || "").slice(0, 40);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 200));

  // A suspended account's scripts come off the site with them. Leaving them up
  // would make a ban cosmetic — the work stays, and keeps earning.
  // `status` keeps held submissions out of the library while a human decides.
  // Rows written before the review queue existed default to 'approved', so
  // nothing that was already published disappears.
  const where = ["s.removed = 0", "u.banned = 0", "s.status = 'approved'"];
  const binds = [];
  if (category) { where.push("s.category = ?"); binds.push(category); }
  if (author) { where.push("s.author_id = ?"); binds.push(author); }

  const { results } = await env.DB.prepare(
    `SELECT ${SCRIPT_COLUMNS},
            (SELECT COUNT(*) FROM likes l WHERE l.script_id = s.id) AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id
      WHERE ${where.join(" AND ")}
      ORDER BY s.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all();

  // Which of these this visitor currently holds, and for how long.
  //
  // One query for every live grant they have, rather than one per script —
  // the free plan allows 10ms of CPU per request and a per-row lookup would
  // spend it. The listing still carries no code; this is only the clock.
  const user = await currentUser(request, env);
  const subject = await grantSubject(request, env, user);
  const now = nowSec();

  const held = new Map();
  const mine = await env.DB.prepare(
    `SELECT script_id, verified, expires FROM grants WHERE subject = ? AND expires > ?`
  ).bind(subject, now).all();

  for (const g of mine.results || []) {
    if (grantOpens(env, g)) held.set(g.script_id, Math.max(0, g.expires - now));
  }

  return ok({
    data: (results || []).map((r) => {
      const own = user && user.id === r.author_id;
      const left = held.get(r.id);
      return publicScript(r, {
        unlocked: Boolean(own) || left !== undefined,
        unlockedFor: own ? null : (left ?? null),
        mine: Boolean(own),
      });
    }),
  });
}

async function handleScriptGet(request, env, { id }) {
  const row = await env.DB.prepare(
    `SELECT ${SCRIPT_COLUMNS},
            (SELECT COUNT(*) FROM likes l WHERE l.script_id = s.id) AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id
      WHERE s.id = ? AND s.removed = 0 AND u.banned = 0`
  ).bind(id).first();

  if (!row) return bad(404, "That script doesn't exist.");

  // A held script is reachable by its author and by nobody else — they should
  // be able to see what they submitted while it waits, without it being live.
  if (row.status && row.status !== "approved") {
    const me = await currentUser(request, env);
    if (!me || me.id !== row.author_id) return bad(404, "That script doesn't exist.");
  }

  const user = await currentUser(request, env);
  const subject = await grantSubject(request, env, user);
  const mine = user && user.id === row.author_id;

  const grant = mine ? null : await env.DB.prepare(
    `SELECT verified, expires FROM grants WHERE subject = ? AND script_id = ? AND expires > ?`
  ).bind(subject, id, nowSec()).first();

  // How long is left, in seconds — not the deadline itself.
  //
  // A timestamp would need the visitor's clock to agree with ours to mean
  // anything, and it often does not: a laptop an hour fast would show an
  // unlock that expired before it started. A duration is measured entirely
  // here and stays true whatever their clock says.
  const unlockedFor = grantOpens(env, grant)
    ? Math.max(0, grant.expires - nowSec())
    : null;

  // A view is one per subject per script per hour, so a refresh loop cannot
  // inflate somebody's numbers.
  if (await underLimit(env, `view:${subject}:${id}`, 1, 3600)) {
    await env.DB.prepare(`UPDATE scripts SET views = views + 1 WHERE id = ?`).bind(id).run();
    row.views = (row.views || 0) + 1;
  }

  return ok({
    data: publicScript(row, {
      // The author never has to unlock their own work, and so has no clock
      // running — `unlockedFor` stays null for them rather than reading zero.
      unlocked: Boolean(mine) || grantOpens(env, grant),
      unlockedFor,
      mine: Boolean(mine),
      liked: user ? Boolean(await env.DB.prepare(
        `SELECT 1 FROM likes WHERE user_id = ? AND script_id = ?`
      ).bind(user.id, id).first()) : false,
    }),
  });
}

/**
 * One creator, by name, with everything they have published.
 *
 * This is what /creators/<name> is drawn from, and it is deliberately its own
 * endpoint rather than a filter on the listing. A profile needs the person —
 * bio, links, joined-when — and the listing only ever knew about scripts, so
 * the page used to be assembled out of whatever happened to be cached and was
 * blank for anyone whose scripts had scrolled off it.
 *
 * Matched on `username_lower`, which is UNIQUE, so a name identifies exactly
 * one person and the URL can never be ambiguous. The reply echoes the stored
 * spelling back as `username`: /creators/lucrit and /creators/LUCRIT both
 * resolve, and the page then corrects the address bar to the real one.
 *
 * Email is not in the reply, and must not be. This document is world-readable.
 */
async function handleCreator(request, env, { id }) {
  const name = decodeURIComponent(id || "").trim();
  if (!name) return bad(404, "No such creator.");

  const user = await env.DB.prepare(
    `SELECT id, username, bio, avatar, youtube, tiktok, created_at
       FROM users WHERE username_lower = ? AND banned = 0`
  ).bind(name.toLowerCase()).first();

  // A suspended account is a 404 here rather than a "suspended" page. Saying
  // which is which turns the profile route into a way to enumerate bans.
  if (!user) return bad(404, "No such creator.");

  const { results } = await env.DB.prepare(
    `SELECT ${SCRIPT_COLUMNS},
            (SELECT COUNT(*) FROM likes l WHERE l.script_id = s.id) AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id
      WHERE s.author_id = ? AND s.removed = 0
      ORDER BY s.created_at DESC LIMIT 200`
  ).bind(user.id).all();

  const scripts = results || [];
  const viewer = await currentUser(request, env);
  const mine = Boolean(viewer && viewer.id === user.id);

  return ok({
    data: {
      id: user.id,
      username: user.username,
      bio: user.bio || "",
      avatar: user.avatar || null,
      youtube: user.youtube || "",
      tiktok: user.tiktok || "",
      createdAt: user.created_at,
      mine,
      totals: {
        scripts: scripts.length,
        views: scripts.reduce((n, r) => n + (r.views || 0), 0),
        copies: scripts.reduce((n, r) => n + (r.copies || 0), 0),
        likes: scripts.reduce((n, r) => n + (r.likes || 0), 0),
      },
      // No unlock flags and no clocks: a profile lists work, it does not open
      // any of it. Whether the viewer holds a grant is decided on the script's
      // own page, by the endpoints that already do it.
      scripts: scripts.map((r) => publicScript(r, { mine })),
    },
  });
}

async function handleScriptPublish(request, env, _params, ctx) {
  const user = await currentUser(request, env);
  if (!user) return bad(401, "Sign in to publish a script.");

  const ip = clientIp(request);
  if (!(await underLimit(env, `publish:${user.id}`, 10, 3600)))
    return bad(429, "That's a lot of scripts at once. Try again in a little while.");

  const body = await request.json().catch(() => ({}));
  const { turnstile } = body;
  if (!(await humanOk(env, turnstile, ip)))
    return bad(400, "Please complete the human check.");

  const title = String(body.title || "").trim();
  const game = String(body.game || "").trim();
  const descr = String(body.desc || "").trim();
  const code = String(body.code || "");
  const category = String(body.category || "utilities").trim();

  if (!title) return bad(400, "Give the script a name.");
  if (title.length > SCRIPT_LIMITS.title) return bad(400, "That title is too long.");
  if (!game) return bad(400, "Say which Roblox game it's for.");
  if (game.length > SCRIPT_LIMITS.game) return bad(400, "That game name is too long.");

  const words = descr.split(/\s+/).filter(Boolean).length;
  if (words < MIN_DESC_WORDS)
    return bad(400, `The description needs at least ${MIN_DESC_WORDS} words.`);
  if (descr.length > SCRIPT_LIMITS.descr) return bad(400, "That description is too long.");

  if (!code.trim()) return bad(400, "Paste the Luau code.");
  if (code.length > SCRIPT_LIMITS.code) return bad(400, "That script is too large to publish.");

  const tags = (Array.isArray(body.tags) ? body.tags : [])
    .map((t) => String(t || "").trim().slice(0, SCRIPT_LIMITS.tag))
    .filter(Boolean)
    .slice(0, 6);

  // A thumbnail is either a data URL the person uploaded or a Roblox CDN link.
  // Anything else would let a publisher point the whole library at a tracker.
  const thumbRaw = String(body.thumbnail || "").trim();
  const thumbnail =
    /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(thumbRaw) && thumbRaw.length < 400000
      ? thumbRaw
      : safeSocial(thumbRaw, ["roblox.com", "rbxcdn.com"]);

  // The checker runs before anything is written. Three outcomes: publish,
  // hold for a human, or refuse. It is looking for spam and empty
  // submissions — NOT deciding whether the code is safe, which it cannot do
  // and must never claim to.
  const verdict = checkSubmission({ code, descr, title, game });
  if (verdict.status === "rejected") return bad(400, verdict.note);

  // The creator may have accepted an AI rewrite in the publish form. Their own
  // words are kept either way, so a rewrite that drifted is recoverable.
  const original = String(body.descOriginal || "").trim() || descr;

  const id = "s_" + randomHex(8);
  await env.DB.prepare(
    `INSERT INTO scripts (id, author_id, title, game, category, descr, code, tags,
                          keyless, thumbnail, created_at, status, check_note, descr_original)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, user.id, title, game, category, descr, code, JSON.stringify(tags),
    body.keyless === false ? 0 : 1, thumbnail, new Date().toISOString(),
    verdict.status, verdict.note, original
  ).run();

  const row = await env.DB.prepare(
    `SELECT ${SCRIPT_COLUMNS}, 0 AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id WHERE s.id = ?`
  ).bind(id).first();

  // Tell Discord, but never at the publisher's expense. waitUntil keeps the
  // request from waiting on it, and every announce path swallows its own
  // failures, so a dead webhook is a missing message rather than a publish
  // that appears to have gone wrong.
  //
  // Held submissions are NOT announced. Posting something to the server and
  // then pulling it after review is worse than posting it a few minutes late.
  const shaped = {
    id, title, game, descr, thumbnail, created_at: new Date().toISOString(),
    tags: JSON.stringify(tags), keyless: body.keyless !== false,
    views: 0, copies: 0, likes: 0,
  };
  const after = verdict.status === "approved"
    ? Promise.all([
        announceScript(env, shaped, user.username),
        announceScriptBot(env, shaped, user.username),
      ])
    : modLog(env, "Held for review",
        `**${title}** by @${user.username} — ${verdict.note}`, 0xf6c343);

  if (ctx?.waitUntil) ctx.waitUntil(after); else after.catch(() => {});

  return ok({
    data: publicScript(row, { unlocked: true, mine: true, liked: false }),
    status: verdict.status,
    note: verdict.note,
  });
}

/**
 * The one door the code comes through.
 *
 * Authors walk straight in. Everyone else needs an unhandled grant, which only
 * /api/unlock/claim can mint. This is the difference between a paywall and a
 * decoration: there is no path that puts the code in a page before this call.
 */
async function handleScriptCode(request, env, { id }) {
  const row = await env.DB.prepare(
    `SELECT id, author_id, code FROM scripts WHERE id = ? AND removed = 0`
  ).bind(id).first();
  if (!row) return bad(404, "That script doesn't exist.");

  const user = await currentUser(request, env);
  if (user && user.id === row.author_id) return ok({ data: { code: row.code } });

  const subject = await grantSubject(request, env, user);
  const grant = await env.DB.prepare(
    `SELECT verified FROM grants WHERE subject = ? AND script_id = ? AND expires > ?`
  ).bind(subject, id, nowSec()).first();

  if (!grantOpens(env, grant)) return bad(403, "Unlock the script first.");

  // Checked again here because this is the door the code actually comes
  // through. A grant minted while the gate was off, or while somebody was
  // still in the server, must not keep opening it after they left.
  const blocked = await discordBlock(env, user);
  if (blocked) return bad(403, blocked.error, { discord: blocked.discord });

  // Counting here rather than at claim time means the number reflects code
  // actually collected, not sponsor steps abandoned at the last moment.
  //
  // But it has to be deduplicated the same way a view is, and originally it
  // was not: one person with a five-minute unlock could re-open the sheet, or
  // the page could re-render, and every single fetch added a copy. A script
  // ended up reading "17 views · 44 copies" — three copies per person who ever
  // looked at it, which is nonsense on its face. One per person per hour, the
  // same window views use, so the two numbers stay comparable.
  if (await underLimit(env, `copy:${subject}:${id}`, 1, 3600)) {
    await env.DB.prepare(`UPDATE scripts SET copies = copies + 1 WHERE id = ?`).bind(id).run();

    // Reading the code is a view of the script by any sane reading, and the
    // detail fetch that normally records one can be skipped. Without this,
    // copies could still outrun views.
    if (await underLimit(env, `view:${subject}:${id}`, 1, 3600)) {
      await env.DB.prepare(`UPDATE scripts SET views = views + 1 WHERE id = ?`).bind(id).run();
    }
  }
  return ok({ data: { code: row.code } });
}

async function handleScriptDelete(request, env, { id }, ctx) {
  const user = await currentUser(request, env);
  if (!user) return bad(401, "Sign in first.");

  const row = await env.DB.prepare(
    `SELECT s.*, u.username AS author FROM scripts s
       JOIN users u ON u.id = s.author_id WHERE s.id = ?`
  ).bind(id).first();
  if (!row) return bad(404, "That script doesn't exist.");

  const admin = env.ADMIN_USER_ID && user.id === env.ADMIN_USER_ID;
  if (row.author_id !== user.id && !admin) return bad(403, "That isn't your script.");

  // Soft delete: the row stays so counts and any payout history survive, but
  // nothing that lists or serves scripts will look at it again.
  await env.DB.prepare(`UPDATE scripts SET removed = 1 WHERE id = ?`).bind(id).run();

  // ...and Discord has to hear about it. Without this the server keeps a live
  // "Get Script" button for something the site will answer 404 to — the exact
  // reason script_posts stores message ids in the first place.
  const after = Promise.all([
    retireScriptPosts(env, row, row.author),
    modLog(env, "Script removed", `**${row.title}** by @${row.author}`, 0xef5350),
  ]);
  if (ctx?.waitUntil) ctx.waitUntil(after); else after.catch(() => {});

  return ok({ data: { id } });
}

async function handleScriptLike(request, env, { id }) {
  const user = await currentUser(request, env);
  if (!user) return bad(401, "Sign in to like a script.");

  const exists = await env.DB.prepare(
    `SELECT 1 FROM likes WHERE user_id = ? AND script_id = ?`
  ).bind(user.id, id).first();

  if (exists) {
    await env.DB.prepare(`DELETE FROM likes WHERE user_id = ? AND script_id = ?`)
      .bind(user.id, id).run();
  } else {
    const script = await env.DB.prepare(
      `SELECT 1 FROM scripts WHERE id = ? AND removed = 0`).bind(id).first();
    if (!script) return bad(404, "That script doesn't exist.");
    await env.DB.prepare(`INSERT INTO likes (user_id, script_id, at) VALUES (?, ?, ?)`)
      .bind(user.id, id, nowSec()).run();
  }

  const { count } = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM likes WHERE script_id = ?`).bind(id).first();
  return ok({ data: { liked: !exists, likes: count } });
}

async function handleScriptReport(request, env, { id }) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `report:${ip}`, 10, 3600)))
    return bad(429, "Too many reports from this connection.");

  const user = await currentUser(request, env);
  const { reason } = await request.json().catch(() => ({}));

  await env.DB.prepare(
    `INSERT INTO reports (id, script_id, reporter, reason, at) VALUES (?, ?, ?, ?, ?)`
  ).bind("r_" + randomHex(8), id, user ? user.id : "", String(reason || "").slice(0, 500), nowSec()).run();

  return ok({ data: { reported: true } });
}

/* ══════════════════════════════════════════════════════════════════ unlocks ══ */

/**
 * The sponsor step, in three parts.
 *
 *   start    the site asks where to send the visitor. We mint a click id,
 *            remember what it is for, and hand back the provider's link.
 *   postback the provider's servers call us when the visitor finishes. No
 *            Origin header, no cookies — it is a machine, not a browser. This
 *            is safe because it only marks a click id done; reading anything
 *            back still goes through claim.
 *   claim    the site says "I finished, click id X". We look it up, and only
 *            if the provider marked it done do we write a grant.
 *
 * WITHOUT A PROVIDER TOKEN CONFIGURED this degrades to an unverified grant, so
 * the site keeps working — but the grant is recorded with verified = 0 and no
 * money was ever made. That is a placeholder, not a paywall, and the honest
 * thing is that it says so in /api/config rather than pretending otherwise.
 */
const LOOTLABS_API = "https://creators.lootlabs.gg/api/public";
const CLICK_TTL_SEC = 3600;

/**
 * How the locker looks and how hard it pushes.
 *
 *   tier   1 Trending & Recommended · 2 Gaming Offers · 3 Profit Maximization
 *          4 Maximum Profit + Software Products
 *   tasks  1-5 ads before the visitor reaches the script
 *   theme  1 Classic · 2 Sims · 3 Minecraft · 4 GTA · 5 Space
 *
 * Tier and task count are a revenue-versus-abandonment trade, and the right
 * answer is a judgement about the audience rather than a technical one — so
 * they are environment variables. Tuning them is a settings change and a
 * redeploy, not a code change.
 *
 * LootLabs rejects the whole request if any of these is out of range, and a
 * rejected request means no link and a visitor who cannot unlock anything.
 * So every value is clamped rather than trusted: a typo in the dashboard
 * degrades to a working locker instead of a broken one.
 */
const clampInt = (value, min, max, fallback) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const lootSettings = (env) => ({
  tier: clampInt(env.LOOT_TIER, 1, 4, 4),
  tasks: clampInt(env.LOOT_TASKS, 1, 5, 3),
  theme: clampInt(env.LOOT_THEME, 1, 5, 3),
});

/**
 * The script's own artwork, if it is something LootLabs can actually fetch.
 *
 * Publishers can upload a thumbnail as a data: URL, which lives happily in our
 * own pages but is meaningless to a third party — sending one would be a
 * megabyte of base64 in an API call that then fails validation. Only real
 * http(s) links go out.
 */
function lootThumbnail(script) {
  const raw = String(script?.thumbnail || "").trim();
  if (!/^https?:\/\//i.test(raw)) return null;
  if (raw.length > 500) return null;
  return raw;
}

/**
 * Which sponsor providers are actually wired up.
 *
 * The site shows a button per entry. It used to show LootLabs AND Linkvertise
 * unconditionally while both ran the same LootLabs code path — so picking
 * Linkvertise did something other than what it said. A provider appears here
 * only when it has credentials AND a way to verify completion; an unverifiable
 * provider is a free bypass wearing a paywall's clothes.
 */
function unlockProviders(env) {
  const live = [];
  if (env.LOOTLABS_TOKEN) live.push("lootlabs");
  // Linkvertise needs the anti-bypass token to verify with, plus somewhere to
  // send people: either a publisher id (dynamic links, built per unlock) or a
  // single hand-made link. Without one of each there is nothing to send a
  // visitor to, or no way to know they arrived honestly.
  if (env.LINKVERTISE_TOKEN && (env.LINKVERTISE_USER_ID || env.LINKVERTISE_URL))
    live.push("linkvertise");
  return live;
}

/**
 * A Linkvertise dynamic link, built per unlock.
 *
 * Their dashboard links point at one fixed destination, which is why the first
 * version of this had to park the script id in sessionStorage and hope the
 * visitor came back in the same tab. Dynamic links take the destination as a
 * base64 parameter, so the return URL can name the script itself — the same
 * property `puid` gives us on the LootLabs side, and a much better one to rely
 * on than a client-side hint.
 *
 * Format is `link-to.net/{publisherId}/{nonce}/dynamic?r={base64(target)}`.
 * The nonce is theirs, not ours; it only has to vary.
 */
function linkvertiseLink(env, target, nonce) {
  const id = encodeURIComponent(String(env.LINKVERTISE_USER_ID));
  // btoa is not available in Workers for arbitrary bytes, and the target is
  // URI-encoded first exactly as their own script does it.
  const encoded = base64Url(encodeURI(target));
  return `https://link-to.net/${id}/${nonce}/dynamic?r=${encoded}`;
}

/** Base64 of a string, standard alphabet — what their `r` parameter expects. */
function base64Url(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Linkvertise verification.
 *
 * Their model is the mirror image of LootLabs'. There is no postback: when the
 * visitor finishes the ad-step, Linkvertise redirects them back carrying a
 * `hash`, and we ask their API whether that hash is real.
 *
 * "you can only verify the hash once" — it is consumed on the first check, so
 * a hash cannot be shared, replayed, or handed round a Discord.
 *
 * Fails CLOSED, unlike the human check. A bot check that locks people out is
 * worse than the bots it stops; an unlock that opens on a failed verification
 * is just giving the script away, which is the exact thing this exists to
 * prevent. If Linkvertise is unreachable the visitor is told to try again.
 */
async function linkvertiseVerified(env, hash) {
  if (!/^[a-f0-9]{64}$/i.test(String(hash || ""))) return false;
  try {
    const url = "https://publisher.linkvertise.com/api/v1/anti_bypassing"
      + `?token=${encodeURIComponent(env.LINKVERTISE_TOKEN)}`
      + `&hash=${encodeURIComponent(hash)}`;
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(8000) });
    const body = (await res.text()).trim().toLowerCase();
    // Documented to answer TRUE or FALSE as bare text; tolerate a JSON-ish
    // wrapper in case that changes, but never treat anything else as a pass.
    return body === "true" || body === '"true"' || body === "{\"status\":true}";
  } catch (err) {
    console.warn("linkvertise unreachable", err?.message);
    return false;
  }
}

function unlockConfigured(env) {
  return unlockProviders(env).length > 0;
}

async function handleUnlockStart(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `unlock:${ip}`, 30, 600)))
    return bad(429, "Too many unlocks from this connection. Try again shortly.");

  const { scriptId, provider } = await request.json().catch(() => ({}));
  const script = await env.DB.prepare(
    `SELECT id, title, thumbnail FROM scripts WHERE id = ? AND removed = 0`).bind(scriptId).first();
  if (!script) return bad(404, "That script doesn't exist.");

  const user = await currentUser(request, env);

  // Before the sponsor step, not after it. Somebody who is not in the server
  // must not be sent through a set of offers only to be refused at the end.
  const blocked = await discordBlock(env, user);
  if (blocked) return bad(403, blocked.error, { discord: blocked.discord });

  const subject = await grantSubject(request, env, user);
  const clickId = randomHex(16);
  const now = nowSec();

  await env.DB.prepare(
    `INSERT INTO unlock_clicks (click_id, script_id, subject, provider, done, at, expires)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).bind(clickId, script.id, subject, String(provider || "").slice(0, 20), now, now + CLICK_TTL_SEC).run();

  if (!unlockConfigured(env)) {
    // Nothing to send them to. Say so plainly instead of inventing a link.
    return ok({ data: { clickId, url: "", configured: false } });
  }

  const site = env.SITE_URL || new URL(request.url).origin;

  // Linkvertise needs no per-unlock API call either way: the click row written
  // above is what ties this visitor to this script when they come back.
  if (provider === "linkvertise" && unlockProviders(env).includes("linkvertise")) {
    const url = env.LINKVERTISE_USER_ID
      // Dynamic: the destination carries the script id, so the return does too.
      ? linkvertiseLink(env, `${site}/?unlocked=${encodeURIComponent(script.id)}`,
                        clickId.replace(/\D/g, "").slice(0, 6) || "1")
      // Fixed link: one destination for everything, so which script this was
      // for is only known from the click row and the client's own hint.
      : env.LINKVERTISE_URL;
    return ok({ data: { clickId, url, configured: true, provider: "linkvertise" } });
  }

  const loot = lootSettings(env);
  const thumb = lootThumbnail(script);
  try {
    // Kept well under the edge's own patience. A 15s wait here meant the
    // platform gave up first and returned its own HTML 502, which no amount of
    // try/catch in this function could turn into a useful message.
    const res = await fetch(LOOTLABS_API + "/content_locker", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.LOOTLABS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        // LootLabs caps the title at 30 characters and rejects longer ones.
        title: String(script.title).slice(0, 30),
        url: `${site}/?unlocked=${encodeURIComponent(script.id)}&click=${clickId}`,
        tier_id: loot.tier,
        number_of_tasks: loot.tasks,
        theme: loot.theme,
        // Showing the script's own artwork on the locker tells the visitor
        // they are still in the right place mid-sponsor-step, which is worth
        // real completions on a three-task flow.
        ...(thumb ? { thumbnail: thumb } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });

    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { /* provider sent something else */ }

    // LootLabs' docs show `message` as an object, but the live API returns it
    // as a single-element ARRAY:
    //   {"type":"created","message":[{"short":"...","loot_url":"..."}]}
    // Reading data.message.loot_url gives undefined on an array, so this fell
    // into the failure path every time while LootLabs had actually succeeded —
    // it created a locker link on every click and we threw it away. Accept
    // both shapes so a future doc-shaped response keeps working too.
    const envelope = Array.isArray(data?.message) ? data.message[0] : data?.message;
    const base = envelope?.loot_url || data?.loot_url || "";
    if (!base) {
      // Say what the provider actually replied. Debugging this blind cost an
      // hour once; the token is never echoed, only their answer.
      console.warn("lootlabs rejected", res.status, raw.slice(0, 300));
      return bad(502, "The sponsor step is unavailable right now.", {
        providerStatus: res.status,
        providerSaid: raw.slice(0, 200),
      });
    }

    // THE PART THAT MAKES VERIFICATION POSSIBLE.
    //
    // LootLabs' postback tells us `click_id`, and that value comes from a
    // `puid` parameter attached to the link the visitor followed. Without
    // this, the postback arrives with no way to say WHICH unlock completed,
    // so every claim would fail its check and nobody could get a script —
    // the paywall would fail closed rather than open.
    const url = base + (base.includes("?") ? "&" : "?") + "puid=" + encodeURIComponent(clickId);

    return ok({ data: { clickId, url, configured: true } });
  } catch {
    return bad(502, "Couldn't reach the sponsor step. Try again.");
  }
}

/** Called by the provider's servers, never by a browser. */
async function handleUnlockPostback(request, env) {
  const url = new URL(request.url);
  const clickId = String(url.searchParams.get("click_id") || url.searchParams.get("click") || "");
  if (!clickId) return bad(400, "missing click_id");

  await env.DB.prepare(
    `UPDATE unlock_clicks SET done = 1 WHERE click_id = ? AND expires > ?`
  ).bind(clickId, nowSec()).run();

  // Providers expect a bare 200, not our JSON envelope.
  return new Response("ok", { status: 200, headers: { "Cache-Control": "no-store" } });
}

async function handleUnlockClaim(request, env) {
  const ip = clientIp(request);
  if (!(await underLimit(env, `claim:${ip}`, 40, 600)))
    return bad(429, "Too many attempts. Try again shortly.");

  const { scriptId, clickId, hash } = await request.json().catch(() => ({}));
  const script = await env.DB.prepare(
    `SELECT id, author_id FROM scripts WHERE id = ? AND removed = 0`).bind(scriptId).first();
  if (!script) return bad(404, "That script doesn't exist.");

  const user = await currentUser(request, env);
  const subject = await grantSubject(request, env, user);
  const now = nowSec();

  let verified = 0;
  let provider = "";

  // ── Linkvertise ────────────────────────────────────────────────────────
  // Proof is the hash they came back with, not a click id we can look up.
  // We still require a click row we minted for THIS subject and script, so a
  // valid hash cannot be pointed at a script the visitor never started.
  if (hash && unlockProviders(env).includes("linkvertise")) {
    const pending = await env.DB.prepare(
      `SELECT click_id FROM unlock_clicks
        WHERE subject = ? AND script_id = ? AND provider = 'linkvertise' AND expires > ?
        ORDER BY at DESC LIMIT 1`
    ).bind(subject, script.id, now).first();

    if (!pending) return bad(400, "Start the unlock from the script page first.");
    if (!(await linkvertiseVerified(env, hash)))
      return bad(400, "That unlock couldn't be verified. Try the sponsor step again.");

    await env.DB.prepare(`DELETE FROM unlock_clicks WHERE click_id = ?`).bind(pending.click_id).run();
    verified = 1;
    provider = "linkvertise";

  // ── LootLabs ───────────────────────────────────────────────────────────
  // Proof is a click id their postback already marked done.
  } else if (unlockConfigured(env)) {
    const click = await env.DB.prepare(
      `SELECT script_id, subject, provider, done FROM unlock_clicks
        WHERE click_id = ? AND expires > ?`
    ).bind(String(clickId || ""), now).first();

    // Every one of these has to hold. A click id for someone else's session, or
    // for a different script, or one the provider never confirmed, is not proof
    // of anything.
    if (!click) return bad(400, "That unlock couldn't be verified.");
    if (!click.done) return bad(400, "The sponsor step wasn't completed.");
    if (click.script_id !== script.id) return bad(400, "That unlock was for a different script.");
    if (!sameSecret(click.subject, subject)) return bad(400, "That unlock belongs to someone else.");

    // Single use, so a completed click id cannot be replayed or shared around.
    await env.DB.prepare(`DELETE FROM unlock_clicks WHERE click_id = ?`).bind(String(clickId)).run();
    verified = 1;
    provider = click.provider || "";
  }

  await env.DB.prepare(
    `INSERT INTO grants (subject, script_id, provider, verified, at, expires)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject, script_id) DO UPDATE SET
       verified = MAX(grants.verified, excluded.verified),
       at = excluded.at,
       expires = excluded.expires`
  ).bind(subject, script.id, provider, verified, now, now + grantMinutes(env) * 60).run();
  // `at` moves with `expires` on a repeat unlock. Leaving it at the first
  // claim's time made `expires - at` drift away from the actual window, so a
  // row could read as a six-minute grant when the window is five. Nothing
  // enforced off `at` — `expires` is the only thing checked — but a stored
  // number that means something should keep meaning it.

  // The grant says "this person may read the code". The event says "an unlock
  // happened" — a separate fact, appended, because the grant above is upserted
  // and would lose the second and third unlock by the same person.
  await env.DB.prepare(
    `INSERT INTO unlock_events (id, script_id, author_id, subject, provider, verified, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind("e_" + randomHex(8), script.id, script.author_id, subject, provider, verified, now).run();

  // The countdown starts here, so the claim says how long it runs for. Without
  // this the page would have to re-fetch the script just to learn the number
  // it is about to display.
  return ok({
    data: {
      unlocked: true,
      verified: Boolean(verified),
      unlockedFor: grantMinutes(env) * 60,
    },
  });
}

/**
 * What an author has earned.
 *
 * Only `verified` events represent money: an unverified one is an unlock that
 * happened while no sponsor provider was configured, so nobody paid for it.
 * Both are reported, separately and labelled, rather than adding them together
 * into a number that would overstate what is owed.
 */
async function handleEarnings(request, env) {
  const user = await currentUser(request, env);
  if (!user) return bad(401, "Sign in first.");

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS unlocks,
            COALESCE(SUM(verified), 0) AS verified
       FROM unlock_events WHERE author_id = ?`
  ).bind(user.id).first();

  const { results } = await env.DB.prepare(
    `SELECT e.script_id AS id,
            COALESCE(s.title, 'Removed script') AS title,
            COUNT(*) AS unlocks,
            COALESCE(SUM(e.verified), 0) AS verified
       FROM unlock_events e
       LEFT JOIN scripts s ON s.id = e.script_id
      WHERE e.author_id = ?
      GROUP BY e.script_id
      ORDER BY verified DESC, unlocks DESC
      LIMIT 100`
  ).bind(user.id).all();

  return ok({
    data: {
      unlocks: totals?.unlocks || 0,
      verified: totals?.verified || 0,
      // So the UI can say why the number is zero rather than looking broken.
      providerLive: unlockConfigured(env),
      scripts: results || [],
    },
  });
}

/* ══════════════════════════════════════════════════════════════════ admin ══ */

/**
 * Everything behind this gate can destroy things, so the gate is one function
 * and every route calls it first.
 *
 * Returns the admin's own row on success, or a Response to send back. Callers
 * check with `instanceof Response` — that way it is impossible to write a
 * handler that forgets to return the refusal, which a boolean would allow.
 */
/**
 * Whether this request carries a live passcode ticket.
 *
 * Expired rows are deleted on the way past rather than swept on a schedule —
 * there is one admin, so the table never grows enough to need one.
 */
async function adminUnlocked(request, env) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (!token) return false;

  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT expires FROM admin_gate WHERE token_hash = ?`).bind(hash).first();
  if (!row) return false;

  if (row.expires <= nowSec()) {
    await env.DB.prepare(`DELETE FROM admin_gate WHERE token_hash = ?`).bind(hash).run();
    return false;
  }
  return true;
}

async function requireAdmin(request, env) {
  // Fails closed when no passcode is configured. An admin area whose lock is
  // simply absent is worse than one that admits it is not ready: the first
  // looks protected.
  if (!env.ADMIN_PASS_HASH)
    return bad(503, "The admin passcode isn't set, so the admin area is closed.");

  if (!(await adminUnlocked(request, env)))
    return bad(423, "Enter the admin passcode.", { locked: true });

  // Whoever holds the ticket is the operator. A session, if there is one, is
  // only used to stop them suspending or deleting the account they are
  // currently using.
  return (await currentUser(request, env)) || { id: null };
}

/**
 * Reports what the admin page is allowed to draw, without leaking anything.
 *
 * Answers for anybody — that is the point, the page has to know whether to
 * show a passcode box, a sign-in prompt, or nothing at all. It never says
 * whether a passcode is correct, only whether one has already been accepted.
 */
async function handleAdminState(request, env) {
  return ok({
    data: {
      configured: Boolean(env.ADMIN_PASS_HASH),
      unlocked: Boolean(env.ADMIN_PASS_HASH) && (await adminUnlocked(request, env)),
      // The browser needs this to stretch the passcode the same way the server
      // expects. It is not a secret — a salt's job is to be unique, not
      // hidden, and it stops one precomputed table covering every site.
      salt: ADMIN_PASS_SALT,
      iterations: ADMIN_PASS_ITERATIONS,
    },
  });
}

/**
 * Trades the passcode for a ticket.
 *
 * The passcode itself is never stored and never travels as plaintext past the
 * browser. The page stretches it with PBKDF2 exactly the way account passwords
 * are handled here — 310k rounds on the machine with spare cycles, because the
 * Worker only gets 10ms — and sends the derived key. We keep a fast SHA-256 of
 * that key in ADMIN_PASS_HASH, so the environment variable is a verifier, not
 * a password: reading it off the dashboard does not let anybody in.
 */
async function handleAdminUnlock(request, env) {
  const ip = clientIp(request);
  // Ten tries per quarter hour. This passcode is the only thing between the
  // internet and the delete button, so guessing has to be slow.
  if (!(await underLimit(env, `adminpass:${ip}`, 10, 900)))
    return bad(429, "Too many attempts. Wait a few minutes.");

  if (!env.ADMIN_PASS_HASH) return bad(503, "The admin passcode isn't set.");

  const { derived } = await request.json().catch(() => ({}));
  if (!AUTH_KEY.test(String(derived || ""))) return bad(400, "That passcode isn't right.");

  const expect = await sha256Hex(String(derived));
  if (!sameSecret(expect, String(env.ADMIN_PASS_HASH)))
    return bad(400, "That passcode isn't right.");

  const token = randomHex(32);
  await env.DB.prepare(
    `INSERT INTO admin_gate (token_hash, expires) VALUES (?, ?)`
  ).bind(await sha256Hex(token), nowSec() + ADMIN_GATE_MINUTES * 60).run();

  return json(200, { ok: true, data: { unlocked: true, minutes: ADMIN_GATE_MINUTES } },
    { "Set-Cookie": cookieHeader(token, ADMIN_GATE_MINUTES * 60, ADMIN_COOKIE) });
}

async function handleAdminLock(request, env) {
  const token = readCookie(request, ADMIN_COOKIE);
  if (token) {
    await env.DB.prepare(`DELETE FROM admin_gate WHERE token_hash = ?`)
      .bind(await sha256Hex(token)).run();
  }
  return json(200, { ok: true }, { "Set-Cookie": cookieHeader("", 0, ADMIN_COOKIE) });
}

async function handleAdminOverview(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const one = async (sql) => Number((await env.DB.prepare(sql).first())?.n || 0);
  return ok({
    data: {
      users: await one(`SELECT COUNT(*) AS n FROM users`),
      banned: await one(`SELECT COUNT(*) AS n FROM users WHERE banned = 1`),
      scripts: await one(`SELECT COUNT(*) AS n FROM scripts WHERE removed = 0`),
      removed: await one(`SELECT COUNT(*) AS n FROM scripts WHERE removed = 1`),
      unlocks: await one(`SELECT COUNT(*) AS n FROM unlock_events`),
      verified: await one(`SELECT COUNT(*) AS n FROM unlock_events WHERE verified = 1`),
      reports: await one(`SELECT COUNT(*) AS n FROM reports`),
    },
  });
}

async function handleAdminUsers(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 60);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));

  const where = q ? `WHERE u.username_lower LIKE ? OR u.email_lower LIKE ?` : "";
  const binds = q ? [`%${q}%`, `%${q}%`] : [];

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.created_at, u.banned,
            (SELECT COUNT(*) FROM scripts s WHERE s.author_id = u.id AND s.removed = 0) AS scripts,
            (SELECT COUNT(*) FROM unlock_events e WHERE e.author_id = u.id) AS unlocks
       FROM users u ${where}
      ORDER BY u.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all();

  return ok({
    data: (results || []).map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      createdAt: String(r.created_at || "").slice(0, 10),
      banned: Boolean(r.banned),
      scripts: Number(r.scripts) || 0,
      unlocks: Number(r.unlocks) || 0,
      self: Boolean(admin.id) && r.id === admin.id,
    })),
  });
}

async function handleAdminUserBan(request, env, { id }) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  // Banning yourself deletes your own sessions and leaves nobody able to
  // unban anyone, because the only way back in is the admin panel.
  if (admin.id && id === admin.id) return bad(400, "You can't suspend the account you're signed in as.");

  const row = await env.DB.prepare(`SELECT id FROM users WHERE id = ?`).bind(id).first();
  if (!row) return bad(404, "No such account.");

  const body = await request.json().catch(() => ({}));
  const banned = body.banned === false ? 0 : 1;

  await env.DB.prepare(`UPDATE users SET banned = ? WHERE id = ?`).bind(banned, id).run();
  if (banned) await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(id).run();

  return ok({ data: { id, banned: Boolean(banned) } });
}

async function handleAdminUserDelete(request, env, { id }) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  if (admin.id && id === admin.id) return bad(400, "You can't delete the account you're signed in as.");

  const row = await env.DB.prepare(`SELECT id, username FROM users WHERE id = ?`).bind(id).first();
  if (!row) return bad(404, "No such account.");

  // The username has to be typed back. Not security — the request is already
  // authenticated — but a deliberate speed bump in front of the one action on
  // this site that cannot be undone.
  const body = await request.json().catch(() => ({}));
  if (String(body.confirm || "").trim().toLowerCase() !== String(row.username).toLowerCase())
    return bad(400, "Type the username exactly to confirm.");

  // Their unlock history is kept. It records what happened, not who they were,
  // and deleting it would silently rewrite every earnings total on the site.
  await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
  return ok({ data: { id, deleted: true } });
}

async function handleAdminScripts(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const url = new URL(request.url);
  const q = String(url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 60);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));

  const where = q ? `WHERE LOWER(s.title) LIKE ? OR LOWER(u.username) LIKE ?` : "";
  const binds = q ? [`%${q}%`, `%${q}%`] : [];

  // Unlike the public listing this includes removed scripts — seeing what was
  // taken down, and putting it back, is most of the point of the panel.
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.title, s.game, s.views, s.copies, s.removed, s.created_at,
            u.username AS author, u.id AS author_id,
            (SELECT COUNT(*) FROM reports r WHERE r.script_id = s.id) AS reports
       FROM scripts s JOIN users u ON u.id = s.author_id
       ${where}
      ORDER BY s.created_at DESC
      LIMIT ?`
  ).bind(...binds, limit).all();

  return ok({
    data: (results || []).map((r) => ({
      id: r.id,
      title: r.title,
      game: r.game,
      author: r.author,
      authorId: r.author_id,
      views: Number(r.views) || 0,
      copies: Number(r.copies) || 0,
      reports: Number(r.reports) || 0,
      removed: Boolean(r.removed),
      createdAt: String(r.created_at || "").slice(0, 10),
    })),
  });
}

/**
 * Take a script down, put it back, or resolve a held submission.
 *
 * `status` is the review queue's half of this: approving one publishes it AND
 * announces it, which is the whole point of holding rather than rejecting —
 * an honest upload the checker was unsure about reaches the server the moment
 * a human says yes, not never.
 */
async function handleAdminScriptState(request, env, { id }, ctx) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const row = await env.DB.prepare(
    `SELECT s.*, u.username AS author FROM scripts s
       JOIN users u ON u.id = s.author_id WHERE s.id = ?`
  ).bind(id).first();
  if (!row) return bad(404, "That script doesn't exist.");

  const body = await request.json().catch(() => ({}));
  const wasHeld = row.status && row.status !== "approved";

  const status = ["approved", "review", "rejected"].includes(body.status)
    ? body.status : row.status || "approved";
  const removed = body.removed === undefined
    ? row.removed : (body.removed === false ? 0 : 1);

  await env.DB.prepare(`UPDATE scripts SET removed = ?, status = ? WHERE id = ?`)
    .bind(removed, status, id).run();

  const live = !removed && status === "approved";
  const shaped = { ...row, removed, status };

  const after = (async () => {
    if (live && wasHeld) {
      // Approved out of the queue: this is its first appearance anywhere.
      await announceScriptBot(env, shaped, row.author);
      await modLog(env, "Approved from review", `**${row.title}** by @${row.author}`, 0x66bb6a);
      return;
    }
    if (live) {
      await syncScriptPosts(env, shaped, row.author, { state: "live" });
      return;
    }
    await retireScriptPosts(env, shaped, row.author);
    await modLog(env, removed ? "Script taken down" : "Script held",
      `**${row.title}** by @${row.author}`, 0xef5350);
  })();
  if (ctx?.waitUntil) ctx.waitUntil(after); else after.catch(() => {});

  return ok({ data: { id, removed: Boolean(removed), status } });
}

/**
 * Resets a script's view and copy counters.
 *
 * These ran away once already: copies were incremented per code fetch with no
 * per-person window, so one script read 17 views and 44 copies. The counting
 * is fixed, but a number inflated before the fix stays inflated, and there was
 * no way to correct it without opening the database by hand.
 */
async function handleAdminScriptCounters(request, env, { id }) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const row = await env.DB.prepare(`SELECT id FROM scripts WHERE id = ?`).bind(id).first();
  if (!row) return bad(404, "That script doesn't exist.");

  const body = await request.json().catch(() => ({}));
  const clean = (v) => Math.min(1e9, Math.max(0, Math.floor(Number(v) || 0)));
  const views = clean(body.views);
  const copies = clean(body.copies);

  await env.DB.prepare(`UPDATE scripts SET views = ?, copies = ? WHERE id = ?`)
    .bind(views, copies, id).run();
  return ok({ data: { id, views, copies } });
}

async function handleAdminReports(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const { results } = await env.DB.prepare(
    `SELECT r.id, r.script_id, r.reason, r.at,
            s.title, s.removed, u.username AS author
       FROM reports r
       LEFT JOIN scripts s ON s.id = r.script_id
       LEFT JOIN users u ON u.id = s.author_id
      ORDER BY r.at DESC
      LIMIT 200`
  ).all();

  return ok({
    data: (results || []).map((r) => ({
      id: r.id,
      scriptId: r.script_id,
      title: r.title || "(deleted script)",
      author: r.author || "",
      reason: r.reason || "",
      at: Number(r.at) || 0,
      removed: Boolean(r.removed),
    })),
  });
}

async function handleAdminReportDismiss(request, env, { id }) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  await env.DB.prepare(`DELETE FROM reports WHERE id = ?`).bind(id).run();
  return ok({ data: { id, dismissed: true } });
}

/* ════════════════════════════════════════════════════════════ leaderboard ══ */

/**
 * The boards, as SQL.
 *
 * This endpoint exists because the leaderboard did not. The page rendered a
 * real board with real tabs and then called `getRows: () => []` — a hardcoded
 * empty array — so it said "Nobody on the board yet" no matter how many
 * scripts had been published. Decoration, in the same family as the paywall
 * that used to hand out the code.
 *
 * Aggregating in the database rather than over a fetched listing matters: the
 * listing is capped at 200 rows, so a client-side board would quietly rank a
 * slice of the site and present it as the whole thing.
 *
 * Removed scripts are excluded everywhere. A deleted script should not keep
 * earning its author a place.
 */
const BOARD_SQL = {
  scripts: `SELECT u.username AS username, COUNT(*) AS value
              FROM scripts s JOIN users u ON u.id = s.author_id
             WHERE s.removed = 0 AND u.banned = 0
             GROUP BY s.author_id HAVING value > 0
             ORDER BY value DESC, u.username ASC LIMIT ?`,

  likes: `SELECT u.username AS username, COUNT(l.script_id) AS value
            FROM scripts s
            JOIN users u ON u.id = s.author_id
            JOIN likes l ON l.script_id = s.id
           WHERE s.removed = 0 AND u.banned = 0
           GROUP BY s.author_id HAVING value > 0
           ORDER BY value DESC, u.username ASC LIMIT ?`,

  views: `SELECT u.username AS username, SUM(s.views) AS value
            FROM scripts s JOIN users u ON u.id = s.author_id
           WHERE s.removed = 0 AND u.banned = 0
           GROUP BY s.author_id HAVING value > 0
           ORDER BY value DESC, u.username ASC LIMIT ?`,

  unlocks: `SELECT u.username AS username, COUNT(*) AS value
              FROM unlock_events e JOIN users u ON u.id = e.author_id
             WHERE u.banned = 0
             GROUP BY e.author_id HAVING value > 0
             ORDER BY value DESC, u.username ASC LIMIT ?`,
};

async function handleLeaderboard(request, env) {
  const url = new URL(request.url);
  const board = String(url.searchParams.get("board") || "scripts");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 10));

  const sql = BOARD_SQL[board];
  if (!sql) return bad(400, "No such board.", { boards: Object.keys(BOARD_SQL) });

  const { results } = await env.DB.prepare(sql).bind(limit).all();
  return ok({
    data: (results || [])
      .filter((r) => r.username)
      .map((r) => ({ username: r.username, value: Number(r.value) || 0 })),
  });
}

/* ═════════════════════════════════════════════════ submission checks ══ */

/**
 * Does this submission look like a script at all?
 *
 * IMPORTANT, and the reason this function is named `looksLikeCode` rather than
 * anything with "safe" in it: passing here means the upload is not obviously
 * junk. It does NOT mean the code is harmless. Luau that looks perfectly
 * ordinary can still steal a token or nuke a place. Nothing in this file may
 * ever be presented to a visitor as a safety guarantee — the job is keeping
 * spam and empty submissions out of the library, not vetting behaviour.
 *
 * Heuristics only, deliberately: they are instant, they cost no CPU budget,
 * and they cannot be talked out of a verdict the way a model can.
 */
function looksLikeCode(code) {
  const src = String(code || "");
  const trimmed = src.trim();
  if (!trimmed) return { ok: false, why: "The submission is empty." };
  if (trimmed.length < 20) return { ok: false, why: "That's too short to be a script." };

  // Luau/Lua signals. A real script hits several of these; prose hits none.
  const signals = [
    // Case-insensitive on the keyword sets. Luau's own keywords are lowercase,
    // but "LocalScript" and "PlayerScripts" are everywhere in real code, and a
    // case-sensitive \bscript\b misses both — which held an honest two-line
    // LocalScript for review purely because of a capital letter.
    /\b(local|function|end|then|elseif|repeat|until)\b/i,
    /\b(game|workspace|script|Instance|Enum|task|wait|spawn)\b/i,
    // Roblox's own names, which are compound words: a \bscript\b can never
    // match inside "LocalScript", so the set above misses the single most
    // common word in Roblox code. These are matched as whole identifiers.
    /\b(LocalScript|ModuleScript|ScreenGui|Humanoid|HumanoidRootPart|CFrame|Vector3|UDim2|Color3|Players|ReplicatedStorage|RunService|UserInputService|TweenService|Workspace|HttpGet|GetService|FindFirstChild|WaitForChild)\b/,
    // Standard-library calls. `print('hello')` is a real, if small, script.
    /\b(print|warn|pcall|xpcall|ipairs|pairs|tostring|tonumber|typeof|setmetatable|require)\s*\(/,
    /\bgame[:.]GetService\s*\(/,
    /:\s*[A-Z][A-Za-z]+\s*\(/,           // method calls
    /[{}()]\s*$/m,
    /\bloadstring\b|\bgetgenv\b|\bhookfunction\b|\bsyn\b/,
    /--\[\[|--/,                          // comments
    /=\s*(true|false|nil|\d)/,
  ];
  const hits = signals.filter((re) => re.test(src)).length;

  // Prose gives itself away: long runs of words with no punctuation of the
  // kind code is made of.
  const wordy = /^[A-Za-z ,.'"!?\n-]{120,}$/.test(trimmed);

  if (wordy && hits < 2)
    return { ok: false, why: "That looks like plain text rather than a script." };
  if (hits < 2)
    return { ok: false, why: "That doesn't look like Luau code." };

  // One character or token repeated forever — the classic keyboard-mash spam.
  const collapsed = trimmed.replace(/\s+/g, "");
  const unique = new Set(collapsed).size;
  if (collapsed.length > 80 && unique <= 6)
    return { ok: false, why: "That looks like repeated characters rather than code." };

  return { ok: true, hits };
}

/** The same mash test, for the description field. */
function looksLikeProse(text) {
  const s = String(text || "").trim();
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < MIN_DESC_WORDS) return { ok: false, why: "The description is too short." };

  const unique = new Set(words.map((w) => w.toLowerCase())).size;
  // "c c c c c c…" clears a word count and says nothing.
  if (words.length >= 20 && unique <= Math.max(3, Math.floor(words.length * 0.12)))
    return { ok: false, why: "The description is the same few words repeated." };

  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < s.length * 0.4)
    return { ok: false, why: "The description is mostly symbols." };

  return { ok: true };
}

/**
 * The verdict for one submission.
 *
 * Three outcomes, and the middle one is the important one: when the checks
 * disagree or the signal is weak, the submission is HELD rather than
 * rejected. Auto-rejecting an honest upload because a regex was unsure is the
 * failure mode that drives creators off a platform, and it is silent — they
 * are simply told no and never come back.
 */
function checkSubmission({ code, descr, title, game }) {
  const notes = [];

  const codeCheck = looksLikeCode(code);
  if (!codeCheck.ok) return { status: "rejected", note: codeCheck.why };

  const prose = looksLikeProse(descr);
  if (!prose.ok) notes.push(prose.why);

  if (!String(title || "").trim()) notes.push("No title.");
  if (!String(game || "").trim()) notes.push("No game named.");

  // A title that is one character repeated. Length-gated on purpose: "V4" and
  // "X" are short, not mash, and flagging them held honest uploads.
  const t = String(title || "").trim().replace(/\s+/g, "");
  if (t.length >= 4 && new Set(t).size <= 2)
    notes.push("The title looks like keyboard mash.");

  // Weak-but-not-absent code signal: hold rather than publish.
  if (codeCheck.hits < 3) notes.push("Only a weak code signal.");

  if (!notes.length) return { status: "approved", note: "" };
  return { status: "review", note: notes.join(" ") };
}

/* ══════════════════════════════════════════════════ AI descriptions ══ */

const DESCRIBE_PROMPT = `You rewrite short descriptions of Roblox scripts for a
public script library.

Rules, in order of importance:
1. NEVER add a feature, claim, or guarantee the author did not write. If they
   did not say it is undetectable, safe, or updated, you must not say so.
2. Keep their meaning exactly. You are fixing the writing, not the facts.
3. Fix spelling, grammar and capitalisation. Expand shorthand ("af" ->
   "auto farm") only when the meaning is unambiguous.
4. Explain the features they DID mention a little more clearly.
5. Remove repetition. No marketing language, no hype, no emoji.
6. 2-4 sentences, plain and professional.

Reply with ONLY minified JSON, no code fence:
{"description":"...","tags":["...","..."]}

tags: 3-6 short PascalCase topic tags with no "#", drawn from the game name
and the features the author actually described.`;

/**
 * Tidies a creator's description without inventing anything.
 *
 * The failure mode worth naming: a model asked to "make this sound
 * professional" will happily promise the script is undetectable, regularly
 * updated and works on every executor — none of which the author said, all of
 * which the site would then be publishing as fact. Hence rule 1, a low
 * temperature, and a caller that falls back to the original text rather than
 * shipping something it could not parse.
 */
async function enhanceDescription(env, { descr, title, game }) {
  const original = String(descr || "").trim();
  if (!original || !env.AI) return { description: original, tags: [], ai: false };

  const ask = `Game: ${String(game || "Roblox").slice(0, 60)}
Script name: ${String(title || "").slice(0, 80)}
Author's description: ${original.slice(0, 1200)}`;

  const models = env.AI_MODEL ? [env.AI_MODEL] : CF_MODELS;
  for (const model of models) {
    try {
      const out = await env.AI.run(model, {
        messages: [
          { role: "system", content: DESCRIBE_PROMPT },
          { role: "user", content: ask },
        ],
        max_tokens: 500,
        temperature: 0.2,
      });

      const text = String(out?.response ?? out?.result?.response ?? "").trim();
      const json = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      const start = json.indexOf("{");
      const end = json.lastIndexOf("}");
      if (start === -1 || end === -1) continue;

      const parsed = JSON.parse(json.slice(start, end + 1));
      const description = String(parsed.description || "").trim();
      if (!description) continue;

      const tags = (Array.isArray(parsed.tags) ? parsed.tags : [])
        .map((t) => String(t).replace(/[^A-Za-z0-9]/g, "").slice(0, 24))
        .filter(Boolean)
        .slice(0, 6);

      return { description, tags, ai: true };
    } catch (err) {
      console.warn("describe model failed", model, err?.message);
    }
  }
  // Every model refused or answered unusably. The author's own words ship.
  return { description: original, tags: [], ai: false };
}

/**
 * Preview endpoint: the creator sees the rewrite BEFORE publishing.
 *
 * Deliberately a separate call rather than something publish does silently.
 * Rewriting somebody's words and posting the result under their name without
 * showing them first is not a feature, it is a liberty.
 */
async function handleDescribe(request, env) {
  const user = await currentUser(request, env);
  if (!user) return bad(401, "Sign in first.");
  if (!(await underLimit(env, `describe:${user.id}`, 20, 600)))
    return bad(429, "That's a lot of rewrites. Try again shortly.");

  const body = await request.json().catch(() => ({}));
  const descr = String(body.desc || "").trim();
  if (!descr) return bad(400, "Write a description first.");
  if (descr.length > SCRIPT_LIMITS.descr) return bad(400, "That description is too long.");

  const out = await enhanceDescription(env, {
    descr, title: body.title, game: body.game,
  });
  return ok({ data: { ...out, original: descr } });
}

/* ═══════════════════════════════════════════════════════════════ discord ══ */

/**
 * Discord, in four parts that share almost nothing:
 *
 *   1. Announcements — a webhook post when somebody publishes.
 *   2. Sign-in       — OAuth2, so an account can be a Discord account.
 *   3. The gate      — optionally, an unlock requires being in the server.
 *   4. Stats         — member and online counts, shown on the site.
 *
 * Each is independently switch-off-able, and each is OFF until its variables
 * exist. That is not politeness; it is the only way a half-configured Discord
 * cannot take the site down with it. A missing webhook must not fail a
 * publish, and a Discord outage must not stop people getting scripts.
 *
 * Variables:
 *   DISCORD_WEBHOOK_URL     secret — announcements
 *   DISCORD_CLIENT_ID       text   — OAuth application id (public by design)
 *   DISCORD_CLIENT_SECRET   secret — OAuth
 *   DISCORD_BOT_TOKEN       secret — membership checks and exact counts
 *   DISCORD_GUILD_ID        text   — which server
 *   DISCORD_REQUIRE_MEMBER  text   — "1" turns the members-only gate ON
 *   DISCORD_INVITE          text   — the invite shown when somebody is refused
 */

const DISCORD_API = "https://discord.com/api/v10";

const discordSignIn = (env) => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);

/**
 * Whether the members-only gate is on.
 *
 * Three things have to be true, and the flag is the least of them: without a
 * bot token and a guild id there is nothing to check membership against, and a
 * gate that cannot check is a gate that refuses everyone. Sign-in has to work
 * too — otherwise nobody has a Discord identity to check in the first place.
 */
function discordGateOn(env) {
  return Boolean(
    /^(1|true|yes|on)$/i.test(String(env.DISCORD_REQUIRE_MEMBER || "")) &&
    env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID && discordSignIn(env)
  );
}

const discordInvite = (env) => String(env.DISCORD_INVITE || "").trim();

/* ------------------------------------------------------------------ cache */

/**
 * A tiny key/value cache in D1.
 *
 * Discord rate-limits per route and per bot, and the answers here move slowly:
 * a member count is interesting to a visitor and uninteresting one second
 * later. Reading a row beats an outbound request on both latency and the 10ms
 * CPU budget, and it means a Discord outage degrades to a stale number rather
 * than a spinner.
 */
async function cacheGet(env, key) {
  try {
    const row = await env.DB.prepare(`SELECT v FROM cache WHERE k = ? AND expires > ?`)
      .bind(key, nowSec()).first();
    return row ? JSON.parse(row.v) : null;
  } catch { return null; }
}

async function cachePut(env, key, value, ttlSec) {
  try {
    await env.DB.prepare(
      `INSERT INTO cache (k, v, expires) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires = excluded.expires`
    ).bind(key, JSON.stringify(value), nowSec() + ttlSec).run();
  } catch { /* the cache is an optimisation, never a requirement */ }
}

/* ----------------------------------------------------------- announcements */

/**
 * Posts a new script to the channel behind DISCORD_WEBHOOK_URL.
 *
 * Called through ctx.waitUntil, so the publisher's request returns the moment
 * the row is written and does not wait on Discord. It cannot throw into the
 * caller and it cannot fail a publish: every path here ends in a swallowed
 * error. A dead webhook is a missing message, not a broken site.
 */
async function announceScript(env, script, authorName) {
  const hook = String(env.DISCORD_WEBHOOK_URL || "").trim();
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i.test(hook)) return;

  const site = env.SITE_URL || "https://lucritscripts.site";
  const link = `${site}/creations/${encodeURIComponent(authorName)}/${encodeURIComponent(
    String(script.id).replace(/^s_/, ""))}`;

  // Only an https thumbnail. Uploaded artwork is stored as a data: URL, which
  // Discord cannot fetch — sending one produces an embed with a broken image
  // rather than an embed with no image.
  const art = /^https:\/\//i.test(String(script.thumbnail || "")) ? script.thumbnail : null;

  // The description is trimmed at a word boundary rather than mid-syllable.
  // Publishing demands a hundred words, so every one of these WILL be cut, and
  // "...a really useful scr" reads like the post itself is broken.
  const full = String(script.descr || "").trim();
  const blurb = full.length > 300
    ? full.slice(0, 300).replace(/\s+\S*$/, "") + "…"
    : full;

  const body = {
    // No content, so the message is the embed alone and nothing is @-pinged.
    embeds: [{
      title: String(script.title || "New script").slice(0, 256),
      url: link,
      description: blurb,
      color: 0x7cc4ff,
      author: { name: `@${authorName}`, url: `${site}/creators/${encodeURIComponent(authorName)}` },
      fields: [
        { name: "Game", value: String(script.game || "Roblox").slice(0, 100), inline: true },
        { name: "Keyless", value: script.keyless ? "Yes" : "Key required", inline: true },
        // The title is already a link, but a hyperlinked heading does not read
        // as a button — people scroll past it. This is the call to action, on
        // its own line, saying what happens when you press it.
        { name: "\u200b", value: `**[Get the script →](${link})**` },
      ],
      ...(art ? { thumbnail: { url: art } } : {}),
      footer: { text: "Lucrit Script · lucritscripts.site" },
      timestamp: new Date().toISOString(),
    }],
    // Belt and braces: even if a title or description ever carried an @everyone,
    // this tells Discord to render it as text rather than ping the server.
    allowed_mentions: { parse: [] },
  };

  try {
    await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    console.warn("discord announce failed", err?.message);
  }
}

/* ------------------------------------------------------------------ OAuth */

const DISCORD_STATE_COOKIE = "__Host-lucrit-oauth";
const DISCORD_SCOPES = "identify email guilds";

const discordRedirect = (env, request) =>
  `${env.SITE_URL || new URL(request.url).origin}/api/auth/discord/callback`;

/**
 * Step one: send them to Discord.
 *
 * The `state` is the CSRF defence and it is not decoration. Without it,
 * anybody can hand a victim a crafted callback URL carrying the ATTACKER's
 * authorization code, and the victim's browser quietly signs itself into the
 * attacker's account — after which everything the victim publishes belongs to
 * someone else. The value is random, lives in an httpOnly cookie, and the
 * callback refuses anything that does not match it.
 */
async function handleDiscordStart(request, env) {
  if (!discordSignIn(env)) return bad(503, "Discord sign-in isn't configured yet.");

  const state = randomHex(16);
  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", discordRedirect(env, request));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DISCORD_SCOPES);
  url.searchParams.set("state", state);
  // Always show the consent screen rather than silently reusing a grant, so
  // "sign in as someone else" is actually reachable.
  url.searchParams.set("prompt", "consent");

  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Cache-Control": "no-store",
      "Set-Cookie": cookieHeader(state, 600, DISCORD_STATE_COOKIE),
    },
  });
}

/** Sends the browser back to the site with a message the page can read. */
function discordBounce(env, request, params) {
  const site = env.SITE_URL || new URL(request.url).origin;
  const url = new URL(site + "/");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Cache-Control": "no-store",
      // The state is single-use; clear it whichever way this went.
      "Set-Cookie": cookieHeader("", 0, DISCORD_STATE_COOKIE),
    },
  });
}

async function handleDiscordCallback(request, env) {
  if (!discordSignIn(env)) return bad(503, "Discord sign-in isn't configured yet.");

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expect = readCookie(request, DISCORD_STATE_COOKIE);

  // Someone declining on Discord's own screen is not an error worth a page.
  if (url.searchParams.get("error")) return discordBounce(env, request, { discord: "cancelled" });
  if (!code) return discordBounce(env, request, { discord: "failed" });
  if (!expect || !state || !sameSecret(state, expect))
    return discordBounce(env, request, { discord: "state" });

  if (!(await underLimit(env, `dsignin:${clientIp(request)}`, 10, 600)))
    return discordBounce(env, request, { discord: "slowdown" });

  let profile;
  try {
    const token = await fetch(DISCORD_API + "/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: discordRedirect(env, request),
      }),
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());

    if (!token?.access_token) throw new Error("no access token");

    profile = await fetch(DISCORD_API + "/users/@me", {
      headers: { Authorization: "Bearer " + token.access_token },
      signal: AbortSignal.timeout(8000),
    }).then((r) => r.json());
  } catch (err) {
    console.warn("discord oauth failed", err?.message);
    return discordBounce(env, request, { discord: "failed" });
  }

  if (!profile?.id) return discordBounce(env, request, { discord: "failed" });

  const row = await upsertDiscordUser(env, profile);
  if (row.error) return discordBounce(env, request, { discord: row.error });

  const session = await startSession(env, row.user.id);
  const site = env.SITE_URL || new URL(request.url).origin;
  const back = new URL(site + "/");
  back.searchParams.set("discord", "ok");

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", back.toString()],
      ["Cache-Control", "no-store"],
      ["Set-Cookie", cookieHeader(session, SESSION_DAYS * 86400)],
      ["Set-Cookie", cookieHeader("", 0, DISCORD_STATE_COOKIE)],
    ],
  });
}

/**
 * Finds or creates the account behind a Discord profile.
 *
 * Matching order matters, and the second step is where account takeover would
 * live if it were done carelessly:
 *
 *   1. `discord_id` — they have signed in this way before. Unambiguous.
 *   2. a VERIFIED email — someone who signed up with a password and is now
 *      using Discord should land on their existing account, not a second one.
 *   3. a new account.
 *
 * Step 2 is gated on `profile.verified` because Discord will happily report an
 * address nobody proved they own. Linking on an unverified one would mean
 * anybody could register a Discord account claiming somebody else's email and
 * walk straight into their scripts. Unverified addresses therefore get a fresh
 * account, and a collision is refused rather than merged.
 */
async function upsertDiscordUser(env, profile) {
  const discordId = String(profile.id);
  const mail = String(profile.email || "").trim();
  const lower = mail.toLowerCase();
  const verified = Boolean(profile.verified) && RULES.email.test(mail);

  let row = await env.DB.prepare(`SELECT * FROM users WHERE discord_id = ?`)
    .bind(discordId).first();

  if (!row && verified) {
    row = await env.DB.prepare(`SELECT * FROM users WHERE email_lower = ?`).bind(lower).first();
    if (row) {
      await env.DB.prepare(`UPDATE users SET discord_id = ? WHERE id = ?`)
        .bind(discordId, row.id).run();
    }
  }

  if (!row) {
    if (lower) {
      const taken = await env.DB.prepare(`SELECT 1 FROM users WHERE email_lower = ?`)
        .bind(lower).first();
      // Only reachable with an unverified address, since a verified one linked
      // above. Refusing is the whole point.
      if (taken) return { error: "emailtaken" };
    }

    // Discord's modern usernames are lowercase and unique over there, but they
    // may still collide with a name chosen here, and they may contain
    // characters this site's own rule rejects.
    const seed = String(profile.global_name || profile.username || "discord")
      .replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 28) || "discord";
    const name = await freeUsername(env, seed);

    const id = newId();
    const avatar = profile.avatar
      ? `https://cdn.discordapp.com/avatars/${discordId}/${profile.avatar}.png?size=128`
      : null;

    try {
      await env.DB.prepare(
        `INSERT INTO users (id, email, email_lower, discord_id, username, username_lower,
                            bio, avatar, youtube, tiktok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, '', ?, '', '', ?)`
      ).bind(
        id,
        // An account needs an address. Discord accounts without a shared email
        // get a routable-looking placeholder rather than an empty column, and
        // password reset simply has nothing to send to — which is correct:
        // there is no password on this account to reset.
        mail || `discord-${discordId}@users.noreply.lucritscripts.site`,
        lower || `discord-${discordId}@users.noreply.lucritscripts.site`,
        discordId, name, name.toLowerCase(), avatar, new Date().toISOString()
      ).run();
    } catch (err) {
      console.error("discord signup failed", err?.message);
      return { error: "failed" };
    }
    row = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first();
  }

  // Discord proves who they are, not that they are welcome.
  if (row.banned) return { error: "banned" };
  return { user: row };
}

/* ────────────────────────────────────────────────────── the bot ── */

/**
 * Discord as a real integration rather than a webhook.
 *
 * A webhook can post into ONE channel and can never touch a message again.
 * That is enough for "tell the server something happened" and nothing more.
 * Routing a script to its game's channel, editing the post when the creator
 * changes the description, striking it through when a script is taken down,
 * creating a channel the first time a game appears — every one of those needs
 * a bot token, so the webhook is a fallback here, not the mechanism.
 *
 * All of it is plain REST. Nothing here opens a gateway socket, because a
 * Worker cannot hold one open: it wakes for a request and dies. That is fine
 * for everything the WEBSITE initiates, and it is the reason two things in the
 * brief cannot live here — see the note on gateway features below.
 */

const botOn = (env) => Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_GUILD_ID);

/**
 * One call to Discord.
 *
 * Returns null on any failure rather than throwing. Every caller is a
 * side-effect on a path that must not fail because Discord had a bad minute —
 * a publish succeeds whether or not the server hears about it.
 */
async function bot(env, path, { method = "GET", body, timeout = 8000 } = {}) {
  if (!env.DISCORD_BOT_TOKEN) return null;
  try {
    const res = await fetch(DISCORD_API + path, {
      method,
      headers: {
        Authorization: "Bot " + env.DISCORD_BOT_TOKEN,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });

    if (res.status === 204) return {};
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* Discord sent something else */ }

    if (!res.ok) {
      // 429 carries retry_after; there is no point sleeping inside a Worker
      // with a 10ms CPU budget, so the caller simply misses this one.
      console.warn("discord bot", method, path, res.status, String(text).slice(0, 200));
      return null;
    }
    return data ?? {};
  } catch (err) {
    console.warn("discord bot failed", method, path, err?.message);
    return null;
  }
}

/* ---------------------------------------------------------- channels */

/** Discord's own rules for a text channel name: lowercase, no spaces, ≤100. */
function channelName(game) {
  return String(game || "unknown")
    .toLowerCase()
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || "unknown";
}

/**
 * The channel a game's scripts go in, creating it if this is the first one.
 *
 * Three layers, cheapest first: the mapping table, then the guild's existing
 * channels (so a channel somebody made by hand is adopted rather than
 * duplicated), then creating one. That middle step matters — without it,
 * pointing the bot at a server that already has #blox-fruits produces
 * #blox-fruits-2 and splits the game in half.
 */
async function gameChannel(env, gameName) {
  if (!botOn(env)) return null;
  const slug = channelName(gameName);

  const known = await env.DB.prepare(`SELECT channel_id FROM game_channels WHERE game_slug = ?`)
    .bind(slug).first().catch(() => null);
  if (known?.channel_id) return known.channel_id;

  const channels = await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  if (!Array.isArray(channels)) return null;

  // Adopt a matching channel if the server already has one.
  let found = channels.find((c) => c.type === 0 && c.name === slug);

  if (!found) {
    const parent = await gamesCategory(env, channels);
    found = await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`, {
      method: "POST",
      body: {
        name: slug,
        type: 0,
        topic: `Scripts for ${String(gameName).slice(0, 80)} — posted automatically from lucritscripts.site`,
        ...(parent ? { parent_id: parent } : {}),
      },
    });
    if (!found?.id) return null;
  }

  await env.DB.prepare(
    `INSERT INTO game_channels (game_slug, game_name, channel_id, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(game_slug) DO UPDATE SET channel_id = excluded.channel_id`
  ).bind(slug, String(gameName).slice(0, 80), found.id, nowSec()).run().catch(() => {});

  return found.id;
}

/** The GAMES category, adopted or created, so new channels are not loose. */
async function gamesCategory(env, channels) {
  const existing = channels.find((c) => c.type === 4 && /games/i.test(c.name));
  if (existing) return existing.id;
  const made = await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`, {
    method: "POST", body: { name: "GAMES", type: 4 },
  });
  return made?.id || null;
}

/** A channel by name anywhere in the guild — #all-scripts and friends. */
async function namedChannel(env, name) {
  if (!botOn(env)) return null;
  const slug = channelName(name);

  const known = await env.DB.prepare(`SELECT channel_id FROM game_channels WHERE game_slug = ?`)
    .bind("~" + slug).first().catch(() => null);
  if (known?.channel_id) return known.channel_id;

  const channels = await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`);
  if (!Array.isArray(channels)) return null;

  let found = channels.find((c) => c.type === 0 && c.name === slug);
  if (!found) {
    found = await bot(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`, {
      method: "POST", body: { name: slug, type: 0 },
    });
    if (!found?.id) return null;
  }

  // Stored under a "~" prefix so a game can never collide with a feed channel.
  await env.DB.prepare(
    `INSERT INTO game_channels (game_slug, game_name, channel_id, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(game_slug) DO UPDATE SET channel_id = excluded.channel_id`
  ).bind("~" + slug, slug, found.id, nowSec()).run().catch(() => {});

  return found.id;
}

/* ------------------------------------------------------ the embed */

/** Discord's cap is 300 for a field value; trim at a word, not a syllable. */
function clip(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

/**
 * One script, as Discord renders it.
 *
 * `state` lets the same builder produce the live post and the struck-through
 * version left behind when a script is taken down — so an edit is one call
 * with a different flag rather than a second near-identical template that
 * drifts out of sync with this one.
 */
function scriptEmbed(env, script, author, { state = "live" } = {}) {
  const site = env.SITE_URL || "https://lucritscripts.site";
  const slug = String(script.id).replace(/^s_/, "");
  const link = `${site}/creations/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`;
  const who = `${site}/creators/${encodeURIComponent(author)}`;
  const gone = state !== "live";

  let tags = [];
  try { tags = JSON.parse(script.tags || "[]"); } catch { tags = []; }
  const hashes = [String(script.game || "Roblox"), ...tags, "Roblox"]
    .map((t) => "#" + String(t).replace(/[^A-Za-z0-9]/g, ""))
    .filter((t) => t.length > 1)
    .slice(0, 6)
    .join(" ");

  // Uploaded artwork is a data: URL, which Discord cannot fetch. Sending one
  // produces a broken image rather than no image.
  const art = /^https:\/\//i.test(String(script.thumbnail || "")) ? script.thumbnail : null;

  const stats = [];
  if (script.views) stats.push(`👁️ ${script.views}`);
  if (script.copies) stats.push(`📋 ${script.copies}`);
  if (script.likes) stats.push(`❤️ ${script.likes}`);

  return {
    title: gone ? `~~${clip(script.title, 240)}~~` : clip(script.title, 256),
    url: gone ? undefined : link,
    description: gone
      ? "**This script is no longer available on Lucrit Scripts.**"
      : clip(script.descr, 400),
    color: gone ? 0x4a5568 : 0x7cc4ff,
    author: { name: `@${author}`, url: who },
    fields: [
      { name: "🎮 Game", value: clip(script.game || "Roblox", 100), inline: true },
      { name: "🔑 Keyless", value: script.keyless ? "Yes" : "Key required", inline: true },
      ...(stats.length ? [{ name: "📊 Stats", value: stats.join("  ·  "), inline: true }] : []),
      ...(hashes && !gone ? [{ name: "​", value: hashes }] : []),
      ...(gone ? [] : [{ name: "​", value: `**[🔗 Get Script](${link})**  ·  [Creator](${who})` }]),
    ],
    ...(art && !gone ? { thumbnail: { url: art } } : {}),
    footer: { text: "Lucrit Scripts · lucritscripts.site" },
    timestamp: new Date(script.created_at || Date.now()).toISOString(),
  };
}

/* ------------------------------------------------ publish / update */

/**
 * Puts a script in every Discord channel it belongs in, and remembers where.
 *
 * The message ids are the point. Fire-and-forget posting means a script taken
 * down on the website keeps a live Get Script button in the server forever, so
 * every send is recorded against the script before this returns.
 *
 * Never throws. A publish is not allowed to fail because Discord is down.
 */
async function announceScriptBot(env, script, author) {
  if (!botOn(env)) return;
  try {
    await postScriptEverywhere(env, script, author);
  } catch (err) {
    // A publish must not fail because a channel lookup threw. `bot()` already
    // swallows network failures; this catches the rest — a malformed embed, a
    // database hiccup — so the worst case stays "no Discord post".
    console.warn("discord announce failed", err?.stack || err?.message);
  }
}

async function postScriptEverywhere(env, script, author) {
  const embed = scriptEmbed(env, script, author);
  const targets = [];

  const all = await namedChannel(env, "all-scripts");
  if (all) targets.push({ id: all, kind: "all" });

  const game = await gameChannel(env, script.game);
  // A game whose channel IS #all-scripts would otherwise be posted twice.
  if (game && game !== all) targets.push({ id: game, kind: "game" });

  const site = env.SITE_URL || "https://lucritscripts.site";
  const slug = String(script.id).replace(/^s_/, "");
  await feedLine(env, "latest-scripts",
    `🆕 **${clip(script.title, 80)}** · ${clip(script.game || "Roblox", 40)} · by @${author}\n` +
    `${site}/creations/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`);

  for (const t of targets) {
    const sent = await bot(env, `/channels/${t.id}/messages`, {
      method: "POST",
      body: { embeds: [embed], allowed_mentions: { parse: [] } },
    });
    if (!sent?.id) continue;
    await env.DB.prepare(
      `INSERT INTO script_posts (script_id, channel_id, message_id, kind, at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(script_id, channel_id) DO UPDATE SET message_id = excluded.message_id`
    ).bind(script.id, t.id, sent.id, t.kind, nowSec()).run().catch(() => {});
  }
}

/**
 * Re-renders every post for a script after something about it changed.
 *
 * Editing rather than reposting is deliberate: a corrected description should
 * not push the channel's older scripts down, and the link people already have
 * should keep working.
 */
async function syncScriptPosts(env, script, author, { state = "live" } = {}) {
  if (!botOn(env)) return;
  const { results } = await env.DB.prepare(
    `SELECT channel_id, message_id FROM script_posts WHERE script_id = ?`
  ).bind(script.id).all().catch(() => ({ results: [] }));

  const embed = scriptEmbed(env, script, author, { state });
  for (const row of results || []) {
    await bot(env, `/channels/${row.channel_id}/messages/${row.message_id}`, {
      method: "PATCH",
      body: { embeds: [embed], allowed_mentions: { parse: [] } },
    });
  }
}

/**
 * A script left the website.
 *
 * Marked rather than deleted by default: a channel where messages silently
 * vanish reads as a bug, and the struck-through card tells somebody who
 * bookmarked it what actually happened. DISCORD_DELETE_REMOVED=1 removes them
 * outright instead.
 */
async function retireScriptPosts(env, script, author) {
  if (!botOn(env)) return;

  if (/^(1|true|yes|on)$/i.test(String(env.DISCORD_DELETE_REMOVED || ""))) {
    const { results } = await env.DB.prepare(
      `SELECT channel_id, message_id FROM script_posts WHERE script_id = ?`
    ).bind(script.id).all().catch(() => ({ results: [] }));
    for (const row of results || []) {
      await bot(env, `/channels/${row.channel_id}/messages/${row.message_id}`, { method: "DELETE" });
    }
    await env.DB.prepare(`DELETE FROM script_posts WHERE script_id = ?`)
      .bind(script.id).run().catch(() => {});
    return;
  }

  await syncScriptPosts(env, script, author, { state: "removed" });
}

/**
 * Anything the staff should see, in one channel.
 *
 * Kept deliberately plain — this is a log, not a feed. It exists so that
 * "why did that script never appear" has an answer that is not "read the
 * Worker's console".
 */
async function modLog(env, title, description, color = 0xf6c343) {
  if (!botOn(env)) return;
  const channel = await namedChannel(env, "moderation-logs");
  if (!channel) return;
  await bot(env, `/channels/${channel}/messages`, {
    method: "POST",
    body: {
      embeds: [{
        title: clip(title, 256),
        description: clip(description, 1000),
        color,
        timestamp: new Date().toISOString(),
      }],
      allowed_mentions: { parse: [] },
    },
  });
}

/* ─────────────────────────────────────────────── server provisioning ── */

/**
 * The whole server layout, as data.
 *
 * Declarative on purpose. Adding `#clips` later is one line here, not a new
 * function — and because provisioning is idempotent, re-running it creates
 * only what is missing and leaves everything else alone. That is what makes
 * this safe to run against a server people are already using.
 *
 * `private: true` marks staff channels: @everyone is denied View Channel, so
 * moderation logs are not a public feed of what got rejected and why.
 */
const SERVER_LAYOUT = [
  {
    category: "📌 INFORMATION",
    channels: [
      { name: "welcome", topic: "Start here — what Lucrit Scripts is and how to use it." },
      { name: "rules", topic: "Read before posting." },
      { name: "announcements", topic: "Site updates and news." },
      { name: "how-to-use", topic: "How to find, unlock and run a script." },
      { name: "faq", topic: "Common questions." },
      { name: "website", topic: "https://lucritscripts.site" },
    ],
  },
  {
    category: "📜 SCRIPTS",
    channels: [
      { name: "all-scripts", topic: "Every approved script, newest first. Posted automatically." },
      { name: "latest-scripts", topic: "The newest releases." },
      { name: "popular-scripts", topic: "Most viewed and copied." },
      { name: "updated-scripts", topic: "Scripts their creators have changed." },
    ],
  },
  // Games live in their own category, but the channels inside it are created
  // on demand by gameChannel() — the first Blox Fruits script makes
  // #blox-fruits. Listing games here would mean editing code to add a game.
  { category: "🎮 GAMES", channels: [] },
  {
    category: "⚙️ EXECUTORS",
    channels: [
      { name: "executors", topic: "Roblox executors, published by staff." },
      { name: "latest-executors", topic: "Newly added executors." },
      { name: "executor-updates", topic: "Version and status changes." },
      { name: "executor-discussion", topic: "Talk about executors here." },
    ],
  },
  {
    category: "🏆 COMMUNITY",
    channels: [
      { name: "leaderboards", topic: "Top creators and scripts, updated automatically." },
      { name: "script-discussion", topic: "Talk about scripts here." },
      { name: "suggestions", topic: "Ideas for the site or the server." },
      { name: "support", topic: "Need help? Ask here." },
    ],
  },
  {
    category: "🛡️ STAFF",
    private: true,
    channels: [
      { name: "moderation-logs", topic: "Automated record of publishes, removals and admin actions." },
      { name: "bot-logs", topic: "Integration errors and diagnostics." },
      { name: "content-review", topic: "Submissions held for a human decision." },
    ],
  },
];

/**
 * Creates the server structure, skipping anything that already exists.
 *
 * Returns a report rather than throwing, because half-provisioned is a real
 * outcome: Discord rate-limits channel creation hard, and the useful answer to
 * "it stopped after nine channels" is a list of what was made and what was
 * not, not a stack trace.
 */
async function provisionServer(env) {
  if (!botOn(env)) return { ok: false, error: "No bot token." };

  const guild = env.DISCORD_GUILD_ID;
  const existing = await bot(env, `/guilds/${guild}/channels`);
  if (!Array.isArray(existing)) return { ok: false, error: "Could not read the server's channels." };

  const byName = (name, type) =>
    existing.find((c) => c.type === type && c.name.toLowerCase() === name.toLowerCase());

  const made = [];
  const kept = [];
  const failed = [];

  for (const group of SERVER_LAYOUT) {
    let cat = byName(group.category, 4);
    if (!cat) {
      cat = await bot(env, `/guilds/${guild}/channels`, {
        method: "POST",
        body: {
          name: group.category,
          type: 4,
          // Staff categories start closed. Channels inside inherit this, so a
          // new log channel is never briefly public while somebody remembers
          // to lock it.
          ...(group.private ? {
            permission_overwrites: [{ id: guild, type: 0, deny: String(1 << 10) }],
          } : {}),
        },
      });
      if (cat?.id) { made.push(group.category); existing.push(cat); }
      else { failed.push(group.category); continue; }
    } else kept.push(group.category);

    for (const ch of group.channels) {
      const found = byName(ch.name, 0);
      if (found) {
        kept.push("#" + ch.name);
        // Adopted channels still get filed under their category, so a server
        // that already had #faq loose at the top ends up organised.
        if (found.parent_id !== cat.id) {
          await bot(env, `/channels/${found.id}`, { method: "PATCH", body: { parent_id: cat.id } });
        }
        continue;
      }
      const created = await bot(env, `/guilds/${guild}/channels`, {
        method: "POST",
        body: {
          name: ch.name, type: 0, parent_id: cat.id,
          topic: String(ch.topic || "").slice(0, 1024),
          ...(group.private ? {
            permission_overwrites: [{ id: guild, type: 0, deny: String(1 << 10) }],
          } : {}),
        },
      });
      if (created?.id) { made.push("#" + ch.name); existing.push(created); }
      else failed.push("#" + ch.name);
    }
  }

  // Cache the feed channels so posting does not re-list the guild every time.
  for (const name of ["all-scripts", "latest-scripts", "popular-scripts", "updated-scripts",
                      "executors", "latest-executors", "executor-updates",
                      "moderation-logs", "bot-logs", "content-review", "leaderboards"]) {
    const c = byName(name, 0);
    if (c) {
      await env.DB.prepare(
        `INSERT INTO game_channels (game_slug, game_name, channel_id, at) VALUES (?, ?, ?, ?)
         ON CONFLICT(game_slug) DO UPDATE SET channel_id = excluded.channel_id`
      ).bind("~" + name, name, c.id, nowSec()).run().catch(() => {});
    }
  }

  return { ok: true, made, kept, failed };
}

async function handleAdminDiscordSetup(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const report = await provisionServer(env);
  if (!report.ok) return bad(503, report.error);
  await modLog(env, "Server structure provisioned",
    `Created: ${report.made.join(", ") || "nothing"}\nAlready there: ${report.kept.length}`, 0x66bb6a);
  return ok({ data: report });
}

/* ──────────────────────────────────────────────────────── leaderboards ── */

/**
 * The leaderboard, as one message that is edited rather than reposted.
 *
 * Reposting would bury the channel in a new ranking every hour and make
 * "current" mean "scroll to the bottom". One pinned message that updates in
 * place is the whole point — and `script_posts` already knows how to remember
 * a message id, so the board reuses it under a reserved key.
 */
async function postLeaderboards(env) {
  if (!botOn(env)) return { ok: false, error: "No bot token." };
  const channel = await namedChannel(env, "leaderboards");
  if (!channel) return { ok: false, error: "No #leaderboards channel." };

  const rows = async (sql, limit = 10) => {
    const { results } = await env.DB.prepare(sql).bind(limit).all().catch(() => ({ results: [] }));
    return results || [];
  };

  const creators = await rows(
    `SELECT u.username AS name,
            COUNT(DISTINCT s.id) AS scripts,
            COALESCE(SUM(s.views), 0) AS views,
            COALESCE(SUM(s.copies), 0) AS copies
       FROM users u JOIN scripts s ON s.author_id = u.id
      WHERE s.removed = 0 AND s.status = 'approved' AND u.banned = 0
      GROUP BY u.id
      ORDER BY (COALESCE(SUM(s.views),0) + COALESCE(SUM(s.copies),0) * 3) DESC
      LIMIT ?`);

  const popular = await rows(
    `SELECT s.title AS title, u.username AS author, s.views AS views, s.copies AS copies,
            (SELECT COUNT(*) FROM likes l WHERE l.script_id = s.id) AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id
      WHERE s.removed = 0 AND s.status = 'approved' AND u.banned = 0
      ORDER BY (s.views + s.copies * 3) DESC LIMIT ?`);

  // Trending is unlocks in the last 48 hours, not all-time. Without the window
  // this is just the popular board again with different words on it.
  const since = nowSec() - 48 * 3600;
  const { results: trend } = await env.DB.prepare(
    `SELECT s.title AS title, u.username AS author, COUNT(*) AS recent
       FROM unlock_events e
       JOIN scripts s ON s.id = e.script_id
       JOIN users u ON u.id = s.author_id
      WHERE e.at > ? AND s.removed = 0 AND s.status = 'approved' AND u.banned = 0
      GROUP BY e.script_id ORDER BY recent DESC LIMIT 10`
  ).bind(since).all().catch(() => ({ results: [] }));

  const medal = (i) => ["🥇", "🥈", "🥉"][i] || `\`${String(i + 1).padStart(2, " ")}\``;
  const site = env.SITE_URL || "https://lucritscripts.site";

  const creatorLines = creators.map((r, i) =>
    `${medal(i)} **${clip(r.name, 40)}** — ${r.scripts} script${r.scripts === 1 ? "" : "s"} · ${r.views} views · ${r.copies} copies`);
  const popularLines = popular.map((r, i) =>
    `${medal(i)} **${clip(r.title, 60)}** by ${clip(r.author, 30)} — ${r.views} views · ${r.likes} ❤️`);
  const trendLines = (trend || []).map((r, i) =>
    `${medal(i)} **${clip(r.title, 60)}** by ${clip(r.author, 30)} — ${r.recent} in 48h`);

  const embeds = [
    {
      title: "🏆 Top Creators",
      description: creatorLines.join("\n") || "_Nobody has published yet._",
      color: 0xf6c343,
    },
    {
      title: "🔥 Most Popular Scripts",
      description: popularLines.join("\n") || "_No scripts yet._",
      color: 0xff7043,
    },
    {
      title: "📈 Trending — last 48 hours",
      description: trendLines.join("\n") || "_Nothing unlocked in the last two days._",
      color: 0x7cc4ff,
      footer: { text: `Lucrit Scripts · ${site.replace(/^https?:\/\//, "")} · updates automatically` },
      timestamp: new Date().toISOString(),
    },
  ];

  const KEY = "~board:main";
  const known = await env.DB.prepare(
    `SELECT message_id FROM script_posts WHERE script_id = ? AND channel_id = ?`
  ).bind(KEY, channel).first().catch(() => null);

  if (known?.message_id) {
    const edited = await bot(env, `/channels/${channel}/messages/${known.message_id}`, {
      method: "PATCH", body: { embeds, allowed_mentions: { parse: [] } },
    });
    if (edited) return { ok: true, edited: true };
    // The message was deleted by hand; fall through and post a new one.
  }

  const sent = await bot(env, `/channels/${channel}/messages`, {
    method: "POST", body: { embeds, allowed_mentions: { parse: [] } },
  });
  if (!sent?.id) return { ok: false, error: "Could not post the board." };

  await env.DB.prepare(
    `INSERT INTO script_posts (script_id, channel_id, message_id, kind, at)
     VALUES (?, ?, ?, 'board', ?)
     ON CONFLICT(script_id, channel_id) DO UPDATE SET message_id = excluded.message_id`
  ).bind(KEY, channel, sent.id, nowSec()).run().catch(() => {});

  // Pinned so it stays reachable as the channel fills.
  await bot(env, `/channels/${channel}/pins/${sent.id}`, { method: "PUT" });
  return { ok: true, posted: true };
}

async function handleAdminLeaderboards(request, env) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;
  const out = await postLeaderboards(env);
  if (!out.ok) return bad(503, out.error);
  return ok({ data: out });
}

/* ---------------------------------------------------------- feed posts */

/**
 * The three secondary feeds.
 *
 * #latest-scripts gets a line per publish. #popular-scripts and
 * #updated-scripts are single edited messages like the leaderboard, because a
 * "most popular" channel that appends is a history of what used to be popular.
 */
async function feedLine(env, name, text) {
  if (!botOn(env)) return;
  const channel = await namedChannel(env, name);
  if (!channel) return;
  await bot(env, `/channels/${channel}/messages`, {
    method: "POST",
    body: { content: clip(text, 1900), allowed_mentions: { parse: [] } },
  });
}

/* ------------------------------------------------------------ the gate */

/**
 * Is this Discord account in the server?
 *
 * `GET /guilds/:guild/members/:user` with a bot token answers 200 or 404. The
 * answer is cached for a few minutes: without that, every code fetch is an
 * outbound request, and Discord rate-limits per bot rather than per visitor —
 * so a busy hour would start refusing everybody at once.
 *
 * Returns null for "could not find out", which the caller treats as a PASS.
 * Deliberately the opposite of the Linkvertise check: there, failing open
 * gives away the thing being sold, so it fails closed. Here, failing closed
 * locks paying visitors out of the whole site because Discord had a bad
 * minute. The sponsor step still stands either way — this gate only ever adds
 * a second condition, so failing open costs nothing that was being charged for.
 */
async function discordMember(env, discordId) {
  if (!discordId || !env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return null;

  const key = `dmember:${env.DISCORD_GUILD_ID}:${discordId}`;
  const hit = await cacheGet(env, key);
  if (hit !== null) return hit.in;

  try {
    const res = await fetch(
      `${DISCORD_API}/guilds/${encodeURIComponent(env.DISCORD_GUILD_ID)}/members/${encodeURIComponent(discordId)}`,
      {
        headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN },
        signal: AbortSignal.timeout(6000),
      });

    if (res.status === 200) { await cachePut(env, key, { in: true }, 600); return true; }
    if (res.status === 404) { await cachePut(env, key, { in: false }, 120); return false; }

    // 401/403 means the bot is not in the server or the token is wrong — a
    // configuration problem, not an answer about this person. Do not cache it,
    // and do not punish the visitor for it.
    console.warn("discord member check", res.status);
    return null;
  } catch (err) {
    console.warn("discord member check failed", err?.message);
    return null;
  }
}

/**
 * Why this person may not unlock yet, or null if they may.
 *
 * Runs before the sponsor step as well as at the code endpoint, so somebody
 * who is not in the server is told BEFORE completing a set of offers rather
 * than after — being made to watch ads and then refused is the single worst
 * version of this feature.
 */
async function discordBlock(env, user) {
  if (!discordGateOn(env)) return null;

  if (!user || !user.discord_id) {
    return {
      error: "Join the Discord server to unlock scripts, then sign in with Discord.",
      discord: { need: "signin", invite: discordInvite(env) },
    };
  }

  const inGuild = await discordMember(env, user.discord_id);
  if (inGuild === false) {
    return {
      error: "You need to be in the Discord server to unlock scripts.",
      discord: { need: "join", invite: discordInvite(env) },
    };
  }
  return null;   // true, or null-meaning-unknown: both pass
}

/* ------------------------------------------------------------------ stats */

/**
 * Member and online counts.
 *
 * Two sources, in order of how much they know. A bot token gets exact-ish
 * counts from the guild itself; without one, the public widget gives an online
 * count only, and needs "Enable Server Widget" switched on in the server's
 * settings. Neither being available is not an error — the site just shows the
 * Join button on its own, the way it did before any of this.
 */
async function handleDiscordStats(request, env) {
  const guild = String(env.DISCORD_GUILD_ID || "").trim();
  const invite = discordInvite(env);
  if (!guild) return ok({ data: { configured: false, invite } });

  const key = `dstats:${guild}`;
  const hit = await cacheGet(env, key);
  if (hit) return ok({ data: { ...hit, invite } });

  let stats = null;

  if (env.DISCORD_BOT_TOKEN) {
    try {
      const res = await fetch(
        `${DISCORD_API}/guilds/${encodeURIComponent(guild)}?with_counts=true`,
        { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN }, signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const g = await res.json();
        stats = {
          configured: true,
          name: String(g.name || ""),
          members: Number(g.approximate_member_count) || 0,
          online: Number(g.approximate_presence_count) || 0,
        };
      }
    } catch (err) { console.warn("discord stats (bot)", err?.message); }
  }

  if (!stats) {
    try {
      const res = await fetch(`https://discord.com/api/guilds/${encodeURIComponent(guild)}/widget.json`,
        { signal: AbortSignal.timeout(6000) });
      if (res.ok) {
        const w = await res.json();
        stats = {
          configured: true,
          name: String(w.name || ""),
          members: 0,                                  // the widget does not know
          online: Number(w.presence_count) || 0,
        };
      }
    } catch (err) { console.warn("discord stats (widget)", err?.message); }
  }

  if (!stats) return ok({ data: { configured: false, invite } });

  // Five minutes. Long enough that a busy site is one request per period,
  // short enough that the number is not visibly wrong.
  await cachePut(env, key, stats, 300);
  return ok({ data: { ...stats, invite } });
}

/* ═══════════════════════════════════════════════════════════ executors ══ */

/**
 * Executors are staff-published, and that is enforced in exactly one place:
 * every write below starts with `requireAdmin`. Nothing about this depends on
 * the publishing page being hidden — the page not existing in somebody's menu
 * is a UI convenience, not a permission. Calling the endpoint directly with a
 * signed-in creator's cookie gets a 423 like everyone else, because the check
 * is on the route, not on the button.
 *
 * `requireAdmin` is the passcode gate that already guards /admin: a separate
 * short-lived ticket, unrelated to being signed in and unrelated to owning an
 * account. A creator cannot escalate into it by any path the site offers.
 */

const EXECUTOR_STATUS = ["working", "updating", "unavailable"];
const EXECUTOR_LIMITS = { name: 60, developer: 60, version: 30, descr: 2000, tag: 24 };

const STATUS_LABEL = {
  working: "🟢 Working",
  updating: "🟡 Updating",
  unavailable: "🔴 Unavailable",
};

function publicExecutor(row) {
  if (!row) return null;
  const list = (v) => { try { const p = JSON.parse(v || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } };
  return {
    id: row.id,
    slug: String(row.id).replace(/^x_/, ""),
    name: row.name,
    developer: row.developer,
    logo: row.logo || "",
    desc: row.descr,
    platforms: list(row.platforms),
    robloxVersions: row.roblox_versions || "",
    status: row.status,
    version: row.version || "",
    website: row.website || "",
    discord: row.discord || "",
    tags: list(row.tags),
    screenshots: list(row.screenshots),
    added: String(row.created_at || "").slice(0, 10),
    updated: String(row.updated_at || "").slice(0, 10),
  };
}

/** Reads an executor out of a request body, or returns the reason it cannot. */
function readExecutor(body) {
  const name = String(body.name || "").trim();
  const developer = String(body.developer || "").trim();
  const descr = String(body.desc || "").trim();

  if (!name) return { error: "Give the executor a name." };
  if (name.length > EXECUTOR_LIMITS.name) return { error: "That name is too long." };
  if (!developer) return { error: "Say who develops it." };
  if (developer.length > EXECUTOR_LIMITS.developer) return { error: "That developer name is too long." };
  if (!descr) return { error: "Write a description." };
  if (descr.length > EXECUTOR_LIMITS.descr) return { error: "That description is too long." };

  const status = EXECUTOR_STATUS.includes(body.status) ? body.status : "working";

  const platforms = (Array.isArray(body.platforms) ? body.platforms : [])
    .map((p) => String(p).trim().slice(0, 24)).filter(Boolean).slice(0, 8);

  const tags = (Array.isArray(body.tags) ? body.tags : [])
    .map((t) => String(t).replace(/[^A-Za-z0-9]/g, "").slice(0, EXECUTOR_LIMITS.tag))
    .filter(Boolean).slice(0, 8);

  // Links are pinned the same way profile links are: a listing page is
  // world-readable, so an unchecked href here is stored XSS with a download
  // button next to it.
  const website = safeSocial(String(body.website || ""), [
    "wearedevs.net", "krnl.place", "getsolara.dev", "swiftexploits.com",
    "delta-executor.com", "codex.lol", "arceusx.com", "fluxus.pro",
    "hydrogen.click", "evon.cc", "trigonevo.pro", "sea-executor.com",
    "github.com", "discord.gg", "discord.com",
  ]);
  const discord = safeSocial(String(body.discord || ""), ["discord.gg", "discord.com"]);

  const logoRaw = String(body.logo || "").trim();
  const logo =
    /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(logoRaw) && logoRaw.length < 400000
      ? logoRaw
      : safeSocial(logoRaw, ["githubusercontent.com", "imgur.com", "rbxcdn.com", "discordapp.com", "discord.com"]);

  const screenshots = (Array.isArray(body.screenshots) ? body.screenshots : [])
    .map((s) => safeSocial(String(s), ["githubusercontent.com", "imgur.com", "discordapp.com", "discord.com"]))
    .filter(Boolean).slice(0, 6);

  return {
    value: {
      name, developer, descr, status, logo, website, discord,
      platforms: JSON.stringify(platforms),
      tags: JSON.stringify(tags),
      screenshots: JSON.stringify(screenshots),
      version: String(body.version || "").trim().slice(0, EXECUTOR_LIMITS.version),
      roblox_versions: String(body.robloxVersions || "").trim().slice(0, 60),
    },
  };
}

/* --------------------------------------------------------------- public */

async function handleExecutorList(request, env) {
  const url = new URL(request.url);
  const status = String(url.searchParams.get("status") || "");
  const where = ["removed = 0"];
  const binds = [];
  if (EXECUTOR_STATUS.includes(status)) { where.push("status = ?"); binds.push(status); }

  const { results } = await env.DB.prepare(
    `SELECT * FROM executors WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 200`
  ).bind(...binds).all();

  return ok({ data: (results || []).map(publicExecutor) });
}

async function handleExecutorGet(request, env, { id }) {
  const row = await env.DB.prepare(
    `SELECT * FROM executors WHERE id = ? AND removed = 0`
  ).bind("x_" + String(id).replace(/^x_/, "")).first();
  if (!row) return bad(404, "No such executor.");
  return ok({ data: publicExecutor(row) });
}

/* ---------------------------------------------------------- staff only */

async function handleExecutorCreate(request, env, _params, ctx) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const body = await request.json().catch(() => ({}));
  const parsed = readExecutor(body);
  if (parsed.error) return bad(400, parsed.error);

  // Executors go through the same description pass creators get, so the
  // listings read consistently — and the same rule applies: it may not invent
  // a capability the submitter did not claim.
  const original = parsed.value.descr;
  let descr = original;
  let tags = JSON.parse(parsed.value.tags);
  if (body.enhance !== false) {
    const out = await enhanceDescription(env, {
      descr: original, title: parsed.value.name, game: "Roblox executor",
    });
    descr = out.description;
    if (!tags.length && out.tags.length) tags = out.tags;
  }

  const id = "x_" + randomHex(8);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO executors (id, name, developer, logo, descr, descr_original, platforms,
                            roblox_versions, status, version, website, discord, tags,
                            screenshots, removed, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(
    id, parsed.value.name, parsed.value.developer, parsed.value.logo, descr, original,
    parsed.value.platforms, parsed.value.roblox_versions, parsed.value.status,
    parsed.value.version, parsed.value.website, parsed.value.discord,
    JSON.stringify(tags), parsed.value.screenshots, now, now
  ).run();

  const row = await env.DB.prepare(`SELECT * FROM executors WHERE id = ?`).bind(id).first();

  const after = Promise.all([
    announceExecutor(env, row),
    modLog(env, "Executor published", `**${row.name}** by ${row.developer}`, 0x66bb6a),
  ]);
  if (ctx?.waitUntil) ctx.waitUntil(after); else after.catch(() => {});

  return ok({ data: publicExecutor(row) });
}

async function handleExecutorUpdate(request, env, { id }, ctx) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const key = "x_" + String(id).replace(/^x_/, "");
  const before = await env.DB.prepare(`SELECT * FROM executors WHERE id = ?`).bind(key).first();
  if (!before) return bad(404, "No such executor.");

  const body = await request.json().catch(() => ({}));
  const parsed = readExecutor({ ...publicExecutor(before), desc: before.descr, ...body });
  if (parsed.error) return bad(400, parsed.error);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE executors SET name = ?, developer = ?, logo = ?, descr = ?, platforms = ?,
            roblox_versions = ?, status = ?, version = ?, website = ?, discord = ?,
            tags = ?, screenshots = ?, updated_at = ? WHERE id = ?`
  ).bind(
    parsed.value.name, parsed.value.developer, parsed.value.logo, parsed.value.descr,
    parsed.value.platforms, parsed.value.roblox_versions, parsed.value.status,
    parsed.value.version, parsed.value.website, parsed.value.discord,
    parsed.value.tags, parsed.value.screenshots, now, key
  ).run();

  const row = await env.DB.prepare(`SELECT * FROM executors WHERE id = ?`).bind(key).first();

  // What actually changed, in words — an "updated" ping that does not say what
  // changed is noise people learn to ignore.
  const changes = [];
  if (before.version !== row.version) changes.push(`version ${before.version || "—"} → **${row.version || "—"}**`);
  if (before.status !== row.status) changes.push(`status ${STATUS_LABEL[before.status] || before.status} → **${STATUS_LABEL[row.status] || row.status}**`);
  if (before.descr !== row.descr) changes.push("description updated");
  if (before.logo !== row.logo) changes.push("image updated");

  const after = Promise.all([
    syncExecutorPosts(env, row),
    changes.length
      ? executorUpdateNote(env, row, changes)
      : Promise.resolve(),
    modLog(env, "Executor updated", `**${row.name}** — ${changes.join(", ") || "no visible change"}`, 0x42a5f5),
  ]);
  if (ctx?.waitUntil) ctx.waitUntil(after); else after.catch(() => {});

  return ok({ data: publicExecutor(row) });
}

async function handleExecutorDelete(request, env, { id }, ctx) {
  const admin = await requireAdmin(request, env);
  if (admin instanceof Response) return admin;

  const key = "x_" + String(id).replace(/^x_/, "");
  const row = await env.DB.prepare(`SELECT * FROM executors WHERE id = ?`).bind(key).first();
  if (!row) return bad(404, "No such executor.");

  await env.DB.prepare(`UPDATE executors SET removed = 1 WHERE id = ?`).bind(key).run();

  const after = Promise.all([
    retireExecutorPosts(env, row),
    modLog(env, "Executor removed", `**${row.name}** by ${row.developer}`, 0xef5350),
  ]);
  if (ctx?.waitUntil) ctx.waitUntil(after); else after.catch(() => {});

  return ok({ data: { id: key } });
}

/* ------------------------------------------------------ executor embeds */

function executorEmbed(env, row, { state = "live" } = {}) {
  const site = env.SITE_URL || "https://lucritscripts.site";
  const link = `${site}/executors/${encodeURIComponent(String(row.id).replace(/^x_/, ""))}`;
  const gone = state !== "live";

  const list = (v) => { try { const p = JSON.parse(v || "[]"); return Array.isArray(p) ? p : []; } catch { return []; } };
  const platforms = list(row.platforms);
  const hashes = [...list(row.tags), "Executor", "Roblox"]
    .map((t) => "#" + String(t).replace(/[^A-Za-z0-9]/g, ""))
    .filter((t) => t.length > 1).slice(0, 6).join(" ");

  const art = /^https:\/\//i.test(String(row.logo || "")) ? row.logo : null;

  return {
    title: gone ? `~~⚙️ ${clip(row.name, 230)}~~` : `⚙️ ${clip(row.name, 240)}`,
    url: gone ? undefined : link,
    description: gone
      ? "**This executor is no longer listed on Lucrit Scripts.**"
      : clip(row.descr, 400),
    color: gone ? 0x4a5568
      : row.status === "working" ? 0x66bb6a
      : row.status === "updating" ? 0xf6c343 : 0xef5350,
    fields: [
      { name: "👤 Developer", value: clip(row.developer, 100), inline: true },
      ...(row.version ? [{ name: "📦 Version", value: clip(row.version, 40), inline: true }] : []),
      ...(platforms.length ? [{ name: "💻 Platform", value: clip(platforms.join(", "), 100), inline: true }] : []),
      { name: "Status", value: STATUS_LABEL[row.status] || row.status, inline: true },
      ...(row.roblox_versions ? [{ name: "🎮 Roblox", value: clip(row.roblox_versions, 60), inline: true }] : []),
      ...(hashes && !gone ? [{ name: "​", value: hashes }] : []),
      ...(gone ? [] : [{ name: "​", value: `**[🔗 View Executor](${link})**` }]),
    ],
    ...(art && !gone ? { thumbnail: { url: art } } : {}),
    footer: { text: "Lucrit Scripts · lucritscripts.site" },
    timestamp: new Date(row.updated_at || Date.now()).toISOString(),
  };
}

async function announceExecutor(env, row) {
  if (!botOn(env)) return;
  try {
    const embed = executorEmbed(env, row);
    for (const name of ["executors", "latest-executors"]) {
      const channel = await namedChannel(env, name);
      if (!channel) continue;
      const sent = await bot(env, `/channels/${channel}/messages`, {
        method: "POST", body: { embeds: [embed], allowed_mentions: { parse: [] } },
      });
      if (!sent?.id) continue;
      await env.DB.prepare(
        `INSERT INTO script_posts (script_id, channel_id, message_id, kind, at)
         VALUES (?, ?, ?, 'executor', ?)
         ON CONFLICT(script_id, channel_id) DO UPDATE SET message_id = excluded.message_id`
      ).bind(row.id, channel, sent.id, nowSec()).run().catch(() => {});
    }
  } catch (err) {
    console.warn("executor announce failed", err?.message);
  }
}

async function syncExecutorPosts(env, row, { state = "live" } = {}) {
  if (!botOn(env)) return;
  const { results } = await env.DB.prepare(
    `SELECT channel_id, message_id FROM script_posts WHERE script_id = ?`
  ).bind(row.id).all().catch(() => ({ results: [] }));
  const embed = executorEmbed(env, row, { state });
  for (const p of results || []) {
    await bot(env, `/channels/${p.channel_id}/messages/${p.message_id}`, {
      method: "PATCH", body: { embeds: [embed], allowed_mentions: { parse: [] } },
    });
  }
}

async function retireExecutorPosts(env, row) {
  if (!botOn(env)) return;
  if (/^(1|true|yes|on)$/i.test(String(env.DISCORD_DELETE_REMOVED || ""))) {
    const { results } = await env.DB.prepare(
      `SELECT channel_id, message_id FROM script_posts WHERE script_id = ?`
    ).bind(row.id).all().catch(() => ({ results: [] }));
    for (const p of results || []) {
      await bot(env, `/channels/${p.channel_id}/messages/${p.message_id}`, { method: "DELETE" });
    }
    await env.DB.prepare(`DELETE FROM script_posts WHERE script_id = ?`).bind(row.id).run().catch(() => {});
    return;
  }
  await syncExecutorPosts(env, row, { state: "removed" });
}

/** A short "what changed" note in #executor-updates, separate from the listing. */
async function executorUpdateNote(env, row, changes) {
  if (!botOn(env)) return;
  const channel = await namedChannel(env, "executor-updates");
  if (!channel) return;
  const site = env.SITE_URL || "https://lucritscripts.site";
  const link = `${site}/executors/${encodeURIComponent(String(row.id).replace(/^x_/, ""))}`;
  await bot(env, `/channels/${channel}/messages`, {
    method: "POST",
    body: {
      embeds: [{
        title: `⚙️ ${clip(row.name, 240)} updated`,
        url: link,
        description: changes.map((c) => "• " + c).join("\n").slice(0, 1000),
        color: 0x42a5f5,
        footer: { text: "Lucrit Scripts" },
        timestamp: new Date().toISOString(),
      }],
      allowed_mentions: { parse: [] },
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════ router ══ */

/**
 * Routes with an :id in them. Kept separate from the exact-match table so the
 * common case stays a plain object lookup.
 */
const PATTERNS = [
  ["GET", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})$/, handleScriptGet],
  // Usernames allow spaces and dots, so this segment is anything but a slash
  // and the handler decodes it. Length is capped here rather than trusted.
  ["GET", /^\/api\/creators\/([^/]{1,80})$/, handleCreator],
  ["GET", /^\/api\/executors\/([A-Za-z0-9_-]{1,40})$/, handleExecutorGet],
  ["POST", /^\/api\/admin\/executors\/([A-Za-z0-9_-]{1,40})$/, handleExecutorUpdate],
  ["DELETE", /^\/api\/admin\/executors\/([A-Za-z0-9_-]{1,40})$/, handleExecutorDelete],
  ["GET", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})\/code$/, handleScriptCode],
  ["DELETE", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})$/, handleScriptDelete],
  ["POST", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})\/like$/, handleScriptLike],
  ["POST", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})\/report$/, handleScriptReport],
  ["POST", /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})\/ban$/, handleAdminUserBan],
  ["DELETE", /^\/api\/admin\/users\/([A-Za-z0-9_-]{1,40})$/, handleAdminUserDelete],
  ["POST", /^\/api\/admin\/scripts\/([A-Za-z0-9_-]{1,40})\/state$/, handleAdminScriptState],
  ["POST", /^\/api\/admin\/scripts\/([A-Za-z0-9_-]{1,40})\/counters$/, handleAdminScriptCounters],
  ["POST", /^\/api\/admin\/reports\/([A-Za-z0-9_-]{1,40})\/dismiss$/, handleAdminReportDismiss],
];

const ROUTES = {
  "GET  /api/scripts": handleScriptList,
  "GET  /api/auth/discord/start": handleDiscordStart,
  "GET  /api/auth/discord/callback": handleDiscordCallback,
  "GET  /api/discord": handleDiscordStats,
  "GET  /api/executors": handleExecutorList,
  "POST /api/admin/discord/setup": handleAdminDiscordSetup,
  "POST /api/admin/discord/leaderboards": handleAdminLeaderboards,
  "POST /api/admin/executors": handleExecutorCreate,
  "GET  /api/leaderboard": handleLeaderboard,
  "GET  /api/admin/state": handleAdminState,
  "POST /api/admin/unlock": handleAdminUnlock,
  "POST /api/admin/lock": handleAdminLock,
  "GET  /api/admin/overview": handleAdminOverview,
  "GET  /api/admin/users": handleAdminUsers,
  "GET  /api/admin/scripts": handleAdminScripts,
  "GET  /api/admin/reports": handleAdminReports,
  "POST /api/scripts": handleScriptPublish,
  "POST /api/unlock/start": handleUnlockStart,
  "GET  /api/unlock/postback": handleUnlockPostback,
  "POST /api/unlock/claim": handleUnlockClaim,
  "POST /api/auth/salt": handleSalt,
  "POST /api/auth/signup": handleSignUp,
  "POST /api/auth/signin": handleSignIn,
  "POST /api/auth/google": handleGoogle,
  "POST /api/auth/signout": handleSignOut,
  "GET  /api/auth/session": handleSession,
  "POST /api/account/username": handleUsername,
  "POST /api/account/profile": handleProfile,
  "POST /api/account/password": handlePassword,
  "GET  /api/account/earnings": handleEarnings,
  "POST /api/auth/reset/request": handleResetRequest,
  "POST /api/auth/reset/confirm": handleResetConfirm,
  "POST /api/ai": handleAI,
  "POST /api/scripts/describe": handleDescribe,
  "POST /api/human": handleHuman,
  "GET  /api/config": async (_request, env) => ok({
    data: {
      googleClientId: env.GOOGLE_CLIENT_ID || "",
      turnstileSiteKey: env.TURNSTILE_SITE_KEY || "",
      resetEmail: Boolean(env.RESEND_API_KEY),
      // The site tells people the truth about the sponsor step rather than
      // showing a paying-looking button that earns nothing.
      unlockLive: unlockConfigured(env),
      unlockProviders: unlockProviders(env),
      unlockMinutes: grantMinutes(env),
      discord: {
        signIn: discordSignIn(env),
        requireMember: discordGateOn(env),
        invite: discordInvite(env),
        stats: Boolean(env.DISCORD_GUILD_ID),
      },
    },
  }),
};

/**
 * Paths the single-page app owns.
 *
 * Every one of these is served the app shell and resolved in the browser. The
 * segments are permissive on purpose — a username may contain spaces and dots,
 * and a request for a creator who does not exist should reach the app and get
 * a "no such creator" page rather than a bare 404 from the asset server.
 *
 * Anything not listed here still falls through to the real files, so a typo in
 * an asset path stays a 404 instead of silently returning HTML.
 */
const APP_ROUTES = [
  /^\/admin\/?$/,
  /^\/creators\/[^/]+\/?$/,
  /^\/creations\/[^/]+\/[^/]+\/?$/,
  /^\/dashboard(\/[^/]+)?\/?$/,
  /^\/executors(\/[^/]+)?\/?$/,
];

/** Headers GitHub Pages could never send us. */
function harden(response) {
  const out = new Response(response.body, response);
  out.headers.set("X-Content-Type-Options", "nosniff");
  out.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  out.headers.set("X-Frame-Options", "DENY");
  out.headers.set("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  return out;
}

/**
 * How long a browser may reuse a file without asking.
 *
 * Pages defaults every asset to `max-age=14400` — four hours during which a
 * browser does not contact the server at all. The filenames are not
 * content-hashed, so that default meant a fix to the paywall kept being
 * bypassed by a copy of `pages.js` from before the fix, on the very machines
 * that most needed it. "Hard-reload to see the fix" is not a deployment
 * strategy.
 *
 * Code and markup therefore revalidate every time. That is an ETag round trip
 * per file, answered `304` from the edge — cheap, and it means a deploy is
 * live on the next page load rather than up to four hours later.
 *
 * Images and fonts go the other way — a day, no revalidation. They are the
 * big files, they change about never, and a stale logo is not a security
 * problem. (Pages' own default for them is `max-age=0`, which would mean a
 * conditional request for every icon on every page load.)
 */
function cacheFor(pathname) {
  if (/\.(js|mjs|css|map)$/i.test(pathname)) return "no-cache, must-revalidate";
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i.test(pathname))
    return "public, max-age=86400";
  // Markup, data, and extensionless routes: always ask.
  return "no-cache, must-revalidate";
}

export default {
  // `ctx` is here for waitUntil: the Discord announcement must not make a
  // publisher wait on Discord, and must not fail their publish if it fails.
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      // These are routes the app draws, not files on disk. Without this, a
      // direct visit or a refresh at one of them is a 404 from the asset
      // server before any JavaScript gets a chance to run — which is what
      // "give every script its own page" actually costs on static hosting.
      // Ask for "/" rather than "/index.html": Pages canonicalises the latter
      // with a 308 back to "/", which the browser follows — so /admin bounced
      // to the home page before any script ran.
      const spa = APP_ROUTES.some((re) => re.test(url.pathname));
      const asset = harden(await env.ASSETS.fetch(
        spa ? new Request(new URL("/", url), request) : request));
      const cache = cacheFor(url.pathname);
      if (cache) asset.headers.set("Cache-Control", cache);
      return asset;
    }

    const key = `${request.method.padEnd(4)} ${url.pathname}`.replace(/\s+/, " ");
    let handler =
      ROUTES[`${request.method} ${url.pathname}`] ||
      ROUTES[`${request.method}  ${url.pathname}`] ||
      ROUTES[key];
    let params = {};

    if (!handler) {
      for (const [method, pattern, fn] of PATTERNS) {
        const m = url.pathname.match(pattern);
        if (m && method === request.method) { handler = fn; params = { id: m[1] }; break; }
      }
    }

    if (!handler) {
      // Distinguish "no such endpoint" from "wrong verb" — it saves an hour
      // of debugging the first time somebody gets it wrong.
      const anyVerb =
        Object.keys(ROUTES).some((k) => k.endsWith(" " + url.pathname)) ||
        PATTERNS.some(([, pattern]) => pattern.test(url.pathname));
      return anyVerb ? bad(405, "Wrong method for that endpoint.") : bad(404, "No such endpoint.");
    }

    try {
      return await handler(request, env, params, ctx);
    } catch (err) {
      console.error("unhandled", url.pathname, err?.stack || err?.message);
      return bad(500, "Something went wrong. Try again.");
    }
  },
};
