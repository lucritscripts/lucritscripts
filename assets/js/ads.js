// Pop-under ads (Monetag "Onclick" zone, added 18 Oct 2026).
//
// Monetag hands out an inline <script>; the site's CSP doesn't run inline
// scripts, so the same tag is created here instead, and only Monetag's own
// domains are added to the CSP (see index.html). It is kept away from:
//   - /admin, /dashboard and /unlock/* (the unlock steps already open
//     LootLabs / Linkvertise, and a pop-under there costs sponsor earnings),
//   - the owner's own browser (set once the admin panel has been opened here),
//   - automated browsers (tests, bots) so they never count as ad traffic.
// /getkey is a separate page and never loads this file.
// How often it pops is set on the zone in Monetag (frequency cap).

const ZONE = "12060465";
const TAG = "https://al5sm.com/tag.min.js";
const SKIP = [/^\/admin(\/|$)/, /^\/dashboard(\/|$)/, /^\/unlock\//];

export function adsAllowed(path = location.pathname) {
  if (SKIP.some((re) => re.test(path))) return false;
  try { if (localStorage.getItem("lucrit:staff") === "1") return false; } catch { /* storage blocked */ }
  if (navigator.webdriver) return false;
  return true;
}

let loaded = false;
export function loadAds() {
  if (loaded || !adsAllowed()) return;
  loaded = true;
  const s = document.createElement("script");
  s.dataset.zone = ZONE;
  s.src = TAG;
  s.async = true;
  document.body.appendChild(s);
}

/** Waits until the page has settled, so the ad never slows the first paint. */
export function scheduleAds() {
  const go = () => setTimeout(loadAds, 1500);
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}
