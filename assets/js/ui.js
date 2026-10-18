// All DOM: navigation, chapters, the searchable library, publishing,
// the leaderboard, and the scroll-linked chapter choreography.

import { SCRIPTS, CATEGORIES, SORTS, BOARDS, categoryOf, statusBadges } from "./data/scripts.js";
import { BANDS } from "./engine/world.js";
import { account } from "./account.js";
import { safeImageSrc } from "./safe.js";
import { isSaved } from "./vault.js";
import { esc, fmt, toast, createLeaderboard } from "./pages.js";
import { totals as scriptTotals, onStatsChange } from "./stats.js";
import {
  tileGames, searchGames, searchScripts, gameArt, allGames, gameId, findGame,
  setServerGames, onGamesChange,
} from "./games.js";
import { libraryOnline, fetchScripts, fetchBoard, searchLibrary, fetchSummary } from "./library-api.js";
import { noteWindow, secondsLeft, clockChip, onExpire } from "./unlockclock.js";
import { pathForCreator } from "./router.js";
import { cardMarkup as executorCard } from "./executors.js";
import { fetchExecutors } from "./library-api.js";


/** A /getkey key still saved in this browser (same localStorage keys getkey.html uses). */
function haveKey() {
  try {
    return Boolean(localStorage.getItem("smh_key")) && Number(localStorage.getItem("smh_keyTime")) > Date.now();
  } catch { return false; }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const DISCORD_INVITE = "https://discord.gg/JUSmn4ZYe";

const el = (tag, attrs = {}, html) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (v != null) node.setAttribute(k, v);
  }
  if (html !== undefined) node.innerHTML = html;
  return node;
};

/* ------------------------------------------------------------- library */

/**
 * Every published script.
 *
 * This array is a CACHE of what the server has, not the source of truth. It
 * used to be the source of truth, which is exactly why a published script was
 * visible to one person in one tab and vanished on refresh.
 *
 * `refreshLibrary()` fills it from /api/scripts. On static hosting there is no
 * API, so it stays a plain local array and the site behaves as it used to —
 * the same build has to work in both places.
 */
export const library = SCRIPTS.slice();

const listeners = new Set();
export function onLibraryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function libraryChanged() { for (const fn of listeners) fn(library); }

// A window running out has to reach the cards, not just the open sheet:
// otherwise a card sits there saying "Open script" for an unlock that ended.
onExpire(() => libraryChanged());

/** Replaces the cache wholesale with what the server just said. */
export function setLibrary(scripts) {
  library.length = 0;
  library.push(...scripts);
  // The listing now carries how long each unlock this visitor holds has left,
  // so the cards can show it without opening anything.
  for (const s of scripts) noteWindow(s.id, s.unlockedFor);
  libraryChanged();
}

export async function refreshLibrary() {
  if (!(await libraryOnline())) return false;
  setLibrary(await fetchScripts());
  return true;
}

export function addScript(script) {
  library.unshift(script);
  rememberScripts([script]);
  libraryChanged();
  scriptsMutated();
}

export function removeScript(id) {
  const i = library.findIndex((s) => s.id === id);
  const had = i >= 0 || seen.has(id);
  if (i >= 0) library.splice(i, 1);
  seen.delete(id);
  if (!had) return false;
  libraryChanged();
  scriptsMutated();
  return true;
}

/* --------------------------------------------------------- Roblox media */

/**
 * Pulls a place id out of a Roblox link or a bare number and returns the
 * public thumbnail URL. Loads as a plain image, so no CORS proxy needed.
 */
export function robloxThumb(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const m = raw.match(/(?:games|catalog)\/(\d{5,})/) || raw.match(/^(\d{5,})$/);
  if (!m) return "";
  return `https://www.roblox.com/asset-thumbnail/image?assetId=${m[1]}&width=768&height=432&format=png`;
}


/* ---------------------------------------------------------- card markup */

export function cardMarkup(script, { large = false } = {}) {
  const cat = categoryOf(script.category);
  const t = scriptTotals(script.id);
  const saved = isSaved(account.session?.id, script.id);

  // The server's counts win when there are any. The card used to show only the
  // local tallies, which are always zero for someone who has never opened the
  // script — so every card read "0 views · 0 likes" until you clicked in, and
  // then the real numbers appeared, as if opening it had created them.
  const views = script.views ?? t.views;
  const likes = script.likes ?? t.likes;
  const copies = script.copies ?? t.copies ?? 0;
  return `
    <article class="card${large ? " card--lg" : ""}" data-id="${esc(script.id)}" style="--cat:${cat.accent}">
      <div class="card__glow" aria-hidden="true"></div>
      <button class="card__heart${saved ? " is-on" : ""}" type="button" data-heart="${esc(script.id)}"
              aria-pressed="${saved}" aria-label="${saved ? "Remove from your tabs" : "Save to your tabs"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-7-9.1A4 4 0 0 1 12 8a4 4 0 0 1 7 2.9C19 15.6 12 20 12 20Z"/></svg>
      </button>
      ${script.thumbnail ? `<img class="card__thumb" src="${esc(safeImageSrc(script.thumbnail))}" alt="" loading="lazy">` : ""}
      <div class="card__body">
        <div class="card__top">
          <span class="chip">${cat.label}</span>
          ${script.keyless === false ? `<span class="chip chip--warn">Key</span>` : `<span class="chip chip--ok">Keyless</span>`}
          ${statusBadges(script, { maxLabels: 2 })}
        </div>
        <h3 class="card__title">${esc(script.title)}</h3>
        ${script.game ? `<p class="card__game">${esc(script.game)}</p>` : ""}
        <p class="card__desc">${esc(String(script.desc || "").slice(0, 140))}${String(script.desc || "").length > 140 ? "…" : ""}</p>
        ${Array.isArray(script.tags) && script.tags.length
          ? `<span class="chips card__tags">${script.tags.slice(0, 3)
              .map((t) => `<span class="chip chip--soft">${esc(t)}</span>`).join("")}</span>`
          : ""}
        <div class="card__meta">
          <a class="by" href="${esc(pathForCreator(script.author))}"
             title="See everything by @${esc(script.author)}">@${esc(script.author)}</a>
          <span class="dot" aria-hidden="true"></span>
          <span>${fmt(views)} views</span>
          <span class="dot" aria-hidden="true"></span>
          <span>${fmt(likes)} like${likes === 1 ? "" : "s"}</span>
          ${copies ? `
            <span class="dot" aria-hidden="true"></span>
            <span>${fmt(copies)} cop${copies === 1 ? "y" : "ies"}</span>` : ""}
          ${script.rating ? `
            <span class="dot" aria-hidden="true"></span>
            <span class="card__rating"><b>${Number(script.rating).toFixed(1)}</b>★</span>` : ""}
        </div>
        <div class="card__actions">
          <button class="btn btn--sm btn--primary" data-act="get">${
            secondsLeft(script.id) !== null ? "Open script" : "Get Script"
          }</button>
          ${clockChip(script.id)}
        </div>
      </div>
    </article>`;
}

