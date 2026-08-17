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

/**
 * One leaderboard.
 *
 * Returns null rather than [] when the request fails, so the caller can tell
 * "nobody is on this board" apart from "we could not find out" — the page says
 * different things for the two, and conflating them was how an empty board
 * looked like a working one for weeks.
 */
export async function fetchBoard(board) {
  const res = await call(`/api/leaderboard?board=${encodeURIComponent(board)}`);
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

/**
 * Asks the server to check the sponsor step really completed.
 *
 * LootLabs proves it with a click id their postback already confirmed;
 * Linkvertise proves it with a hash carried back on the return URL. The server
 * decides which applies — the caller just forwards whatever it was given.
 */
export async function claimUnlock(scriptId, clickId, hash) {
  return call("/api/unlock/claim", { method: "POST", body: { scriptId, clickId, hash } });
}

/**
 * A click id parked by the sponsor round-trip.
 *
 * The provider sends the visitor back to /?unlocked=<id>&click=<clickId>. We
 * stash it and clean the URL, so a refresh does not re-trigger anything and
 * the address bar does not carry it around.
 */
const PENDING = "lucrit:pendingUnlock";
const STARTED = "lucrit:startedUnlock";

export function capturePendingUnlock() {
  try {
    const url = new URL(location.href);
    const clickId = url.searchParams.get("click");
    const hash = url.searchParams.get("hash");

    // LootLabs sends them back to a URL we built, so it names the script.
    // Linkvertise links point at one fixed destination configured by hand in
    // their dashboard, so the return carries only a hash — which script it was
    // for is what we parked in `started` on the way out.
    let scriptId = url.searchParams.get("unlocked");
    if (!scriptId && hash) {
      try { scriptId = JSON.parse(sessionStorage.getItem(STARTED) || "null")?.scriptId || null; }
      catch { scriptId = null; }
    }
    if (!scriptId || (!clickId && !hash)) return null;

    sessionStorage.setItem(PENDING, JSON.stringify({ scriptId, clickId, hash }));
    sessionStorage.removeItem(STARTED);
    url.searchParams.delete("unlocked");
    url.searchParams.delete("click");
    url.searchParams.delete("hash");
    history.replaceState(null, "", url.toString());
    return { scriptId, clickId, hash };
  } catch {
    return null;
  }
}

/**
 * Remembers which script a Linkvertise trip was for.
 *
 * Their link has one fixed destination, so nothing in the return URL says what
 * the visitor was unlocking. This is only a hint for the client — the server
 * still requires an unlock it minted for this person and this script, so
 * editing it cannot unlock anything.
 */
export function rememberStartedUnlock(scriptId) {
  try { sessionStorage.setItem(STARTED, JSON.stringify({ scriptId, at: Date.now() })); }
  catch { /* private mode — the trip just cannot be resumed */ }
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
