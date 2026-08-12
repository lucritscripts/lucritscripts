// The two pages you reach from "Find a script":
//
//   Library   — every game on the site, searchable, nothing capped.
//   Game page — every script published for one game.
//
// Both are overlays rather than routes, so the 3D world behind them keeps its
// position and closing returns you exactly where you were. Deep links still
// work: the hash is kept in step, so #library and #game=<id> are shareable.

import { createOverlay, esc, fmt } from "./pages.js";
import { allGames, findGame, scriptsForGame, searchGames, gameArt, gameId } from "./games.js";
import { totals as scriptTotals } from "./stats.js";

const $ = (sel, root = document) => root.querySelector(sel);

/**
 * Keeps the address bar in step without touching history — you can copy a
 * link to a game, and Back still leaves the site rather than unwinding a
 * dozen overlay opens.
 */
function setHash(value) {
  const next = value ? `#${value}` : location.pathname + location.search;
  try { history.replaceState(null, "", next); } catch { /* file:// */ }
}

// Escape is handled inside createOverlay, so the hash is tidied up here.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  setTimeout(() => {
    const ours = /^#(library|game=)/.test(location.hash);
    const open = document.querySelector("#library-page:not([hidden]), #game-page:not([hidden])");
    if (ours && !open) setHash("");
  }, 0);
});

/* ---------------------------------------------------------------- art */

function artMarkup(game, big = false) {
  const art = gameArt(game);
  return `
    <span class="gtile__art${big ? " gtile__art--lg" : ""}" style="--h:${art.hue}" aria-hidden="true">
      ${game.thumbnail
        ? `<img src="${esc(game.thumbnail)}" alt="" loading="lazy">`
        : `<span class="gtile__mono">${esc(art.initials)}</span>`}
    </span>`;
}

function rowMarkup(game) {
  return `
    <button class="grow" type="button" data-game="${esc(game.id)}" style="--h:${gameArt(game).hue}">
      ${artMarkup(game)}
      <span class="grow__text">
        <span class="grow__name">${esc(game.name)}</span>
        <span class="grow__meta">${game.scripts
          ? `${fmt(game.scripts)} script${game.scripts === 1 ? "" : "s"} · ${fmt(game.views)} views`
          : "No scripts yet — publish the first"}</span>
      </span>
      <svg class="grow__chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
    </button>`;
}

/* ------------------------------------------------------------ library */

