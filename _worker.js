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

function cookieHeader(token, maxAgeSec) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
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
  return row;
}

/** The shape the site's UI already expects. Note there is no email in here. */
function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    bio: row.bio || "",
    avatar: row.avatar || null,
    youtube: row.youtube || "",
    tiktok: row.tiktok || "",
    createdAt: row.created_at,
    usernameChangedAt: row.username_changed_at || null,
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
  return json(200, { ok: true, data: publicSession(row) },
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

  const token = await startSession(env, row.id);
  return json(200, { ok: true, data: publicSession(row) },
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

  const token = await startSession(env, row.id);
  return json(200, { ok: true, data: publicSession(row) },
    { "Set-Cookie": cookieHeader(token, SESSION_DAYS * 86400) });
}

async function handleSignOut(request, env) {
  await endSession(env, readCookie(request, SESSION_COOKIE));
  return json(200, { ok: true }, { "Set-Cookie": cookieHeader("", 0) });
}

async function handleSession(request, env) {
  const row = await currentUser(request, env);
  return ok({ data: publicSession(row) });
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
  return ok({ data: publicSession(row) });
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
  return ok({ data: publicSession(row) });
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

  const where = ["s.removed = 0"];
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

  return ok({ data: (results || []).map((r) => publicScript(r)) });
}

async function handleScriptGet(request, env, { id }) {
  const row = await env.DB.prepare(
    `SELECT ${SCRIPT_COLUMNS},
            (SELECT COUNT(*) FROM likes l WHERE l.script_id = s.id) AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id
      WHERE s.id = ? AND s.removed = 0`
  ).bind(id).first();

  if (!row) return bad(404, "That script doesn't exist.");

  const user = await currentUser(request, env);
  const subject = await grantSubject(request, env, user);
  const mine = user && user.id === row.author_id;

  const grant = mine ? null : await env.DB.prepare(
    `SELECT verified FROM grants WHERE subject = ? AND script_id = ? AND expires > ?`
  ).bind(subject, id, nowSec()).first();

  // A view is one per subject per script per hour, so a refresh loop cannot
  // inflate somebody's numbers.
  if (await underLimit(env, `view:${subject}:${id}`, 1, 3600)) {
    await env.DB.prepare(`UPDATE scripts SET views = views + 1 WHERE id = ?`).bind(id).run();
    row.views = (row.views || 0) + 1;
  }

  return ok({
    data: publicScript(row, {
      // The author never has to unlock their own work.
      unlocked: Boolean(mine) || grantOpens(env, grant),
      mine: Boolean(mine),
      liked: user ? Boolean(await env.DB.prepare(
        `SELECT 1 FROM likes WHERE user_id = ? AND script_id = ?`
      ).bind(user.id, id).first()) : false,
    }),
  });
}

async function handleScriptPublish(request, env) {
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

  const id = "s_" + randomHex(8);
  await env.DB.prepare(
    `INSERT INTO scripts (id, author_id, title, game, category, descr, code, tags,
                          keyless, thumbnail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id, user.id, title, game, category, descr, code, JSON.stringify(tags),
    body.keyless === false ? 0 : 1, thumbnail, new Date().toISOString()
  ).run();

  const row = await env.DB.prepare(
    `SELECT ${SCRIPT_COLUMNS}, 0 AS likes
       FROM scripts s JOIN users u ON u.id = s.author_id WHERE s.id = ?`
  ).bind(id).first();

  return ok({ data: publicScript(row, { unlocked: true, mine: true, liked: false }) });
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

  // Counting here rather than at claim time means the number reflects code
  // actually collected, not sponsor steps abandoned at the last moment.
  await env.DB.prepare(`UPDATE scripts SET copies = copies + 1 WHERE id = ?`).bind(id).run();
  return ok({ data: { code: row.code } });
}

async function handleScriptDelete(request, env, { id }) {
  const user = await currentUser(request, env);
  if (!user) return bad(401, "Sign in first.");

  const row = await env.DB.prepare(`SELECT author_id FROM scripts WHERE id = ?`).bind(id).first();
  if (!row) return bad(404, "That script doesn't exist.");

  const admin = env.ADMIN_USER_ID && user.id === env.ADMIN_USER_ID;
  if (row.author_id !== user.id && !admin) return bad(403, "That isn't your script.");

  // Soft delete: the row stays so counts and any payout history survive, but
  // nothing that lists or serves scripts will look at it again.
  await env.DB.prepare(`UPDATE scripts SET removed = 1 WHERE id = ?`).bind(id).run();
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
  // Linkvertise needs BOTH: the anti-bypass token to verify with, and the link
  // itself, which is created by hand in their dashboard because their API does
  // not offer link creation. Without either one there is nothing to send a
  // visitor to, or no way to know they arrived honestly.
  if (env.LINKVERTISE_TOKEN && env.LINKVERTISE_URL) live.push("linkvertise");
  return live;
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

  // Linkvertise links are made by hand in their dashboard and point at a fixed
  // destination, so there is no per-unlock API call — the click row we just
  // wrote is what ties this visitor to this script when they come back.
  if (provider === "linkvertise" && unlockProviders(env).includes("linkvertise")) {
    return ok({ data: { clickId, url: env.LINKVERTISE_URL, configured: true, provider: "linkvertise" } });
  }

  const site = env.SITE_URL || new URL(request.url).origin;
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

  return ok({ data: { unlocked: true, verified: Boolean(verified) } });
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

/* ═══════════════════════════════════════════════════════════════════ router ══ */

/**
 * Routes with an :id in them. Kept separate from the exact-match table so the
 * common case stays a plain object lookup.
 */
const PATTERNS = [
  ["GET", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})$/, handleScriptGet],
  ["GET", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})\/code$/, handleScriptCode],
  ["DELETE", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})$/, handleScriptDelete],
  ["POST", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})\/like$/, handleScriptLike],
  ["POST", /^\/api\/scripts\/([A-Za-z0-9_-]{1,40})\/report$/, handleScriptReport],
];

const ROUTES = {
  "GET  /api/scripts": handleScriptList,
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
    },
  }),
};

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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      const asset = harden(await env.ASSETS.fetch(request));
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
      return await handler(request, env, params);
    } catch (err) {
      console.error("unhandled", url.pathname, err?.stack || err?.message);
      return bad(500, "Something went wrong. Try again.");
    }
  },
};
