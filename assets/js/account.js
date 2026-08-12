// Account model.
//
// Every method here is async and returns { ok, error?, data? } so that
// swapping the local shell for Supabase is a body-only change — no caller
// has to be touched.
//
//   const { data, error } = await supabase.auth.signUp({ email, password })
//
// UNTIL THEN: this is a local-only shell for building and demoing the UI.
// Passwords are PBKDF2-hashed with a per-user salt (never stored in the
// clear), but browser storage is not a security boundary — real credential
// storage starts the moment Supabase is wired in.

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
let session = readJSON(KEY_SESSION, null);

function emit() {
  for (const fn of listeners) {
    try { fn(session); } catch (e) { console.error(e); }
  }
}

function allUsers() { return readJSON(KEY_USERS, {}); }
function saveUsers(users) { store.set(KEY_USERS, JSON.stringify(users)); }

/** Strips the secret fields before anything reaches the UI. */
function publicUser(u) {
  if (!u) return null;
  const { passwordHash, salt, ...rest } = u;
  return rest;
}

export const account = {
  get session() { return session; },
  get isSignedIn() { return Boolean(session); },

  onChange(fn) {
    listeners.add(fn);
    fn(session);
    return () => listeners.delete(fn);
  },

  async signUp({ username, email, password, captcha }) {
    const problem = validateSignUp({ username, email, password });
    if (problem) return { ok: false, error: problem };
    if (!captcha) return { ok: false, error: "Please complete the human check." };

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

    session = publicUser(user);
    store.set(KEY_SESSION, JSON.stringify(session));
    emit();
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

    session = publicUser(user);
    store.set(KEY_SESSION, JSON.stringify(session));
    emit();
    return { ok: true, data: session };
  },

  async signOut() {
    session = null;
    store.del(KEY_SESSION);
    emit();
    return { ok: true };
  },

  /** Supabase sends the real email; here we only confirm the request shape. */
  async requestPasswordReset(email) {
    if (!RULES.email.test(email || ""))
      return { ok: false, error: "That email address doesn't look right." };
    return {
      ok: true,
      data: { pending: true },
      note: "Reset emails start working once Supabase auth is connected.",
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

  /** Days remaining before the username can change again (0 = allowed now). */
  usernameCooldownDays() {
    if (!session?.usernameChangedAt) return 0;
    const elapsed = Date.now() - new Date(session.usernameChangedAt).getTime();
    const left = USERNAME_COOLDOWN_DAYS - elapsed / 86400000;
    return left > 0 ? Math.ceil(left) : 0;
  },

  async changeUsername(username) {
    if (!session) return { ok: false, error: "You need to be signed in." };
    const name = String(username || "").trim();
    if (!name) return { ok: false, error: "Pick a username." };
    if (name.length > 32) return { ok: false, error: "Username can be at most 32 characters." };
    if (!RULES.username.test(name))
      return { ok: false, error: "Username can use letters, numbers, spaces, dots, dashes and underscores." };
    username = name;

    const days = this.usernameCooldownDays();
    if (days > 0)
      return { ok: false, error: `You can change your username again in ${days} day${days === 1 ? "" : "s"}.` };

    const users = allUsers();
    if (Object.values(users).some(
      (u) => u.id !== session.id && u.username.toLowerCase() === username.toLowerCase()
    )) return { ok: false, error: "That username is already taken." };

    const user = users[session.id];
    if (!user) return { ok: false, error: "Account not found." };

    user.username = username;
    user.usernameChangedAt = new Date().toISOString();
    saveUsers(users);

    session = publicUser(user);
    store.set(KEY_SESSION, JSON.stringify(session));
    emit();
    return { ok: true, data: session };
  },

  async updateProfile({ bio, avatar, youtube, tiktok }) {
    if (!session) return { ok: false, error: "You need to be signed in." };

    const users = allUsers();
    const user = users[session.id];
    if (!user) return { ok: false, error: "Account not found." };

    if (bio !== undefined) user.bio = String(bio).slice(0, 300);
    if (avatar !== undefined) user.avatar = avatar;
    if (youtube !== undefined) user.youtube = normaliseUrl(youtube, "youtube.com");
    if (tiktok !== undefined) user.tiktok = normaliseUrl(tiktok, "tiktok.com");

    saveUsers(users);
    session = publicUser(user);
    store.set(KEY_SESSION, JSON.stringify(session));
    emit();
    return { ok: true, data: session };
  },

  /** Records a publish against the signed-in account. */
  async addPublish(scriptId) {
    if (!session) return { ok: false, error: "You need to be signed in." };
    const users = allUsers();
    const user = users[session.id];
    if (!user) return { ok: false, error: "Account not found." };
    user.publishes = Array.from(new Set([...(user.publishes || []), scriptId]));
    saveUsers(users);
    session = publicUser(user);
    store.set(KEY_SESSION, JSON.stringify(session));
    emit();
    return { ok: true };
  },
};

function normaliseUrl(value, host) {
  const v = String(value || "").trim();
  if (!v) return "";
  try {
    const url = new URL(v.startsWith("http") ? v : "https://" + v);
    return url.hostname.includes(host) ? url.toString() : "";
  } catch { return ""; }
}

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