/* --------------------------------------------------------- pointer tilt */

function attachTilt(root, strength = 8) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (window.matchMedia("(hover: none)").matches) return;

  root.addEventListener("pointermove", (e) => {
    const card = e.target.closest(".card");
    if (!card || !root.contains(card)) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty("--rx", `${(-py * strength).toFixed(2)}deg`);
    card.style.setProperty("--ry", `${(px * strength).toFixed(2)}deg`);
    card.style.setProperty("--mx", `${((px + 0.5) * 100).toFixed(1)}%`);
    card.style.setProperty("--my", `${((py + 0.5) * 100).toFixed(1)}%`);
    card.classList.add("is-tilt");
  });

  root.addEventListener("pointerout", (e) => {
    const card = e.target.closest(".card");
    if (card && !card.contains(e.relatedTarget)) {
      card.classList.remove("is-tilt");
      card.style.removeProperty("--rx");
      card.style.removeProperty("--ry");
    }
  });
}

/* ------------------------------------------------------- server paging */

/**
 * The site is built for thousands of scripts, so nothing lists "all of them"
 * any more. Every grid asks for one page (20) of exactly what it shows —
 * search, game, category, sort — and the server says how many matched in
 * total. `library` above stays a small cache of the newest scripts for the
 * things that only need a sample (suggestions, the assistant).
 *
 * Scripts that arrive through a page are remembered here, so a click on any
 * card can find the object it was drawn from.
 */
export const PAGE_SIZE = 20;
const seen = new Map();

export function rememberScripts(list = []) {
  for (const s of list) {
    if (!s || !s.id) continue;
    seen.set(s.id, s);
    if ("unlockedFor" in s) noteWindow(s.id, s.unlockedFor);
  }
}

/** Any script this page has shown, from whichever list showed it. */
export function findScript(id) {
  return library.find((s) => s.id === id) || seen.get(id) || null;
}

// Published, edited or deleted from this tab: every list starts over and the
// totals are asked for again. (A plain cache refresh only repaints.)
const mutationListeners = new Set();
export function onScriptsMutated(fn) { mutationListeners.add(fn); return () => mutationListeners.delete(fn); }
export function scriptsMutated() {
  refreshSummary();
  for (const fn of mutationListeners) fn();
}

/** Site totals from the server; null until it answers (or on static hosting). */
let summary = null;
const summaryListeners = new Set();
export function onSummary(fn) { summaryListeners.add(fn); return () => summaryListeners.delete(fn); }
export function siteSummary() { return summary; }
let summaryInFlight = null;
export function refreshSummary() {
  if (summaryInFlight) return summaryInFlight;
  summaryInFlight = (async () => {
    try {
      if (!(await libraryOnline())) return null;
      const next = await fetchSummary();
      if (next) {
        summary = next;
        setServerGames(next.games);
        for (const fn of summaryListeners) fn(summary);
      }
      return summary;
    } finally { summaryInFlight = null; }
  })();
  return summaryInFlight;
}

/** The same query run against the local cache — static hosting has no API. */
function localQuery({ q = "", game = "", category = "", author = "", sort = "", offset = 0, limit = PAGE_SIZE }) {
  let list = q ? searchScripts(library, q, 1e6) : library.slice();
  if (game) list = list.filter((s) => gameId(s.game) === game);
  if (category) list = list.filter((s) => s.category === category);
  if (author) list = list.filter((s) => s.authorId === author);
  const n = (s, k) => s[k] ?? scriptTotals(s.id)[k] ?? 0;
  const by = {
    views: (a, b) => n(b, "views") - n(a, "views"),
    copies: (a, b) => n(b, "copies") - n(a, "copies") || n(b, "views") - n(a, "views"),
    likes: (a, b) => n(b, "likes") - n(a, "likes"),
    new: (a, b) => String(b.added || "").localeCompare(String(a.added || "")),
  }[sort];
  if (by) list = list.slice().sort(by);
  return { data: list.slice(offset, offset + limit), total: list.length };
}

export async function queryScripts(params) {
  if (await libraryOnline()) return searchLibrary(params);
  return localQuery(params);
}

/**
 * One paged list of scripts. `params()` says what it shows; `reset()` starts
 * again from page one, `more()` appends the next page. Responses that arrive
 * after the question changed are dropped, so fast typing can't paint an old
 * search over a new one.
 */
export function createScriptList({ params, onPaint, pageSize = PAGE_SIZE }) {
  const list = { items: [], total: 0, loading: false, failed: false, loaded: false };
  let seq = 0;

  async function load(append) {
    const mine = ++seq;
    list.loading = true;
    list.failed = false;
    onPaint?.(list);
    const offset = append ? list.items.length : 0;
    let res = null;
    try { res = await queryScripts({ ...params(), offset, limit: pageSize }); } catch { res = null; }
    if (mine !== seq) return;
    list.loading = false;
    list.loaded = true;
    if (!res) { list.failed = true; if (!append) { list.items = []; list.total = 0; } }
    else {
      rememberScripts(res.data);
      list.items = append ? list.items.concat(res.data) : res.data;
      list.total = Math.max(res.total, list.items.length);
    }
    onPaint?.(list);
  }

  list.reset = () => load(false);
  list.more = () => { if (!list.loading && list.items.length < list.total) load(true); };
  list.left = () => Math.max(0, list.total - list.items.length);
  return list;
}

