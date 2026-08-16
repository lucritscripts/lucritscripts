// One site, one address.
//
// The same build is served from two places: Cloudflare Pages, which has the
// API behind it, and the old GitHub Pages copy, which is static files and
// nothing else. They look identical, which is the problem — landing on the
// static one means publishing silently falls back to "saved on this device
// only", and a person has no way to tell why.
//
// So the static copy sends you to the real one. This is a module script loaded
// BEFORE main.js in index.html, and module scripts run in order, so it decides
// before the 3D engine or the account layer have started.
//
// Deliberately narrow: it only ever redirects away from the known-static
// hosts, and only to the canonical domain. It cannot bounce the real site, and
// it cannot be pointed anywhere else by a query parameter.

const CANONICAL = "https://lucritscripts.site";

/** Hosts that serve this build with no API behind it. */
const STATIC_HOSTS = new Set([
  "lucritscripts.github.io",
]);

try {
  const host = location.hostname.toLowerCase();

  if (STATIC_HOSTS.has(host)) {
    // Keep whatever they were pointed at — a #script= deep link from a shared
    // URL should survive the hop rather than dumping them on the homepage.
    // The path is dropped on purpose: the old host served the site under a
    // /lucritscripts/ subpath that does not exist on the real domain.
    const target = CANONICAL + "/" + (location.search || "") + (location.hash || "");

    // replace(), not assign(), so Back does not bounce them straight back here.
    location.replace(target);
  }
} catch {
  // If anything about this throws, fall through and let the site load. A
  // redirect that can break the page is worse than an inconsistent address.
}
