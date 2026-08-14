// Overlay pages: auth, dashboard, the monetization info tab, and the
// script page with the Linkvertise / Lootlabs unlock.
//
// These are overlays rather than chapters so the scroll-driven camera path
// stays untouched.

import { account, STAT_WINDOWS } from "./account.js";
import * as stats from "./stats.js";
import { CATEGORIES, BOARDS, categoryOf } from "./data/scripts.js";
import { renderCodeBlock } from "./engine/highlight.js";

/* ------------------------------------------------------------------ util */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

import { safeHref, safeImageSrc } from "./safe.js";
import { drafts as myDrafts, deleteDraft, savedIds } from "./vault.js";

export const esc = (s) => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

export function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "K";
  return String(n);
}

function el(tag, attrs = {}, html) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (v != null) node.setAttribute(k, v);
  }
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/* ---------------------------------------------------------------- toast */

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
  toastTimer = setTimeout(() => toastNode.classList.remove("is-in"), 2600);
}

/* --------------------------------------------------------- overlay base */

/**
 * A full-screen overlay. Handles the scrim, escape, focus return and body
 * lock so every page below only has to supply markup.
 */
export function createOverlay({ id, label, wide = false }) {
  const node = el("div", {
    class: `sheet${wide ? " sheet--wide" : ""}`,
    id, role: "dialog", "aria-modal": "true", "aria-label": label, hidden: "",
  });
  node.innerHTML = `
    <div class="sheet__scrim" data-close></div>
    <div class="sheet__panel" data-native-scroll>
      <button class="sheet__close" data-close aria-label="Close">&times;</button>
      <div class="sheet__body"></div>
    </div>`;
  document.body.appendChild(node);

  const body = $(".sheet__body", node);
  let lastFocus = null;

  function open(html) {
    if (html !== undefined) body.innerHTML = html;
    lastFocus = document.activeElement;
    node.hidden = false;
    document.documentElement.classList.add("is-locked");
    $(".sheet__panel", node).scrollTop = 0;
    $(".sheet__close", node).focus();
  }

  function close() {
    if (node.hidden) return;
    node.hidden = true;
    if (!$$(".sheet:not([hidden])").length)
      document.documentElement.classList.remove("is-locked");
    lastFocus?.focus?.();
  }

  node.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !node.hidden) close();
  });

  return { node, body, open, close, get isOpen() { return !node.hidden; } };
}

/* ------------------------------------------------------------- captcha */

/**
 * Human check.
 *
 * Click to verify, then it weighs a few signals before passing:
 *   - a honeypot field only an autofilling bot would touch
 *   - dwell time (instant submits are not human)
 *   - real pointer or keyboard interaction somewhere on the page
 * Anything suspicious escalates to a drag-to-fit slider.
 *
 * This raises the cost of casual scripted signups. It is NOT a security
 * boundary — a determined bot runs a real browser. The real check is
 * Cloudflare Turnstile with the token verified in the Worker; this widget is
 * shaped so that swap is a body change inside `verify()`.
 */

let sawPointer = false;
let sawKey = false;
addEventListener("pointermove", () => { sawPointer = true; }, { passive: true, once: true });
addEventListener("keydown", () => { sawKey = true; }, { passive: true, once: true });
addEventListener("touchstart", () => { sawPointer = true; }, { passive: true, once: true });

const MIN_DWELL_MS = 1200;

export function captchaMarkup(id) {
  return `
    <div class="hcheck" id="${id}" data-hcheck data-born="${Date.now()}" data-state="idle">
      <div class="hcheck__main">
        <button type="button" class="hcheck__box" role="checkbox" aria-checked="false"
                aria-label="Verify that you are human">
          <span class="hcheck__spin" aria-hidden="true"></span>
          <svg class="hcheck__tick" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg>
        </button>
        <span class="hcheck__label">
          <b data-hc-title>I'm human</b>
          <span class="hcheck__sub" data-hc-sub>Click to verify</span>
        </span>
        <span class="hcheck__brand" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M12 3l7 3v6c0 4.2-2.9 7.9-7 9-4.1-1.1-7-4.8-7-9V6z"/></svg>
          Lucrit Check
        </span>
      </div>

      <div class="hcheck__slide" hidden>
        <span class="hcheck__slidehint">Drag the handle all the way across</span>
        <div class="hcheck__track" data-hc-track>
          <span class="hcheck__fill" data-hc-fill></span>
          <button type="button" class="hcheck__handle" data-hc-handle aria-label="Slide to verify">
            <svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>
          </button>
        </div>
      </div>

      <label class="hcheck__hp" aria-hidden="true">
        Leave this empty
        <input type="text" tabindex="-1" autocomplete="off" name="lucrit_hp_${id}">
      </label>
    </div>`;
}

