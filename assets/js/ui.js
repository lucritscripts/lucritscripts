// All DOM: navigation, chapters, the searchable library, publishing,
// the leaderboard, and the scroll-linked chapter choreography.

import { SCRIPTS, CATEGORIES, SORTS, BOARDS, categoryOf } from "./data/scripts.js";
import { BANDS } from "./engine/world.js";
import { account } from "./account.js";
import { safeImageSrc } from "./safe.js";
import { isSaved } from "./vault.js";
import { esc, fmt, toast, captchaMarkup, captchaPassed, captchaReset, createLeaderboard,
         mountTurnstile, turnstileToken } from "./pages.js";
import { totals as scriptTotals, onStatsChange } from "./stats.js";
import { createGamePicker } from "./gamepicker.js";
import {
  tileGames, searchGames, searchScripts, gameArt, allGames, gameId, findGame,
} from "./games.js";
import { libraryOnline, fetchScripts, publishScript, fetchBoard } from "./library-api.js";
import { noteWindow, secondsLeft, clockChip, onExpire } from "./unlockclock.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const DISCORD_INVITE = "https://discord.gg/JUSmn4ZYe";

/** The two category shortcuts worth a permanent button. */
const PINNED = ["combat", "universal"];

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
  libraryChanged();
}

export function removeScript(id) {
  const i = library.findIndex((s) => s.id === id);
  if (i < 0) return false;
  library.splice(i, 1);
  libraryChanged();
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

const wordCount = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

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
        </div>
        <h3 class="card__title">${esc(script.title)}</h3>
        ${script.game ? `<p class="card__game">${esc(script.game)}</p>` : ""}
        <p class="card__desc">${esc(String(script.desc || "").slice(0, 140))}${String(script.desc || "").length > 140 ? "…" : ""}</p>
        <div class="card__meta">
          <span class="by">@${esc(script.author)}</span>
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

/* ============================================================
   Search
   ============================================================ */

/**
 * Find a script.
 *
 * This used to open on a wall of game tiles, most of them reading "No scripts
 * yet" — a directory of absence. People come here for scripts, so scripts are
 * what it shows; the game is a filter above them, not a gate in front of them.
 *
 * Two categories stay pinned: Combat, and Universal for everything that is not
 * tied to a single game. Everything else is reachable through search, the
 * Library, or a game's own page.
 */
export function createLibraryPanel({ id, onOpen, onPublish, onOpenGame, onOpenLibrary }) {
  const state = { query: "", cat: "", game: "" };
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
    </div>

    <div class="library__pinned">
      ${PINNED.map((c) => `
        <button class="filter filter--pin" type="button" data-cat="${esc(c)}"
                style="--cat:${esc(categoryOf(c).accent)}">${esc(categoryOf(c).label)}</button>`).join("")}
      <span class="library__pinnote">Pinned categories</span>
      <button class="btn btn--ghost btn--xs library__all" type="button" data-more>Browse all games</button>
    </div>

    <p class="library__count" aria-live="polite"></p>
    <div class="library__results" data-native-scroll></div>`;

  const input = $(".library__input", root);
  const clear = $(".library__clear", root);
  const pins = $$(".filter--pin", root);
  const gamePick = $("[data-gamepick]", root);
  const results = $(".library__results", root);
  const count = $(".library__count", root);

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
      `${esc(g.name)}${g.scripts ? ` (${g.scripts})` : ""}</option>`;

    gamePick.innerHTML = `
      <option value=""${state.game ? "" : " selected"}>All games</option>
      ${withScripts.length ? `<optgroup label="Has scripts">${withScripts.map(option).join("")}</optgroup>` : ""}
      ${empty.length ? `<optgroup label="Nothing published yet">${empty.map(option).join("")}</optgroup>` : ""}`;
  }

  /** Everything currently published, narrowed by whatever filters are on. */
  function filtered() {
    return library.filter((s) =>
      (!state.game || gameId(s.game) === state.game) &&
      (!state.cat || s.category === state.cat));
  }

  function scriptsView() {
    const list = filtered();
    const cat = state.cat ? categoryOf(state.cat) : null;
    const game = state.game ? findGame(library, state.game) : null;

    const bits = [`${list.length} script${list.length === 1 ? "" : "s"}`];
    if (cat) bits.push(`in ${cat.label}`);
    if (game) bits.push(`for ${game.name}`);

    count.innerHTML = `${esc(bits.join(" "))}` +
      (cat || game ? ` <button class="library__undo" type="button" data-clear-filters>clear</button>` : "");

    if (list.length) {
      results.innerHTML = `<div class="results__grid">${list.map((s) => cardMarkup(s)).join("")}</div>`;
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
    const games = searchGames(library, q, 12);
    const scripts = searchScripts(library, q);

    count.textContent = `${games.length} game${games.length === 1 ? "" : "s"} · ${scripts.length} script${scripts.length === 1 ? "" : "s"}`;

    if (!games.length && !scripts.length) {
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
      ${scripts.length ? `
        <h3 class="results__head">Scripts</h3>
        <div class="results__grid">${scripts.map((s) => cardMarkup(s)).join("")}</div>` : ""}`;
  }

  function render() {
    for (const p of pins) p.classList.toggle("is-on", state.cat === p.dataset.cat);
    clear.hidden = !state.query;
    paintGameMenu();

    if (state.query.trim()) searchView();
    else scriptsView();
  }

  function emptyState(title, line) {
    return `
      <div class="empty empty--lg">
        <strong>${title}</strong>
        <span>${line}</span>
        <button class="btn btn--primary btn--sm" data-act="publish">Publish a script</button>
      </div>`;
  }

  /* ---------------------------------------------------------- events */

  input.addEventListener("input", () => { state.query = input.value; render(); });

  clear.addEventListener("click", () => {
    input.value = "";
    state.query = "";
    input.focus();
    render();
  });

  for (const p of pins) {
    p.addEventListener("click", () => {
      // Clicking the pin you are already on clears it, so the same button
      // both applies and removes the filter.
      state.cat = state.cat === p.dataset.cat ? "" : p.dataset.cat;
      state.query = "";
      input.value = "";
      render();
    });
  }

  gamePick.addEventListener("change", () => {
    state.game = gamePick.value;
    // A search would hide the very list the picker just filtered.
    state.query = "";
    input.value = "";
    render();
  });

  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-more]")) { onOpenLibrary?.(); return; }
    if (e.target.closest("[data-clear-filters]")) {
      state.cat = "";
      state.game = "";
      render();
      return;
    }
    if (e.target.closest('[data-act="publish"]')) { onPublish?.(); return; }

    const tile = e.target.closest("[data-game]");
    if (tile) { onOpenGame?.(tile.dataset.game); return; }

    const card = e.target.closest(".card");
    if (card) {
      const script = library.find((s) => s.id === card.dataset.id);
      if (script) onOpen?.(script);
    }
  });

  attachTilt(results, 6);
  onLibraryChange(render);
  onStatsChange(() => { if (!state.query) render(); });
  render();

  return {
    node: root,
    focus: () => input.focus(),
    search(q) { state.cat = ""; state.query = q; input.value = q; render(); },
    setCategory(cat) {
      state.query = "";
      input.value = "";
      state.cat = cat || "";
      render();
    },
    setGame(gameKey) {
      state.query = "";
      input.value = "";
      state.game = gameKey || "";
      render();
    },
    refresh: render,
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
  { key: "vault",      label: "The Vault",  len: 321 },
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

export function buildChapters({ libraryPanel, onOpenScript, onJump, onPublish, onAuth, onInfo }) {
  const content = el("main", { id: "content" });

  // The stage is a 100vh scroll box. Most chapters fit inside it and never
  // scroll, but a few — Publish above all — are taller than the screen, and
  // without `data-native-scroll` the wheel handler would drive the page past
  // them instead of letting you read to the bottom.
  const chapter = (key, label, len, inner) => `
    <section class="chapter" id="ch-${key}" data-chapter="${key}" style="--len:${len}">
      <div class="chapter__inner">
        <div class="chapter__stage" data-native-scroll>
          <span class="chapter__tag" aria-hidden="true">${label}</span>
          ${inner}
        </div>
      </div>
    </section>`;

  content.innerHTML = [
    chapter("hero", "01 / Origin", CHAPTERS[0].len, `
      <div class="hero">
        <img class="hero__logo" src="assets/img/logo.png" alt="Lucrit Script"
             width="460" height="236" fetchpriority="high" decoding="async">
        <h1 class="hero__title">
          <span class="line">The ultimate</span>
          <span class="line">Roblox script</span>
          <span class="line accent">library</span>
        </h1>
        <p class="hero__sub">Discover, explore, and build with Roblox scripts — published by creators who get paid every time you unlock one.</p>
        <div class="hero__cta">
          <button class="btn btn--primary" data-jump="search">Explore scripts</button>
          <button class="btn btn--ai" data-generate>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z"/></svg>
            Create a Script with AI
          </button>
          <a class="btn btn--discord" href="${DISCORD_INVITE}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.3 5.3A16 16 0 0 0 15.4 4l-.2.4a12 12 0 0 1 3.3 1.6 11 11 0 0 0-9-1.1 11.4 11.4 0 0 0-2 1.1A12 12 0 0 1 10.8 4L10.6 4a16 16 0 0 0-3.9 1.3C4.2 9 3.5 12.6 3.9 16.2a16 16 0 0 0 4.8 2.4l.6-1a10.6 10.6 0 0 1-1.7-.8l.4-.3a11.4 11.4 0 0 0 9.8 0l.4.3a10.6 10.6 0 0 1-1.7.8l.6 1a16 16 0 0 0 4.8-2.4c.5-4.2-.6-7.8-2.6-10.9ZM9.7 14.1c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Zm4.6 0c-.9 0-1.7-.9-1.7-2s.8-2 1.7-2 1.7.9 1.7 2-.7 2-1.7 2Z"/></svg>
            Join Discord for daily updates
          </a>
          <button class="btn btn--gold" data-info="paid">Start Getting Paid for Scripting</button>
          <button class="btn btn--ghost" data-auth="account">View Account</button>
        </div>
      </div>
      <div class="scrollcue" aria-hidden="true">
        <span>Scroll to explore</span>
        <svg viewBox="0 0 24 24"><path d="M12 4v14M6 13l6 6 6-6"/></svg>
      </div>`),

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

    chapter("vault", "04 / The Vault", CHAPTERS[3].len, `
      <div class="panel">
        <header class="panel__head">
          <h2>The vault</h2>
          <p>Every module, open and readable. No paste-and-pray.</p>
        </header>
        <div class="vault__grid" data-grid="vault"></div>
      </div>`),

    chapter("categories", "05 / Worlds", CHAPTERS[4].len, `
      <div class="worlds">
        <div class="worlds__rail" aria-hidden="true"></div>
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
          <a class="btn btn--discord" href="${DISCORD_INVITE}" target="_blank" rel="noopener">Join Discord</a>
        </div>
      </div>`),
  ].join("");

  document.body.appendChild(content);

  $("#search-mount", content).appendChild(libraryPanel.node);

  /* ---- category worlds ---- */
  const rail = $(".worlds__rail", content);
  const stage = $(".worlds__stage", content);
  rail.innerHTML = CATEGORY_WORLDS.map((w) => `<span>${w.title}</span>`).join("");
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

  /* ---- publish ---- */
  const publish = buildPublishForm({ onAuth, onPublished: onPublish });
  $("#publish-mount", content).appendChild(publish.node);

  /* ---- grids + stats react to the library ---- */
  function paintGrids() {
    const stats = $("[data-stats]", content);
    const total = library.length;
    const views = library.reduce((a, s) => a + (s.views || 0), 0);
    stats.innerHTML = `
      <div><strong>${total}</strong><span>scripts</span></div>
      <div><strong>${CATEGORIES.length}</strong><span>categories</span></div>
      <div><strong>${fmt(views)}</strong><span>views</span></div>`;

    const vault = $('[data-grid="vault"]', content);
    const featured = $('[data-grid="featured"]', content);

    const emptyBlock = (title, line) => `
      <div class="empty empty--lg">
        <strong>${title}</strong>
        <span>${line}</span>
        <button class="btn btn--primary btn--sm" data-jump="submit">Publish a script</button>
      </div>`;

    const top = library.slice().sort((a, b) => b.copies - a.copies);
    vault.innerHTML = top.length
      ? top.slice(0, 8).map((s) => cardMarkup(s)).join("")
      : emptyBlock("Nothing in the vault yet.", "Published scripts land here, newest and most-unlocked first.");

    featured.innerHTML = top.length
      ? top.slice(0, 6).map((s) => cardMarkup(s, { large: true })).join("")
      : emptyBlock("No trending scripts yet.", "Once scripts start getting unlocked, the most popular show up here.");
  }

  onLibraryChange(paintGrids);
  paintGrids();

  attachTilt($('[data-grid="vault"]', content), 9);
  attachTilt($('[data-grid="featured"]', content), 7);

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
      const s = library.find((x) => x.id === card.dataset.id);
      if (s) onOpenScript(s);
    }
  });

  return { content, chapters: CHAPTERS, board, publish, refresh: paintGrids };
}

