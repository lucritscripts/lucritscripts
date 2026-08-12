// All DOM: navigation, chapters, the searchable library, publishing,
// the leaderboard, and the scroll-linked chapter choreography.

import { SCRIPTS, CATEGORIES, SORTS, BOARDS, categoryOf } from "./data/scripts.js";
import { BANDS } from "./engine/world.js";
import { account } from "./account.js";
import { esc, fmt, toast, captchaMarkup, captchaPassed, captchaReset, createLeaderboard } from "./pages.js";
import { totals as scriptTotals } from "./stats.js";
import { createGamePicker } from "./gamepicker.js";

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

/** Every published script. Starts empty; grows through the submit form. */
export const library = SCRIPTS.slice();

const listeners = new Set();
export function onLibraryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function libraryChanged() { for (const fn of listeners) fn(library); }

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
  return `
    <article class="card${large ? " card--lg" : ""}" data-id="${esc(script.id)}" style="--cat:${cat.accent}">
      <div class="card__glow" aria-hidden="true"></div>
      ${script.thumbnail ? `<img class="card__thumb" src="${esc(script.thumbnail)}" alt="" loading="lazy">` : ""}
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
          <span>${fmt(scriptTotals(script.id).views)} views</span>
        </div>
        <div class="card__actions">
          <button class="btn btn--sm btn--primary" data-act="get">Get Script</button>
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

export function createLibraryPanel({ id, onOpen, onPublish }) {
  const state = { query: "", cats: new Set(), sort: "popular" };
  const root = el("div", { class: "library", id });

  root.innerHTML = `
    <div class="library__search">
      <svg class="library__icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>
      </svg>
      <input class="library__input" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search scripts, games, categories..." aria-label="Search scripts">
      <kbd class="library__kbd">/</kbd>
    </div>

    <div class="library__controls">
      <div class="filters" role="group" aria-label="Filter by category"></div>
      <label class="sort">
        <span class="sort__label">Sort</span>
        <select class="sort__select" aria-label="Sort scripts">
          ${SORTS.map((s) => `<option value="${s.id}">${s.label}</option>`).join("")}
        </select>
      </label>
    </div>

    <p class="library__count" aria-live="polite"></p>
    <div class="library__results" data-native-scroll></div>`;

  const input = $(".library__input", root);
  const filters = $(".filters", root);
  const select = $(".sort__select", root);
  const results = $(".library__results", root);
  const count = $(".library__count", root);

  filters.appendChild(el("button", { class: "filter is-on", type: "button", "data-cat": "" }, "All"));
  for (const c of CATEGORIES) {
    filters.appendChild(el("button", {
      class: "filter", type: "button", "data-cat": c.id, style: `--cat:${c.accent}`,
    }, c.label));
  }

  function matches(s) {
    if (state.cats.size && !state.cats.has(s.category)) return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [s.title, s.game, s.desc, s.author, s.category, ...(s.tags || [])]
      .join(" ").toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  function sorted(list) {
    const by = {
      popular: (a, b) => (b.copies + b.views * 0.1) - (a.copies + a.views * 0.1),
      newest: (a, b) => String(b.added).localeCompare(String(a.added)),
      rated: (a, b) => (b.rating || 0) - (a.rating || 0) || b.views - a.views,
      viewed: (a, b) => b.views - a.views,
    }[state.sort];
    return list.slice().sort(by);
  }

  function render() {
    const list = sorted(library.filter(matches));

    if (!library.length) {
      count.textContent = "0 scripts";
      results.innerHTML = `
        <div class="empty empty--lg">
          <strong>The library is empty — for now.</strong>
          <span>Every script here is published by a creator. Be the first and you're at the top of the leaderboard by default.</span>
          <button class="btn btn--primary btn--sm" data-act="publish">Publish the first script</button>
        </div>`;
      return;
    }

    count.textContent = list.length === library.length
      ? `${list.length} script${list.length === 1 ? "" : "s"}`
      : `${list.length} of ${library.length} scripts`;

    results.innerHTML = list.length
      ? list.map((s) => cardMarkup(s)).join("")
      : `<div class="empty">
           <strong>Nothing matched that.</strong>
           <span>Try a different word, or clear the category filters.</span>
         </div>`;
  }

  input.addEventListener("input", () => { state.query = input.value; render(); });

  filters.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter");
    if (!btn) return;
    const cat = btn.dataset.cat;
    if (!cat) state.cats.clear();
    else if (state.cats.has(cat)) state.cats.delete(cat);
    else state.cats.add(cat);

    $$(".filter", filters).forEach((b) => {
      b.classList.toggle("is-on", b.dataset.cat ? state.cats.has(b.dataset.cat) : state.cats.size === 0);
    });
    render();
  });

  select.addEventListener("change", () => { state.sort = select.value; render(); });

  results.addEventListener("click", (e) => {
    if (e.target.closest('[data-act="publish"]')) { onPublish?.(); return; }
    const card = e.target.closest(".card");
    if (!card) return;
    const script = library.find((s) => s.id === card.dataset.id);
    if (script) onOpen?.(script);
  });

  attachTilt(results, 6);
  onLibraryChange(render);
  render();

  return {
    node: root,
    focus: () => input.focus(),
    setCategory(cat) {
      state.cats.clear();
      if (cat) state.cats.add(cat);
      $$(".filter", filters).forEach((b) => {
        b.classList.toggle("is-on", b.dataset.cat ? state.cats.has(b.dataset.cat) : state.cats.size === 0);
      });
      render();
    },
    refresh: render,
  };
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
        <h1 class="hero__title">
          <span class="line">The ultimate</span>
          <span class="line">Roblox script</span>
          <span class="line accent">library</span>
        </h1>
        <p class="hero__sub">Discover, explore, and build with Roblox scripts — published by creators who get paid every time you unlock one.</p>
        <div class="hero__cta">
          <button class="btn btn--primary" data-jump="search">Explore scripts</button>
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
          <p>Filter by what it does, sort by what people actually use.</p>
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
  const board = createLeaderboard({ getRows: () => [] });
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

        <div class="wide">${captchaMarkup("publish-captcha")}</div>

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
    if (!captchaPassed(node)) return toast("Complete the human check", "warn");

    const prev = $("[data-thumb]", node);
    const script = {
      id: "s_" + Math.random().toString(36).slice(2, 10),
      title: String(d.title).trim(),
      game: String(d.game).trim(),
      category: d.category,
      desc: String(d.desc).trim(),
      code: String(d.code),
      tags: String(d.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
      keyless: d.keyless !== "no",
      thumbnail: prev?.dataset.value || prev?.dataset.auto || robloxThumb(d.place) || "",
      author: account.session.username,
      authorId: account.session.id,
      views: 0, copies: 0, likes: 0, rating: 0,
      added: new Date().toISOString().slice(0, 10),
    };

    addScript(script);
    await account.addPublish(script.id);
    form.reset();
    picker?.reset();
    captchaReset(node);
    render();
    mountPicker();
    toast("Published — it's live in the library");
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

export function buildChrome({ onJump, onSearch, onDashboard, onAuth }) {
  const nav = el("header", { class: "nav" });
  nav.innerHTML = `
    <div class="progress" role="presentation">
      <span class="progress__fill"></span>
      <span class="progress__label" data-label></span>
    </div>
    <a class="nav__brand" href="#ch-hero" data-jump="hero">
      <span class="nav__mark" aria-hidden="true"></span>
      <span>Lucrit<b>Script</b></span>
    </a>
    <nav class="nav__links" aria-label="Sections">
      <button data-jump="search">Scripts</button>
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
    if (e.target.closest(".nav__search")) onSearch();
  });

  // Fixed, always visible, survives scroll.
  const dash = el("button", { class: "dashbtn", type: "button" });
  function paintDash(session) {
    dash.innerHTML = session
      ? `<span class="avatar" style="--seed:${session.username.length * 37}">
           ${session.avatar ? `<img src="${esc(session.avatar)}" alt="">` : esc(session.username.slice(0, 2).toUpperCase())}
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