/** "Show 20 more" for a list, or nothing when it is all on screen. */
function moreMarkup(list, attr = "data-more-results") {
  const left = list.left();
  if (!left) return "";
  return `<button class="btn btn--ghost results__more" type="button" ${attr}${list.loading ? " disabled" : ""}>
      ${list.loading ? "Loading…" : `Show ${fmt(Math.min(PAGE_SIZE, left))} more <span class="results__left">(${fmt(left)} left)</span>`}
    </button>`;
}

const SKELETON = `<div class="results__grid results__grid--loading">${
  '<div class="card card--skeleton" aria-hidden="true"></div>'.repeat(4)}</div>`;

const LIST_SORTS = [
  { id: "", label: "Newest", search: "Best match" },
  { id: "views", label: "Most viewed" },
  { id: "copies", label: "Most unlocked" },
  { id: "likes", label: "Most liked" },
];

function sortOptions(current, searching = false) {
  return LIST_SORTS.map((s) =>
    `<option value="${s.id}"${s.id === current ? " selected" : ""}>${esc(searching && s.search ? s.search : s.label)}</option>`).join("");
}

/* ============================================================
   Search
   ============================================================ */

/**
 * Find a script.
 *
 * Shows the newest 20 and nothing more until asked: with thousands of scripts
 * on the site, the rest are found by searching, picking a game, or "Show 20
 * more". Every one of those is answered by the server, so a search reaches a
 * script published two years ago just as well as one from this morning.
 *
 * There is no category filter here on purpose: every card already wears its
 * category, which is enough to scan by. Category still narrows the list when
 * something else asks for it — a chapter, or the Categories page — and the
 * count line then offers a way back out.
 */
export function createLibraryPanel({ id, onOpen, onPublish, onOpenGame, onOpenLibrary }) {
  const state = { query: "", cat: "", game: "", sort: "" };
  const root = el("div", { class: "library", id });

  root.innerHTML = `
    <div class="library__search">
      <svg class="library__icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>
      </svg>
      <input class="library__input" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search any game or script..." aria-label="Search games and scripts">
      <button class="library__clear" type="button" aria-label="Clear search" hidden>&times;</button>
      <kbd class="library__kbd">/</kbd>
    </div>

    <div class="library__filters">
      <label class="library__gamepick">
        <span class="sr-only">Filter by game</span>
        <select class="library__game" data-gamepick></select>
      </label>
      <label class="library__sortpick">
        <span class="sr-only">Sort scripts</span>
        <select class="library__sort" data-sortpick></select>
      </label>
      <button class="btn btn--ghost btn--xs library__all" type="button" data-more>Browse all games</button>
    </div>

    <p class="library__count" aria-live="polite"></p>
    <div class="library__results" data-native-scroll></div>`;

  const input = $(".library__input", root);
  const clear = $(".library__clear", root);
  const gamePick = $("[data-gamepick]", root);
  const sortPick = $("[data-sortpick]", root);
  const results = $(".library__results", root);
  const count = $(".library__count", root);

  const list = createScriptList({
    params: () => ({ q: state.query.trim(), game: state.game, category: state.cat, sort: state.sort }),
    onPaint: () => paint(),
  });

  /* ------------------------------------------------------------ views */

  /**
   * Rebuilds the game menu.
   *
   * Games that actually have scripts come first with their counts; the rest of
   * the catalogue follows, so someone can still pick a game nobody has
   * published for and be told so plainly rather than not finding it at all.
   */
  function paintGameMenu() {
    const games = allGames(library);
    const withScripts = games.filter((g) => g.scripts > 0);
    const empty = games.filter((g) => !g.scripts)
      .sort((a, b) => a.name.localeCompare(b.name));

    const option = (g) =>
      `<option value="${esc(g.id)}"${g.id === state.game ? " selected" : ""}>` +
      `${esc(g.name)}${g.scripts ? ` (${fmt(g.scripts)})` : ""}</option>`;

    gamePick.innerHTML = `
      <option value=""${state.game ? "" : " selected"}>All games</option>
      ${withScripts.length ? `<optgroup label="Has scripts">${withScripts.map(option).join("")}</optgroup>` : ""}
      ${empty.length ? `<optgroup label="Nothing published yet">${empty.map(option).join("")}</optgroup>` : ""}`;
    sortPick.innerHTML = sortOptions(state.sort, Boolean(state.query.trim()));
  }

  function grid() {
    if (!list.items.length) return "";
    return `<div class="results__grid">${list.items.map((s) => cardMarkup(s)).join("")}</div>` + moreMarkup(list);
  }

  function scriptsView() {
    const cat = state.cat ? categoryOf(state.cat) : null;
    const game = state.game ? findGame(library, state.game) : null;
    const n = list.total;

    const bits = [list.items.length && list.items.length < n
      ? `Showing ${fmt(list.items.length)} of ${fmt(n)} scripts`
      : `${fmt(n)} script${n === 1 ? "" : "s"}`];
    if (cat) bits.push(`in ${cat.label}`);
    if (game) bits.push(`for ${game.name}`);

    count.innerHTML = (list.loaded ? esc(bits.join(" ")) : "Loading scripts…") +
      (cat || game ? ` <button class="library__undo" type="button" data-clear-filters>clear</button>` : "");

    if (list.items.length) { results.innerHTML = grid(); return; }
    if (!list.loaded || list.loading) { results.innerHTML = SKELETON; return; }
    if (list.failed) {
      results.innerHTML = emptyState("Couldn't load scripts.", "Check your connection and try again.", true);
      return;
    }

    // Say which filter emptied the list, rather than a blanket "nothing here".
    if (game && cat) {
      results.innerHTML = emptyState(
        `No ${cat.label.toLowerCase()} scripts for ${esc(game.name)} yet.`,
        "Clear one of the filters, or publish the first one.");
    } else if (game) {
      results.innerHTML = emptyState(
        `Nothing published for ${esc(game.name)} yet.`,
        "Be the first — it sits at the top of this list.");
    } else if (cat) {
      results.innerHTML = emptyState(
        `No ${cat.label.toLowerCase()} scripts yet.`,
        "Be the first to publish one and it sits at the top of this list.");
    } else {
      results.innerHTML = emptyState(
        "No scripts published yet.",
        "The first one lands right here.");
    }
  }

  function searchView() {
    const q = state.query.trim();
    const games = state.game ? [] : searchGames(library, q, 12);
    const n = list.total;

    count.textContent = list.loaded
      ? `${games.length} game${games.length === 1 ? "" : "s"} · ${fmt(n)} script${n === 1 ? "" : "s"}`
      : "Searching…";

    if (list.loaded && !list.loading && !games.length && !list.items.length) {
      results.innerHTML = emptyState(
        `Nothing matched “${esc(q)}”.`,
        "Search covers every game on the site and every published script — try a shorter word."
      );
      return;
    }

    results.innerHTML = `
      ${games.length ? `
        <h3 class="results__head">Games</h3>
        <div class="games games--compact">${games.map(gameTileMarkup).join("")}</div>` : ""}
      ${list.items.length ? `
        <h3 class="results__head">Scripts</h3>
        ${grid()}` : (list.loading || !list.loaded ? SKELETON : "")}`;
  }

  function paint() {
    clear.hidden = !state.query;
    if (state.query.trim()) searchView();
    else scriptsView();
  }

  /** Something about the question changed: new menu, page one. */
  function render() {
    paintGameMenu();
    paint();
  }
  function restart() { render(); list.reset(); }

  function emptyState(title, line, retry = false) {
    return `
      <div class="empty empty--lg">
        <strong>${title}</strong>
        <span>${line}</span>
        ${retry
          ? `<button class="btn btn--primary btn--sm" type="button" data-retry>Try again</button>`
          : `<button class="btn btn--primary btn--sm" data-act="publish">Publish a script</button>`}
      </div>`;
  }

  /* ---------------------------------------------------------- events */

  // Typing waits for a pause before asking the server; a filter is instant.
  let typing = 0;
  input.addEventListener("input", () => {
    state.query = input.value;
    clear.hidden = !state.query;
    clearTimeout(typing);
    typing = setTimeout(restart, 250);
  });

  clear.addEventListener("click", () => {
    input.value = "";
    state.query = "";
    input.focus();
    clearTimeout(typing);
    restart();
  });

  gamePick.addEventListener("change", () => {
    state.game = gamePick.value;
    // A search would hide the very list the picker just filtered.
    state.query = "";
    input.value = "";
    restart();
  });

  sortPick.addEventListener("change", () => { state.sort = sortPick.value; restart(); });

  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-more-results]")) { list.more(); return; }
    if (e.target.closest("[data-retry]")) { list.reset(); return; }
    if (e.target.closest("[data-more]")) { onOpenLibrary?.(); return; }
    if (e.target.closest("[data-clear-filters]")) {
      state.cat = "";
      state.game = "";
      restart();
      return;
    }
    if (e.target.closest('[data-act="publish"]')) { onPublish?.(); return; }

    const tile = e.target.closest("[data-game]");
    if (tile) { onOpenGame?.(tile.dataset.game); return; }

    const card = e.target.closest(".card");
    if (card) {
      const script = findScript(card.dataset.id);
      if (script) onOpen?.(script);
    }
  });

  attachTilt(results, 6);
  onLibraryChange(paint);
  onGamesChange(render);
  onScriptsMutated(restart);
  onStatsChange(() => { if (!state.query) paint(); });
  restart();

  return {
    node: root,
    focus: () => input.focus(),
    search(q) { state.cat = ""; state.query = q; input.value = q; restart(); },
    setCategory(cat) {
      state.query = "";
      input.value = "";
      state.cat = cat || "";
      restart();
    },
    setGame(gameKey) {
      state.query = "";
      input.value = "";
      state.game = gameKey || "";
      restart();
    },
    refresh: paint,
  };
}

