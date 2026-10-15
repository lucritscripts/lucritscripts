// Lucrit Script — library data.
//
// The library starts EMPTY. Every script on the site is user-published
// through the submit form; nothing is seeded. Once Supabase is connected,
// `SCRIPTS` and `CONTRIBUTORS` are replaced by live queries and this file
// keeps only the category and sort vocabularies.

export const CATEGORIES = [
  // Universal comes first because it is the honest answer for most of what
  // gets published: a script that does not belong to one game. Without it,
  // people picked whatever category was closest and the game filter buried
  // their script under a title it had nothing to do with.
  { id: "universal",   label: "Universal",    accent: "#7cc4ff" },
  { id: "combat",      label: "Combat",       accent: "#ff4d5e" },
  { id: "movement",    label: "Movement",     accent: "#4ff0d0" },
  { id: "ui",          label: "UI",           accent: "#39d7ff" },
  { id: "npc",         label: "NPC & AI",     accent: "#a97bff" },
  { id: "admin",       label: "Admin",        accent: "#ffb547" },
  { id: "data",        label: "Data & Saves", accent: "#2fe0a6" },
  { id: "anticheat",   label: "Anti-Cheat",   accent: "#ff7a45" },
  { id: "inventory",   label: "Inventory",    accent: "#5aa9ff" },
  { id: "shops",       label: "Shops",        accent: "#ff6fd8" },
  { id: "economy",     label: "Economy",      accent: "#ffd75e" },
  { id: "tycoon",      label: "Tycoon",       accent: "#f7c948" },
  { id: "simulator",   label: "Simulator",    accent: "#7ee787" },
  { id: "obby",        label: "Obby",         accent: "#63d2ff" },
  { id: "towerdefense",label: "Tower Defense",accent: "#c08cff" },
  { id: "roleplay",    label: "Roleplay",     accent: "#ff9ecd" },
  { id: "minigames",   label: "Minigames",    accent: "#8de06a" },
  { id: "pets",        label: "Pets",         accent: "#ffb3d1" },
  { id: "farming",     label: "Farming",      accent: "#9ede5a" },
  { id: "crafting",    label: "Crafting",     accent: "#d8a96a" },
  { id: "building",    label: "Building",     accent: "#9fb2cc" },
  { id: "vehicles",    label: "Vehicles",     accent: "#6fa8ff" },
  { id: "quests",      label: "Quests",       accent: "#ffcf6f" },
  { id: "chat",        label: "Chat",         accent: "#7ad9ff" },
  { id: "teleport",    label: "Teleport",     accent: "#b48cff" },
  { id: "camera",      label: "Camera",       accent: "#84e3ff" },
  { id: "lighting",    label: "Lighting",     accent: "#ffe08a" },
  { id: "audio",       label: "Audio",        accent: "#ff8fb1" },
  { id: "effects",     label: "VFX",          accent: "#c2a0ff" },
  { id: "animation",   label: "Animation",    accent: "#c98bff" },
  { id: "leaderboard", label: "Leaderboards", accent: "#6ee7d1" },
  { id: "utilities",   label: "Utilities",    accent: "#8fa6c2" },
  { id: "other",       label: "Other",        accent: "#9fb2cc" },
];

export const SORTS = [
  { id: "popular", label: "Most Popular" },
  { id: "newest",  label: "Newest" },
  { id: "rated",   label: "Highest Rated" },
  { id: "viewed",  label: "Most Viewed" },
];

/** Leaderboard rankings. */
// "Best Rating" used to be here. Nothing in the site ever produced a rating,
// so that tab could only ever be empty — a board promising a ranking that did
// not exist. Unlocks replace it: a real number, and the one that decides who
// gets paid.
export const BOARDS = [
  { id: "scripts", label: "Most Scripts", metric: "scripts", suffix: "scripts" },
  { id: "likes",   label: "Most Likes",   metric: "likes",   suffix: "likes" },
  { id: "views",   label: "Highest Views",metric: "views",   suffix: "views" },
  { id: "unlocks", label: "Most Unlocks", metric: "unlocks", suffix: "unlocks" },
];

/** Every script is user-published. Nothing is seeded. */
export const SCRIPTS = [];

/** Populated from real accounts once Supabase is connected. */
export const CONTRIBUTORS = [];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}


/* ─────────────────────────────────────────────── status badges ── */

