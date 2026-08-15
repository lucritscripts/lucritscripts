// Accounts, against our own API.
//
// Same method shapes as the local shell in account.js — every call returns
// { ok, error?, data? } — so nothing above this layer knows or cares that
// Firebase is gone.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE PASSWORD NEVER LEAVES THIS FILE
//
// The server runs on Cloudflare's free plan, which allows 10ms of CPU per
// request — nowhere near enough to hash a password properly. So we do the
// expensive part here, in the browser:
//
//     authKey = PBKDF2-SHA256(password, salt, 310000)
//
// and send authKey instead of the password. The server stores a fast hash of
// it. An attacker who steals the database still has to run those 310,000
// iterations for every password they want to guess, so the work factor is
// unchanged — it has only moved to the machine that has spare cycles. As a
// bonus, the server never learns the password at all.
//
// The salt comes from the server but is derived from the email address rather
// than stored, so asking for it cannot reveal whether an account exists.
// ─────────────────────────────────────────────────────────────────────────────

const ITERATIONS = 310000;

const toHex = (buf) =>
  Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");

const enc = new TextEncoder();

/** Turns a hex salt into the bytes PBKDF2 wants. */
const hexToBytes = (hex) =>
  Uint8Array.from(String(hex).match(/.{2}/g) || [], (h) => parseInt(h, 16));

async function api(path, { method = "POST", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });

  let data = null;
  try { data = await res.json(); } catch { /* not JSON — handled below */ }

  if (!data) return { ok: false, error: "The server didn't answer properly. Try again." };
  if (!res.ok) return { ok: false, error: data.error || "Something went wrong. Try again." };
  return data;
}

/**
 * Derives the key we send in place of the password.
 *
 * Deliberately not cached: holding a password-equivalent in memory for the
 * length of a session is exactly the thing this design is meant to avoid.
 */
async function deriveAuthKey(password, email) {
  const saltRes = await api("/api/auth/salt", { body: { email } });
  if (!saltRes.ok) return { ok: false, error: saltRes.error };

  const material = await crypto.subtle.importKey(
    "raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltRes.salt), iterations: ITERATIONS, hash: "SHA-256" },
    material, 256
  );
  return { ok: true, authKey: toHex(bits) };
}

/* ───────────────────────────────────────────────────────────── Google ─── */

let gisLoaded = null;

/** Loads Google Identity Services once, on demand. */
function loadGoogle() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve(window.google);
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve(window.google);
    s.onerror = () => reject(new Error("Couldn't load Google sign-in."));
    document.head.appendChild(s);
  });
  return gisLoaded;
}

/* ──────────────────────────────────────────────────────────── backend ─── */

