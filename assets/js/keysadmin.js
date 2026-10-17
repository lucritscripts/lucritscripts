// Keys from the Get Key page (/getkey), for the admin panel's Keys tab.
//
// The keys live in the user's Firebase project (smh-keysystem, collection
// "keys") — the same one the Roblox loader checks — not in D1. This talks to
// Firestore's REST API with plain fetch rather than loading the Firebase SDK,
// so the main site's CSP only needs connect-src for firestore.googleapis.com
// and no new script source.
//
// Same operations as the old "SMH Key Cleaner" admin page: list, delete,
// delete all expired, and unlock (clear inUse / sessionId / userId / lastPing).
// The panel only draws this tab after the admin passcode; the old page's own
// hardcoded password is deliberately not carried over.

const FIREBASE = {
  apiKey: "AIzaSyDpgv4ZMQ_VKdW565VsDReKGYKJMTVeK58",
  projectId: "smh-keysystem",
};
const BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents`;
const KEY = `key=${encodeURIComponent(FIREBASE.apiKey)}`;

/** Firestore's typed value → plain JS. Timestamps come back as ms. */
function plain(v) {
  if (!v || typeof v !== "object") return null;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return Boolean(v.booleanValue);
  if ("stringValue" in v) return v.stringValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  return null;
}

function shape(docu) {
  const f = docu.fields || {};
  const id = decodeURIComponent(String(docu.name || "").split("/").pop() || "");
  return {
    id,
    valid: plain(f.valid),
    expiresAt: plain(f.expiresAt),
    inUse: Boolean(plain(f.inUse)),
    sessionId: plain(f.sessionId) || "",
    userId: plain(f.userId) || "",
    boundTo: plain(f.boundTo) || "",
    lastPing: plain(f.lastPing),
  };
}

async function fsFetch(url, init) {
  let res;
  try { res = await fetch(url, init); }
  catch { throw new Error("Couldn't reach Firebase."); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message || `Firebase said ${res.status}.`);
  }
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

/** Every key, all pages (capped so a runaway collection can't hang the panel). */
export async function listKeys({ maxPages = 25 } = {}) {
  const out = [];
  let token = "";
  for (let i = 0; i < maxPages; i++) {
    const page = await fsFetch(`${BASE}/keys?pageSize=300&${KEY}${token ? `&pageToken=${encodeURIComponent(token)}` : ""}`);
    for (const d of page.documents || []) out.push(shape(d));
    token = page.nextPageToken || "";
    if (!token) break;
  }
  return out;
}

export async function deleteKey(id) {
  await fsFetch(`${BASE}/keys/${encodeURIComponent(id)}?${KEY}`, { method: "DELETE" });
}

/** Frees a key that's stuck "in use" — same fields the old cleaner reset. */
export async function unlockKey(id) {
  const mask = ["inUse", "sessionId", "userId", "lastPing"].map((f) => `updateMask.fieldPaths=${f}`).join("&");
  await fsFetch(`${BASE}/keys/${encodeURIComponent(id)}?${mask}&${KEY}&currentDocument.exists=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        inUse: { booleanValue: false },
        sessionId: { stringValue: "" },
        userId: { stringValue: "" },
        lastPing: { nullValue: null },
      },
    }),
  });
}

/** Deletes in small parallel batches; returns how many went. */
export async function deleteMany(ids, onProgress) {
  let done = 0, failed = 0;
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10);
    const res = await Promise.allSettled(batch.map((id) => deleteKey(id)));
    done += res.filter((r) => r.status === "fulfilled").length;
    failed += res.filter((r) => r.status === "rejected").length;
    onProgress?.(done, ids.length);
  }
  return { done, failed };
}

/** "Expired" here means "the loader would reject it": past expiry, no expiry, or valid !== true. */
export const isExpired = (k, now = Date.now()) =>
  typeof k.expiresAt !== "number" || k.expiresAt <= now || k.valid === false;

/**
 * Makes a key straight away, no sponsor steps — the admin panel's "Make key".
 * Same document shape /getkey writes (valid, expiresAt, inUse, boundTo,
 * lastPing), so the Roblox loader treats it like any other key. Fails if that
 * id somehow already exists rather than overwriting it.
 */
export async function makeKey(hours = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const rnd = new Uint32Array(16);
  crypto.getRandomValues(rnd);
  let id = "LUCRIT-";
  for (let i = 0; i < 16; i++) id += chars.charAt(rnd[i] % chars.length);
  const now = Date.now();
  const expiresAt = now + Math.round(hours * 3600000);
  await fsFetch(`${BASE}/keys?documentId=${encodeURIComponent(id)}&${KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        valid: { booleanValue: true },
        expiresAt: { integerValue: String(expiresAt) },
        inUse: { booleanValue: false },
        boundTo: { stringValue: "admin" },
        lastPing: { integerValue: String(now) },
      },
    }),
  });
  return { id, expiresAt };
}