const escAttr = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * The two status badges, rendered as two badges — never merged.
 *
 * `verified` is the site's own review verdict, set only by an admin route.
 * `lua` is the server's reading of the submitted code at publish time. A
 * script can be one, both, or neither, and each has to survive being read on
 * its own by somebody about to run the thing.
 *
 * The wording is not decoration. "Lua Detected" beside a green tick would be
 * read as approval by most people, so it gets a different colour, a different
 * word, and a tooltip that says what it does not mean. If these two ever end
 * up sharing a class, the site has started vouching for code nobody read.
 *
 * Lives in this module because it is used by BOTH `ui.js` (cards) and
 * `pages.js` (the script sheet), and ui.js already imports pages.js — putting
 * it in either one would be a cycle. Nothing here imports anything.
 */
/**
 * Labels staff can set from the admin panel. Same ids, same order as
 * ADMIN_LABEL_IDS in _worker.js (tests/adminlabels.spec.mjs checks it).
 * `warn` labels also raise the caution box on the script page.
 */
export const ADMIN_LABELS = [
  { id: "risky",     text: "Risky",           tone: "red",    warn: true,
    tip: "Staff flagged this script as risky. Use it at your own risk." },
  { id: "banrisk",   text: "Ban Risk",        tone: "red",    warn: true,
    tip: "Staff believe using this can get your account banned." },
  { id: "patched",   text: "Patched",         tone: "grey",   warn: true,
    tip: "This no longer works \u2014 the game patched it." },
  { id: "outdated",  text: "Outdated",        tone: "orange",
    tip: "Older script; parts of it may not work on the current game version." },
  { id: "working",   text: "Working",         tone: "green",
    tip: "Staff tested this recently and it worked." },
  { id: "updated",   text: "Updated",         tone: "blue",
    tip: "Recently updated for the current version of the game." },
  { id: "featured",  text: "Featured",        tone: "purple",
    tip: "Featured by the Lucrit Scripts team." },
  { id: "staffpick", text: "Staff Pick",      tone: "pink",
    tip: "A favourite of the Lucrit Scripts team." },
  { id: "hot",       text: "Hot",             tone: "orange",
    tip: "Popular right now." },
  { id: "mobile",    text: "Mobile Friendly", tone: "cyan",
    tip: "Works on mobile executors." },
];
const LABEL_ICON = { risky: "\u26a0 ", banrisk: "\u26d4 ", patched: "\u2716 ", working: "\u2714 ",
  featured: "\u2605 ", staffpick: "\u2665 ", hot: "\ud83d\udd25 ", updated: "\u21bb " };

export function labelBadge(id) {
  const l = ADMIN_LABELS.find((x) => x.id === id);
  if (!l) return "";
  return `<span class="badge badge--label badge--${l.tone}" data-label="${l.id}" title="${escAttr(l.tip)}">${LABEL_ICON[l.id] || ""}${l.text}</span>`;
}

/** Warning labels first, so a card that can only fit two shows the ones that matter. */
export function sortedLabels(ids = []) {
  const known = ADMIN_LABELS.filter((l) => ids.includes(l.id));
  return [...known.filter((l) => l.warn), ...known.filter((l) => !l.warn)].map((l) => l.id);
}

export function statusBadges(script, { showUnverified = false, showLua = true, maxLabels = Infinity } = {}) {
  const out = [];
  if (script?.verified) {
    out.push(`<span class="badge badge--verified" title="${escAttr(
      "A person on the Lucrit Scripts team reviewed this script."
    )}">\u2713 Verified</span>`);
  }
  for (const id of sortedLabels(script?.labels || []).slice(0, maxLabels)) out.push(labelBadge(id));
  if (!script?.verified && showUnverified) {
    out.push(`<span class="badge badge--unverified" title="${escAttr(
      "Nobody has reviewed this script yet."
    )}">Not reviewed</span>`);
  }
  // The script page leaves this one off (owner's call, 15 Oct 2026); cards keep it.
  if (showLua && script?.lua) {
    out.push(`<span class="badge badge--lua" title="${escAttr(
      "The submitted code contains Luau syntax. This is an automatic check of the text — "
      + "it does not mean the script is safe, working, or reviewed."
    )}">Lua Detected</span>`);
  }
  return out.length ? `<span class="badges">${out.join("")}</span>` : "";
}
