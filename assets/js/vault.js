// A person's own shelf: drafts they are still working on, and scripts they
// hearted off the site.
//
// Both are keyed by account id, so two people sharing a browser do not see
// each other's shelf, and signing out hides it rather than deleting it.
// Storage is local for now; against Firestore this becomes
// users/{uid}/drafts and users/{uid}/saved with the same four functions.

const KEY = "lucrit:vault";

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function save(all) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); }
  catch { /* storage full or blocked — the shelf is best-effort */ }
}

const listeners = new Set();
export function onVaultChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed() { for (const fn of listeners) fn(); }

/** Everything belonging to one account. Signed out is an empty shelf. */
function shelf(userId) {
  if (!userId) return { drafts: [], saved: [] };
  const mine = load()[userId] || {};
  return { drafts: mine.drafts || [], saved: mine.saved || [] };
}

function write(userId, next) {
  if (!userId) return;
  const all = load();
  all[userId] = next;
  save(all);
  changed();
}

/* --------------------------------------------------------------- drafts */

export function drafts(userId) {
  return shelf(userId).drafts.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function getDraft(userId, id) {
  return shelf(userId).drafts.find((d) => d.id === id) || null;
}

/** Creates or updates a draft and returns it. */
export function saveDraft(userId, draft) {
  if (!userId) return null;
  const mine = shelf(userId);
  const id = draft.id || "d_" + Math.random().toString(36).slice(2, 10);

  const next = {
    id,
    title: String(draft.title || "Untitled script").slice(0, 70),
    prompt: String(draft.prompt || "").slice(0, 2000),
    code: String(draft.code || ""),
    game: String(draft.game || ""),
    category: draft.category || "utilities",
    // The conversation that produced it, so reopening a script picks the chat
    // back up instead of dropping you in front of a stranger's code. Bounded,
    // because this all has to fit in one localStorage entry.
    turns: (Array.isArray(draft.turns) ? draft.turns : [])
      .slice(-20)
      .filter((t) => t && (t.role === "user" || t.role === "ai") && typeof t.text === "string")
      .map((t) => ({ role: t.role, text: t.text.slice(0, 600) })),
    updatedAt: new Date().toISOString(),
  };

  const rest = mine.drafts.filter((d) => d.id !== id);
  write(userId, { ...mine, drafts: [next, ...rest].slice(0, 50) });
  return next;
}

export function deleteDraft(userId, id) {
  const mine = shelf(userId);
  write(userId, { ...mine, drafts: mine.drafts.filter((d) => d.id !== id) });
}

/* ---------------------------------------------------------------- saved */

export function savedIds(userId) {
  return shelf(userId).saved.slice();
}

export function isSaved(userId, scriptId) {
  return shelf(userId).saved.includes(scriptId);
}

/** Hearts or un-hearts a script. Returns the new state. */
export function toggleSaved(userId, scriptId) {
  if (!userId || !scriptId) return false;
  const mine = shelf(userId);
  const has = mine.saved.includes(scriptId);
  const saved = has ? mine.saved.filter((s) => s !== scriptId) : [scriptId, ...mine.saved];
  write(userId, { ...mine, saved: saved.slice(0, 500) });
  return !has;
}

/* --------------------------------------------------------------- quota */

// Generation is free for everyone, so the only thing standing between a
// popular day and an empty credit balance is a per-person allowance. The
// server enforces its own limit too — this one exists to give people a clear
// number instead of a sudden failure.

const QUOTA_KEY = "lucrit:quota";

export const QUOTA = { signedOut: 5, signedIn: 25 };

function today() { return new Date().toISOString().slice(0, 10); }

export function quotaLeft(signedIn) {
  const cap = signedIn ? QUOTA.signedIn : QUOTA.signedOut;
  try {
    const raw = JSON.parse(localStorage.getItem(QUOTA_KEY) || "{}");
    return raw.day === today() ? Math.max(0, cap - (raw.used || 0)) : cap;
  } catch { return cap; }
}

export function spendQuota() {
  try {
    const raw = JSON.parse(localStorage.getItem(QUOTA_KEY) || "{}");
    const used = raw.day === today() ? (raw.used || 0) + 1 : 1;
    localStorage.setItem(QUOTA_KEY, JSON.stringify({ day: today(), used }));
  } catch { /* best-effort */ }
}
