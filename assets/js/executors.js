// Executors: /executors and /executors/<slug>
//
// This is the reader's half of a feature whose writer's half already existed.
// The backend has had executors for a while — a table, a public list, a public
// get, and three admin-only writes — and `/executors` was already in the
// Worker's APP_ROUTES, so the path served the app shell. But the shell had no
// handler for it, so the router filed it under `unknown` and quietly drew the
// home page. A link posted in #executors landed people on the front page and
// looked like the site had eaten the link.
//
// Two things this page is deliberately NOT:
//
// 1. It is not a publish surface. There is no form here, no "add executor"
//    button, no admin branch. Publishing is admin-only and enforced by
//    `requireAdmin` on every write route in the Worker — and the whole point
//    of enforcing it there is that the UI does not have to be trusted to hide
//    anything. Adding a hidden form here would not weaken that check, but it
//    would put the belt next to the braces and invite someone later to move
//    the check into the belt.
//
// 2. It is not a download host. Every outbound link goes through `safeHref`
//    and was already pinned to a known host list when it was stored, because
//    a world-readable listing with a big button on it is the single most
//    attractive place on this site to park a hostile URL.

import { createOverlay, esc, toast } from "./pages.js";
import { safeHref, safeImageSrc } from "./safe.js";
import { fetchExecutors, fetchExecutor } from "./library-api.js";
import { pathForExecutor, setTitle } from "./router.js";

// Mirrors EXECUTOR_STATUS / STATUS_LABEL in _worker.js. The server is the
// authority on which values exist; this is only how they read on screen.
const STATUS = {
  working:     { label: "Working",     chip: "chip--ok",   dot: "🟢" },
  updating:    { label: "Updating",    chip: "chip--warn", dot: "🟡" },
  unavailable: { label: "Unavailable", chip: "chip--hot",  dot: "🔴" },
};

const FILTERS = [
  ["",            "All"],
  ["working",     "Working"],
  ["updating",    "Updating"],
  ["unavailable", "Unavailable"],
];

function statusChip(status) {
  const s = STATUS[status] || { label: status || "Unknown", chip: "chip--soft", dot: "" };
  return `<span class="chip ${s.chip}">${s.dot ? s.dot + " " : ""}${esc(s.label)}</span>`;
}

function logo(x) {
  const src = safeImageSrc(x.logo || "");
  return src
    ? `<img class="xcard__logo" src="${esc(src)}" alt="" loading="lazy" decoding="async">`
    : `<span class="xcard__logo xcard__logo--none" aria-hidden="true">${esc((x.name || "?").slice(0, 2).toUpperCase())}</span>`;
}

/** One row in the listing. An anchor, so middle-click and "copy link" work. */
function cardMarkup(x) {
  return `
    <a class="xcard" href="${esc(pathForExecutor(x))}" data-slug="${esc(x.slug)}">
      ${logo(x)}
      <span class="xcard__body">
        <span class="xcard__top">
          <b class="xcard__name">${esc(x.name)}</b>
          ${statusChip(x.status)}
        </span>
        <span class="xcard__dev">by ${esc(x.developer)}${x.version ? ` · v${esc(x.version)}` : ""}</span>
        <span class="xcard__desc">${esc(x.desc || "")}</span>
        ${x.platforms?.length
          ? `<span class="chips">${x.platforms.map((p) => `<span class="chip chip--soft">${esc(p)}</span>`).join("")}</span>`
          : ""}
      </span>
    </a>`;
}

/**
 * No callbacks. Every navigable thing on this page is a real anchor with a
 * real href, and the router's capture-phase click listener turns those into
 * pushState navigation for free. There is nothing for this module to hand
 * back up.
 */
