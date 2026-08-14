// Firebase-backed accounts.
//
// Same method shapes as the local shell in account.js — every call returns
// { ok, error?, data? } — so the UI never learns which backend it is talking
// to. account.js picks one at startup and delegates.
//
// Where things live:
//   Auth              email + password, password resets, the uid
//   users/{uid}       the public profile: username, bio, avatar, socials
//   usernames/{lower} a claim ticket, so two people cannot take one name
//
// Emails are deliberately NOT copied into Firestore. `users` is world-readable
// so profiles and the leaderboard work without an account, and an email
// address has no business in a public document.

import { firebaseReady } from "./firebase.js";
import { safeSocialUrl } from "./safe.js";

const COOLDOWN_DAYS = 7;

/** Firebase's error codes, in words a person can act on. */
function readable(err) {
  const code = String(err?.code || "");
  return {
    "auth/email-already-in-use": "An account already exists for that email.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Password must be at least 8 characters.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/wrong-password": "Email or password is incorrect.",
    "auth/user-not-found": "Email or password is incorrect.",
    "auth/too-many-requests": "Too many attempts — wait a minute and try again.",
    "auth/network-request-failed": "Couldn't reach the server. Check your connection.",
    "auth/requires-recent-login": "For safety, sign out and back in before changing this.",
    "permission-denied": "You don't have permission to do that.",
    "unavailable": "Couldn't reach the server. Check your connection.",
  }[code] || err?.message || "Something went wrong. Try again.";
}

const fail = (err) => ({ ok: false, error: readable(err) });

