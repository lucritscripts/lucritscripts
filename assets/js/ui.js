// All DOM: navigation, chapters, the searchable library, the code reader,
// submission, and the scroll-linked chapter choreography.

import { SCRIPTS, CATEGORIES, SORTS, CONTRIBUTORS, categoryOf } from "./data/scripts.js";
import { renderCodeBlock } from "./engine/highlight.js";
import { BANDS } from "./engine/world.js";

/* ------------------------------------------------------------------ util */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const el = (tag, attrs = {}, html) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (html !== undefined) node.innerHTML = html;
  return node;
};

const escapeHtml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

export function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** localStorage is not available in every embedding context. */
const store = (() => {
  const mem = new Map();
  let ok = true;
  try {
    const k = "__lucrit_probe";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
  } catch { ok = false; }
  return {
    get(k) {
      try { return ok ? window.localStorage.getItem(k) : mem.get(k) ?? null; }
      catch { return mem.get(k) ?? null; }
    },
    set(k, v) {
      try { if (ok) window.localStorage.setItem(k, v); else mem.set(k, v); }
      catch { mem.set(k, v); }
    },
  };
})();

/* ------------------------------------------------------------- app state */

const library = SCRIPTS.slice();

const favourites = new Set(
  (() => { try { return JSON.parse(store.get("lucrit:favs") || "[]"); } catch { return []; } })()
);

function saveFavourites() {
  store.set("lucrit:favs", JSON.stringify(Array.from(favourites)));
}

/* ----------------------------------------------------------------- toast */

let toastNode = null;
let toastTimer = 0;

