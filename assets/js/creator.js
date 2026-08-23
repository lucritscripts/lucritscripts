// A creator's public page: /creators/<name>
//
// Before this, "who wrote this" was a name printed on a card and nothing more.
// There was no way to see the rest of somebody's work, and no address to send
// anyone to. A publisher had a dashboard only they could see and no public
// face at all.
//
// This is the public half of that pair, and the split matters: the dashboard
// carries earnings, drafts, saved scripts, email and security settings, none
// of which belong on a page anyone can open. What is here is only what the
// server puts in /api/creators/<name> — and that endpoint deliberately does
// not select the email column.

import { createOverlay, esc, fmt, toast } from "./pages.js";
import { safeHref, safeImageSrc } from "./safe.js";
import { fetchCreator } from "./library-api.js";
import { cardMarkup } from "./ui.js";
import { pathForCreator, setTitle } from "./router.js";

/**
 * @param onOpenScript  a card was clicked
 * @param onCorrectName the stored spelling differs from the one in the URL,
 *                      or the visitor is the creator and belongs on their own
 *                      dashboard — the router decides what to do about it
 */
export function createCreatorPage({ onOpenScript, onCorrectName, onOpenDashboard }) {
  const sheet = createOverlay({ id: "creator", label: "Creator", wide: true });
  let current = null;

  function joined(iso) {
    const d = new Date(iso || Date.now());
    return Number.isNaN(d.getTime())
      ? ""
      : d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }

  function statCard(label, value) {
    return `<div class="stat"><span class="stat__l">${label}</span><span class="stat__v">${fmt(value)}</span></div>`;
  }

  function renderMissing(name) {
    sheet.body.innerHTML = `
      <div class="empty empty--lg">
        <h2>No creator called “${esc(name)}”</h2>
        <p>The name may have changed, or the account may no longer be on the site.</p>
        <a class="btn btn--primary" href="/">Back to the library</a>
      </div>`;
  }

  function render(profile) {
    const t = profile.totals || {};
    const scripts = profile.scripts || [];

    sheet.body.innerHTML = `
      <header class="dash__head">
        <span class="avatar avatar--lg" style="--seed:${profile.username.length * 37}">
          ${profile.avatar
            ? `<img src="${esc(safeImageSrc(profile.avatar))}" alt="">`
            : esc(profile.username.slice(0, 2).toUpperCase())}
        </span>
        <div class="dash__who">
          <span class="sheet__eyebrow">Creator</span>
          <h2>@${esc(profile.username)}</h2>
          <p>${profile.bio ? esc(profile.bio) : "This creator hasn’t written a bio yet."}</p>
          <div class="dash__links">
            ${joined(profile.createdAt) ? `<span class="dash__meta">Joined ${joined(profile.createdAt)}</span>` : ""}
            ${profile.youtube ? `<a href="${esc(safeHref(profile.youtube))}" target="_blank" rel="noopener nofollow" class="sociallink">YouTube</a>` : ""}
            ${profile.tiktok ? `<a href="${esc(safeHref(profile.tiktok))}" target="_blank" rel="noopener nofollow" class="sociallink">TikTok</a>` : ""}
          </div>
        </div>
        ${profile.mine
          ? `<button class="btn btn--ghost btn--sm" data-act="dashboard">Your dashboard</button>`
          : `<button class="btn btn--ghost btn--sm" data-act="share">Copy link</button>`}
      </header>

      <div class="stats">
        ${statCard("Scripts", t.scripts || 0)}
        ${statCard("Views", t.views || 0)}
        ${statCard("Copies", t.copies || 0)}
        ${statCard("Likes", t.likes || 0)}
      </div>

      <section class="pane">
        <div class="pane__head"><h3>Published</h3></div>
        ${scripts.length
          ? `<div class="grid">${scripts.map((s) => cardMarkup(s)).join("")}</div>`
          : `<div class="empty"><p>Nothing published yet.</p></div>`}
      </section>`;
  }

  sheet.body.addEventListener("click", async (e) => {
    if (e.target.closest("[data-heart]")) return;   // the shelf owns that one

    if (e.target.closest('[data-act="dashboard"]')) {
      sheet.close();
      onOpenDashboard?.();
      return;
    }

    if (e.target.closest('[data-act="share"]')) {
      const link = location.origin + pathForCreator(current?.username || "");
      const { copyText } = await import("./pages.js");
      toast(await copyText(link) ? "Link copied" : link, "ok");
      return;
    }

    const card = e.target.closest(".card[data-id]");
    if (!card) return;
    const script = (current?.scripts || []).find((s) => s.id === card.dataset.id);
    if (script) onOpenScript?.(script);
  });

  return {
    /**
     * Opens by name, which is what a URL carries.
     *
     * The sheet goes up immediately with a loading state rather than after the
     * fetch: a deep link should show something belonging to this page within a
     * frame, not the home page for half a second and then this.
     */
    async open(name) {
      current = null;
      sheet.open(`<div class="empty empty--lg"><p class="script__loading">Loading @${esc(name)}…</p></div>`);
      setTitle(`@${name}`);

      const profile = await fetchCreator(name);
      if (!sheet.isOpen) return null;         // they closed it while we waited

      if (!profile) { renderMissing(name); setTitle(`@${name}`); return null; }

      current = profile;
      render(profile);
      setTitle(`@${profile.username}`);

      // /creators/lucrit and /creators/LUCRIT both resolve; the address bar
      // should end up showing the spelling the creator actually chose.
      if (profile.username !== name) onCorrectName?.(profile.username);
      return profile;
    },
    close: () => sheet.close(),
    get isOpen() { return sheet.isOpen; },
    /** The shelf repaints hearts across every surface, this one included. */
    refresh() { if (sheet.isOpen && current) render(current); },
  };
}