/** Every game on the site. No 20-tile cap, and its own search. */
export function createGameLibrary({ getLibrary, onOpenGame, onPublish }) {
  const overlay = createOverlay({ id: "library-page", label: "Game library", wide: true });
  let query = "";

  function render() {
    const lib = getLibrary();
    const all = allGames(lib);
    const shown = query.trim() ? searchGames(lib, query, 500) : all;
    const withScripts = all.filter((g) => g.scripts).length;

    overlay.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">Library</span>
        <h2>Every game on Lucrit</h2>
        <p>${fmt(all.length)} games · ${fmt(withScripts)} with scripts published so far.
          Pick one to see everything written for it.</p>
      </header>

      <div class="library__search library__search--inline">
        <svg class="library__icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>
        </svg>
        <input class="library__input" type="search" autocomplete="off" spellcheck="false"
               value="${esc(query)}" placeholder="Search every game..." aria-label="Search games">
      </div>

      <p class="library__count">${shown.length === all.length
        ? `${fmt(all.length)} games`
        : `${fmt(shown.length)} of ${fmt(all.length)} games`}</p>

      ${shown.length
        ? `<div class="grows">${shown.map(rowMarkup).join("")}</div>`
        : `<div class="empty empty--lg">
             <strong>No game matched “${esc(query)}”.</strong>
             <span>You can still publish a script for it — type the name in the publish form and it joins the list.</span>
             <button class="btn btn--primary btn--sm" data-act="publish">Publish a script</button>
           </div>`}`;

    const input = $(".library__input", overlay.body);
    input?.addEventListener("input", () => {
      query = input.value;
      const at = input.selectionStart;
      render();
      const next = $(".library__input", overlay.body);
      next.focus();
      next.setSelectionRange(at, at);
    });
  }

  overlay.node.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="publish"]')) { overlay.close(); onPublish?.(); return; }
    const row = e.target.closest("[data-game]");
    if (row) { overlay.close(); onOpenGame?.(row.dataset.game); }
  });

  overlay.node.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) setHash("");
  });

  return {
    open() { query = ""; overlay.open(); render(); setHash("library"); },
    close: () => { overlay.close(); setHash(""); },
    refresh() { if (overlay.isOpen) render(); },
    get isOpen() { return overlay.isOpen; },
  };
}

/* ---------------------------------------------------------- game page */

const SORTS = [
  { id: "popular", label: "Most viewed" },
  { id: "liked", label: "Most liked" },
  { id: "rated", label: "Best rated" },
  { id: "newest", label: "Newest" },
];

/** Everything published for one game. */
export function createGamePage({ getLibrary, onOpenScript, onPublish, cardMarkup }) {
  const overlay = createOverlay({ id: "game-page", label: "Game", wide: true });
  let current = null;
  let sort = "popular";

  function sortScripts(list) {
    const t = (s) => scriptTotals(s.id);
    const by = {
      popular: (a, b) => t(b).views - t(a).views || t(b).copies - t(a).copies,
      liked: (a, b) => t(b).likes - t(a).likes,
      rated: (a, b) => (b.rating || 0) - (a.rating || 0) || t(b).likes - t(a).likes,
      newest: (a, b) => String(b.added).localeCompare(String(a.added)),
    }[sort];
    return list.slice().sort(by);
  }

  function render() {
    if (!current) return;
    const lib = getLibrary();
    const game = findGame(lib, current) || { id: current, name: current, scripts: 0, views: 0, likes: 0, thumbnail: "" };
    const scripts = sortScripts(scriptsForGame(lib, current));

    overlay.body.innerHTML = `
      <div class="gamehead">
        ${artMarkup(game, true)}
        <div class="gamehead__text">
          <span class="sheet__eyebrow">Game</span>
          <h2>${esc(game.name)}</h2>
          <p class="gamehead__meta">
            <span><b>${fmt(scripts.length)}</b> script${scripts.length === 1 ? "" : "s"}</span>
            <span class="dot" aria-hidden="true"></span>
            <span><b>${fmt(game.views)}</b> views</span>
            <span class="dot" aria-hidden="true"></span>
            <span><b>${fmt(game.likes)}</b> like${game.likes === 1 ? "" : "s"}</span>
          </p>
        </div>
        <button class="btn btn--ghost btn--sm gamehead__back" type="button" data-back>All games</button>
      </div>

      ${scripts.length > 1 ? `
        <div class="library__controls">
          <label class="sort">
            <span class="sort__label">Sort</span>
            <select class="sort__select" aria-label="Sort scripts">
              ${SORTS.map((s) => `<option value="${s.id}"${s.id === sort ? " selected" : ""}>${s.label}</option>`).join("")}
            </select>
          </label>
        </div>` : ""}

      ${scripts.length
        ? `<div class="results__grid">${scripts.map((s) => cardMarkup(s)).join("")}</div>`
        : `<div class="empty empty--lg">
             <strong>No scripts for ${esc(game.name)} yet.</strong>
             <span>Publish the first one and every player searching this game finds your work at the top.</span>
             <button class="btn btn--primary btn--sm" data-act="publish">Publish a script</button>
           </div>`}`;

    $(".sort__select", overlay.body)?.addEventListener("change", (e) => {
      sort = e.target.value;
      render();
    });
  }

  overlay.node.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) { setHash(""); return; }
    if (e.target.closest("[data-back]")) { overlay.close(); document.dispatchEvent(new CustomEvent("lucrit:library")); return; }
    if (e.target.closest('[data-act="publish"]')) { overlay.close(); onPublish?.(); return; }

    const card = e.target.closest(".card");
    if (!card) return;
    const script = getLibrary().find((s) => s.id === card.dataset.id);
    if (script) onOpenScript?.(script);
  });

  return {
    open(id) {
      current = gameId(id) === id ? id : gameId(id);
      sort = "popular";
      overlay.open();
      render();
      setHash(`game=${current}`);
    },
    close: () => { overlay.close(); setHash(""); },
    refresh() { if (overlay.isOpen) render(); },
    get isOpen() { return overlay.isOpen; },
    get game() { return current; },
  };
}