/** One game tile: art, name, and how many scripts it has. */
export function gameTileMarkup(game) {
  const art = gameArt(game);
  return `
    <button class="gtile" type="button" data-game="${esc(game.id)}" style="--h:${art.hue}">
      <span class="gtile__art" aria-hidden="true">
        ${game.thumbnail
          ? `<img src="${esc(game.thumbnail)}" alt="" loading="lazy">`
          : `<span class="gtile__mono">${esc(art.initials)}</span>`}
      </span>
      <span class="gtile__name">${esc(game.name)}</span>
      <span class="gtile__count">${game.scripts
        ? `${fmt(game.scripts)} script${game.scripts === 1 ? "" : "s"}`
        : "No scripts yet"}</span>
    </button>`;
}

/* ============================================================
   Chapters
   ============================================================ */

export const CHAPTERS = [
  { key: "hero",       label: "Origin",     len: 170 },
  { key: "universe",   label: "The Library",len: 213 },
  { key: "search",     label: "Search",     len: 190 },
  { key: "executors",  label: "Executors",  len: 150 },
  { key: "categories", label: "Worlds",     len: 381 },
  { key: "featured",   label: "Trending",   len: 213 },
  { key: "community",  label: "Community",  len: 213 },
  { key: "submit",     label: "Publish",    len: 128 },
  { key: "finale",     label: "Begin",      len: 128 },
];

const CATEGORY_WORLDS = [
  { id: "combat",    title: "Combat",    blurb: "Damage, hitboxes and weapon state — written so the client can’t lie about a hit." },
  { id: "npc",       title: "NPC & AI",  blurb: "Pathfinding that survives real geometry, aggro state machines and ambient life." },
  { id: "ui",        title: "UI",        blurb: "Dialogue, toasts, hotbars and windows — the interface work you’d otherwise rewrite every project." },
  { id: "data",      title: "Data",      blurb: "Session-locked saves, retries with backoff, and a shutdown path that doesn’t lose progress." },
  { id: "shops",     title: "Shops",     blurb: "Economy flows where the server owns the price, the stock and the receipt." },
  { id: "utilities", title: "Utilities", blurb: "Signals, cleanup, rate limiting — the unglamorous modules every codebase needs." },
];