/* ============================================================
   Publish form
   ============================================================ */

function buildPublishForm({ onAuth, onPublished }) {
  const node = el("div", { class: "publish" });

  function render() {
    const signedIn = account.isSignedIn;

    if (!signedIn) {
      node.innerHTML = `
        <header class="panel__head">
          <h2>Publish a script</h2>
          <p>Share your work and earn every time someone unlocks it.</p>
        </header>
        <div class="empty empty--lg">
          <strong>You need an account to publish.</strong>
          <span>It takes about twenty seconds — username, email, password.</span>
          <button class="btn btn--primary btn--sm" data-act="auth">Create an account</button>
        </div>`;
      return;
    }

    node.innerHTML = `
      <header class="panel__head">
        <h2>Publish a script</h2>
        <p>Publishing as <b>@${esc(account.session.username)}</b>. It goes live in its category straight away.</p>
      </header>

      <form class="form form--grid publish__form" novalidate>
        <label>Script name<input name="title" maxlength="70" placeholder="Inventory System" required></label>
        <label>Roblox game<span data-gamepick></span></label>

        <label>Category
          <select name="category">
            ${CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join("")}
          </select>
        </label>

        <label>Game link or place ID <span class="opt">optional</span>
          <input name="place" placeholder="roblox.com/games/123456789">
        </label>

        <label class="wide">Thumbnail <span class="opt">optional — leave blank to use the game's Roblox thumbnail</span>
          <div class="thumbpick">
            <span class="thumbpick__preview" data-thumb>No thumbnail</span>
            <input type="file" name="thumbnail" accept="image/png,image/jpeg,image/webp">
          </div>
        </label>

        <label class="wide">Description
          <textarea name="desc" rows="5" placeholder="What does it do, how do you use it, what makes it different? Minimum 100 words."></textarea>
          <span class="counter" data-counter>0 / 100 words</span>
        </label>

        <label class="wide">Luau code
          <textarea name="code" rows="8" spellcheck="false" placeholder="--!strict&#10;local Module = {}&#10;return Module"></textarea>
        </label>

        <label>Tags <span class="opt">comma separated</span>
          <input name="tags" maxlength="80" placeholder="inventory, stacks, server">
        </label>

        <fieldset class="keyless">
          <legend>Key requirement</legend>
          <label class="radio"><input type="radio" name="keyless" value="yes" checked> Keyless</label>
          <label class="radio"><input type="radio" name="keyless" value="no"> Key required</label>
        </fieldset>

        <div class="wide">${account.turnstileKey
          ? `<div class="turnstile" data-turnstile></div>`
          : captchaMarkup("publish-captcha")}</div>

        <div class="wide publish__actions">
          <button class="btn btn--primary" type="submit">Publish script</button>
          <span class="note">By publishing you confirm this is yours to share.</span>
        </div>
      </form>`;
  }

  let picker = null;

  function mountPicker() {
    const slot = $("[data-gamepick]", node);
    if (!slot) { picker = null; return; }
    picker = createGamePicker({ name: "game", placeholder: "Search Roblox games, or type your own" });
    slot.replaceWith(picker.node);
    // Turnstile replaces the hand-rolled widget wherever a server can verify it.
    mountTurnstile(node);
  }

  node.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="auth"]')) onAuth?.();
  });

  node.addEventListener("input", (e) => {
    if (e.target.name === "desc") {
      const n = wordCount(e.target.value);
      const counter = $("[data-counter]", node);
      counter.textContent = `${n} / 100 words`;
      counter.classList.toggle("is-ok", n >= 100);
    }
    if (e.target.name === "place") {
      const url = robloxThumb(e.target.value);
      const prev = $("[data-thumb]", node);
      if (url && !prev.dataset.value) {
        prev.innerHTML = `<img src="${url}" alt="">`;
        prev.dataset.auto = url;
      }
    }
  });

  node.addEventListener("change", (e) => {
    const input = e.target.closest('input[name="thumbnail"]');
    if (!input?.files?.[0]) return;
    const file = input.files[0];
    if (file.size > 3 * 1024 * 1024) { toast("Thumbnail must be under 3 MB", "warn"); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const prev = $("[data-thumb]", node);
      prev.innerHTML = `<img src="${reader.result}" alt="">`;
      prev.dataset.value = reader.result;
    };
    reader.readAsDataURL(file);
  });

  node.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const d = Object.fromEntries(new FormData(form));

    if (!String(d.title).trim()) return toast("Give the script a name", "warn");
    if (!String(d.game || "").trim()) return toast("Pick or type the Roblox game", "warn");

    const words = wordCount(d.desc);
    if (words < 100) return toast(`Description needs ${100 - words} more word${100 - words === 1 ? "" : "s"}`, "warn");
    if (!String(d.code).trim()) return toast("Paste the Luau code", "warn");
    const usingTurnstile = Boolean(account.turnstileKey);
    if (!usingTurnstile && !captchaPassed(node))
      return toast("Complete the human check", "warn");

    const prev = $("[data-thumb]", node);
    const draft = {
      title: String(d.title).trim(),
      game: String(d.game).trim(),
      category: d.category,
      desc: String(d.desc).trim(),
      code: String(d.code),
      tags: String(d.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
      keyless: d.keyless !== "no",
      thumbnail: prev?.dataset.value || prev?.dataset.auto || robloxThumb(d.place) || "",
      turnstile: turnstileToken(node),
    };

    const submit = $('[type="submit"]', form);
    const wasLabel = submit?.textContent;
    if (submit) { submit.disabled = true; submit.textContent = "Publishing…"; }

    let script;
    try {
      if (await libraryOnline()) {
        // The real path: the script goes to the server, and what comes back is
        // what everyone else will see.
        const res = await publishScript(draft);
        if (!res.ok) {
          toast(res.error || "Couldn't publish that. Try again.", "warn");
          return;
        }
        script = res.data;
        addScript(script);
      } else {
        // Static hosting, no API. Publish locally and SAY SO — the old code
        // showed "it's live in the library" here, which was untrue and is how
        // a published script ended up visible to nobody.
        script = {
          ...draft,
          id: "s_" + Math.random().toString(36).slice(2, 10),
          author: account.session.username,
          authorId: account.session.id,
          views: 0, copies: 0, likes: 0,
          added: new Date().toISOString().slice(0, 10),
          localOnly: true,
        };
        addScript(script);
        toast("Saved on this device only — the library isn't reachable", "warn");
      }
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = wasLabel; }
    }

    await account.addPublish(script.id);
    form.reset();
    picker?.reset();
    captchaReset(node);
    render();
    mountPicker();
    if (!script.localOnly) toast("Published — it's live in the library");
    onPublished?.(script);
  });

  account.onChange(() => { render(); mountPicker(); });
  render();
  mountPicker();

  return { node, refresh() { render(); mountPicker(); } };
}

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
      <img class="nav__mark" src="assets/img/mark.png" alt="" width="184" height="123" decoding="async">
      <span aria-hidden="true">Lucrit<b>Script</b></span>
    </a>
    <nav class="nav__links" aria-label="Sections">
      <button data-jump="search">Scripts</button>
      <button data-library>Library</button>
      <button data-mine>My Scripts</button>
      <button data-jump="categories">Categories</button>
      <button data-jump="featured">Trending</button>
      <button data-jump="community">Leaderboard</button>
      <button data-jump="submit">Publish</button>
    </nav>
    <button class="nav__search" aria-label="Search scripts">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
    </button>`;
  document.body.appendChild(nav);

  nav.addEventListener("click", (e) => {
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

  return {
    nav,
    update(progress, activeIndex) {
      fill.style.transform = `scaleX(${progress})`;
      label.textContent = CHAPTERS[activeIndex]?.label || "";
      nav.classList.toggle("is-scrolled", progress > 0.004);
      $$(".nav__links button", nav).forEach((b) => {
        b.classList.toggle("is-on", b.dataset.jump === CHAPTERS[activeIndex]?.key);
      });
    },
  };
}

/* ============================================================
   Scroll choreography
   ============================================================ */

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
  const railItems = $$(".worlds__rail span");
  let lastWorld = -1;

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
    }
  }

  measure();
  window.addEventListener("resize", measure, { passive: true });
  window.addEventListener("load", measure, { passive: true });

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
    return sections[i].a + (sections[i].b - sections[i].a) * 0.45;
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
    let active = 0;

    sections.forEach((s, i) => {
      const span = Math.max(1e-6, s.b - s.a);
      const local = clamp01((progress - s.a) / span);
      const inView = progress >= s.a - 0.02 && progress <= s.b + 0.02;
      if (progress >= s.a && progress < s.b) active = i;

      const isFirst = i === 0;
      const isLast = i === sections.length - 1;
      const fadeIn = isFirst ? 1 : clamp01(local / 0.22);
      const fadeOut = isLast ? 1 : 1 - clamp01((local - 0.78) / 0.22);
      const vis = Math.min(fadeIn, fadeOut);

      s.stage.style.opacity = vis.toFixed(3);
      s.stage.style.transform =
        `translate3d(0, ${((1 - fadeIn) * 30 - (1 - fadeOut) * 24).toFixed(2)}px, 0)`;
      s.stage.style.pointerEvents = vis > 0.35 ? "auto" : "none";
      s.node.classList.toggle("is-live", inView);

      if (!inView && s.stage.scrollTop !== 0) s.stage.scrollTop = 0;
    });

    if (cue) cue.style.opacity = String(clamp01(1 - progress / 0.015));

    const cat = sections.find((s) => s.key === "categories");
    if (cat && progress >= cat.a && progress <= cat.b) {
      const t = clamp01((progress - cat.a) / Math.max(1e-6, cat.b - cat.a));
      const idx = Math.min(CATEGORY_WORLDS.length - 1, Math.floor(t * CATEGORY_WORLDS.length));
      const inner = t * CATEGORY_WORLDS.length - idx;
      worlds.forEach((w, i) => {
        const on = i === idx;
        w.classList.toggle("is-on", on);
        w.style.opacity = on ? String(clamp01(Math.min(inner / 0.16, (1 - inner) / 0.16))) : "0";
      });
      railItems.forEach((r, i) => r.classList.toggle("is-on", i === idx));
      if (idx !== lastWorld) { lastWorld = idx; onCategoryIndex?.(idx); }
    } else {
      worlds.forEach((w) => { w.style.opacity = "0"; w.classList.remove("is-on"); });
    }

    chrome.update(progress, active);
  }

  return { update, targetFor, toCameraProgress, measure, snapTarget, restZones };
}
