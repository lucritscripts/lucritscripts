// Games as first-class objects.
//
// The site is browsed by GAME first — "what am I playing?" — and only then by
// what a script does. This module is the single source of truth for that: it
// merges the curated Roblox catalogue with whatever games people have actually
// published for, and keeps the counts live.
//
// Against Supabase this becomes a `games` view with a join count. The shape of
// everything exported here stays identical.

import { POPULAR_GAMES } from "./gamepicker.js";
import { totals as scriptTotals } from "./stats.js";

/** How many game tiles the Find a Script section shows before the +N bubble. */
export const TILE_COUNT = 20;

/** Stable, URL-safe id for a game name. */
export function gameId(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Every game the site knows about: the curated list plus any game a script
 * was published for. Games with scripts sort first, then by the curated
 * order — so the visible tiles fill with real content as the site grows and
 * fall back to recognisable names while it is still empty.
 */
export function allGames(library = []) {
  const byId = new Map();

  POPULAR_GAMES.forEach((name, i) => {
    byId.set(gameId(name), {
      id: gameId(name), name, rank: i, curated: true,
      scripts: 0, views: 0, likes: 0, thumbnail: "",
    });
  });

  for (const s of library) {
    const name = String(s.game || "").trim();
    if (!name) continue;
    const id = gameId(name);

    if (!byId.has(id)) {
      byId.set(id, {
        id, name, rank: POPULAR_GAMES.length + byId.size, curated: false,
        scripts: 0, views: 0, likes: 0, thumbnail: "",
      });
    }

    const g = byId.get(id);
    const t = scriptTotals(s.id);
    g.scripts += 1;
    g.views += t.views;
    g.likes += t.likes;
    if (!g.thumbnail && s.thumbnail) g.thumbnail = s.thumbnail;
  }

  return Array.from(byId.values()).sort(
    (a, b) => b.scripts - a.scripts || b.views - a.views || a.rank - b.rank
  );
}

/** The games that get tiles, plus how many are hidden behind the +N bubble. */
export function tileGames(library = [], count = TILE_COUNT) {
  const games = allGames(library);
  return { tiles: games.slice(0, count), overflow: Math.max(0, games.length - count), total: games.length };
}

export function findGame(library, id) {
  return allGames(library).find((g) => g.id === id) || null;
}

export function scriptsForGame(library, id) {
  return library.filter((s) => gameId(s.game) === id);
}

/* -------------------------------------------------------------- search */

function score(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 70;
  if (n.includes(q)) return 45;
  return q.split(" ").every((w) => n.includes(w)) ? 25 : 0;
}

/** Games matching free text — including ones with no scripts yet. */
export function searchGames(library, query, limit = 24) {
  if (!String(query || "").trim()) return [];
  return allGames(library)
    .map((g) => ({ g, s: score(query, g.name) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || b.g.scripts - a.g.scripts || a.g.rank - b.g.rank)
    .slice(0, limit)
    .map((r) => r.g);
}

/** Scripts matching free text across every field people actually search by. */
export function searchScripts(library, query, limit = 60) {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(" ");

  return library
    .map((s) => {
      const hay = norm([s.title, s.game, s.desc, s.author, s.category, ...(s.tags || [])].join(" "));
      if (!words.every((w) => hay.includes(w))) return null;
      // A title hit is what you meant; a description hit is a maybe.
      const bonus = score(query, s.title) + score(query, s.game) * 0.5;
      return { s, bonus };
    })
    .filter(Boolean)
    .sort((a, b) => b.bonus - a.bonus || scriptTotals(b.s.id).views - scriptTotals(a.s.id).views)
    .slice(0, limit)
    .map((r) => r.s);
}

/* --------------------------------------------------------------- media */

/**
 * Tile art for a game with no published thumbnail yet: a deterministic
 * gradient plus its initials, so the grid never looks like a row of holes.
 */
export function gameArt(game) {
  let h = 0;
  for (const ch of game.id) h = (h * 31 + ch.charCodeAt(0)) % 360;

  // Held inside the brand's cyan → blue → violet arc. A full-spectrum hash
  // gives a rainbow grid, which reads as a gaming template rather than as
  // something expensive.
  h = 186 + (h % 96);

  const initials = game.name
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");

  return { hue: h, initials: initials || "?" };
}
