// Account model.
//
// Every method returns { ok, error?, data? }, so a caller never has to know
// where the account actually lives.
//
// Two backends live behind that shape:
//   cloudflare  real accounts in D1, reached through /api on our own origin
//   local       browser-only fallback for when there is no API to talk to
//
// The local one hashes passwords with PBKDF2 and a per-user salt, but browser
// storage is not a security boundary. It exists so the site still works
// offline, not as a place to keep real credentials.

import { safeSocialUrl } from "./safe.js";
import { useSameOriginApi } from "./config.js";

const KEY_USERS = "lucrit:users";
const KEY_SESSION = "lucrit:session";
const USERNAME_COOLDOWN_DAYS = 7;

/* ------------------------------------------------------------- storage */

const store = (() => {
  const mem = new Map();
  let ok = true;
  try {
    window.localStorage.setItem("__probe", "1");
    window.localStorage.removeItem("__probe");
  } catch { ok = false; }
  return {
    get(k) {
      try { return ok ? window.localStorage.getItem(k) : mem.get(k) ?? null; }
      catch { return mem.get(k) ?? null; }
    },
    set(k, v) {
      try { if (ok) window.localStorage.setItem(k, v); else mem.set(k, v); }
      catch { mem.set(k, v); }
    },
    del(k) {
      try { if (ok) window.localStorage.removeItem(k); else mem.delete(k); }
      catch { mem.delete(k); }
    },
  };
})();

const readJSON = (k, fallback) => {
  try { return JSON.parse(store.get(k) || "") ?? fallback; }
  catch { return fallback; }
};

/* -------------------------------------------------------------- crypto */

const enc = new TextEncoder();
const toHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

async function hashPassword(password, saltHex) {
  // SubtleCrypto needs a secure context; fall back to a marker so the shell
  // still works over plain http during local development.
  if (!crypto?.subtle) return "insecure:" + password.length;

  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256
  );
  return toHex(bits);
}

const newSalt = () => toHex(crypto.getRandomValues(new Uint8Array(16)));
const newId = () => "u_" + toHex(crypto.getRandomValues(new Uint8Array(8)));

/* ------------------------------------------------------------ validation */

export const RULES = {
  username: /^[\p{L}\p{N} _.-]{1,32}$/u,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
};

export function validateSignUp({ username, email, password }) {
  const name = String(username || "").trim();
  if (!name) return "Pick a username.";
  if (name.length > 32) return "Username can be at most 32 characters.";
  if (!RULES.username.test(name))
    return "Username can use letters, numbers, spaces, dots, dashes and underscores.";
  if (!RULES.email.test(email || ""))
    return "That email address doesn't look right.";
  if ((password || "").length < 8)
    return "Password must be at least 8 characters.";
  return null;
}

/* ---------------------------------------------------------------- model */

const listeners = new Set();

// Seeded from storage so the offline shell works on reload. If the API turns
// out to be there, it overwrites this with the real answer a moment later.
let session = readJSON(KEY_SESSION, null);

function emit() {
  for (const fn of listeners) {
    try { fn(session); } catch (e) { console.error(e); }
  }
}

/** The one place the session changes, whichever backend is in charge. */
function setSession(next) {
  session = next;
  if (next) store.set(KEY_SESSION, JSON.stringify(next));
  else store.del(KEY_SESSION);
  emit();
}

function allUsers() { return readJSON(KEY_USERS, {}); }
function saveUsers(users) { store.set(KEY_USERS, JSON.stringify(users)); }

/** Strips the secret fields before anything reaches the UI. */
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, salt, ...rest } = u;
  return rest;
}

/* --------------------------------------------------------- local backend */

// The original browser-only implementation. It is the fallback now rather
// than the default: it still runs when Firebase cannot load, so the site
// works offline and on a blocked network.