export function createExecutorsPage() {
  const sheet = createOverlay({ id: "executors", label: "Executors", wide: true });

  // Cached across opens so switching filters and stepping in and out of a
  // detail view does not refetch the same 200 rows every time. Invalidated
  // by nothing: this list changes when staff publish, which is rare, and a
  // reload is a page load.
  let all = null;
  let filter = "";

  async function load() {
    if (all) return all;
    all = await fetchExecutors();
    return all;
  }

  function visible() {
    return filter ? (all || []).filter((x) => x.status === filter) : (all || []);
  }

  function renderList() {
    const rows = visible();
    sheet.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">Executors</span>
        <h2>Roblox executors</h2>
        <p>Published and kept current by staff. Statuses are updated as they change —
           check here before you download anything.</p>
      </header>

      <div class="filters">
        <div class="segmented" role="tablist" aria-label="Filter by status">
          ${FILTERS.map(([v, label]) =>
            `<button role="tab" data-filter="${v}" aria-selected="${v === filter}"
                     class="${v === filter ? "is-on" : ""}">${label}</button>`).join("")}
        </div>
      </div>

      ${rows.length
        ? `<div class="xlist">${rows.map(cardMarkup).join("")}</div>`
        : `<div class="empty"><p>${all?.length
             ? "Nothing with that status right now."
             : "No executors are listed yet."}</p></div>`}

      <p class="note">Lucrit Scripts lists these for reference. We don't build them and
         we can't vouch for anything you download from a third party.</p>`;
  }

  function renderMissing(slug) {
    sheet.body.innerHTML = `
      <div class="empty empty--lg">
        <h2>No executor called “${esc(slug)}”</h2>
        <p>It may have been taken down, or the link may be wrong.</p>
        <a class="btn btn--primary" href="/executors">All executors</a>
      </div>`;
  }

  function renderOne(x) {
    const shots = (x.screenshots || []).map(safeImageSrc).filter(Boolean);
    const site = safeHref(x.website || "");
    const chat = safeHref(x.discord || "");

    sheet.body.innerHTML = `
      <a class="gamehead__back" href="/executors">&larr; All executors</a>

      <header class="dash__head">
        ${logo(x)}
        <div class="dash__who">
          <span class="sheet__eyebrow">Executor</span>
          <h2>${esc(x.name)}</h2>
          <p>by ${esc(x.developer)}</p>
          <div class="chips">
            ${statusChip(x.status)}
            ${x.version ? `<span class="chip chip--soft">v${esc(x.version)}</span>` : ""}
            ${(x.tags || []).map((t) => `<span class="chip chip--soft">${esc(t)}</span>`).join("")}
          </div>
        </div>
        <button class="btn btn--ghost btn--sm" data-act="share">Copy link</button>
      </header>

      ${x.status === "unavailable"
        ? `<p class="callout">This executor is listed as unavailable. Downloads from it may
             not work, and links found elsewhere claiming otherwise are not from us.</p>`
        : ""}

      <div class="stats">
        <div class="stat"><span class="stat__l">Status</span><span class="stat__v" style="font-size:1.1rem">${esc(STATUS[x.status]?.label || x.status || "—")}</span></div>
        <div class="stat"><span class="stat__l">Platforms</span><span class="stat__v" style="font-size:1.1rem">${esc((x.platforms || []).join(", ") || "—")}</span></div>
        <div class="stat"><span class="stat__l">Roblox</span><span class="stat__v" style="font-size:1.1rem">${esc(x.robloxVersions || "—")}</span></div>
        <div class="stat"><span class="stat__l">Updated</span><span class="stat__v" style="font-size:1.1rem">${esc(x.updated || "—")}</span></div>
      </div>

      <section class="pane">
        <div class="pane__head"><h3>About</h3></div>
        <div class="script__desc">${esc(x.desc || "").split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("")}</div>
      </section>

      ${shots.length
        ? `<section class="pane">
             <div class="pane__head"><h3>Screenshots</h3></div>
             <div class="xshots">${shots.map((s) =>
               `<img src="${esc(s)}" alt="" loading="lazy" decoding="async">`).join("")}</div>
           </section>`
        : ""}

      <div class="script__toolbar">
        ${site ? `<a class="btn btn--primary" href="${esc(site)}" target="_blank" rel="noopener nofollow">Official site</a>` : ""}
        ${chat ? `<a class="btn btn--discord" href="${esc(chat)}" target="_blank" rel="noopener nofollow">Their Discord</a>` : ""}
      </div>

      <p class="note">These links go to the developer, not to us. Lucrit Scripts does not
         host executor downloads and cannot vouch for third-party files.</p>`;
  }

  sheet.body.addEventListener("click", async (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) {
      filter = f.dataset.filter;
      renderList();
      return;
    }

    if (e.target.closest('[data-act="share"]')) {
      const { copyText } = await import("./pages.js");
      const link = location.origin + location.pathname;
      toast(await copyText(link) ? "Link copied" : link, "ok");
      return;
    }

    // Cards and the back link are anchors, and the router's capture-phase
    // listener already turns them into navigation. Nothing to do here.
  });

  return {
    /** The listing at /executors. */
    async openList() {
      setTitle("Executors");
      const cached = all;
      if (cached) { renderList(); sheet.open(); }
      else {
        sheet.open(`<div class="empty empty--lg"><p class="script__loading">Loading executors…</p></div>`);
        await load();
        if (!sheet.isOpen) return;
        renderList();
      }
    },

    /**
     * One executor at /executors/<slug>.
     *
     * The cached list is checked first so stepping in from the listing is
     * instant, and the server is asked otherwise — a link pasted into Discord
     * has to work on a cold tab with no listing loaded.
     */
    async open(slug) {
      sheet.open(`<div class="empty empty--lg"><p class="script__loading">Loading…</p></div>`);
      setTitle("Executor");

      const known = (all || []).find((x) => x.slug === slug);
      const x = known || await fetchExecutor(slug);
      if (!sheet.isOpen) return null;

      if (!x) { renderMissing(slug); return null; }
      renderOne(x);
      setTitle(x.name);
      return x;
    },

    close: () => sheet.close(),
    get isOpen() { return sheet.isOpen; },
  };
}