export async function createApiBackend({ setSession, validateSignUp, RULES }) {
  // One probe decides everything. On Cloudflare Pages this answers; on plain
  // static hosting it 404s and account.js quietly keeps the local shell, so
  // the same build works in both places.
  let config = { googleClientId: "", turnstileSiteKey: "", resetEmail: false };
  try {
    const probe = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!probe.ok) return null;
    const first = await probe.json();
    if (!first || typeof first.ok !== "boolean") return null;
    setSession(first.data || null);

    const cfg = await api("/api/config", { method: "GET" });
    if (cfg.ok && cfg.data) config = cfg.data;
  } catch {
    return null;   // no API here — the caller falls back
  }

  return {
    kind: "cloudflare",
    config,

    async signUp({ username, email, password, captcha, turnstile }) {
      const problem = validateSignUp({ username, email, password });
      if (problem) return { ok: false, error: problem };
      // Turnstile replaces the old hand-rolled widget, but the widget is still
      // there for anyone who loads the page before Turnstile is configured.
      if (!turnstile && !captcha) return { ok: false, error: "Please complete the human check." };

      const derived = await deriveAuthKey(password, email);
      if (!derived.ok) return derived;

      const res = await api("/api/auth/signup", {
        body: { username: String(username).trim(), email: String(email).trim(),
                authKey: derived.authKey, turnstile },
      });
      if (res.ok) setSession(res.data);
      return res;
    },

    async signIn({ email, password }) {
      const derived = await deriveAuthKey(password, email);
      if (!derived.ok) return derived;

      const res = await api("/api/auth/signin", {
        body: { email: String(email).trim(), authKey: derived.authKey },
      });
      if (res.ok) setSession(res.data);
      return res;
    },

    async signInWithGoogle() {
      if (!config.googleClientId) {
        return { ok: false, error: "Google sign-in isn't switched on yet." };
      }

      let google;
      try { google = await loadGoogle(); }
      catch (err) { return { ok: false, error: err.message }; }

      const credential = await new Promise((resolve) => {
        try {
          google.accounts.id.initialize({
            client_id: config.googleClientId,
            callback: (response) => resolve(response?.credential || null),
            cancel_on_tap_outside: true,
            ux_mode: "popup",
          });
          // A hidden button we click ourselves: it gives the real Google popup
          // without asking the site to find room for Google's own button.
          const host = document.createElement("div");
          host.style.cssText = "position:fixed;opacity:0;pointer-events:none;z-index:-1";
          document.body.appendChild(host);
          google.accounts.id.renderButton(host, { type: "standard" });
          const real = host.querySelector('div[role="button"], div[tabindex]');
          if (real) real.click(); else google.accounts.id.prompt();
          setTimeout(() => host.remove(), 1000);
        } catch { resolve(null); }
      });

      if (!credential) return { ok: false, error: "" };   // they closed it; say nothing

      const res = await api("/api/auth/google", { body: { credential } });
      if (res.ok) setSession(res.data);
      return res;
    },

    /**
     * One Tap: if this browser already has a Google session and the person has
     * used the site before, Google offers to sign them straight back in. This
     * is what "it just logs me in like other sites" actually is.
     */
    async tryAutoSignIn() {
      if (!config.googleClientId) return false;
      try {
        const google = await loadGoogle();
        return await new Promise((resolve) => {
          google.accounts.id.initialize({
            client_id: config.googleClientId,
            auto_select: true,
            cancel_on_tap_outside: true,
            callback: async (response) => {
              if (!response?.credential) return resolve(false);
              const res = await api("/api/auth/google", { body: { credential: response.credential } });
              if (res.ok) setSession(res.data);
              resolve(res.ok);
            },
          });
          google.accounts.id.prompt();
          setTimeout(() => resolve(false), 6000);
        });
      } catch { return false; }
    },

    async signOut() {
      const res = await api("/api/auth/signout", { body: {} });
      setSession(null);            // clear locally whatever the server said
      return res.ok ? res : { ok: true };
    },

    async requestPasswordReset(email) {
      if (!RULES.email.test(email || ""))
        return { ok: false, error: "That email address doesn't look right." };
      return api("/api/auth/reset/request", { body: { email } });
    },

    /** Finishes a reset from the #reset=… link in the email. */
    async confirmPasswordReset({ token, password, email }) {
      const derived = await deriveAuthKey(password, email);
      if (!derived.ok) return derived;
      return api("/api/auth/reset/confirm", { body: { token, authKey: derived.authKey } });
    },

    async changePassword({ current, next }, session) {
      if (!session) return { ok: false, error: "You need to be signed in." };
      if ((next || "").length < 8)
        return { ok: false, error: "New password must be at least 8 characters." };

      const currentKey = current ? await deriveAuthKey(current, session.email) : { ok: true, authKey: "" };
      if (!currentKey.ok) return currentKey;
      const nextKey = await deriveAuthKey(next, session.email);
      if (!nextKey.ok) return nextKey;

      return api("/api/account/password", {
        body: { currentAuthKey: currentKey.authKey, nextAuthKey: nextKey.authKey },
      });
    },

    usernameCooldownDays(session) {
      if (!session?.usernameChangedAt) return 0;
      const elapsed = Date.now() - new Date(session.usernameChangedAt).getTime();
      const left = 7 - elapsed / 86400000;
      return left > 0 ? Math.ceil(left) : 0;
    },

    async changeUsername(username, session) {
      if (!session) return { ok: false, error: "You need to be signed in." };
      const res = await api("/api/account/username", { body: { username } });
      if (res.ok) setSession(res.data);
      return res;
    },

    async updateProfile(patch, session) {
      if (!session) return { ok: false, error: "You need to be signed in." };
      const res = await api("/api/account/profile", { body: patch });
      if (res.ok) setSession(res.data);
      return res;
    },

    async addPublish(scriptId, session) {
      // Nothing to record. A publish IS the row in the scripts table, and the
      // dashboard reads someone's publishes by filtering the library on
      // authorId — so there is no second list that could drift out of step.
      if (!session) return { ok: false, error: "You need to be signed in." };
      return { ok: true };
    },
  };
}
