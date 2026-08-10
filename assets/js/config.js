/* ============================================================
 *  SITE + MONETIZATION CONFIG  —  edit this file, nothing else
 * ============================================================ */

window.SITE = {
  name: "LucritScripts",
  tagline: "Guides and resources, free.",
  domain: "lucritscripts.github.io", // used for the Linkvertise blacklist
};

/* ------------------------------------------------------------
 *  LOOTLABS
 * ---------------------------------------------------------- */
window.LOOTLABS = {
  // lockId -> loot-link URL. Create these in the LootLabs panel.
  links: {
    "pack-basic": "https://loot-link.com/s?REPLACE_ME_1",
    "pack-pro":   "https://loot-link.com/s?REPLACE_ME_2",
    "cheatsheet": "https://loot-link.com/s?REPLACE_ME_3",
  },

  // Cloudflare Worker base URL (see /worker). Holds your API token and
  // receives postbacks. Leave "" to run link-locker only.
  workerUrl: "",

  // Task-wall SDK script, issued by your LootLabs account manager.
  sdkScriptUrl: "",

  unlockTtlHours: 24,
  verifyTimeoutMs: 300000,
  verifyIntervalMs: 3000,
  allowUnverifiedUnlock: true,
};

/* ------------------------------------------------------------
 *  LINKVERTISE
 * ---------------------------------------------------------- */
window.LINKVERTISE = {
  // Your numeric publisher/user ID from the Linkvertise dashboard.
  userId: 0, // e.g. 1234567

  // Full Script API: auto-converts OUTBOUND links into Linkvertise links.
  // Loaded into <head> on every page. Set false to disable.
  fullScript: true,

  // IMPORTANT: Linkvertise matches these as SUBSTRINGS, not domains.
  // Always blacklist your own domain or your internal navigation gets
  // monetized and readers can never move around the site.
  blacklist: ["lucritscripts.github.io", "github.com", "loot-link.com"],

  // If non-empty, ONLY links containing these substrings are monetized.
  whitelist: [],

  // Static Linkvertise links you created by hand, keyed like LootLabs.
  links: {
    "pack-basic": "https://link-to.net/REPLACE/ME/1",
    "cheatsheet": "https://link-to.net/REPLACE/ME/2",
  },

  // Community "dynamic detour" link format. Unofficial — Linkvertise does
  // not document or support it, links won't appear in your dashboard list,
  // and it can break without notice. Off by default; turn on at your risk.
  useDynamicLinks: false,
};

/* ------------------------------------------------------------
 *  GATE STACK — how hard the site monetizes
 * ---------------------------------------------------------- */
window.GATES = {
  // Which network handles unlocks. "rotate" alternates per unlock so you
  // are not dependent on one network's fill rate or payout swings.
  network: "rotate", // "lootlabs" | "linkvertise" | "rotate"

  // Sticky bar pinned to the bottom of every page.
  stickyBar: {
    enabled: true,
    text: "Enjoying the site? One quick step keeps it free.",
    cta: "Support",
    lockId: "pack-basic",
    delayMs: 8000,       // wait before showing
    dismissHours: 12,    // stay dismissed this long
  },

  // Fires once per session when the cursor leaves toward the tab bar.
  exitIntent: {
    enabled: true,
    title: "Before you go",
    body: "Grab the resource pack — one sponsor step, no signup.",
    cta: "Unlock the pack",
    lockId: "pack-pro",
    minSecondsOnPage: 20,
  },

  // Full-page gate. Add data-gate-page to <body> to require a step
  // before the page is readable at all. Use sparingly.
  interstitial: {
    title: "One step to continue",
    body: "This page is reader-supported. Complete one sponsor step to unlock it for 24 hours.",
    cta: "Continue",
    lockId: "pack-basic",
  },
};
