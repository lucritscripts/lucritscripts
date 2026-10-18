// Sponsor-tab gate (18 Oct 2026).
//
// After someone has finished the unlock steps, the last button — "Get Your
// Key" on /getkey, "Copy code" on a script — takes a few presses. Each press
// opens one sponsor tab (a Monetag Direct Link); the action itself happens on
// the final press. The button says how many presses are left, so nobody is
// left thinking the site is broken.
//
// Monetag's Onclick tag is frequency-capped (about one pop per visit), which
// is why this uses a Direct Link opened from the click instead: one press,
// one tab, as many as the gate asks for.
//
// Skipped for: the owner's browser (admin panel opened here), a script's own
// author, automated browsers, and whenever no link is configured.

/**
 * Monetag Direct Links, one per gate so their earnings show separately in
 * Monetag (Direct Link page). An empty string switches that gate off.
 */
export const SPONSOR_LINKS = {
  key: "https://uplcm.com/4/12060629",    // "Superior link" — /getkey, Get Your Key
  copy: "https://uplcm.com/4/12060633",   // "Industrious link" — a script's Copy / raw / link
};
export const SPONSOR_LINK = SPONSOR_LINKS.copy;

const MIN = 3;
const MAX = 5;

function exempt(link) {
  if (!link) return true;
  try { if (localStorage.getItem("lucrit:staff") === "1") return true; } catch { /* storage blocked */ }
  // Automated browsers never open ad tabs — except a test that asks for the
  // gate explicitly (harmless for a real visitor: it only means more presses).
  if (typeof navigator !== "undefined" && navigator.webdriver) {
    try { if (localStorage.getItem("lucrit:adtest") === "1") return false; } catch { /* storage blocked */ }
    return true;
  }
  return false;
}

const roll = () => MIN + Math.floor(Math.random() * (MAX - MIN + 1));

/** Opens one sponsor tab. Must run synchronously inside the click/copy handler. */
function openSponsor(link) {
  try {
    const w = window.open(link, "_blank");
    if (w) { try { w.opener = null; } catch { /* cross-origin already */ } }
  } catch { /* popup blocked: the press still counts */ }
}

/**
 * One gate, remembered for this browser tab session under `name` — so a
 * refresh doesn't make someone start the presses again, and once a script's
 * copy gate is done, copying it again is free.
 */
export function createAdGate(name, { link = SPONSOR_LINKS[String(name).split(":")[0]] ?? SPONSOR_LINK } = {}) {
  const exempt_ = () => exempt(link);
  const key = "lucrit:gate:" + name;
  let st = null;
  try { st = JSON.parse(sessionStorage.getItem(key) || "null"); } catch { st = null; }
  if (!st || !Number.isInteger(st.need) || !Number.isInteger(st.done)) st = { need: roll(), done: 0 };
  const save = () => { try { sessionStorage.setItem(key, JSON.stringify(st)); } catch { /* fine */ } };

  return {
    /** Presses still needed (0 = the action is free). */
    get left() { return exempt_() ? 0 : Math.max(0, st.need - st.done); },
    get need() { return st.need; },
    get done() { return Math.min(st.done, st.need); },
    /**
     * Call from the click handler. While presses are owed it opens one sponsor
     * tab and returns false; once they're all done it returns true and the
     * caller does the action. The action press opens nothing, so it never
     * fights the sponsor tab for the browser's one-popup-per-click allowance.
     */
    press() {
      if (exempt_() || st.done >= st.need) return true;
      st.done += 1;
      save();
      openSponsor(link);
      return false;
    },
    /** Start over with a fresh count — e.g. after a key is made, for the next one. */
    reset() {
      st = { need: roll(), done: 0 };
      try { sessionStorage.removeItem(key); } catch { /* fine */ }
    },
    /** "(2/4)"-style progress for a button label, or "" when there's nothing to show. */
    label() {
      if (exempt_() || st.done >= st.need) return "";
      return ` (${st.done}/${st.need})`;
    },
  };
}