export function buildChapters({ libraryPanel, publishForm, onOpenScript, onJump, onPublish, onAuth, onInfo }) {
  const content = el("main", { id: "content" });

  // Sections are ordinary, full-width blocks that flow down the page (Oct
  // 2026). They used to be 100vh boxes pinned in place that scrolled on their
  // own — on a phone, a swipe that started on the content scrolled that inner
  // box instead of the page, so the page only moved if you swiped along the
  // very edges of the screen. Now there is one scroll: the page's.
  const chapter = (key, label, len, inner) => `
    <section class="chapter" id="ch-${key}" data-chapter="${key}" style="--len:${len}">
      <div class="chapter__inner">
        <div class="chapter__stage">
          <span class="chapter__tag" aria-hidden="true">${label}</span>
          ${inner}
        </div>
      </div>
    </section>`;

  content.innerHTML = [
    chapter("hero", "01 / Origin", CHAPTERS[0].len, `
      <div class="hero">
        <img class="hero__logo" src="/assets/img/logo.png" alt="Lucrit Script"
             width="460" height="236" fetchpriority="high" decoding="async">
        <h1 class="hero__title">
          <span class="line">The ultimate</span>
          <span class="line">Roblox script</span>
          <span class="line accent">library</span>
        </h1>
        <p class="hero__sub">Discover, explore, and build with Roblox scripts — published by creators who get paid every time you unlock one.</p>
        <div class="hero__cta">
          <button class="btn btn--primary" data-jump="search">Explore scripts</button>
          <button class="btn btn--publish" data-jump="submit">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
            Publish a Script
          </button>
          <a class="btn btn--key" href="/getkey" data-getkey>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"/></svg>
            ${haveKey() ? "Your Key" : "Get Key"}
          </a>
          <button class="btn btn--ai" data-generate>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/></svg>
            Create a Script with AI
          </button>
          <a class="btn btn--discord" href="${DISCORD_INVITE}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.3 5.3A16 16 0 0 0 15.4 4l-.2.4a12 12 0 0 1 3.3 1.6 11 11 0 0 0-9-1.1 11.4 11.4 0 0 0-2 1.1A12 12 0 0 1 10.8 4L10.6 4a16 16 0 0 0-3.9 1.3C4.2 9 3.5 12.6 3.9 16.2a16 16 0 0 0 4.8 2.4l.6-1a10.6 10.6 0 0 1-1.7-.8l.4-.3a11.4 11.4 0 0 0 9.8 0l.4.3a10.6 10.6 0 0 1-1.7.8l.6 1a16 16 0 0 0 4.8-2.4c.5-4.2-.6-7.8-2.6-10.9ZM9.7 14.1c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Zm4.6 0c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Z"/></svg>
            Join Discord for daily updates<span data-discord-stats hidden></span>
          </a>
          <button class="btn btn--gold" data-info="paid">Start Getting Paid for Scripting</button>
          <button class="btn btn--ghost" data-auth="account">View Account</button>
        </div>
      </div>
      <button class="scrollcue" type="button" data-jump="universe" aria-label="Scroll down to explore">
        <span class="scrollcue__mouse" aria-hidden="true"></span>
        <svg class="scrollcue__finger" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V6M7 11l5-5 5 5"/></svg>
        <span><span class="scrollcue__label--mouse">Scroll to explore</span><span class="scrollcue__label--touch">Swipe up to explore</span></span>
      </button>`),

    chapter("universe", "02 / The Library", CHAPTERS[1].len, `
      <div class="statement">
        <h2 class="statement__title">Every script.<br>One place.</h2>
        <p class="statement__sub">A growing library built by Roblox creators. Read the source before you ever paste it — every script is open on its page.</p>
        <div class="statement__stats" data-stats></div>
      </div>`),

    chapter("search", "03 / Search", CHAPTERS[2].len, `
      <div class="panel panel--wide" id="search-mount">
        <header class="panel__head">
          <h2>Find a script</h2>
          <p>Start with the game you play. Search reaches every game and every script on the site.</p>
        </header>
      </div>`),

    chapter("executors", "04 / Executors", CHAPTERS[3].len, `
      <div class="panel panel--wide xlib">
        <header class="panel__head">
          <h2>Executor library</h2>
          <p>The Roblox executors people use to run these scripts — PC and mobile, with whether each one is working right now.</p>
        </header>
        <div class="xlib__grid" data-xlib></div>
        <div class="xlib__more"><a class="btn btn--ghost" href="/executors" data-xlib-all>See every executor</a></div>
      </div>`),

    chapter("categories", "05 / Worlds", CHAPTERS[4].len, `
      <div class="worlds">
        <div class="worlds__rail" role="tablist" aria-label="Script categories"></div>
        <div class="worlds__stage"></div>
      </div>`),

    chapter("featured", "06 / Trending", CHAPTERS[5].len, `
      <div class="panel">
        <header class="panel__head">
          <h2>Trending this week</h2>
          <p>The scripts being unlocked the most right now.</p>
        </header>
        <div class="featured__grid" data-grid="featured"></div>
      </div>`),

    chapter("community", "07 / Community", CHAPTERS[6].len, `
      <div class="panel panel--wide">
        <header class="panel__head">
          <h2>The leaderboard</h2>
          <p>Anyone can look. You need an account to rate a script.</p>
        </header>
        <div id="board-mount"></div>
      </div>`),

    chapter("submit", "08 / Publish", CHAPTERS[7].len, `
      <div class="panel panel--wide" id="publish-mount"></div>`),

    chapter("finale", "09 / Begin", CHAPTERS[8].len, `
      <div class="finale">
        <h2 class="finale__title">Build something great.</h2>
        <p class="finale__sub">Your next Roblox game starts here.</p>
        <div class="finale__cta">
          <button class="btn btn--primary" data-jump="search">Explore the library</button>
          <button class="btn btn--gold" data-info="paid">Get paid for scripting</button>
          <a class="btn btn--discord" href="${DISCORD_INVITE}" target="_blank"
             rel="noopener">Join Discord<span data-discord-stats hidden></span></a>
        </div>
      </div>`),
  ].join("");

  document.body.appendChild(content);

  $("#search-mount", content).appendChild(libraryPanel.node);

  /* ---- category worlds ---- */
  const rail = $(".worlds__rail", content);
  const stage = $(".worlds__stage", content);
  rail.innerHTML = CATEGORY_WORLDS.map((w, i) =>
    `<button type="button" data-world-tab="${i}" role="tab">${w.title}</button>`).join("");
  stage.innerHTML = CATEGORY_WORLDS.map((w, i) => {
    const cat = categoryOf(w.id);
    return `<div class="world" data-i="${i}" style="--cat:${cat.accent}">
      <span class="world__idx">0${i + 1}</span>
      <h3>${w.title}</h3>
      <p>${w.blurb}</p>
      <button class="btn btn--sm btn--ghost" data-world="${w.id}">Browse ${cat.label}</button>
    </div>`;
  }).join("");

  /* ---- leaderboard ---- */
  const board = createLeaderboard({
    // Static hosting has no server to rank anything, so the board stays empty
    // there rather than inventing numbers.
    getRows: () => [],
    async load(which) {
      if (!(await libraryOnline())) return [];
      return fetchBoard(which);
    },
  });
  $("#board-mount", content).appendChild(board.node);

  /* ---- publish ----
     The form itself lives in publish.js. It is mounted by the caller rather
     than built here: it imports `addScript` and `robloxThumb` from this
     module, so building it here would be a cycle. */
  const publish = publishForm || null;
  if (publish) $("#publish-mount", content).appendChild(publish.node);

  /* ---- stats: the server's totals, not a count of what this tab holds ---- */
  function paintStats() {
    const stats = $("[data-stats]", content);
    const sum = siteSummary();
    const total = sum ? sum.total : library.length;
    const views = sum ? sum.views : library.reduce((a, s) => a + (s.views || 0), 0);
    stats.innerHTML = `
      <div><strong>${fmt(total)}</strong><span>scripts</span></div>
      <div><strong>${CATEGORIES.length}</strong><span>categories</span></div>
      <div><strong>${fmt(views)}</strong><span>views</span></div>`;
  }

  const emptyBlock = (title, line) => `
    <div class="empty empty--lg">
      <strong>${title}</strong>
      <span>${line}</span>
      <button class="btn btn--primary btn--sm" data-jump="submit">Publish a script</button>
    </div>`;

  /* ---- trending: the most-unlocked six, asked of the server ---- */
  const featured = $('[data-grid="featured"]', content);
  const trending = createScriptList({ params: () => ({ sort: "copies" }), pageSize: 6, onPaint: paintTrending });
  function paintTrending() {
    featured.innerHTML = trending.items.length
      ? trending.items.map((s) => cardMarkup(s, { large: true })).join("")
      : trending.loaded && !trending.loading
        ? emptyBlock("No trending scripts yet.", "Once scripts start getting unlocked, the most popular show up here.")
        : "";
  }

  /* ---- executor library: the newest working ones, from /api/executors ---- */
  const xlib = $("[data-xlib]", content);
  const XLIB_MAX = 6;
  const XORDER = { working: 0, updating: 1, unavailable: 2 };
  async function paintExecutors() {
    let list = [];
    try { if (await libraryOnline()) list = await fetchExecutors(); } catch { list = []; }
    list = (list || []).slice().sort((a, b) => (XORDER[a.status] ?? 3) - (XORDER[b.status] ?? 3));
    xlib.innerHTML = list.length
      ? list.slice(0, XLIB_MAX).map(executorCard).join("")
      : `<div class="empty"><strong>No executors listed yet.</strong><span>They show up here as soon as they're added.</span></div>`;
    const all = $("[data-xlib-all]", content);
    if (all) all.textContent = list.length > XLIB_MAX ? `See all ${list.length} executors` : "See every executor";
  }
  paintExecutors();

  function paintGrids() { paintStats(); paintTrending(); }

  onLibraryChange(paintGrids);
  onSummary(paintStats);
  onScriptsMutated(() => trending.reset());
  paintStats();
  trending.reset();
  refreshSummary();

  attachTilt(featured, 7);

  /* ---- interactions ---- */
  content.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-jump]");
    if (jump) { onJump(jump.dataset.jump); return; }

    if (e.target.closest("[data-generate]")) {
      document.dispatchEvent(new CustomEvent("lucrit:generate"));
      return;
    }
    if (e.target.closest("[data-info]")) { onInfo?.(); return; }
    if (e.target.closest("[data-auth]")) { onAuth?.(); return; }

    const world = e.target.closest("[data-world]");
    if (world) { libraryPanel.setCategory(world.dataset.world); onJump("search"); return; }

    const card = e.target.closest(".card");
    if (card && !e.target.closest(".library__results")) {
      const s = findScript(card.dataset.id);
      if (s) onOpenScript(s);
    }
  });

  return { content, chapters: CHAPTERS, board, publish, refresh: paintGrids };
}