function setState(box, state, title, sub) {
  box.dataset.state = state;
  box.querySelector("[data-hc-title]").textContent = title;
  box.querySelector("[data-hc-sub]").textContent = sub;
  box.querySelector(".hcheck__box").setAttribute("aria-checked", state === "ok" ? "true" : "false");
}

function pass(box) {
  setState(box, "ok", "Verified", "You're good to go");
  box.querySelector(".hcheck__slide").hidden = true;
}

function challenge(box) {
  setState(box, "slide", "One more step", "Slide to confirm");
  box.querySelector(".hcheck__slide").hidden = false;
}

/** Decides whether the quick path is enough. */
function looksHuman(box) {
  const honeypot = box.querySelector(".hcheck__hp input");
  if (honeypot && honeypot.value.trim()) return false;
  if (Date.now() - Number(box.dataset.born || 0) < MIN_DWELL_MS) return false;
  return sawPointer || sawKey;
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest(".hcheck__box");
  if (!btn) return;
  const box = btn.closest("[data-hcheck]");
  if (!box || box.dataset.state === "ok" || box.dataset.state === "checking") return;

  setState(box, "checking", "Checking...", "One moment");
  setTimeout(() => {
    if (looksHuman(box)) pass(box);
    else challenge(box);
  }, 620);
});

/* ---- slider challenge ---- */

let drag = null;

function dragTo(clientX) {
  if (!drag) return;
  const { track, handle, fill } = drag;
  const rect = track.getBoundingClientRect();
  const max = rect.width - handle.offsetWidth;
  const x = Math.max(0, Math.min(max, clientX - rect.left - drag.grab));
  handle.style.transform = `translateX(${x}px)`;
  fill.style.width = `${x + handle.offsetWidth / 2}px`;
  drag.done = x >= max - 2;
}

document.addEventListener("pointerdown", (e) => {
  const handle = e.target.closest("[data-hc-handle]");
  if (!handle) return;
  const box = handle.closest("[data-hcheck]");
  const track = box.querySelector("[data-hc-track]");
  drag = {
    box, track, handle,
    fill: box.querySelector("[data-hc-fill]"),
    grab: e.clientX - handle.getBoundingClientRect().left,
    done: false,
  };
  handle.setPointerCapture?.(e.pointerId);
  e.preventDefault();
});

document.addEventListener("pointermove", (e) => { if (drag) dragTo(e.clientX); });

document.addEventListener("pointerup", () => {
  if (!drag) return;
  const { box, handle, fill, done } = drag;
  if (done) {
    pass(box);
  } else {
    handle.style.transform = "translateX(0)";
    fill.style.width = "0px";
  }
  drag = null;
});

export function captchaPassed(root) {
  const box = root.querySelector("[data-hcheck]");
  if (!box) return false;
  if (box.dataset.state === "ok") return true;

  // Nudge the user toward the control they missed.
  if (box.dataset.state === "idle") setState(box, "idle", "I'm human", "Click the box to verify");
  box.classList.remove("is-shake");
  void box.offsetWidth;
  box.classList.add("is-shake");
  return false;
}

/** Lets a form reset its check after a successful submit. */
export function captchaReset(root) {
  const box = root.querySelector("[data-hcheck]");
  if (!box) return;
  box.dataset.born = String(Date.now());
  setState(box, "idle", "I'm human", "Click to verify");
  box.querySelector(".hcheck__slide").hidden = true;
  const handle = box.querySelector("[data-hc-handle]");
  const fill = box.querySelector("[data-hc-fill]");
  if (handle) handle.style.transform = "translateX(0)";
  if (fill) fill.style.width = "0px";
}

/* ============================================================
   Auth
   ============================================================ */

