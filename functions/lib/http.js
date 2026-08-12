// Shared HTTP plumbing: CORS, JSON replies, and the origin allowlist.
//
// Cloud Functions hand you an Express-style (req, res), so unlike a Worker
// there is no Response object — everything here writes to `res`.

/** Origins allowed to call these functions, from the ALLOWED_ORIGINS secret. */
function allowedList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function checkOrigin(req, res, allowedValue) {
  const origin = req.headers.origin || "";
  const list = allowedList(allowedValue);
  const ok = Boolean(origin) && list.includes(origin);

  res.set("Access-Control-Allow-Origin", ok ? origin : "null");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  res.set("Vary", "Origin");

  return ok;
}

export function sendJson(res, status, body) {
  res.status(status).set("Content-Type", "application/json").send(JSON.stringify(body));
}

/**
 * The caller's address. Cloud Run puts the real client first in
 * X-Forwarded-For; req.ip is the proxy, so it is not usable on its own.
 */
export function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  return forwarded.split(",")[0].trim() || req.ip || "unknown";
}

/**
 * Fixed-window rate limit in Firestore.
 *
 * Cloudflare had a rate limiting binding; Firebase does not, so this is the
 * equivalent: one counter document per (key, minute), incremented inside a
 * transaction so parallel instances cannot both slip under the limit.
 *
 * Documents carry `expires` — set a Firestore TTL policy on that field and the
 * counters clean themselves up. See functions/README.md.
 */
export async function underLimit(db, key, limit, windowMs = 60000) {
  const bucket = Math.floor(Date.now() / windowMs);
  const ref = db.collection("ratelimits").doc(`${key}_${bucket}`);

  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? snap.data().count || 0 : 0;
      if (count >= limit) return false;

      tx.set(ref, {
        count: count + 1,
        expires: new Date(Date.now() + windowMs * 3),
      });
      return true;
    });
  } catch (err) {
    // A Firestore outage should not take the assistant down with it. Failing
    // open is the right call here: the spend ceiling is max_tokens per reply,
    // and a hard failure would break the site for everyone.
    console.error("rate limit check failed", err);
    return true;
  }
}