/* ============================================================
   Publish form
   ============================================================ */


/* ============================================================
   Chrome — nav, top progress bar, floating dashboard button
   ============================================================ */

export function buildChrome({ onJump, onSearch, onDashboard, onAuth, onLibrary, onMine }) {
  const nav = el("header", { class: "nav" });
  nav.innerHTML = `
    <div class="progress" role="presentation">
      <span class="progress__fill"></span>
      <span class="progress__label" data-label></span>
    </div>
    <a class="nav__brand" href="#ch-hero" data-jump="hero" aria-label="Lucrit Script — home">
      <img class="nav__mark" src="/assets/img/mark.png" alt="" width="184" height="123" decoding="async">
      <span aria-hidden="true">Lucrit<b>Script</b></span>
    </a>
    <nav class="nav__links" aria-label="Sections">
      <button data-jump="search">Scripts</button>
      <button data-library>Library</button>
      <button data-mine>My Scripts</button>
      <button data-jump="categories">Categories</button>
      <button data-jump="featured">Trending</button>
      <button data-jump="community">Leaderboard</button>
      <a href="/executors">Executors</a>
      <button data-jump="submit">Publish</button>
    </nav>
    <button class="nav__search" aria-label="Search scripts">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
    </button>
    <button class="nav__menu" type="button" aria-label="Menu" aria-expanded="false" aria-controls="nav-drawer">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path></svg>
    </button>
    <div class="nav__drawer" id="nav-drawer" hidden></div>`;
  document.body.appendChild(nav);

  /*
   * Links collapse into a menu whenever they don't fit — measured, not guessed.
   *
   * The links used to vanish below 820px and otherwise just squeeze: between
   * about 820 and 1200px wide they wrapped ("My / Scripts"), slid under the
   * floating Dashboard button, and pushed the search button off the edge. Now
   * the nav measures what it needs on every resize and switches to a menu
   * button the moment the row would overflow, at any window size.
   */
  const linksEl = $(".nav__links", nav);
  const drawer = $(".nav__drawer", nav);
  const menuBtn = $(".nav__menu", nav);
  drawer.innerHTML = linksEl.innerHTML;
  let linksWidth = 0;
  function fitNav() {
    // Measure the links at their natural width (they're hidden while compact,
    // so briefly un-compact to read it — one layout, once per resize frame).
    if (window.innerWidth > 820) {
      nav.classList.remove("nav--compact");
      linksWidth = linksEl.scrollWidth || linksWidth;
    }
    const cs = getComputedStyle(nav);
    const gap = parseFloat(cs.columnGap || cs.gap) || 0;
    const brand = $(".nav__brand", nav).getBoundingClientRect().width;
    const search = $(".nav__search", nav).getBoundingClientRect().width;
    const need = parseFloat(cs.paddingLeft) + brand + gap + linksWidth + gap + search;
    // The row has to stop short of the floating Dashboard button when that
    // button sits up in the top bar; otherwise at the nav's own padding.
    const dash = document.querySelector(".dashbtn");
    const dr = dash?.getBoundingClientRect();
    const limit = dr && dr.width && dr.top < 60
      ? dr.left - 14
      : nav.clientWidth - parseFloat(cs.paddingRight);
    const tooNarrow = window.innerWidth <= 820 || need > limit;
    nav.classList.toggle("nav--compact", tooNarrow);
    if (!tooNarrow) closeDrawer();
  }
  function closeDrawer() {
    drawer.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  }
  menuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opening = drawer.hidden;
    drawer.hidden = !opening;
    menuBtn.setAttribute("aria-expanded", String(opening));
  });
  document.addEventListener("click", (e) => { if (!drawer.hidden && !nav.contains(e.target)) closeDrawer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });
  let fitQueued = false;
  const queueFit = () => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fitNav(); });
  };
  window.addEventListener("resize", queueFit, { passive: true });
  document.fonts?.ready?.then(queueFit);
  queueFit();

  nav.addEventListener("click", (e) => {
    if (e.target.closest(".nav__drawer button, .nav__drawer a")) closeDrawer();
    const jump = e.target.closest("[data-jump]");
    if (jump) { e.preventDefault(); onJump(jump.dataset.jump); return; }
    if (e.target.closest("[data-library]")) { onLibrary?.(); return; }
    if (e.target.closest("[data-mine]")) { onMine?.(); return; }
    if (e.target.closest(".nav__search")) onSearch();
  });

  // Fixed, always visible, survives scroll.
  const dash = el("button", { class: "dashbtn", type: "button" });
  function paintDash(session) {
    dash.innerHTML = session
      ? `<span class="avatar" style="--seed:${session.username.length * 37}">
           ${session.avatar ? `<img src="${esc(safeImageSrc(session.avatar))}" alt="">` : esc(session.username.slice(0, 2).toUpperCase())}
         </span><span>Dashboard</span>`
      : `<span class="dashbtn__icon" aria-hidden="true">
           <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6"/></svg>
         </span><span>View Dashboard</span>`;
  }
  account.onChange(paintDash);
  dash.addEventListener("click", () => (account.isSignedIn ? onDashboard() : onAuth()));
  document.body.appendChild(dash);

  const fill = $(".progress__fill", nav);
  const label = $("[data-label]", nav);

  // Section dots down the right edge: shows where you are on the page and
  // jumps anywhere in one click. Desktop only — phones have the menu.
  const dots = el("nav", { class: "sectiondots", "aria-label": "Page sections" });
  dots.innerHTML = CHAPTERS.map((c) =>
    `<button type="button" data-jump="${c.key}" aria-label="${c.label}"><span>${c.label}</span></button>`).join("");
  dots.addEventListener("click", (e) => {
    const b = e.target.closest("[data-jump]");
    if (b) onJump(b.dataset.jump);
  });
  document.body.appendChild(dots);
  const dotButtons = $$("button", dots);

  return {
    nav,
    update(progress, activeIndex) {
      fill.style.transform = `scaleX(${progress})`;
      label.textContent = CHAPTERS[activeIndex]?.label || "";
      nav.classList.toggle("is-scrolled", progress > 0.004);
      dotButtons.forEach((b, i) => b.classList.toggle("is-on", i === activeIndex));
      $$(".nav__links button, .nav__drawer button", nav).forEach((b) => {
        b.classList.toggle("is-on", b.dataset.jump === CHAPTERS[activeIndex]?.key);
      });
    },
  };
}

