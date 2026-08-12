// Lucrit Script — library data.
//
// The library starts EMPTY. Every script on the site is user-published
// through the submit form; nothing is seeded. Once Supabase is connected,
// `SCRIPTS` and `CONTRIBUTORS` are replaced by live queries and this file
// keeps only the category and sort vocabularies.

export const CATEGORIES = [
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
export const BOARDS = [
  { id: "scripts", label: "Most Scripts", metric: "scripts", suffix: "scripts" },
  { id: "likes",   label: "Most Likes",   metric: "likes",   suffix: "likes" },
  { id: "rating",  label: "Best Rating",  metric: "rating",  suffix: "avg" },
  { id: "views",   label: "Highest Views",metric: "views",   suffix: "views" },
];

/** Every script is user-published. Nothing is seeded. */
export const SCRIPTS = [];

/** Populated from real accounts once Supabase is connected. */
export const CONTRIBUTORS = [];

export function categoryOf(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}