const local = {
  kind: "local",

  async signUp({ username, email, password, captcha, turnstile }) {
    const problem = validateSignUp({ username, email, password });
    if (problem) return { ok: false, error: problem };
    if (!captcha && !turnstile) return { ok: false, error: "Please complete the human check." };

    const users = allUsers();
    const taken = Object.values(users);
    if (taken.some((u) => u.username.toLowerCase() === username.toLowerCase()))
      return { ok: false, error: "That username is already taken." };
    if (taken.some((u) => u.email.toLowerCase() === email.toLowerCase()))
      return { ok: false, error: "An account already exists for that email." };

    const salt = newSalt();
    const user = {
      id: newId(),
      username,
      email: email.toLowerCase(),
      salt,
      passwordHash: await hashPassword(password, salt),
      bio: "",
      avatar: null,
      youtube: "",
      tiktok: "",
      createdAt: new Date().toISOString(),
      usernameChangedAt: null,
      publishes: [],
    };

    users[user.id] = user;
    saveUsers(users);
    setSession(publicUser(user));
    return { ok: true, data: session };
  },

  async signIn({ email, password }) {
    const users = allUsers();
    const user = Object.values(users)
      .find((u) => u.email.toLowerCase() === String(email).toLowerCase());

    // Same message either way — never reveal which accounts exist.
    const generic = { ok: false, error: "Email or password is incorrect." };
    if (!user) return generic;

    const hash = await hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return generic;

    setSession(publicUser(user));
    return { ok: true, data: session };
  },

  // Google sign-in is a real identity provider, so there is nothing honest a
  // browser-only shell can do with it. The UI hides the button when the
  // backend is local; this is the belt-and-braces answer if it slips through.
  async signInWithGoogle() {
    return { ok: false, error: "Google sign-in needs the server backend, which isn't available right now." };
  },

  async signOut() {
    setSession(null);
    return { ok: true };
  },

  async requestPasswordReset(email) {
    if (!RULES.email.test(email || ""))
      return { ok: false, error: "That email address doesn't look right." };
    return {
      ok: true,
      data: { pending: true },
      note: "Reset emails need the Firebase backend — this browser-only mode cannot send mail.",
    };
  },

  async changePassword({ current, next }) {
    if (!session) return { ok: false, error: "You need to be signed in." };
    if ((next || "").length < 8)
      return { ok: false, error: "New password must be at least 8 characters." };

    const users = allUsers();
    const user = users[session.id];
    if (!user) return { ok: false, error: "Account not found." };

    if (await hashPassword(current, user.salt) !== user.passwordHash)
      return { ok: false, error: "Current password is incorrect." };

    user.salt = newSalt();
    user.passwordHash = await hashPassword(next, user.salt);
    saveUsers(users);
    return { ok: true };
  },

  usernameCooldownDays(current) {
    if (!current?.usernameChangedAt) return 0;
    const elapsed = Date.now() - new Date(current.usernameChangedAt).getTime();
    const left = USERNAME_COOLDOWN_DAYS - elapsed / 86400000;
    return left > 0 ? Math.ceil(left) : 0;
  },

  async changeUsername(username, current) {
    if (!current) return { ok: false, error: "You need to be signed in." };
    const name = String(username || "").trim();
    if (!name) return { ok: false, error: "Pick a username." };
    if (name.length > 32) return { ok: false, error: "Username can be at most 32 characters." };
    if (!RULES.username.test(name))
      return { ok: false, error: "Username can use letters, numbers, spaces, dots, dashes and underscores." };

    const days = this.usernameCooldownDays(current);
    if (days > 0)
      return { ok: false, error: `You can change your username again in ${days} day${days === 1 ? "" : "s"}.` };

    const users = allUsers();
    if (Object.values(users).some(
      (u) => u.id !== current.id && u.username.toLowerCase() === name.toLowerCase()
    )) return { ok: false, error: "That username is already taken." };

    const user = users[current.id];
    if (!user) return { ok: false, error: "Account not found." };

    user.username = name;
    user.usernameChangedAt = new Date().toISOString();
    saveUsers(users);
    setSession(publicUser(user));
    return { ok: true, data: session };
  },

  async updateProfile({ bio, avatar, youtube, tiktok }, current) {
    if (!current) return { ok: false, error: "You need to be signed in." };

    const users = allUsers();
    const user = users[current.id];
    if (!user) return { ok: false, error: "Account not found." };

    if (bio !== undefined) user.bio = String(bio).slice(0, 300);
    if (avatar !== undefined) user.avatar = avatar;
    if (youtube !== undefined) user.youtube = safeSocialUrl(youtube, ["youtube.com", "youtu.be"]);
    if (tiktok !== undefined) user.tiktok = safeSocialUrl(tiktok, ["tiktok.com"]);

    saveUsers(users);
    setSession(publicUser(user));
    return { ok: true, data: session };
  },

  async addPublish(scriptId, current) {
    if (!current) return { ok: false, error: "You need to be signed in." };
    const users = allUsers();
    const user = users[current.id];
    if (!user) return { ok: false, error: "Account not found." };
    user.publishes = Array.from(new Set([...(user.publishes || []), scriptId]));
    saveUsers(users);
    setSession(publicUser(user));
    return { ok: true };
  },
};

