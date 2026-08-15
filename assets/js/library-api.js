// The library, as the server sees it.
//
// This replaces the in-memory array that used to be the whole library. That
// array was why a published script was visible to exactly one person in
// exactly one tab: nothing ever left the browser, and a refresh emptied it.
//
// Two things are worth knowing about the shape here:
//
// 1. A script object from this module has NO `code` property. The code is
//    fetched separately, once, after an unlock. If you find yourself adding
//    code to a listing response, the paywall has just become decoration again.
//
// 2. It degrades. On static hosting there is no /api, so `available` is false
//    and the caller keeps its old local behaviour rather than showing an
//    error page. The same build runs in both places.

let available = null;          // null = not probed yet

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });

  if (res.status === 404 && available === null) {
    // Could be "no API here" or "no such script". Only the former is a reason
    // to fall back, and it is distinguishable: our API answers with JSON.
    const text = await res.text();
    try { return { ...JSON.parse(text), status: res.status }; }
    catch { available = false; return { ok: false, absent: true }; }
  }

  const data = await res.json().catch(() => ({ ok: false, error: "That didn't work." }));
  return { ...data, status: res.status };
}

/** True when there is a real backend behind this host. */
export async function libraryOnline() {
  if (available !== null) return available;
  try {
    const res = await fetch("/api/scripts?limit=1", { credentials: "same-origin" });
    available = res.ok;
  } catch {
    available = false;
  }
  return available;
}

export async function fetchScripts() {
  const res = await call("/api/scripts");
  return res.ok ? res.data : [];
}

export async function fetchScript(id) {
  const res = await call(`/api/scripts/${encodeURIComponent(id)}`);
  return res.ok ? res.data : null;
}

export async function publishScript(script) {
  return call("/api/scripts", { method: "POST", body: script });
}

export async function deleteScript(id) {
  return call(`/api/scripts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function likeScript(id) {
  return call(`/api/scripts/${encodeURIComponent(id)}/like`, { method: "POST" });
}

export async function reportScript(id, reason) {
  return call(`/api/scripts/${encodeURIComponent(id)}/report`, { method: "POST", body: { reason } });
}

/** The code, which only comes back if this visitor is allowed to have it. */
export async function fetchCode(id) {
  const res = await call(`/api/scripts/${encodeURIComponent(id)}/code`);
  return res.ok ? res.data.code : null;
}

/* ------------------------------------------------------------- unlocking */

/**
 * Starts the sponsor step.
 *
 * Returns the provider URL to send the visitor to, plus the click id that the
 * claim step will quote back. When the provider is not configured there is no
 * URL — the caller should say so rather than pretending a step happened.
 */
export async function startUnlock(scriptId, provider) {
  return call("/api/unlock/start", { method: "POST", body: { scriptId, provider } });
}

/** Asks the server to check the sponsor step really completed. */
export async function claimUnlock(scriptId, clickId) {
  return call("/api/unlock/claim", { method: "POST", body: { scriptId, clickId } });
}

/**
 * A click id parked by the sponsor round-trip.
 *
 * The provider sends the visitor back to /?unlocked=<id>&click=<clickId>. We
 * stash it and clean the URL, so a refresh does not re-trigger anything and
 * the address bar does not carry it around.
 */
const PENDING = "lucrit:pendingUnlock";

export function capturePendingUnlock() {
  try {
    const url = new URL(location.href);
    const scriptId = url.searchParams.get("unlocked");
    const clickId = url.searchParams.get("click");
    if (!scriptId || !clickId) return null;

    sessionStorage.setItem(PENDING, JSON.stringify({ scriptId, clickId }));
    url.searchParams.delete("unlocked");
    url.searchParams.delete("click");
    history.replaceState(null, "", url.toString());
    return { scriptId, clickId };
  } catch {
    return null;
  }
}

export function takePendingUnlock() {
  try {
    const raw = sessionStorage.getItem(PENDING);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