/* ============================================================
   Scroll choreography
   ============================================================ */

const FLOW = true;

export function createChoreography({ chrome, onCategoryIndex }) {
  const sections = $$(".chapter").map((node) => ({
    node,
    key: node.dataset.chapter,
    stage: $(".chapter__stage", node),
    band: BANDS[node.dataset.chapter],
    a: 0, b: 1,
  }));

  const cue = $(".scrollcue");
  const worlds = $$(".world");
  const railItems = $$(".worlds__rail [data-world-tab]");

  /* ---- reveal: each section glides in once as it comes on screen ----
     The animation people see is kept — a fade and a short rise — but it is
     triggered by the section ARRIVING, not tied to the exact scroll position.
     Content is never half-transparent while you are trying to read it, and
     nothing depends on scrolling a precise distance. */
  const reveal = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting) { e.target.classList.add("is-in"); reveal.unobserve(e.target); }
        }
      }, { rootMargin: "0px 0px -12% 0px", threshold: 0.06 })
    : null;
  sections.forEach((s, i) => {
    if (i === 0 || !reveal) s.node.classList.add("is-in");
    else reveal.observe(s.node);
  });

  /* ---- category worlds: tabs that also cycle on their own ----
     These used to change with scroll position, which is why that chapter was
     nearly four screens tall. Now they are tabs: click one, or let them
     rotate every few seconds while the section is on screen. */
  let lastWorld = -1;
  let worldIdx = 0;
  let worldTimer = 0;
  let worldsVisible = false;
  let worldsPinned = false;   // someone picked a tab — stop rotating for good
  function showWorld(i, { user = false } = {}) {
    worldIdx = (i + worlds.length) % worlds.length;
    worlds.forEach((w, k) => {
      const on = k === worldIdx;
      w.classList.toggle("is-on", on);
      w.style.opacity = "";
    });
    railItems.forEach((r, k) => {
      r.classList.toggle("is-on", k === worldIdx);
      r.setAttribute("aria-selected", String(k === worldIdx));
    });
    if (worldIdx !== lastWorld) { lastWorld = worldIdx; onCategoryIndex?.(worldIdx); }
    if (user) { worldsPinned = true; clearInterval(worldTimer); worldTimer = 0; }
  }
  railItems.forEach((r) => r.addEventListener("click", () => showWorld(Number(r.dataset.worldTab), { user: true })));
  if (worlds.length) showWorld(0);
  const catSection = sections.find((x) => x.key === "categories");
  if (catSection && "IntersectionObserver" in window && !document.documentElement.classList.contains("reduced-motion")) {
    new IntersectionObserver(([e]) => {
      worldsVisible = e.isIntersecting;
      if (worldsVisible && !worldTimer && !worldsPinned) {
        worldTimer = setInterval(() => showWorld(worldIdx + 1), 4200);
      } else if (!worldsVisible && worldTimer) { clearInterval(worldTimer); worldTimer = 0; }
    }, { threshold: 0.35 }).observe(catSection.node);
  }

  /**
   * Scroll progress is scrollY / (docHeight - viewportHeight), but a section
   * reaches the top of the viewport at offsetTop / (docHeight - viewportHeight).
   * Deriving the bands from real layout keeps the DOM and the camera in step.
   */
  function measure() {
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    for (const s of sections) {
      s.a = clamp01(s.node.offsetTop / max);
      s.b = clamp01((s.node.offsetTop + s.node.offsetHeight) / max);
      // Unclamped, for "which section is on screen": with short sections the
      // last ones can start past the end of the scroll range, and clamping
      // them to 1 lit the last dot whenever the page reached the bottom.
      s.top = s.node.offsetTop / max;
    }
  }

  measure();
  window.addEventListener("resize", measure, { passive: true });
  window.addEventListener("load", measure, { passive: true });
  // Sections are as tall as their content now, and content arrives late (the
  // library, the publish form, "show more"), so positions are re-read when it does.
  if ("ResizeObserver" in window) {
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; measure(); window.dispatchEvent(new Event("lucrit:layout")); });
    }).observe(document.getElementById("content"));
  }

  function toCameraProgress(p) {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (p <= s.b || i === sections.length - 1) {
        const span = Math.max(1e-6, s.b - s.a);
        return s.band[0] + clamp01((p - s.a) / span) * (s.band[1] - s.band[0]);
      }
    }
    return p;
  }

  function targetFor(key) {
    const i = sections.findIndex((x) => x.key === key);
    if (i < 0) return 0;
    if (i === 0) return 0;
    // Land with the section's label just under the fixed nav bar.
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const nav = window.innerWidth <= 820 ? 8 : 0;
    return Math.max(0, sections[i].a - nav / max);
  }

  /* --------------------------------------------------------- settling */

  // A chapter is fully readable between the end of its fade-in and the start
  // of its fade-out (local 0.22 → 0.78 in update()). SETTLE sits just inside
  // that, so a settled chapter is unambiguously at full opacity. Anywhere in
  // between two of these ranges is the half-faded limbo we glide out of.
  const SETTLE = 0.26;

  function restZones() {
    const last = sections.length - 1;
    return sections.map((s, i) => {
      const span = Math.max(1e-6, s.b - s.a);
      return {
        key: s.key,
        from: i === 0 ? s.a : s.a + span * SETTLE,
        to: i === last ? s.b : s.b - span * SETTLE,
      };
    });
  }

  /**
   * Where the page should come to rest. Returns null when the current
   * position is already a comfortable one — the common case, so ordinary
   * scrolling inside a chapter is never interfered with.
   */
  function snapTarget(progress, direction = 0) {
    // Sections flow now, so there is no half-faded "limbo" to glide out of.
    // The page stays exactly where the reader stops it — the forced settle
    // was a large part of why scrolling felt like a fight.
    if (FLOW) return null;
    const zones = restZones();

    for (const z of zones) {
      if (progress >= z.from && progress <= z.to) return null;
    }

    let prev = null;
    let next = null;
    for (const z of zones) {
      if (z.to < progress) prev = z;
      else if (!next) next = z;
    }

    if (!prev) return next ? next.from : null;
    if (!next) return prev.to;

    // Favour the chapter being scrolled towards: reversing someone's
    // direction feels like the page arguing with them.
    const gap = Math.max(1e-6, next.from - prev.to);
    const t = (progress - prev.to) / gap;
    const tipping = direction > 0 ? 0.3 : direction < 0 ? 0.7 : 0.5;
    return t >= tipping ? next.from : prev.to;
  }

  function update(progress) {
    // The active section is the one under the upper third of the screen —
    // what someone is actually looking at, for the nav highlight and dots.
    const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
    const probe = progress + (window.innerHeight * 0.35) / max;
    let active = 0;
    sections.forEach((s, i) => {
      if (probe >= (s.top ?? s.a)) active = i;
      const live = i === active;
      if (s._live !== live) { s._live = live; s.node.classList.toggle("is-live", live); }
    });

    if (cue) {
      const o = clamp01(1 - progress / 0.02).toFixed(2);
      if (cue._o !== o) { cue._o = o; cue.style.opacity = o; cue.style.pointerEvents = o > 0.2 ? "auto" : "none"; }
    }

    chrome.update(progress, active);
  }

  return { update, targetFor, toCameraProgress, measure, snapTarget, restZones };
}
