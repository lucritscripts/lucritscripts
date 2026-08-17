// How long an unlock has left, in one place.
//
// The countdown started life inside the script sheet, which meant it only
// existed while that sheet was open — you could hold three live unlocks and
// see none of them from the library. This module is the shared registry: the
// sheet and the cards both read from it, so they can never disagree about how
// long is left.
//
// Two rules matter here.
//
// 1. It stores DEADLINES, derived from the seconds-remaining the server sends.
//    Never a timestamp from the server — that would need the visitor's clock
//    to agree with Cloudflare's, and plenty of clocks are hours out.
//
// 2. It is a display, not a permission. The server refuses the code the moment
//    a grant lapses whatever this says. Editing it in the console buys a
//    prettier number and nothing else.

const deadlines = new Map();     // scriptId -> ms epoch
const expiryHandlers = new Set();
let ticking = null;

/** m:ss — the shape people read a countdown in. */
export function asClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Records a window from a server answer.
 *
 * `seconds` null or absent means "no clock for this one" — an author reading
 * their own script, or a script nobody has unlocked. That clears any stale
 * deadline rather than leaving one behind.
 */
export function noteWindow(scriptId, seconds) {
  if (!scriptId) return;
  if (Number.isFinite(seconds) && seconds > 0) {
    deadlines.set(scriptId, Date.now() + seconds * 1000);
    start();
  } else {
    deadlines.delete(scriptId);
  }
}

/** Seconds left, or null when there is no live window. */
export function secondsLeft(scriptId) {
  const until = deadlines.get(scriptId);
  if (until === undefined) return null;
  const left = (until - Date.now()) / 1000;
  if (left > 0) return left;
  deadlines.delete(scriptId);
  return null;
}

export function isUnlocked(scriptId) {
  return secondsLeft(scriptId) !== null;
}

export function forget(scriptId) {
  deadlines.delete(scriptId);
}

/** Called with a script id when its window runs out. */
export function onExpire(fn) {
  expiryHandlers.add(fn);
  return () => expiryHandlers.delete(fn);
}

/**
 * One interval for the whole page.
 *
 * Every countdown anywhere is `[data-unlock-clock="<id>"]`, so a card in the
 * library and the chip in the open sheet are updated by the same pass. It
 * stops itself when nothing is counting, rather than ticking forever.
 */
function tick() {
  const expired = [];

  for (const [id, until] of deadlines) {
    if (until - Date.now() <= 0) expired.push(id);
  }
  for (const id of expired) deadlines.delete(id);

  for (const node of document.querySelectorAll("[data-unlock-clock]")) {
    const id = node.dataset.unlockClock;
    const left = deadlines.get(id);
    node.textContent = left === undefined ? "" : asClock((left - Date.now()) / 1000);
  }

  for (const id of expired) {
    for (const fn of expiryHandlers) {
      try { fn(id); } catch { /* one bad listener must not stop the rest */ }
    }
  }

  if (!deadlines.size) stop();
}

function start() {
  if (ticking) return;
  ticking = setInterval(tick, 1000);
  tick();
}

function stop() {
  if (!ticking) return;
  clearInterval(ticking);
  ticking = null;
}

/**
 * The countdown chip, ready to drop into any markup.
 *
 * Returns "" when there is nothing to count, so callers can interpolate it
 * unconditionally instead of writing the same ternary everywhere.
 */
export function clockChip(scriptId, { compact = false } = {}) {
  const left = secondsLeft(scriptId);
  if (left === null) return "";
  return `<span class="chip chip--warn" title="When this runs out, the sponsor step comes back.">`
    + `<span data-unlock-clock="${String(scriptId).replace(/"/g, "&quot;")}">${asClock(left)}</span>`
    + (compact ? "" : " left")
    + `</span>`;
}