export function createAuth({ onDone }) {
  const sheet = createOverlay({ id: "auth", label: "Account" });
  let mode = "signup";

  function render(message) {
    const signup = mode === "signup";
    sheet.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">Account</span>
        <h2>${signup ? "Create your account" : mode === "reset" ? "Reset your password" : "Welcome back"}</h2>
        <p>${signup
          ? "You need an account to publish scripts, rate them and track your stats."
          : mode === "reset"
            ? "Enter your email and we'll send a reset link."
            : "Sign in to publish, rate and see your dashboard."}</p>
      </header>

      ${message ? `<p class="formerror" role="alert">${esc(message)}</p>` : ""}

      <form class="form" novalidate>
        ${signup ? `<label>Username<input name="username" autocomplete="nickname" autocapitalize="none"
          spellcheck="false" placeholder="yourname" required></label>` : ""}
        <label>Email<input name="email" type="email" autocomplete="email" placeholder="you@example.com" required></label>
        ${mode !== "reset" ? `<label>Password<input name="password" type="password"
          autocomplete="${signup ? "new-password" : "current-password"}" placeholder="At least 8 characters" required></label>` : ""}
        ${signup ? captchaMarkup("auth-captcha") : ""}
        <button class="btn btn--primary btn--full" type="submit">
          ${signup ? "Create account" : mode === "reset" ? "Send reset link" : "Sign in"}
        </button>
      </form>

      <div class="sheet__alt">
        ${signup
          ? `<button data-mode="signin">Already have an account? <b>Sign in</b></button>`
          : mode === "reset"
            ? `<button data-mode="signin">Back to <b>sign in</b></button>`
            : `<button data-mode="signup">No account? <b>Create one</b></button>
               <button data-mode="reset">Forgot password?</button>`}
      </div>`;
  }

  sheet.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    mode = btn.dataset.mode;
    render();
  });

  sheet.body.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const d = Object.fromEntries(new FormData(form));
    const submit = form.querySelector("button[type=submit]");
    submit.disabled = true;

    let res;
    if (mode === "signup") {
      res = await account.signUp({ ...d, captcha: captchaPassed(sheet.body) });
    } else if (mode === "reset") {
      res = await account.requestPasswordReset(d.email);
      if (res.ok) {
        toast("Reset link requested", "ok");
        sheet.body.innerHTML = `
          <header class="sheet__head">
            <span class="sheet__eyebrow">Check your inbox</span>
            <h2>Reset link sent</h2>
            <p>If an account exists for <b>${esc(d.email)}</b>, a reset link is on its way.</p>
          </header>
          <p class="note">${esc(res.note || "")}</p>
          <button class="btn btn--full" data-close>Close</button>`;
        return;
      }
    } else {
      res = await account.signIn(d);
    }

    submit.disabled = false;
    if (!res.ok) { render(res.error); return; }

    toast(mode === "signup" ? "Account created" : "Signed in");
    sheet.close();
    onDone?.(account.session);
  });

  return {
    open(next = "signup") { mode = next; render(); sheet.open(); },
    close: () => sheet.close(),
  };
}

/* ============================================================
   Monetization info tab
   ============================================================ */

const INFO_HTML = `
  <header class="sheet__head">
    <span class="sheet__eyebrow">Creator program</span>
    <h2>Start getting paid for scripting</h2>
    <p>Publish a script, share it, get paid when people unlock it. No exclusivity, no minimum, you keep ownership.</p>
  </header>

  <ol class="steps">
    <li><b>Publish your script.</b> Name it, pick the game and category, write a real description, paste the Luau. It goes live in the library straight away.</li>
    <li><b>People unlock it.</b> To get the code, a visitor completes one short sponsor step through Linkvertise or Lootlabs. They choose which.</li>
    <li><b>That step pays out.</b> Every completed unlock earns revenue, tracked against your account and split with you.</li>
    <li><b>Watch it in your dashboard.</b> Views, likes and copies over 24 hours, 7 days, 1 month and 3 months.</li>
  </ol>

  <div class="infogrid">
    <div><h3>What earns</h3><p>Completed unlocks. Views alone don't pay — someone has to finish the sponsor step.</p></div>
    <div><h3>Rates</h3><p>Linkvertise and Lootlabs both pay per completion, and the rate moves with the visitor's country and the ad market. Lootlabs usually pays more in the US and UK; Linkvertise tends to convert better in the EU.</p></div>
    <div><h3>Getting paid</h3><p>Payouts run through the monetization provider once you pass their minimum. Payout methods and thresholds are set by them, not by us.</p></div>
    <div><h3>Your own scripts</h3><p>You never have to unlock your own work. The author always gets straight through to their code.</p></div>
  </div>

  <div class="callout">
    <b>Being set up now.</b> Payout tracking per creator needs the account system and the server-side unlock check finished first. Publishing works today, and every unlock from launch is counted.
  </div>

  <h3 class="sheet__sub">Rules that keep it working</h3>
  <ul class="rules">
    <li>Publish scripts you wrote or have the right to share. Stolen code gets removed and the account banned.</li>
    <li>The description must actually describe the script — at least 100 words, no filler.</li>
    <li>No malicious code. Anything that steals accounts, tokens or data is removed immediately and reported.</li>
    <li>Don't fake unlocks. Bot traffic gets caught by the provider and zeroes your balance, not just the script.</li>
  </ul>`;

export function createInfoPage() {
  const sheet = createOverlay({ id: "info", label: "Creator program", wide: true });
  return { open: () => sheet.open(INFO_HTML), close: () => sheet.close() };
}

/* ============================================================
   Dashboard
   ============================================================ */

export function createDashboard({ onRequireAuth, getPublishes, onOpenScript, onDeleteScript,
                                 getScript, onOpenDraft, onGenerate, onUnheart }) {
  const sheet = createOverlay({ id: "dashboard", label: "Dashboard", wide: true });
  let statWindow = "7d";
  let tab = "stats";

  const windowDays = () => STAT_WINDOWS.find((w) => w.id === statWindow)?.days || 7;

  function trendChip(value) {
    if (!value) return `<span class="trend trend--flat">no change</span>`;
    const up = value > 0;
    return `<span class="trend trend--${up ? "up" : "down"}">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="${up ? "M5 15l7-7 7 7" : "M5 9l7 7 7-7"}"/></svg>
      ${Math.abs(value)}%</span>`;
  }

  function statCard(label, value, tr) {
    return `<div class="stat">
      <span class="stat__l">${label}</span>
      <span class="stat__v">${fmt(value)}</span>
      ${tr === undefined ? "" : trendChip(tr)}
    </div>`;
  }

  function render() {
    const u = account.session;
    if (!u) return;

    const publishes = getPublishes?.(u) || [];
    const ids = publishes.map((s) => s.id);
    const days = windowDays();
    const sum = stats.summary(ids, days);
    const since = new Date(u.createdAt || Date.now());

    sheet.body.innerHTML = `
      <header class="dash__head">
        <span class="avatar avatar--lg" style="--seed:${u.username.length * 37}">
          ${u.avatar ? `<img src="${esc(safeImageSrc(u.avatar))}" alt="">` : esc(u.username.slice(0, 2).toUpperCase())}
        </span>
        <div class="dash__who">
          <span class="sheet__eyebrow">Dashboard</span>
          <h2>@${esc(u.username)}</h2>
          <p>${u.bio ? esc(u.bio) : "No bio yet — add one in Profile."}</p>
          <div class="dash__links">
            <span class="dash__meta">Joined ${since.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</span>
            <span class="dash__meta">${publishes.length} publish${publishes.length === 1 ? "" : "es"}</span>
            ${u.youtube ? `<a href="${esc(safeHref(u.youtube))}" target="_blank" rel="noopener" class="sociallink">YouTube</a>` : ""}
            ${u.tiktok ? `<a href="${esc(safeHref(u.tiktok))}" target="_blank" rel="noopener" class="sociallink">TikTok</a>` : ""}
          </div>
        </div>
        <button class="btn btn--ghost btn--sm" data-act="signout">Sign out</button>
      </header>

      <nav class="tabs" role="tablist">
        ${[["stats","Stats"],["publishes","Publishes"],["drafts","Drafts"],["saved","Saved"],["profile","Profile"],["security","Security"]]
          .map(([id, label]) => `<button class="tab${tab === id ? " is-on" : ""}" data-tab="${id}" role="tab">${label}</button>`).join("")}
      </nav>

      <section class="pane" data-pane="stats" ${tab === "stats" ? "" : "hidden"}>
        <div class="pane__head">
          <h3>Performance</h3>
          <div class="segmented" role="group" aria-label="Time range">
            ${STAT_WINDOWS.map((w) => `<button data-window="${w.id}" class="${w.id === statWindow ? "is-on" : ""}">${w.label}</button>`).join("")}
          </div>
        </div>

        <div class="stats">
          ${statCard("Views", sum.views, stats.trend(ids, days, "views"))}
          ${statCard("Likes", sum.likes, stats.trend(ids, days, "likes"))}
          ${statCard("Copies", sum.copies, stats.trend(ids, days, "copies"))}
          ${statCard("Scripts", publishes.length)}
        </div>

        <div class="chartbox">
          <div class="chartbox__head">
            <b>Views</b>
            <span>${days <= 1 ? "last 24 hours, hourly" : `last ${days} days, daily`}</span>
          </div>
          ${sum.views
            ? stats.sparkline(sum.series, { key: "views" })
            : `<div class="chart__empty">
                 <strong>No activity in this window.</strong>
                 <span>Every time someone opens or copies one of your scripts it lands here.</span>
               </div>`}
        </div>
      </section>

      <section class="pane" data-pane="publishes" ${tab === "publishes" ? "" : "hidden"}>
        <div class="pane__head">
          <h3>Your publishes</h3>
          ${publishes.length ? `<button class="btn btn--primary btn--sm" data-act="publish">Publish another</button>` : ""}
        </div>
        ${publishes.length ? `
          <table class="ptable">
            <thead><tr><th>Script</th><th>Category</th><th>Views</th><th>Likes</th><th>Copies</th><th></th></tr></thead>
            <tbody>
              ${publishes.map((s) => {
                const t = stats.totals(s.id);
                const cat = categoryOf(s.category);
                return `<tr data-id="${esc(s.id)}">
                  <td>
                    <button class="ptable__name" data-act="open">${esc(s.title)}</button>
                    <span class="ptable__game">${esc(s.game || "Roblox")}</span>
                  </td>
                  <td><span class="chip" style="--cat:${cat.accent}">${cat.label}</span></td>
                  <td class="num">${fmt(t.views)}</td>
                  <td class="num">${fmt(t.likes)}</td>
                  <td class="num">${fmt(t.copies)}</td>
                  <td><button class="ptable__del" data-act="delete" aria-label="Delete ${esc(s.title)}">&times;</button></td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>` : `
          <div class="empty empty--lg">
            <strong>You haven't posted any scripts yet...</strong>
            <span>Publish your first one and it shows up here with its own views, likes and copies.</span>
            <button class="btn btn--primary btn--sm" data-act="publish">Publish a script</button>
          </div>`}
      </section>

      <section class="pane" data-pane="drafts" ${tab === "drafts" ? "" : "hidden"}>
        <div class="pane__head"><h3>Drafts</h3><p>Private until you publish them.</p></div>
        ${(() => {
          const list = myDrafts(u.id);
          if (!list.length) return `
            <div class="empty">
              <strong>No drafts yet.</strong>
              <span>Anything you make with the AI generator and save lands here.</span>
              <button class="btn btn--primary btn--sm" data-act="generate">Create a script with AI</button>
            </div>`;
          return `<div class="ptable">${list.map((d) => `
            <div class="ptable__row">
              <div class="ptable__main">
                <strong>${esc(d.title)}</strong>
                <span>${esc(new Date(d.updatedAt).toLocaleDateString())} · ${d.code.split("\n").length} lines</span>
              </div>
              <div class="ptable__acts">
                <button class="btn btn--ghost btn--xs" data-draft-open="${esc(d.id)}">Open</button>
                <button class="btn btn--ghost btn--xs" data-draft-del="${esc(d.id)}">Delete</button>
              </div>
            </div>`).join("")}</div>`;
        })()}
      </section>

      <section class="pane" data-pane="saved" ${tab === "saved" ? "" : "hidden"}>
        <div class="pane__head"><h3>Saved</h3><p>Scripts you hearted around the site.</p></div>
        ${(() => {
          const ids = savedIds(u.id);
          const list = ids.map((id) => getScript?.(id)).filter(Boolean);
          if (!list.length) return `
            <div class="empty">
              <strong>Nothing saved yet.</strong>
              <span>Tap the heart on any script and it gets its own tab here.</span>
            </div>`;
          return `<div class="ptable">${list.map((sc) => `
            <div class="ptable__row">
              <div class="ptable__main">
                <strong>${esc(sc.title)}</strong>
                <span>${esc(sc.game || "")} · @${esc(sc.author)}</span>
              </div>
              <div class="ptable__acts">
                <button class="btn btn--ghost btn--xs" data-open="${esc(sc.id)}">Open</button>
                <button class="btn btn--ghost btn--xs" data-unheart="${esc(sc.id)}">Remove</button>
              </div>
            </div>`).join("")}</div>`;
        })()}
      </section>

      <section class="pane" data-pane="profile" ${tab === "profile" ? "" : "hidden"}>
        <h3>Profile</h3>
        <form class="form form--grid" data-form="profile">
          <label class="wide">Profile picture
            <div class="avatarpick">
              <span class="avatar avatar--lg" data-preview style="--seed:${u.username.length * 37}">
                ${u.avatar ? `<img src="${esc(safeImageSrc(u.avatar))}" alt="">` : esc(u.username.slice(0, 2).toUpperCase())}
              </span>
              <div class="avatarpick__controls">
                <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif">
                ${u.avatar ? `<button type="button" class="btn btn--ghost btn--sm" data-act="clearavatar">Remove</button>` : ""}
              </div>
            </div>
          </label>
          <label class="wide">Bio
            <textarea name="bio" rows="3" maxlength="300" placeholder="What do you build?">${esc(u.bio)}</textarea>
            <span class="counter" data-biocount>${(u.bio || "").length} / 300</span>
          </label>
          <label>YouTube<input name="youtube" value="${esc(u.youtube)}" placeholder="youtube.com/@you"></label>
          <label>TikTok<input name="tiktok" value="${esc(u.tiktok)}" placeholder="tiktok.com/@you"></label>
          <div class="wide"><button class="btn btn--primary" type="submit">Save profile</button></div>
        </form>
      </section>

      <section class="pane" data-pane="security" ${tab === "security" ? "" : "hidden"}>
        <h3>Username</h3>
        ${(() => {
          const cd = account.usernameCooldownDays();
          return `<form class="form form--grid" data-form="username">
            <label>New username<input name="username" autocomplete="nickname" autocapitalize="none"
              spellcheck="false" value="${esc(u.username)}" ${cd ? "disabled" : ""}></label>
            <div class="wide">
              <button class="btn btn--primary" type="submit" ${cd ? "disabled" : ""}>Change username</button>
              <span class="note">${cd
                ? `Available again in ${cd} day${cd === 1 ? "" : "s"}.`
                : "Letters are fine on their own. Changeable once every 7 days."}</span>
            </div>
          </form>`;
        })()}

        <h3>Password</h3>
        <form class="form form--grid" data-form="password">
          <label>Current password<input name="current" type="password" autocomplete="current-password"></label>
          <label>New password<input name="next" type="password" autocomplete="new-password">
            <span class="meter" data-meter><i></i></span>
          </label>
          <div class="wide">
            <button class="btn btn--primary" type="submit">Change password</button>
            <button class="btn btn--ghost" type="button" data-act="reset">Email me a reset link</button>
          </div>
        </form>

        <h3>Email</h3>
        <p class="note">${esc(u.email)} — changing this arrives with Supabase auth.</p>
      </section>`;
  }

  /* ---- interactions ---- */

  sheet.body.addEventListener("click", async (e) => {
    const draftOpen = e.target.closest("[data-draft-open]");
    if (draftOpen) { sheet.close(); onOpenDraft?.(draftOpen.dataset.draftOpen); return; }

    const draftDel = e.target.closest("[data-draft-del]");
    if (draftDel) {
      const d = myDrafts(account.session.id).find((x) => x.id === draftDel.dataset.draftDel);
      if (d && window.confirm(`Delete the draft "${d.title}"? This cannot be undone.`)) {
        deleteDraft(account.session.id, d.id);
        render();
      }
      return;
    }

    const unheart = e.target.closest("[data-unheart]");
    if (unheart) { onUnheart?.(unheart.dataset.unheart); render(); return; }

    if (e.target.closest('[data-act="generate"]')) { sheet.close(); onGenerate?.(); return; }

    const tabBtn = e.target.closest("[data-tab]");
    if (tabBtn) {
      tab = tabBtn.dataset.tab;
      $$(".tab", sheet.body).forEach((t) => t.classList.toggle("is-on", t === tabBtn));
      $$(".pane", sheet.body).forEach((p) => { p.hidden = p.dataset.pane !== tab; });
      return;
    }

    const win = e.target.closest("[data-window]");
    if (win) { statWindow = win.dataset.window; render(); return; }

    const row = e.target.closest("tr[data-id]");
    const act = e.target.closest("[data-act]")?.dataset.act;

    if (act === "open" && row) {
      const s = (getPublishes?.(account.session) || []).find((x) => x.id === row.dataset.id);
      if (s) { sheet.close(); onOpenScript?.(s); }
      return;
    }

    if (act === "delete" && row) {
      const s = (getPublishes?.(account.session) || []).find((x) => x.id === row.dataset.id);
      if (!s) return;
      if (!window.confirm(`Delete "${s.title}"? This cannot be undone.`)) return;
      onDeleteScript?.(s);
      stats.forget(s.id);
      render();
      toast("Script deleted");
      return;
    }

    if (act === "signout") { await account.signOut(); sheet.close(); toast("Signed out"); }
    if (act === "publish") { sheet.close(); document.dispatchEvent(new CustomEvent("lucrit:publish")); }
    if (act === "clearavatar") {
      await account.updateProfile({ avatar: null });
      render();
      toast("Profile picture removed");
    }
    if (act === "reset") {
      const res = await account.requestPasswordReset(account.session?.email);
      toast(res.ok ? "Reset link requested" : res.error, res.ok ? "ok" : "warn");
    }
  });

  sheet.body.addEventListener("input", (e) => {
    if (e.target.name === "bio") {
      const c = $("[data-biocount]", sheet.body);
      if (c) c.textContent = `${e.target.value.length} / 300`;
    }
    if (e.target.name === "next") {
      const meter = $("[data-meter]", sheet.body);
      if (!meter) return;
      const v = e.target.value;
      let score = 0;
      if (v.length >= 8) score++;
      if (v.length >= 12) score++;
      if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
      if (/\d/.test(v)) score++;
      if (/[^A-Za-z0-9]/.test(v)) score++;
      meter.dataset.score = String(Math.min(4, score));
    }
  });

  sheet.body.addEventListener("change", (e) => {
    const input = e.target.closest('input[name="avatar"]');
    if (!input?.files?.[0]) return;
    const file = input.files[0];
    if (file.size > 2 * 1024 * 1024) { toast("Image must be under 2 MB", "warn"); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const preview = $("[data-preview]", sheet.body);
      if (!preview) return;
      preview.innerHTML = `<img src="${esc(safeImageSrc(reader.result))}" alt="">`;
      preview.dataset.value = reader.result;
    };
    reader.readAsDataURL(file);
  });

  sheet.body.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const d = Object.fromEntries(new FormData(form));
    let res;

    if (form.dataset.form === "profile") {
      const preview = $("[data-preview]", sheet.body);
      res = await account.updateProfile({
        bio: d.bio, youtube: d.youtube, tiktok: d.tiktok,
        avatar: preview?.dataset.value || account.session.avatar,
      });
      if (res.ok && (d.youtube || d.tiktok)) {
        const s = account.session;
        if (d.youtube && !s.youtube) toast("YouTube link ignored — use a youtube.com address", "warn");
        else if (d.tiktok && !s.tiktok) toast("TikTok link ignored — use a tiktok.com address", "warn");
        else toast("Saved");
      } else if (res.ok) toast("Saved");
    } else if (form.dataset.form === "username") {
      res = await account.changeUsername(d.username);
      if (res.ok) toast("Username changed");
    } else {
      res = await account.changePassword({ current: d.current, next: d.next });
      if (res.ok) toast("Password changed");
    }

    if (!res.ok) { toast(res.error, "warn"); return; }
    render();
  });

  stats.onStatsChange(() => { if (sheet.isOpen) render(); });

  return {
    open(startTab = "stats") {
      if (!account.isSignedIn) { onRequireAuth?.(); return; }
      tab = startTab;
      render();
      sheet.open();
    },
    close: () => sheet.close(),
    refresh() { if (sheet.isOpen) render(); },
  };
}

