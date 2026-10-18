// Ads (Monetag). 18 Oct 2026: "add every type of ad for maximum pay".
//
// One Monetag Multitag ("Epic tag", zone 297797) runs every format the
// account has: OnClick popunder, In-Page Push, Vignette banner and push
// notifications (push needs /sw.js at the site root, which is in this repo).
// It replaces the single OnClick zone 12060465 the site used before — running
// both would double the popunders.
//
// Monetag hands out an inline <script>; the site's CSP doesn't run inline
// scripts, so the same tag is created here. The Multitag loads from domains
// that keep changing, so the Worker relaxes the CSP on public pages only
// (see adsCsp in _worker.js). The tag is kept away from:
//   - /admin, /dashboard and /unlock/* (the unlock steps already open
//     LootLabs / Linkvertise, and an ad there costs sponsor completions; admin
//     and dashboard keep a strict CSP and are opened with a full page load once
//     ads are running, so no ad script is ever resident there);
//   - the owner's own browser (set once the admin panel has been opened here);
//   - automated browsers (tests, bots) so they never count as ad traffic.
// /getkey is a separate page and never loads this file.
// How often each format shows is set on the zone in Monetag.

const ZONE = "297797";
const TAG = "https://quge5.com/88/tag.min.js";
const SKIP = [/^\/admin(\/|$)/, /^\/dashboard(\/|$)/, /^\/unlock\//];

export function adsAllowed(path = location.pathname) {
  if (SKIP.some((re) => re.test(path))) return false;
  try { if (localStorage.getItem("lucrit:staff") === "1") return false; } catch { /* storage blocked */ }
  if (navigator.webdriver) return false;
  return true;
}

let loaded = false;
/** True once the ad tag is in this page (so strict pages need a fresh load). */
export const adsLoaded = () => loaded;

export function loadAds() {
  if (loaded || !adsAllowed()) return;
  loaded = true;
  watchBlocks();
  const s = document.createElement("script");
  s.dataset.zone = ZONE;
  s.dataset.cfasync = "false";
  s.src = TAG;
  s.async = true;
  document.head.appendChild(s);
}

/** Waits until the page has settled, so the ad never slows the first paint. */
export function scheduleAds() {
  const go = () => setTimeout(loadAds, 1500);
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

// Anything the CSP still blocks is reported (directive + host only), so a
// format that silently fails shows up in /api/admin/csp.
let reported = 0;
const seen = new Set();
function watchBlocks() {
  document.addEventListener("securitypolicyviolation", (e) => {
    if (reported >= 8) return;
    let h = String(e.blockedURI || "");
    try { h = /^https?:/.test(h) ? new URL(h).host : h.split(":")[0]; } catch { /* keep as is */ }
    const d = String(e.effectiveDirective || e.violatedDirective || "").split(" ")[0];
    const key = d + "|" + h;
    if (!d || !h || seen.has(key)) return;
    seen.add(key);
    reported++;
    try {
      fetch("/api/csp", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ d, h }),
      }).catch(() => {});
    } catch { /* never let reporting break the page */ }
  });
}