/* -------------------------------------------------------------- backend */

let backend = local;

/**
 * Resolves once the backend is chosen and, for Firebase, once the first auth
 * state has arrived. Await it before trusting `account.isSignedIn` on load.
 */
export const ready = (async () => {
  try {
    const { createApiBackend } = await import("./account-api.js");
    const remote = await createApiBackend({ setSession, validateSignUp, RULES });
    if (remote) {
      backend = remote;
      // The session cookie is the truth now; a stale local copy would only
      // confuse things on the next reload.
      store.del(KEY_SESSION);
      // Same origin for accounts means same origin for the assistant too.
      useSameOriginApi();
      return backend.kind;
    }
  } catch (err) {
    console.warn("[lucrit] no account API here, staying local:", err?.message || err);
  }

  // No API — the stored session is the real one again. Skipping this would
  // sign people out of the offline mode on every reload.
  const saved = readJSON(KEY_SESSION, null);
  if (saved) setSession(saved);
  return backend.kind;
})();

export const account = {
  get session() { return session; },
  get isSignedIn() { return Boolean(session); },
  /** "cloudflare" or "local" — the dashboard shows this so it is never a mystery. */
  get backend() { return backend.kind; },
  ready,

  onChange(fn) {
    listeners.add(fn);
    fn(session);
    return () => listeners.delete(fn);
  },

  /** True once a real provider is behind the account, so the UI can offer Google. */
  get canUseGoogle() { return backend.kind === "cloudflare" && Boolean(backend.config?.googleClientId); },

  /** Turnstile's public site key, or "" when it is not configured yet. */
  get turnstileKey() { return backend.config?.turnstileSiteKey || ""; },

  /** Google One Tap, if this browser already knows the person. */
  tryAutoSignIn: () => backend.tryAutoSignIn?.() ?? Promise.resolve(false),
  confirmPasswordReset: (details) => backend.confirmPasswordReset?.(details)
    ?? Promise.resolve({ ok: false, error: "Password reset isn't available here." }),

  signUp: (details) => backend.signUp(details),
  signIn: (details) => backend.signIn(details),
  signInWithGoogle: () => backend.signInWithGoogle(),
  signOut: () => backend.signOut(),
  requestPasswordReset: (email) => backend.requestPasswordReset(email),
  changePassword: (details) => backend.changePassword(details),
  usernameCooldownDays: () => backend.usernameCooldownDays(session),
  changeUsername: (username) => backend.changeUsername(username, session),
  updateProfile: (patch) => backend.updateProfile(patch, session),
  addPublish: (scriptId) => backend.addPublish(scriptId, session),
};

/* ------------------------------------------------------------ analytics */

/** Stat windows the dashboard charts. Real numbers arrive with Supabase. */
export const STAT_WINDOWS = [
  { id: "24h", label: "24 hours", days: 1 },
  { id: "7d",  label: "7 days",   days: 7 },
  { id: "1m",  label: "1 month",  days: 30 },
  { id: "3m",  label: "3 months", days: 90 },
];

export function emptyStats() {
  return { views: 0, likes: 0, copies: 0, series: [] };
}