/* ============================================================
   Script page — Get Script + monetization unlock
   ============================================================ */

const UNLOCK_KEY = "lucrit:unlocked";

const unlocked = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(UNLOCK_KEY) || "[]")); }
  catch { return new Set(); }
})();

function persistUnlocks() {
  try { localStorage.setItem(UNLOCK_KEY, JSON.stringify([...unlocked])); } catch { /* ignore */ }
}

export function createScriptPage({ onRequireAuth }) {
  const sheet = createOverlay({ id: "script", label: "Script", wide: true });
  let current = null;

  function isOwner(s) {
    return Boolean(account.session && s.authorId && s.authorId === account.session.id);
  }

  function canSee(s) {
    return isOwner(s) || unlocked.has(s.id);
  }

  function render() {
    const s = current;
    if (!s) return;
    const cat = categoryOf(s.category);
    const open = canSee(s);

    sheet.body.innerHTML = `
      <header class="sheet__head">
        <div class="chips">
          <span class="chip" style="--cat:${cat.accent}">${cat.label}</span>
          ${s.keyless ? `<span class="chip chip--ok">Keyless</span>` : `<span class="chip chip--warn">Key required</span>`}
          ${(s.tags || []).map((t) => `<span class="chip chip--soft">${esc(t)}</span>`).join("")}
        </div>
        <h2>${esc(s.title)}</h2>
        <p class="script__game">${esc(s.game || "Roblox")}</p>
        <div class="sheet__meta">
          <span>@${esc(s.author)}</span><span class="dot"></span>
          <span>${fmt(stats.totals(s.id).views)} views</span><span class="dot"></span>
          <span>${fmt(stats.totals(s.id).copies)} copies</span><span class="dot"></span>
          <span>${esc(s.added)}</span>
        </div>
      </header>

      ${s.thumbnail ? `<img class="script__thumb" src="${esc(safeImageSrc(s.thumbnail))}" alt="">` : ""}

      <div class="script__desc">${esc(s.desc).replace(/\n+/g, "</p><p>").replace(/^/, "<p>") + "</p>"}</div>

      ${open ? `
        <div class="script__toolbar">
          ${isOwner(s) ? `<span class="chip chip--ok">Your script — unlocked automatically</span>` : ""}
          <button class="btn btn--primary" data-act="copy">Copy code</button>
          <button class="btn btn--ghost" data-act="raw">Open raw</button>
          <button class="btn btn--ghost${account.isSignedIn && stats.hasLiked(s.id, account.session.id) ? " is-on" : ""}" data-act="like">
            ${account.isSignedIn && stats.hasLiked(s.id, account.session.id) ? "Liked" : "Like"}
            ${stats.totals(s.id).likes ? ` · ${stats.totals(s.id).likes}` : ""}
          </button>
          <button class="btn btn--ghost" data-act="report">Report</button>
        </div>
        <div class="script__code">${renderCodeBlock(s.code || "-- no code")}</div>
      ` : `
        <div class="gate">
          <div class="gate__lock" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
          </div>
          <h3>Get this script</h3>
          <p>Complete one short sponsor step to unlock the code. It pays the person who wrote it.</p>
          <div class="gate__actions">
            <button class="btn btn--primary" data-act="linkvertise">Unlock with Linkvertise</button>
            <button class="btn btn--primary btn--alt" data-act="lootlabs">Unlock with Lootlabs</button>
          </div>
          <p class="gate__note">You'll come straight back here with the script open.</p>
        </div>
      `}`;
  }

  sheet.body.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act || !current) return;

    if (act === "copy") {
      const ok = await copyText(current.code || "");
      if (ok) stats.record(current.id, "copy");
      toast(ok ? "COPIED TO CLIPBOARD" : "Copy blocked — select the code manually", ok ? "ok" : "warn");
    }

    if (act === "raw") {
      const url = URL.createObjectURL(new Blob([current.code || ""], { type: "text/plain;charset=utf-8" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    if (act === "like") {
      if (!account.isSignedIn) { onRequireAuth?.(); return; }
      const me = account.session.id;
      if (stats.hasLiked(current.id, me)) {
        stats.unlike(current.id, me);
        toast("Like removed");
      } else {
        stats.record(current.id, "like", me);
        toast("Liked");
      }
      render();
    }

    if (act === "report") toast("Report sent to moderators", "warn");

    if (act === "linkvertise" || act === "lootlabs") {
      // The real flow hands off to the provider and comes back with a token
      // the Worker verifies. Until that endpoint exists this unlocks locally
      // and says so, rather than pretending to be secure.
      unlocked.add(current.id);
      persistUnlocks();
      render();
      toast("Unlocked — server verification arrives with the Worker", "warn");
    }
  });

  return {
    open(script) {
      current = script;
      stats.record(script.id, "view");
      render();
      sheet.open();
    },
    close: () => sheet.close(),
  };
}

export async function copyText(text) {
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

/* ============================================================
   Leaderboard
   ============================================================ */

export function createLeaderboard({ getRows }) {
  const node = el("div", { class: "board" });
  let board = BOARDS[0].id;

  function render() {
    const rows = getRows?.(board) || [];
    node.innerHTML = `
      <div class="board__tabs" role="tablist">
        ${BOARDS.map((b) => `<button class="${b.id === board ? "is-on" : ""}" data-board="${b.id}" role="tab">${b.label}</button>`).join("")}
      </div>
      ${rows.length ? `
        <ol class="board__list">
          ${rows.map((r, i) => `
            <li class="board__row${i < 3 ? " is-top" : ""}">
              <span class="board__rank">${i + 1}</span>
              <span class="avatar" style="--seed:${(r.username || "?").length * 37}">${esc((r.username || "?").slice(0, 2).toUpperCase())}</span>
              <span class="board__name">@${esc(r.username)}</span>
              <span class="board__value">${fmt(r.value)} <small>${esc(r.suffix || "")}</small></span>
            </li>`).join("")}
        </ol>` : `
        <div class="empty">
          <strong>Nobody on the board yet.</strong>
          <span>Publish the first script and you'll be number one by default.</span>
        </div>`}`;
  }

  node.addEventListener("click", (e) => {
    const b = e.target.closest("[data-board]");
    if (!b) return;
    board = b.dataset.board;
    render();
  });

  render();
  return { node, refresh: render };
}