export async function createFirebaseBackend({ setSession, validateSignUp, RULES }) {
  const fb = await firebaseReady;
  if (!fb) return null;

  const { auth, db, fns } = fb;
  const {
    createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
    sendPasswordResetEmail, updatePassword, EmailAuthProvider,
    reauthenticateWithCredential, onAuthStateChanged,
    doc, getDoc, setDoc, updateDoc, deleteDoc, runTransaction, serverTimestamp,
  } = fns;

  const userRef = (uid) => doc(db, "users", uid);
  const nameRef = (name) => doc(db, "usernames", name.toLowerCase());

  /** Profile doc + auth user → the session shape the UI already expects. */
  function toSession(user, profile) {
    if (!user) return null;
    return {
      id: user.uid,
      email: user.email || "",
      username: profile?.username || (user.email || "").split("@")[0],
      bio: profile?.bio || "",
      avatar: profile?.avatar || null,
      youtube: profile?.youtube || "",
      tiktok: profile?.tiktok || "",
      createdAt: profile?.createdAt || new Date().toISOString(),
      usernameChangedAt: profile?.usernameChangedAt || null,
      publishes: profile?.publishes || [],
      remote: true,
    };
  }

  async function loadSession(user) {
    if (!user) return null;
    const snap = await getDoc(userRef(user.uid)).catch(() => null);
    return toSession(user, snap?.exists() ? snap.data() : null);
  }

  /** Claims a username, or fails if someone already holds it. */
  async function claimUsername(uid, username, previous) {
    await runTransaction(db, async (tx) => {
      const ref = nameRef(username);
      const held = await tx.get(ref);
      if (held.exists() && held.data().uid !== uid) {
        throw new Error("That username is already taken.");
      }
      tx.set(ref, { uid });
      if (previous && previous.toLowerCase() !== username.toLowerCase()) {
        tx.delete(nameRef(previous));
      }
    });
  }

  // Keep the UI in step with Auth: a refreshed tab, a token expiring, or a
  // sign-in in another tab all land here.
  let settled = false;
  const first = new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      setSession(await loadSession(user));
      if (!settled) { settled = true; resolve(); }
    });
  });
  await first;

  return {
    kind: "firebase",

    async signUp({ username, email, password, captcha }) {
      const problem = validateSignUp({ username, email, password });
      if (problem) return { ok: false, error: problem };
      if (!captcha) return { ok: false, error: "Please complete the human check." };

      const name = String(username).trim();

      // Check first for a friendly message; the transaction below is what
      // actually makes it safe against two people racing for one name.
      const taken = await getDoc(nameRef(name)).catch(() => null);
      if (taken?.exists()) return { ok: false, error: "That username is already taken." };

      let credential;
      try {
        credential = await createUserWithEmailAndPassword(auth, email, password);
      } catch (err) { return fail(err); }

      const uid = credential.user.uid;
      const profile = {
        username: name,
        usernameLower: name.toLowerCase(),
        bio: "", avatar: null, youtube: "", tiktok: "",
        createdAt: new Date().toISOString(),
        usernameChangedAt: null,
        publishes: [],
        joinedAt: serverTimestamp(),
      };

      try {
        await claimUsername(uid, name, null);
        await setDoc(userRef(uid), profile);
      } catch (err) {
        // The account exists but has no profile — deleting the auth user here
        // would need a recent login, so leave it and surface the real reason.
        return fail(err);
      }

      const session = toSession(credential.user, profile);
      setSession(session);
      return { ok: true, data: session };
    },

    async signIn({ email, password }) {
      try {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        const session = await loadSession(credential.user);
        setSession(session);
        return { ok: true, data: session };
      } catch (err) { return fail(err); }
    },

    async signOut() {
      try { await signOut(auth); setSession(null); return { ok: true }; }
      catch (err) { return fail(err); }
    },

    async requestPasswordReset(email) {
      if (!RULES.email.test(email || ""))
        return { ok: false, error: "That email address doesn't look right." };
      try {
        await sendPasswordResetEmail(auth, email);
        // Never reveal whether an account exists for that address.
        return { ok: true, data: { pending: true } };
      } catch (err) {
        if (String(err?.code) === "auth/user-not-found") return { ok: true, data: { pending: true } };
        return fail(err);
      }
    },

    async changePassword({ current, next }) {
      const user = auth.currentUser;
      if (!user) return { ok: false, error: "You need to be signed in." };
      if ((next || "").length < 8)
        return { ok: false, error: "New password must be at least 8 characters." };

      try {
        // Proving the current password is what stops a walk-up attacker on an
        // unlocked laptop from taking the account over.
        await reauthenticateWithCredential(
          user, EmailAuthProvider.credential(user.email, current)
        );
      } catch { return { ok: false, error: "Current password is incorrect." }; }

      try { await updatePassword(user, next); return { ok: true }; }
      catch (err) { return fail(err); }
    },

    usernameCooldownDays(session) {
      if (!session?.usernameChangedAt) return 0;
      const elapsed = Date.now() - new Date(session.usernameChangedAt).getTime();
      const left = COOLDOWN_DAYS - elapsed / 86400000;
      return left > 0 ? Math.ceil(left) : 0;
    },

    async changeUsername(username, session) {
      const user = auth.currentUser;
      if (!user || !session) return { ok: false, error: "You need to be signed in." };

      const name = String(username || "").trim();
      if (!name) return { ok: false, error: "Pick a username." };
      if (name.length > 32) return { ok: false, error: "Username can be at most 32 characters." };
      if (!RULES.username.test(name))
        return { ok: false, error: "Username can use letters, numbers, spaces, dots, dashes and underscores." };

      const days = this.usernameCooldownDays(session);
      if (days > 0)
        return { ok: false, error: `You can change your username again in ${days} day${days === 1 ? "" : "s"}.` };

      const changedAt = new Date().toISOString();
      try {
        await claimUsername(user.uid, name, session.username);
        await updateDoc(userRef(user.uid), {
          username: name, usernameLower: name.toLowerCase(), usernameChangedAt: changedAt,
        });
      } catch (err) { return fail(err); }

      const next = { ...session, username: name, usernameChangedAt: changedAt };
      setSession(next);
      return { ok: true, data: next };
    },

    async updateProfile(patch, session) {
      const user = auth.currentUser;
      if (!user || !session) return { ok: false, error: "You need to be signed in." };

      const clean = {};
      if (patch.bio !== undefined) clean.bio = String(patch.bio).slice(0, 300);
      if (patch.avatar !== undefined) clean.avatar = patch.avatar;
      // Validated here, not just in the local backend. Storing these raw let
      // a profile hold a javascript: URL that ran on any visitor who clicked
      // it — and `users` is world-readable, so that reached everyone.
      if (patch.youtube !== undefined) clean.youtube = safeSocialUrl(patch.youtube, ["youtube.com", "youtu.be"]);
      if (patch.tiktok !== undefined) clean.tiktok = safeSocialUrl(patch.tiktok, ["tiktok.com"]);

      try { await updateDoc(userRef(user.uid), clean); }
      catch (err) { return fail(err); }

      const next = { ...session, ...clean };
      setSession(next);
      return { ok: true, data: next };
    },

    async addPublish(scriptId, session) {
      const user = auth.currentUser;
      if (!user || !session) return { ok: false, error: "You need to be signed in." };

      const publishes = Array.from(new Set([...(session.publishes || []), scriptId]));
      try { await updateDoc(userRef(user.uid), { publishes }); }
      catch (err) { return fail(err); }

      setSession({ ...session, publishes });
      return { ok: true };
    },

    /** Deleting an account is the user's to do, and needs a recent sign-in. */
    async deleteUsernameClaim(name) {
      try { await deleteDoc(nameRef(name)); return { ok: true }; }
      catch (err) { return fail(err); }
    },
  };
}
