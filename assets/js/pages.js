// Overlay pages: auth, dashboard, the monetization info tab, and the
// script page with the Linkvertise / Lootlabs unlock.
//
// These are overlays rather than chapters so the scroll-driven camera path
// stays untouched.

import { account, STAT_WINDOWS, emptyStats } from "./account.js";
import { CATEGORIES, BOARDS, categoryOf } from "./data/scripts.js";
import { renderCodeBlock } from "./engine/highlight.js";

/* ------------------------------------------------------------------ util */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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
 * Placeholder human check. Deliberately NOT presented as security — a real
 * check is Cloudflare Turnstile with the token verified in the Worker.
 * This keeps the flow and the UI honest until that key exists.
 */
export function captchaMarkup(id) {
  const a = 3 + Math.floor(Math.random() * 6);
  const b = 2 + Math.floor(Math.random() * 6);
  return `
    <div class="captcha" data-answer="${a + b}" id="${id}">
      <span class="captcha__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>
      </span>
      <label class="captcha__q">Human check — what is <b>${a} + ${b}</b>?
        <input type="text" inputmode="numeric" autocomplete="off" class="captcha__input" aria-label="Answer">
      </label>
      <span class="captcha__state" aria-live="polite"></span>
    </div>`;
}

export function captchaPassed(root) {
  const box = root.querySelector(".captcha");
  if (!box) return false;
  const ok = box.querySelector(".captcha__input").value.trim() === box.dataset.answer;
  box.classList.toggle("is-ok", ok);
  box.querySelector(".captcha__state").textContent = ok ? "Verified" : "";
  return ok;
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
        ${signup ? `<label>Username<input name="username" autocomplete="username" placeholder="yourname" required></label>` : ""}
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

export function createDashboard({ onRequireAuth, getPublishes }) {
  const sheet = createOverlay({ id: "dashboard", label: "Dashboard", wide: true });
  let statWindow = "7d";

  function statCard(label, value) {
    return `<div class="stat"><span class="stat__v">${fmt(value)}</span><span class="stat__l">${label}</span></div>`;
  }

  function render() {
    const u = account.session;
    if (!u) return;

    const cooldown = account.usernameCooldownDays();
    const publishes = getPublishes?.(u) || [];
    const stats = emptyStats();

    sheet.body.innerHTML = `
      <header class="sheet__head sheet__head--row">
        <span class="avatar avatar--lg" style="--seed:${u.username.length * 37}">
          ${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc(u.username.slice(0, 2).toUpperCase())}
        </span>
        <div>
          <span class="sheet__eyebrow">Dashboard</span>
          <h2>@${esc(u.username)}</h2>
          <p>${u.bio ? esc(u.bio) : "No bio yet — add one below."}</p>
        </div>
        <button class="btn btn--ghost btn--sm" data-act="signout">Sign out</button>
      </header>

      <nav class="tabs" role="tablist">
        <button class="tab is-on" data-tab="stats" role="tab">Stats</button>
        <button class="tab" data-tab="publishes" role="tab">Publishes</button>
        <button class="tab" data-tab="profile" role="tab">Profile</button>
        <button class="tab" data-tab="security" role="tab">Security</button>
      </nav>

      <section class="pane" data-pane="stats">
        <div class="pane__head">
          <h3>Performance</h3>
          <div class="segmented" role="group" aria-label="Time range">
            ${STAT_WINDOWS.map((w) => `<button data-window="${w.id}" class="${w.id === statWindow ? "is-on" : ""}">${w.label}</button>`).join("")}
          </div>
        </div>
        <div class="stats">
          ${statCard("Views", stats.views)}
          ${statCard("Likes", stats.likes)}
          ${statCard("Copies", stats.copies)}
          ${statCard("Scripts", publishes.length)}
        </div>
        <div class="chart" aria-label="Views over time">
          <div class="chart__empty">No activity yet. Publish a script and this fills in.</div>
        </div>
      </section>

      <section class="pane" data-pane="publishes" hidden>
        <h3>Your publishes</h3>
        ${publishes.length ? `<div class="grid">${publishes.map(publishRow).join("")}</div>` : `
          <div class="empty">
            <strong>You haven't posted any scripts yet...</strong>
            <span>Publish your first one and it shows up here with its own stats.</span>
            <button class="btn btn--primary btn--sm" data-act="publish">Publish a script</button>
          </div>`}
      </section>

      <section class="pane" data-pane="profile" hidden>
        <h3>Profile</h3>
        <form class="form form--grid" data-form="profile">
          <label class="wide">Profile picture
            <div class="avatarpick">
              <span class="avatar avatar--lg" data-preview>
                ${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : esc(u.username.slice(0, 2).toUpperCase())}
              </span>
              <input type="file" name="avatar" accept="image/png,image/jpeg,image/webp,image/gif">
            </div>
          </label>
          <label class="wide">Bio
            <textarea name="bio" rows="3" maxlength="300" placeholder="What do you build?">${esc(u.bio)}</textarea>
          </label>
          <label>YouTube<input name="youtube" value="${esc(u.youtube)}" placeholder="youtube.com/@you"></label>
          <label>TikTok<input name="tiktok" value="${esc(u.tiktok)}" placeholder="tiktok.com/@you"></label>
          <div class="wide"><button class="btn btn--primary" type="submit">Save profile</button></div>
        </form>
      </section>

      <section class="pane" data-pane="security" hidden>
        <h3>Username</h3>
        <form class="form form--grid" data-form="username">
          <label>New username<input name="username" value="${esc(u.username)}" ${cooldown ? "disabled" : ""}></label>
          <div class="wide">
            <button class="btn btn--primary" type="submit" ${cooldown ? "disabled" : ""}>Change username</button>
            <span class="note">${cooldown
              ? `You can change it again in ${cooldown} day${cooldown === 1 ? "" : "s"}.`
              : "Can be changed once every 7 days."}</span>
          </div>
        </form>

        <h3>Password</h3>
        <form class="form form--grid" data-form="password">
          <label>Current password<input name="current" type="password" autocomplete="current-password"></label>
          <label>New password<input name="next" type="password" autocomplete="new-password"></label>
          <div class="wide">
            <button class="btn btn--primary" type="submit">Change password</button>
            <button class="btn btn--ghost" type="button" data-act="reset">Email me a reset link</button>
          </div>
        </form>
      </section>`;
  }

  function publishRow(s) {
    const cat = categoryOf(s.category);
    return `<article class="card" style="--cat:${cat.accent}">
      <div class="card__body">
        <span class="chip">${cat.label}</span>
        <h4 class="card__title">${esc(s.title)}</h4>
        <div class="card__stats"><span>${fmt(s.views)} views</span><span>${fmt(s.likes || 0)} likes</span></div>
      </div></article>`;
  }

  sheet.body.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab) {
      $$(".tab", sheet.body).forEach((t) => t.classList.toggle("is-on", t === tab));
      $$(".pane", sheet.body).forEach((p) => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
      return;
    }

    const win = e.target.closest("[data-window]");
    if (win) {
      statWindow = win.dataset.window;
      $$("[data-window]", sheet.body).forEach((b) => b.classList.toggle("is-on", b === win));
      return;
    }

    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "signout") { await account.signOut(); sheet.close(); toast("Signed out"); }
    if (act === "reset") {
      const res = await account.requestPasswordReset(account.session?.email);
      toast(res.ok ? "Reset link requested" : res.error, res.ok ? "ok" : "warn");
    }
    if (act === "publish") { sheet.close(); document.dispatchEvent(new CustomEvent("lucrit:publish")); }
  });

  sheet.body.addEventListener("change", (e) => {
    const input = e.target.closest('input[name="avatar"]');
    if (!input?.files?.[0]) return;
    const file = input.files[0];
    if (file.size > 2 * 1024 * 1024) { toast("Image must be under 2 MB", "warn"); input.value = ""; return; }
    const reader = new FileReader();
    reader.onload = () => {
      const preview = $("[data-preview]", sheet.body);
      if (preview) preview.innerHTML = `<img src="${reader.result}" alt="">`;
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
    } else if (form.dataset.form === "username") {
      res = await account.changeUsername(d.username);
    } else {
      res = await account.changePassword({ current: d.current, next: d.next });
    }

    toast(res.ok ? "Saved" : res.error, res.ok ? "ok" : "warn");
    if (res.ok) render();
  });

  return {
    open() {
      if (!account.isSignedIn) { onRequireAuth?.(); return; }
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
          <span>${fmt(s.views)} views</span><span class="dot"></span>
          <span>${fmt(s.copies)} copies</span><span class="dot"></span>
          <span>${esc(s.added)}</span>
        </div>
      </header>

      ${s.thumbnail ? `<img class="script__thumb" src="${esc(s.thumbnail)}" alt="">` : ""}

      <div class="script__desc">${esc(s.desc).replace(/\n+/g, "</p><p>").replace(/^/, "<p>") + "</p>"}</div>

      ${open ? `
        <div class="script__toolbar">
          ${isOwner(s) ? `<span class="chip chip--ok">Your script — unlocked automatically</span>` : ""}
          <button class="btn btn--primary" data-act="copy">Copy code</button>
          <button class="btn btn--ghost" data-act="raw">Open raw</button>
          <button class="btn btn--ghost" data-act="like">Like</button>
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
      toast(ok ? "COPIED TO CLIPBOARD" : "Copy blocked — select the code manually", ok ? "ok" : "warn");
    }

    if (act === "raw") {
      const url = URL.createObjectURL(new Blob([current.code || ""], { type: "text/plain;charset=utf-8" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    if (act === "like") {
      if (!account.isSignedIn) { onRequireAuth?.(); return; }
      toast("Liked");
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
    open(script) { current = script; render(); sheet.open(); },
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
