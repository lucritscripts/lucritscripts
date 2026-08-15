// "My Scripts" — a person's own shelf.
//
// Two kinds of thing live here and they are deliberately not mixed up:
//
//   Drafts     scripts you made with the AI. Private. Nobody else can see
//              them, they are not in the library, and they never will be
//              unless you publish one.
//   Published  the ones you did publish, which are public and earning.
//
// Drafts are stored per account in the browser (see vault.js), so this page
// needs an account before it can show anything — not as a gate, but because
// there is genuinely nothing to show without one.

import { createOverlay, esc, toast } from "./pages.js";
import { account } from "./account.js";
import { drafts as myDrafts, deleteDraft, onVaultChange } from "./vault.js";

const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** "3 minutes ago", "yesterday", "12 Aug" — whichever reads best. */
function when(iso) {
  const then = new Date(iso).getTime();
  if (!then) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The first few real lines, so a card is recognisable at a glance. */
function preview(code) {
  return String(code || "")
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 3)
    .join("\n")
    .slice(0, 180);
}

export function createMyScripts({ getPublished, onContinue, onPublishDraft, onOpenScript, onGenerate, onRequireAuth }) {
  const sheet = createOverlay({ id: "mine", label: "My Scripts", wide: true });
  let tab = "drafts";

  function draftCard(d) {
    const lines = String(d.code || "").split("\n").length;
    return `
      <article class="mine__card">
        <div class="mine__top">
          <h3 class="mine__title">${esc(d.title || "Untitled script")}</h3>
          <span class="mine__meta">${lines} lines · ${esc(when(d.updatedAt))}</span>
        </div>
        ${d.prompt ? `<p class="mine__ask">${esc(d.prompt)}</p>` : ""}
        <pre class="mine__code"><code>${esc(preview(d.code))}</code></pre>
        <div class="mine__acts">
          <button class="btn btn--primary btn--sm" data-continue="${esc(d.id)}">Continue with AI</button>
          <button class="btn btn--gold btn--sm" data-publish="${esc(d.id)}">Publish</button>
          <button class="btn btn--ghost btn--sm" data-copy="${esc(d.id)}">Copy</button>
          <button class="btn btn--ghost btn--sm mine__del" data-del="${esc(d.id)}">Delete</button>
        </div>
      </article>`;
  }

  function publishedCard(s) {
    return `
      <article class="mine__card mine__card--live">
        <div class="mine__top">
          <h3 class="mine__title">${esc(s.title)}</h3>
          <span class="mine__meta mine__meta--live">Live${s.game ? ` · ${esc(s.game)}` : ""}</span>
        </div>
        <p class="mine__ask">${esc(String(s.description || "").slice(0, 160))}</p>
        <div class="mine__acts">
          <button class="btn btn--primary btn--sm" data-open="${esc(s.id)}">Open it</button>
        </div>
      </article>`;
  }

  function render() {
    if (!account.isSignedIn) {
      sheet.body.innerHTML = `
        <header class="sheet__head">
          <span class="sheet__eyebrow">My Scripts</span>
          <h2>Your own shelf</h2>
          <p>Everything you make with the AI is saved here — private, only yours,
             and you can pick any of it back up mid-conversation.</p>
        </header>
        <div class="mine__empty">
          <p>Sign in and your scripts follow you.</p>
          <button class="btn btn--primary" data-auth>Sign in or create an account</button>
        </div>`;
      return;
    }

    const list = myDrafts(account.session.id);
    const live = (getPublished?.(account.session) || []);

    sheet.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">My Scripts</span>
        <h2>Your own shelf</h2>
        <p>Drafts are private — only you can see them. Publish one and it joins
           the library.</p>
      </header>

      <div class="tabs" role="tablist">
        <button role="tab" data-tab="drafts" aria-selected="${tab === "drafts"}">
          Drafts${list.length ? ` (${list.length})` : ""}
        </button>
        <button role="tab" data-tab="published" aria-selected="${tab === "published"}">
          Published${live.length ? ` (${live.length})` : ""}
        </button>
      </div>

      ${tab === "drafts"
        ? (list.length
            ? `<div class="mine__grid">${list.map(draftCard).join("")}</div>`
            : `<div class="mine__empty">
                 <p>Nothing here yet. Make something with the AI and it lands on this shelf.</p>
                 <button class="btn btn--primary" data-generate>Create a script with AI</button>
               </div>`)
        : (live.length
            ? `<div class="mine__grid">${live.map(publishedCard).join("")}</div>`
            : `<div class="mine__empty">
                 <p>You haven't published anything yet. Any draft can go live — publishing is free.</p>
                 <button class="btn btn--primary" data-tab="drafts">See your drafts</button>
               </div>`)}`;
  }

  sheet.body.addEventListener("click", async (e) => {
    const t = (sel) => e.target.closest(sel);

    if (t("[data-auth]")) { sheet.close(); onRequireAuth?.(); return; }
    if (t("[data-generate]")) { sheet.close(); onGenerate?.(); return; }

    const tabBtn = t("[data-tab]");
    if (tabBtn) { tab = tabBtn.dataset.tab; render(); return; }

    const id = (attr) => t(`[data-${attr}]`)?.dataset[attr];

    const cont = id("continue");
    if (cont) { sheet.close(); onContinue?.(cont); return; }

    const pub = id("publish");
    if (pub) { sheet.close(); onPublishDraft?.(pub); return; }

    const open = id("open");
    if (open) { sheet.close(); onOpenScript?.(open); return; }

    const copy = id("copy");
    if (copy) {
      const d = myDrafts(account.session?.id).find((x) => x.id === copy);
      if (!d) return;
      try { await navigator.clipboard.writeText(d.code); toast("Copied"); }
      catch { toast("Couldn't copy — select it in the editor instead", "warn"); }
      return;
    }

    const del = id("del");
    if (del) {
      const btn = t("[data-del]");
      // Two-step, because a draft is not recoverable once it is gone.
      if (btn.dataset.sure !== "1") {
        btn.dataset.sure = "1";
        btn.textContent = "Really delete?";
        setTimeout(() => {
          if (!btn.isConnected) return;
          btn.dataset.sure = "0";
          btn.textContent = "Delete";
        }, 4000);
        return;
      }
      deleteDraft(account.session.id, del);
      toast("Deleted");
      render();
    }
  });

  account.onChange(() => { if (sheet.isOpen) render(); });
  onVaultChange(() => { if (sheet.isOpen) render(); });

  return {
    open(startTab = "drafts") { tab = startTab; render(); sheet.open(); },
    close: () => sheet.close(),
    refresh() { if (sheet.isOpen) render(); },
  };
}