export function toast(message, tone = "ok") {
  if (!toastNode) {
    toastNode = el("div", { class: "toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastNode);
  }
  toastNode.textContent = message;
  toastNode.dataset.tone = tone;
  toastNode.classList.remove("is-in");
  void toastNode.offsetWidth;
  toastNode.classList.add("is-in");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastNode.classList.remove("is-in"), 2200);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }

  try {
    const ta = el("textarea", { class: "sr-only" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}

/* ------------------------------------------------------------ card markup */

function ratingStars(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += `<span class="star${i < full ? " is-full" : i === full && half ? " is-half" : ""}">★</span>`;
  }
  return `<span class="stars" aria-label="${rating} out of 5">${out}</span><span class="rating-num">${rating.toFixed(1)}</span>`;
}

function cardMarkup(script, { large = false } = {}) {
  const cat = categoryOf(script.category);
  return `
    <article class="card${large ? " card--lg" : ""}" data-id="${script.id}" style="--cat:${cat.accent}">
      <div class="card__glow" aria-hidden="true"></div>
      <div class="card__body">
        <div class="card__top">
          <span class="chip">${cat.label}</span>
          ${script.featured ? '<span class="chip chip--hot">Trending</span>' : ""}
        </div>
        <h3 class="card__title">${escapeHtml(script.title)}</h3>
        <p class="card__desc">${escapeHtml(script.desc)}</p>
        <div class="card__meta">
          ${ratingStars(script.rating)}
          <span class="dot" aria-hidden="true"></span>
          <span class="by">@${escapeHtml(script.author)}</span>
        </div>
        <div class="card__stats">
          <span title="Views">${fmt(script.views)} views</span>
          <span title="Copies">${fmt(script.copies)} copies</span>
        </div>
        <div class="card__actions">
          <button class="btn btn--sm" data-act="view">View script</button>
          ${large ? '<button class="btn btn--sm btn--ghost" data-act="copy">Copy code</button>' : ""}
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

  root.addEventListener("pointerleave", () => {
    $$(".card.is-tilt", root).forEach((c) => {
      c.classList.remove("is-tilt");
      c.style.removeProperty("--rx");
      c.style.removeProperty("--ry");
    });
  }, true);

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
   The library — search, filter, sort, results
   ============================================================ */

export function createLibrary({ id, compact = false, onOpen }) {
  const state = { query: "", cats: new Set(), sort: "popular" };

  const root = el("div", { class: `library${compact ? " library--compact" : ""}`, id });

  root.innerHTML = `
    <div class="library__search">
      <svg class="library__icon" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path>
      </svg>
      <input class="library__input" type="search" autocomplete="off" spellcheck="false"
             placeholder="Search scripts, systems, categories..." aria-label="Search scripts">
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
    <div class="library__results" data-native-scroll></div>
  `;

  const input = $(".library__input", root);
  const filters = $(".filters", root);
  const select = $(".sort__select", root);
  const results = $(".library__results", root);
  const count = $(".library__count", root);

  filters.appendChild(el("button", {
    class: "filter is-on", type: "button", dataset: { cat: "" },
  }, "All"));
  for (const c of CATEGORIES) {
    filters.appendChild(el("button", {
      class: "filter", type: "button", dataset: { cat: c.id },
      style: `--cat:${c.accent}`,
    }, c.label));
  }

  function matches(script) {
    if (state.cats.size && !state.cats.has(script.category)) return false;
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      script.title, script.desc, script.author, script.category,
      ...(script.tags || []),
    ].join(" ").toLowerCase();
    return q.split(/\s+/).every((term) => hay.includes(term));
  }

  function sorted(list) {
    const by = {
      popular: (a, b) => (b.copies + b.views * 0.1) - (a.copies + a.views * 0.1),
      newest: (a, b) => String(b.added).localeCompare(String(a.added)),
      rated: (a, b) => b.rating - a.rating || b.views - a.views,
      viewed: (a, b) => b.views - a.views,
    }[state.sort];
    return list.slice().sort(by);
  }

  function render() {
    const list = sorted(library.filter(matches));
    count.textContent = list.length === library.length
      ? `${list.length} scripts`
      : `${list.length} of ${library.length} scripts`;

    if (!list.length) {
      results.innerHTML = `<div class="empty">
        <strong>Nothing matched that.</strong>
        <span>Try a different word, or clear the category filters.</span>
      </div>`;
      return;
    }

    results.innerHTML = list.map((s) => cardMarkup(s)).join("");
  }

  input.addEventListener("input", () => { state.query = input.value; render(); });

  filters.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter");
    if (!btn) return;
    const cat = btn.dataset.cat;

    if (!cat) {
      state.cats.clear();
    } else if (state.cats.has(cat)) {
      state.cats.delete(cat);
    } else {
      state.cats.add(cat);
    }

    $$(".filter", filters).forEach((b) => {
      b.classList.toggle("is-on", b.dataset.cat ? state.cats.has(b.dataset.cat) : state.cats.size === 0);
    });
    render();
  });

  select.addEventListener("change", () => { state.sort = select.value; render(); });

  results.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (!card) return;
    const script = library.find((s) => s.id === card.dataset.id);
    if (!script) return;

    if (e.target.closest('[data-act="copy"]')) {
      copyText(script.code).then((ok) => toast(ok ? "COPIED TO CLIPBOARD" : "Copy blocked — select the code manually", ok ? "ok" : "warn"));
      return;
    }
    onOpen?.(script);
  });

  attachTilt(results, 6);
  render();

  return {
    node: root,
    focus: () => input.focus(),
    setQuery(q) { state.query = q; input.value = q; render(); },
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
   Script reader
   ============================================================ */

export function createReader() {
  const overlay = el("div", {
    class: "reader", role: "dialog", "aria-modal": "true",
    "aria-label": "Script detail", hidden: "",
  });

  overlay.innerHTML = `
    <div class="reader__scrim" data-close></div>
    <div class="reader__panel" data-native-scroll>
      <button class="reader__close" data-close aria-label="Close">&times;</button>
      <header class="reader__head">
        <div class="reader__chips"></div>
        <h2 class="reader__title"></h2>
        <p class="reader__desc"></p>
        <div class="reader__meta"></div>
      </header>
      <div class="reader__toolbar">
        <button class="btn" data-act="copy">Copy code</button>
        <button class="btn btn--ghost" data-act="raw">Open raw</button>
        <button class="btn btn--ghost" data-act="fav">Favourite</button>
        <button class="btn btn--ghost" data-act="report">Report</button>
      </div>
      <div class="reader__code"></div>
    </div>
  `;

  document.body.appendChild(overlay);

  let current = null;
  let lastFocus = null;
  let rawUrl = null;

  function close() {
    overlay.hidden = true;
    document.documentElement.classList.remove("is-locked");
    if (rawUrl) { URL.revokeObjectURL(rawUrl); rawUrl = null; }
    lastFocus?.focus?.();
    current = null;
  }

  function syncFav() {
    const btn = $('[data-act="fav"]', overlay);
    const on = current && favourites.has(current.id);
    btn.classList.toggle("is-on", Boolean(on));
    btn.textContent = on ? "Favourited" : "Favourite";
  }

  function open(script) {
    current = script;
    lastFocus = document.activeElement;
    const cat = categoryOf(script.category);

    $(".reader__chips", overlay).innerHTML =
      `<span class="chip" style="--cat:${cat.accent}">${cat.label}</span>` +
      (script.tags || []).map((t) => `<span class="chip chip--soft">${escapeHtml(t)}</span>`).join("");

    $(".reader__title", overlay).textContent = script.title;
    $(".reader__desc", overlay).textContent = script.desc;
    $(".reader__meta", overlay).innerHTML = `
      ${ratingStars(script.rating)}
      <span class="dot"></span><span class="by">@${escapeHtml(script.author)}</span>
      <span class="dot"></span><span>${fmt(script.views)} views</span>
      <span class="dot"></span><span>${fmt(script.copies)} copies</span>
      <span class="dot"></span><span>${escapeHtml(script.added)}</span>
    `;

    $(".reader__code", overlay).innerHTML = renderCodeBlock(script.code);

    overlay.style.setProperty("--cat", cat.accent);
    overlay.hidden = false;
    document.documentElement.classList.add("is-locked");
    $(".reader__panel", overlay).scrollTop = 0;
    syncFav();
    $(".reader__close", overlay).focus();
  }

  overlay.addEventListener("click", async (e) => {
    if (e.target.closest("[data-close]")) { close(); return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act || !current) return;

    if (act === "copy") {
      const ok = await copyText(current.code);
      toast(ok ? "COPIED TO CLIPBOARD" : "Copy blocked — select the code manually", ok ? "ok" : "warn");
      const btn = e.target.closest("[data-act]");
      btn.classList.add("is-flash");
      setTimeout(() => btn.classList.remove("is-flash"), 700);
    }

    if (act === "raw") {
      if (rawUrl) URL.revokeObjectURL(rawUrl);
      rawUrl = URL.createObjectURL(new Blob([current.code], { type: "text/plain;charset=utf-8" }));
      window.open(rawUrl, "_blank", "noopener");
    }

    if (act === "fav") {
      if (favourites.has(current.id)) favourites.delete(current.id);
      else favourites.add(current.id);
      saveFavourites();
      syncFav();
      toast(favourites.has(current.id) ? "Added to favourites" : "Removed from favourites");
    }

    if (act === "report") {
      toast("Report sent to moderators", "warn");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !overlay.hidden) close();
  });

  return { open, close, get isOpen() { return !overlay.hidden; } };
}

/* ============================================================
   Chapters
   ============================================================ */

const CHAPTERS = [
  { key: "hero",       label: "Origin",     len: 170 },
  { key: "universe",   label: "The Library",len: 213 },
  { key: "search",     label: "Search",     len: 190 },
  { key: "vault",      label: "The Vault",  len: 321 },
  { key: "categories", label: "Worlds",     len: 381 },
  { key: "featured",   label: "Trending",   len: 213 },
  { key: "community",  label: "Community",  len: 213 },
  { key: "submit",     label: "Submit",     len: 128 },
  { key: "finale",     label: "Begin",      len: 128 },
];

const CATEGORY_WORLDS = [
  { id: "combat",    title: "Combat",    blurb: "Server-authoritative damage, hitboxes and weapon state — built so the client can’t lie about a hit." },
  { id: "npc",       title: "NPC",       blurb: "Pathfinding that survives real geometry, aggro state machines and ambient life for your world." },
  { id: "ui",        title: "UI",        blurb: "Dialogue, toasts, hotbars and draggable windows — interface work you’d otherwise rewrite every project." },
  { id: "data",      title: "Data",      blurb: "Session-locked saves, retries with backoff, autosave and a shutdown path that doesn’t lose progress." },
  { id: "shops",     title: "Shops",     blurb: "Economy flows where the server owns the price, the stock and the receipt." },
  { id: "utilities", title: "Utilities", blurb: "Signals, cleanup, rate limiting — the unglamorous modules every codebase ends up needing." },
];

export function buildChapters({ library: mainLibrary, onOpenScript, onJump }) {
  const content = el("main", { id: "content" });

  const chapter = (key, label, len, inner, extra = "") => `
    <section class="chapter" id="ch-${key}" data-chapter="${key}" style="--len:${len}">
      <div class="chapter__inner">
        <div class="chapter__stage ${extra}">
          <span class="chapter__tag" aria-hidden="true">${label}</span>
          ${inner}
        </div>
      </div>
    </section>`;

  content.innerHTML = [
    /* --- hero --- */
    chapter("hero", "01 / Origin", CHAPTERS[0].len, `
      <div class="hero">
        <h1 class="hero__title">
          <span class="line">The ultimate</span>
          <span class="line">Roblox script</span>
          <span class="line accent">library</span>
        </h1>
        <p class="hero__sub">Discover, explore, and build with thousands of Roblox scripts.</p>
        <div class="hero__cta">
          <button class="btn btn--primary" data-jump="search">Explore scripts</button>
          <button class="btn btn--ghost" data-jump="submit">Submit a script</button>
        </div>
      </div>
      <div class="scrollcue" aria-hidden="true">
        <span>Scroll to explore</span>
        <svg viewBox="0 0 24 24"><path d="M12 4v14M6 13l6 6 6-6"/></svg>
      </div>
    `),

    /* --- universe --- */
    chapter("universe", "02 / The Library", CHAPTERS[1].len, `
      <div class="statement">
        <h2 class="statement__title">Every script.<br>One place.</h2>
        <p class="statement__sub">Search a growing library of scripts built for Roblox creators — read the source before you ever paste it.</p>
        <div class="statement__stats">
          <div><strong>${library.length}</strong><span>scripts</span></div>
          <div><strong>${CATEGORIES.length}</strong><span>categories</span></div>
          <div><strong>${fmt(library.reduce((a, s) => a + s.views, 0))}</strong><span>views</span></div>
        </div>
      </div>
    `),

    /* --- search --- */
    chapter("search", "03 / Search", CHAPTERS[2].len, `
      <div class="panel panel--wide" id="search-mount">
        <header class="panel__head">
          <h2>Find a script</h2>
          <p>Filter by what it does, sort by what people actually use.</p>
        </header>
      </div>
    `),

    /* --- vault --- */
    chapter("vault", "04 / The Vault", CHAPTERS[3].len, `
      <div class="vault">
        <header class="vault__head">
          <h2>The vault</h2>
          <p>Every module, open and readable. No paste-and-pray.</p>
        </header>
        <div class="vault__grid"></div>
      </div>
    `),

    /* --- categories --- */
    chapter("categories", "05 / Worlds", CHAPTERS[4].len, `
      <div class="worlds">
        <div class="worlds__rail" aria-hidden="true"></div>
        <div class="worlds__stage"></div>
      </div>
    `),

    /* --- featured --- */
    chapter("featured", "06 / Trending", CHAPTERS[5].len, `
      <div class="featured">
        <header class="featured__head">
          <h2>Trending this week</h2>
          <p>The modules being copied the most right now.</p>
        </header>
        <div class="featured__grid"></div>
      </div>
    `),

    /* --- community --- */
    chapter("community", "07 / Community", CHAPTERS[6].len, `
      <div class="community">
        <header class="community__head"><h2>The community</h2>
          <p>Built and maintained in the open by the people using it.</p></header>
        <div class="community__people"></div>
        <div class="community__cols">
          <div><h3>Recently added</h3><div class="minilist" data-list="recent"></div></div>
          <div><h3>Most popular</h3><div class="minilist" data-list="popular"></div></div>
        </div>
      </div>
    `),

    /* --- submit --- */
    chapter("submit", "08 / Submit", CHAPTERS[7].len, `
      <div class="submit">
        <header class="submit__head"><h2>Submit a script</h2>
          <p>Share a module. It appears in the library exactly as previewed.</p></header>
        <form class="submit__form" novalidate>
          <label>Script name<input name="title" required maxlength="60" placeholder="Inventory System"></label>
          <label>Category
            <select name="category">${CATEGORIES.map((c) => `<option value="${c.id}">${c.label}</option>`).join("")}</select>
          </label>
          <label class="wide">Description<textarea name="desc" rows="1" maxlength="180" placeholder="What it does, and what makes it different."></textarea></label>
          <label>Author<input name="author" maxlength="24" placeholder="yourname"></label>
          <label>Tags<input name="tags" maxlength="60" placeholder="inventory, stacks"></label>
          <label class="wide">Luau code<textarea name="code" rows="4" spellcheck="false" placeholder="--!strict&#10;local Module = {}&#10;return Module"></textarea></label>
          <div class="submit__actions">
            <button class="btn btn--primary" type="submit">Publish to library</button>
            <span class="submit__note">Stays in your session — no account, nothing sent anywhere.</span>
          </div>
        </form>
        <aside class="submit__preview">
          <span class="submit__previewlabel">Live preview</span>
          <div class="submit__card"></div>
        </aside>
      </div>
    `),

    /* --- finale --- */
    chapter("finale", "09 / Begin", CHAPTERS[8].len, `
      <div class="finale">
        <h2 class="finale__title">Build something great.</h2>
        <p class="finale__sub">Your next Roblox game starts here.</p>
        <div class="finale__cta">
          <button class="btn btn--primary" data-jump="search">Explore the library</button>
          <button class="btn btn--ghost" data-jump="submit">Submit a script</button>
        </div>
      </div>
    `),
  ].join("");

  document.body.appendChild(content);

  /* ---- mount the in-flow library ---- */
  $("#search-mount", content).appendChild(mainLibrary.node);

  /* ---- vault grid ---- */
  const vaultPicks = library.slice().sort((a, b) => b.copies - a.copies).slice(0, 8);
  $(".vault__grid", content).innerHTML = vaultPicks.map((s) => cardMarkup(s)).join("");

  /* ---- featured ---- */
  const featured = library.filter((s) => s.featured).slice(0, 6);
  $(".featured__grid", content).innerHTML = featured.map((s) => cardMarkup(s, { large: true })).join("");

  /* ---- category worlds ---- */
  const rail = $(".worlds__rail", content);
  const stage = $(".worlds__stage", content);
  rail.innerHTML = CATEGORY_WORLDS.map((w, i) => `<span data-i="${i}">${w.title}</span>`).join("");
  stage.innerHTML = CATEGORY_WORLDS.map((w, i) => {
    const cat = categoryOf(w.id);
    const n = library.filter((s) => s.category === w.id).length;
    return `<div class="world" data-i="${i}" style="--cat:${cat.accent}">
      <span class="world__idx">0${i + 1}</span>
      <h3>${w.title}</h3>
      <p>${w.blurb}</p>
      <button class="btn btn--sm btn--ghost" data-world="${w.id}">Browse ${n} ${n === 1 ? "script" : "scripts"}</button>
    </div>`;
  }).join("");

  /* ---- community ---- */
  $(".community__people", content).innerHTML = CONTRIBUTORS.map((c) => `
    <div class="person">
      <span class="person__avatar" style="--h:${c.hue}">${c.user.slice(0, 2).toUpperCase()}</span>
      <span class="person__name">@${escapeHtml(c.user)}</span>
      <span class="person__stats">${c.scripts} scripts · ${fmt(c.views)} views</span>
      <span class="person__rep">${fmt(c.rep)} rep</span>
    </div>`).join("");

  const mini = (list) => list.map((s) => `
    <button class="mini" data-id="${s.id}">
      <span class="mini__title">${escapeHtml(s.title)}</span>
      <span class="mini__cat">${categoryOf(s.category).label}</span>
      <span class="mini__stat">${fmt(s.views)}</span>
    </button>`).join("");

  $('[data-list="recent"]', content).innerHTML =
    mini(library.slice().sort((a, b) => String(b.added).localeCompare(String(a.added))).slice(0, 6));
  $('[data-list="popular"]', content).innerHTML =
    mini(library.slice().sort((a, b) => b.copies - a.copies).slice(0, 6));

  /* ---- interactions ---- */
  content.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-jump]");
    if (jump) { onJump(jump.dataset.jump); return; }

    const world = e.target.closest("[data-world]");
    if (world) {
      mainLibrary.setCategory(world.dataset.world);
      onJump("search");
      return;
    }

    const miniBtn = e.target.closest(".mini");
    if (miniBtn) {
      const s = library.find((x) => x.id === miniBtn.dataset.id);
      if (s) onOpenScript(s);
      return;
    }

    const card = e.target.closest(".card");
    if (card && !e.target.closest(".library__results")) {
      const s = library.find((x) => x.id === card.dataset.id);
      if (!s) return;
      if (e.target.closest('[data-act="copy"]')) {
        copyText(s.code).then((ok) => toast(ok ? "COPIED TO CLIPBOARD" : "Copy blocked — select the code manually", ok ? "ok" : "warn"));
        return;
      }
      onOpenScript(s);
    }
  });

  attachTilt($(".vault__grid", content), 9);
  attachTilt($(".featured__grid", content), 7);

  /* ---- submit form ---- */
  const form = $(".submit__form", content);
  const preview = $(".submit__card", content);

  function draft() {
    const d = new FormData(form);
    return {
      id: "user-" + Math.random().toString(36).slice(2, 8),
      title: (d.get("title") || "Untitled script").toString().trim() || "Untitled script",
      category: (d.get("category") || "other").toString(),
      desc: (d.get("desc") || "No description yet.").toString().trim() || "No description yet.",
      author: (d.get("author") || "you").toString().trim() || "you",
      tags: (d.get("tags") || "").toString().split(",").map((t) => t.trim()).filter(Boolean).slice(0, 4),
      code: (d.get("code") || "").toString(),
      rating: 5.0, views: 0, copies: 0,
      added: new Date().toISOString().slice(0, 10),
    };
  }

  function paint() { preview.innerHTML = cardMarkup(draft()); }
  form.addEventListener("input", paint);
  paint();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const d = draft();
    if (!d.code.trim()) { toast("Add some Luau before publishing", "warn"); return; }
    library.unshift(d);
    mainLibrary.refresh();
    form.reset();
    paint();
    toast("Published to your library");
  });

  return { content, chapters: CHAPTERS };
}

/* ============================================================
   Navigation + progress rail
   ============================================================ */

export function buildChrome({ onJump, onSearch }) {
  const nav = el("header", { class: "nav" });
  nav.innerHTML = `
    <a class="nav__brand" href="#ch-hero" data-jump="hero">
      <span class="nav__mark" aria-hidden="true"></span>
      <span>Lucrit<b>Script</b></span>
    </a>
    <nav class="nav__links" aria-label="Sections">
      <button data-jump="search">Scripts</button>
      <button data-jump="categories">Categories</button>
      <button data-jump="featured">Trending</button>
      <button data-jump="community">Community</button>
      <button data-jump="submit">Submit</button>
    </nav>
    <button class="nav__search" aria-label="Search scripts">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>
    </button>
  `;
  document.body.appendChild(nav);

  nav.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-jump]");
    if (jump) { e.preventDefault(); onJump(jump.dataset.jump); return; }
    if (e.target.closest(".nav__search")) onSearch();
  });

  const rail = el("aside", { class: "rail", "aria-label": "Progress" });
  rail.innerHTML = `
    <div class="rail__track"><span class="rail__fill"></span></div>
    <ol class="rail__list">
      ${CHAPTERS.map((c) => `<li><button data-jump="${c.key}"><span class="rail__dot"></span><span class="rail__label">${c.label}</span></button></li>`).join("")}
    </ol>`;
  document.body.appendChild(rail);

  rail.addEventListener("click", (e) => {
    const jump = e.target.closest("[data-jump]");
    if (jump) onJump(jump.dataset.jump);
  });

  return {
    nav,
    rail,
    update(progress, activeIndex) {
      $(".rail__fill", rail).style.transform = `scaleY(${progress})`;
      $$(".rail__list li", rail).forEach((li, i) => li.classList.toggle("is-on", i === activeIndex));
      nav.classList.toggle("is-scrolled", progress > 0.005);
      $$(".nav__links button", nav).forEach((b) => {
        b.classList.toggle("is-on", b.dataset.jump === CHAPTERS[activeIndex]?.key);
      });
    },
  };
}

/* ============================================================
   Scroll choreography — ties DOM chapters to the camera bands
   ============================================================ */

export function createChoreography({ chrome, onCategoryIndex }) {
  const sections = $$(".chapter").map((node) => ({
    node,
    key: node.dataset.chapter,
    stage: $(".chapter__stage", node),
    band: BANDS[node.dataset.chapter],   // canonical band the camera path uses
    a: 0, b: 1,                          // measured from real layout
  }));

  const cue = $(".scrollcue");
  const worlds = $$(".world");
  const railItems = $$(".worlds__rail span");
  let lastWorld = -1;

  /**
   * Scroll progress is scrollY / (docHeight - viewportHeight), but a section
   * reaches the top of the viewport at offsetTop / (docHeight - viewportHeight).
   * Deriving the bands from real layout keeps the DOM and the camera in step;
   * hard-coded fractions drift by a whole viewport by the end of the page.
   */
  function measure() {
    const vh = window.innerHeight;
    const max = Math.max(1, document.documentElement.scrollHeight - vh);
    for (const s of sections) {
      s.a = clamp01(s.node.offsetTop / max);
      s.b = clamp01((s.node.offsetTop + s.node.offsetHeight) / max);
    }
    void vh;
  }

  measure();
  window.addEventListener("resize", measure, { passive: true });
  window.addEventListener("load", measure, { passive: true });

  /** Scroll progress -> the canonical progress the camera path expects. */
  function toCameraProgress(p) {
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      if (p <= s.b || i === sections.length - 1) {
        const span = Math.max(1e-6, s.b - s.a);
        const local = clamp01((p - s.a) / span);
        return s.band[0] + local * (s.band[1] - s.band[0]);
      }
    }
    return p;
  }

  /** Where to scroll so a chapter's content sits fully readable. */
  function targetFor(key) {
    const i = sections.findIndex((x) => x.key === key);
    if (i < 0) return 0;
    // The opening chapter belongs at the very top — landing mid-band would
    // put the camera past the hero object.
    if (i === 0) return 0;
    return sections[i].a + (sections[i].b - sections[i].a) * 0.45;
  }

  function update(progress) {
    let active = 0;

    sections.forEach((s, i) => {
      const span = Math.max(1e-6, s.b - s.a);
      const local = clamp01((progress - s.a) / span);
      const inView = progress >= s.a - 0.02 && progress <= s.b + 0.02;
      if (progress >= s.a && progress < s.b) active = i;

      // Fade in, hold, then fade out — all inside the sticky pinned window,
      // because past it the chapter slides out of the viewport on its own.
      const isFirst = i === 0;
      const isLast = i === sections.length - 1;
      const fadeIn = isFirst ? 1 : clamp01(local / 0.22);
      const fadeOut = isLast ? 1 : 1 - clamp01((local - 0.78) / 0.22);
      const vis = Math.min(fadeIn, fadeOut);

      s.stage.style.opacity = vis.toFixed(3);
      s.stage.style.transform =
        `translate3d(0, ${((1 - fadeIn) * 34 - (1 - fadeOut) * 26).toFixed(2)}px, 0)`;
      s.stage.style.pointerEvents = vis > 0.35 ? "auto" : "none";
      s.node.classList.toggle("is-live", inView);

      // A chapter that scrolled internally (focus, scrollIntoView) must not
      // stay stuck part-way when the camera comes back to it.
      if (!inView && s.stage.scrollTop !== 0) s.stage.scrollTop = 0;
    });

    if (cue) cue.style.opacity = String(clamp01(1 - progress / 0.015));

    // Category worlds cross-fade as the camera flies through them.
    const cat = sections.find((s) => s.key === "categories");
    if (cat && progress >= cat.a && progress <= cat.b) {
      const t = clamp01((progress - cat.a) / Math.max(1e-6, cat.b - cat.a));
      const idx = Math.min(CATEGORY_WORLDS.length - 1, Math.floor(t * CATEGORY_WORLDS.length));
      const inner = t * CATEGORY_WORLDS.length - idx;
      worlds.forEach((w, i) => {
        const on = i === idx;
        w.classList.toggle("is-on", on);
        w.style.opacity = on
          ? String(clamp01(Math.min(inner / 0.16, (1 - inner) / 0.16)))
          : "0";
      });
      railItems.forEach((r, i) => r.classList.toggle("is-on", i === idx));
      if (idx !== lastWorld) { lastWorld = idx; onCategoryIndex?.(idx); }
    } else {
      worlds.forEach((w) => { w.style.opacity = "0"; w.classList.remove("is-on"); });
    }

    chrome.update(progress, active);
  }

  return { update, targetFor, toCameraProgress, measure };
}

export { CHAPTERS, library, cardMarkup, copyText };
