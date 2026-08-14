// URL safety. No imports, so both the account layer and the render layer can
// use the same rules — a check that only runs in one of those places is a
// check that eventually gets bypassed.

/** Schemes allowed to appear in an href. Everything else is a vector. */
const SAFE_SCHEMES = new Set(["http:", "https:"]);

/**
 * True when `hostname` is exactly `host` or a subdomain of it.
 *
 * The naive version of this check is `hostname.includes(host)`, which passes
 * "youtube.com.evil.tk" — an attacker registers that and puts a phishing link
 * on a public profile. Anchoring at a dot boundary is what makes it a real
 * check rather than a substring coincidence.
 */
export function isHost(hostname, host) {
  const h = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const want = String(host).toLowerCase();
  return h === want || h.endsWith("." + want);
}

/**
 * Normalises a social link, or returns "" if it is not a real link to one of
 * `hosts`. Rejects javascript:, data:, vbscript: and anything else that is not
 * plain http(s) — those are how a profile field becomes stored XSS.
 */
export function safeSocialUrl(value, hosts) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  // A bare "youtube.com/@me" is what people actually type.
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : "https://" + raw;

  let url;
  try { url = new URL(candidate); } catch { return ""; }

  if (!SAFE_SCHEMES.has(url.protocol)) return "";
  if (![].concat(hosts).some((h) => isHost(url.hostname, h))) return "";

  url.protocol = "https:";     // never hand out a downgraded link
  url.username = "";
  url.password = "";           // strips the "https://real.com@evil.com" trick
  return url.toString();
}

/**
 * Last line of defence at render time. Data written before these rules
 * existed — or by a future code path that forgets to validate — still cannot
 * become a javascript: href on someone else's screen.
 */
export function safeHref(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return SAFE_SCHEMES.has(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

/**
 * Images may legitimately be data: URLs here, because avatars are stored
 * inline. Scripts cannot run from an <img src>, but javascript: and other
 * schemes have no business there either.
 */
export function safeImageSrc(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,[A-Za-z0-9+/=\s]+$/i.test(raw)) return raw;
  return safeHref(raw);
}
