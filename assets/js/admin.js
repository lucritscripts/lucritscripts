// The owner's page, at /admin.
//
// One lock: the passcode. It buys thirty minutes, then it is asked for again.
//
// The passcode is never sent as typed. The browser stretches it with PBKDF2
// (310k rounds — the same treatment account passwords get, for the same
// reason: the Worker has 10ms of CPU and cannot do it) and sends the derived
// key. What the server keeps is a hash of that, so the stored value is a
// verifier: reading it off the Cloudflare dashboard does not open anything.
//
// Nothing on this page is a security boundary. Every route it calls checks the
// ticket server-side and answers 423 or 503 on its own account — unhiding the
// page from the console gets an empty table and a row of refusals. The page is
// the convenience; the Worker is the rule.

import { esc, fmt, toast, createOverlay } from "./pages.js";

const $ = (sel, root = document) => root.querySelector(sel);

async function get(path) {
  try {
    const res = await fetch(path, { credentials: "same-origin" });
    const body = await res.json();
    return { status: res.status, ...body };
  } catch {
    return { status: 0, ok: false, error: "That didn't reach the server." };
  }
}

async function send(path, method = "POST", payload) {
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const body = await res.json();
    return { status: res.status, ...body };
  } catch {
    return { status: 0, ok: false, error: "That didn't reach the server." };
  }
}

/**
 * Stretches the passcode in the browser.
 *
 * Exactly what account passwords already do here, and for the same reason:
 * the Worker gets 10ms of CPU per request, nowhere near enough to run 310,000
 * rounds. The work happens on the machine with spare cycles, and the passcode
 * itself never leaves this function — the server only ever sees the derived
 * key, and only ever stores a hash of that.
 */
async function derivePasscode(passcode, salt, iterations) {
  const enc = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw", enc.encode(String(passcode)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(String(salt)), iterations, hash: "SHA-256" },
    material, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const AGO = (secs) => {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

export function createAdminPage({ onChanged } = {}) {
  const sheet = createOverlay({ id: "admin", label: "Site administration", wide: true });

  let tab = "users";
  let query = "";
  let searchTimer = 0;

  /* ------------------------------------------------------------- gate */

  let gate = null;   // salt + iterations, from the server

  async function paint() {
    const state = await get("/api/admin/state");

    if (!state.ok) return lockScreen(
      "Couldn't reach the admin API.",
      "This copy of the site has no server behind it.");

    gate = state.data;

    if (!gate.configured) {
      return lockScreen("The admin area isn't switched on.",
        "ADMIN_PASS_HASH has to be set in the Worker's environment before this "
        + "page will open. Until it is, every admin route refuses.");
    }
    if (!gate.unlocked) return passcodeScreen();

    return panel();
  }

  function lockScreen(title, detail, actions = "") {
    sheet.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">Admin</span>
        <h2>${esc(title)}</h2>
      </header>
      <p class="note note--warn">${esc(detail)}</p>
      ${actions ? `<div class="gate__actions">${actions}</div>` : ""}`;
  }

  function passcodeScreen() {
    sheet.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">Admin</span>
        <h2>Passcode</h2>
        <p>Opens the panel for 30 minutes.</p>
      </header>
      <form class="form" data-passform>
        <label class="field">
          <span>Admin passcode</span>
          <input type="password" name="passcode" autocomplete="current-password"
                 autofocus required>
        </label>
        <div class="gate__actions">
          <button class="btn btn--primary" type="submit">Unlock</button>
        </div>
      </form>`;
    $("[name=passcode]", sheet.body)?.focus();
  }

  /* ------------------------------------------------------------ panel */

  async function panel() {
    sheet.body.innerHTML = `<p class="muted">Loading…</p>`;

    const overview = await get("/api/admin/overview");
    if (!overview.ok) {
      // 423 means the ticket lapsed while the page sat open.
      if (overview.status === 423) return passcodeScreen();
      return lockScreen("Couldn't load the panel.", overview.error || "Try again.");
    }

    const o = overview.data;
    const q = query ? `&q=${encodeURIComponent(query)}` : "";
    const rows =
      tab === "users" ? await get(`/api/admin/users?limit=100${q}`)
      : tab === "scripts" ? await get(`/api/admin/scripts?limit=100${q}`)
      : await get("/api/admin/reports");

    if (rows.status === 423) return passcodeScreen();

    sheet.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">Admin</span>
        <h2>Site administration</h2>
        <div class="dash__links">
          <span class="dash__meta">Unlocked for this session</span>
          <button class="btn btn--ghost btn--xs" data-act="lock">Lock again</button>
        </div>
      </header>

      <div class="stats">
        ${tile("Accounts", o.users)}
        ${tile("Suspended", o.banned)}
        ${tile("Live scripts", o.scripts)}
        ${tile("Taken down", o.removed)}
        ${tile("Paid unlocks", o.verified)}
        ${tile("Open reports", o.reports)}
      </div>

      <nav class="tabs" role="tablist">
        ${[["users", "Accounts"], ["scripts", "Scripts"], ["reports", "Reports"]]
          .map(([id, label]) => `<button class="tab${tab === id ? " is-on" : ""}"
            data-admintab="${id}" role="tab">${label}</button>`).join("")}
      </nav>

      ${tab === "reports" ? "" : `
        <div class="library__search" style="margin:14px 0">
          <input class="library__input" type="search" data-adminq
                 placeholder="${tab === "users" ? "Search name or email" : "Search title or author"}"
                 value="${esc(query)}">
        </div>`}

      ${!rows.ok ? `<p class="note note--warn">${esc(rows.error || "Couldn't load that list.")}</p>`
        : !rows.data.length ? `<p class="muted">Nothing here.</p>`
        : tab === "users" ? usersTable(rows.data)
        : tab === "scripts" ? scriptsTable(rows.data)
        : reportsTable(rows.data)}`;

    // Typing into the search box must not steal focus back on every repaint.
    const box = $("[data-adminq]", sheet.body);
    if (box && query) { box.focus(); box.setSelectionRange(query.length, query.length); }
  }

  const tile = (label, value) => `
    <div class="stat">
      <span class="stat__k">${esc(label)}</span>
      <span class="stat__v">${fmt(value)}</span>
    </div>`;

  function usersTable(rows) {
    return `
      <table class="rows">
        <thead><tr><th>Account</th><th>Scripts</th><th>Unlocks</th><th>Joined</th><th></th></tr></thead>
        <tbody>
          ${rows.map((u) => `
            <tr data-user="${esc(u.id)}">
              <td>
                <b>@${esc(u.username)}</b>${u.self ? ` <span class="chip chip--ok">you</span>` : ""}
                ${u.banned ? ` <span class="chip chip--warn">suspended</span>` : ""}
                <br><span class="muted">${esc(u.email)}</span>
              </td>
              <td>${fmt(u.scripts)}</td>
              <td>${fmt(u.unlocks)}</td>
              <td>${esc(u.createdAt)}</td>
              <td>
                ${u.self ? `<span class="muted">—</span>` : `
                  <button class="btn btn--ghost btn--xs" data-adminact="ban"
                          data-banned="${u.banned ? "1" : "0"}">
                    ${u.banned ? "Restore" : "Suspend"}
                  </button>
                  <button class="btn btn--ghost btn--xs btn--danger" data-adminact="wipe"
                          data-username="${esc(u.username)}">Delete</button>`}
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted">Suspending is reversible and takes their scripts off the site
         with them. Deleting is not.</p>`;
  }

  function scriptsTable(rows) {
    return `
      <table class="rows">
        <thead><tr><th>Script</th><th>Views</th><th>Copies</th><th>Reports</th><th></th></tr></thead>
        <tbody>
          ${rows.map((s) => `
            <tr data-script="${esc(s.id)}">
              <td>
                <b>${esc(s.title)}</b>${s.removed ? ` <span class="chip chip--warn">removed</span>` : ""}
                <br><span class="muted">@${esc(s.author)} · ${esc(s.game)} · ${esc(s.createdAt)}</span>
              </td>
              <td>${fmt(s.views)}</td>
              <td>${fmt(s.copies)}</td>
              <td>${s.reports ? `<b>${fmt(s.reports)}</b>` : "0"}</td>
              <td>
                <button class="btn btn--ghost btn--xs" data-adminact="state"
                        data-removed="${s.removed ? "1" : "0"}">
                  ${s.removed ? "Restore" : "Take down"}
                </button>
                <button class="btn btn--ghost btn--xs" data-adminact="counters"
                        data-views="${s.views}" data-copies="${s.copies}">Counters</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function reportsTable(rows) {
    return `
      <table class="rows">
        <thead><tr><th>Reported script</th><th>Reason</th><th>When</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr data-report="${esc(r.id)}" data-script="${esc(r.scriptId)}">
              <td>
                <b>${esc(r.title)}</b>${r.removed ? ` <span class="chip chip--warn">removed</span>` : ""}
                ${r.author ? `<br><span class="muted">@${esc(r.author)}</span>` : ""}
              </td>
              <td>${r.reason ? esc(r.reason) : `<span class="muted">no reason given</span>`}</td>
              <td class="muted">${esc(AGO(r.at))}</td>
              <td>
                ${r.removed ? "" : `<button class="btn btn--ghost btn--xs" data-adminact="takedown">Take down</button>`}
                <button class="btn btn--ghost btn--xs" data-adminact="dismiss">Dismiss</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>`;
  }

  /* ----------------------------------------------------- interactions */

  sheet.body.addEventListener("input", (e) => {
    if (!e.target.closest("[data-adminq]")) return;
    query = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(panel, 300);
  });

  sheet.body.addEventListener("submit", async (e) => {
    const form = e.target.closest("[data-passform]");
    if (!form) return;
    e.preventDefault();

    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.textContent = "Checking…";

    // 310,000 rounds takes a moment on a phone; the button says so rather than
    // looking dead.
    const derived = await derivePasscode(
      form.passcode.value, gate?.salt || "lucrit-admin-v1", gate?.iterations || 310000);
    const res = await send("/api/admin/unlock", "POST", { derived });

    btn.disabled = false;
    btn.textContent = "Unlock";

    if (!res.ok) {
      form.passcode.value = "";
      form.passcode.focus();
      return toast(res.error || "That passcode isn't right.", "warn");
    }
    toast(`Unlocked for ${res.data.minutes} minutes`);
    panel();
  });

  sheet.body.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="lock"]')) {
      await send("/api/admin/lock");
      toast("Locked");
      paint();
      return;
    }

    const tabBtn = e.target.closest("[data-admintab]");
    if (tabBtn) { tab = tabBtn.dataset.admintab; query = ""; panel(); return; }

    const btn = e.target.closest("[data-adminact]");
    if (!btn) return;

    const act = btn.dataset.adminact;
    const userId = btn.closest("[data-user]")?.dataset.user;
    const scriptId = btn.closest("[data-script]")?.dataset.script;
    const reportId = btn.closest("[data-report]")?.dataset.report;

    btn.disabled = true;
    let res = { ok: false, error: "Nothing to do." };

    if (act === "ban") {
      res = await send(`/api/admin/users/${encodeURIComponent(userId)}/ban`, "POST",
        { banned: btn.dataset.banned !== "1" });

    } else if (act === "wipe") {
      // The only irreversible thing on this page, so it asks for the name back
      // rather than a yes/no nobody reads.
      const name = btn.dataset.username || "";
      const typed = prompt(
        `Delete @${name} permanently?\n\n`
        + `This removes the account and every script it published. Their unlock `
        + `history stays, so nobody else's earnings change.\n\n`
        + `Type the username to confirm:`);
      if (typed === null) { btn.disabled = false; return; }
      res = await send(`/api/admin/users/${encodeURIComponent(userId)}`, "DELETE",
        { confirm: typed });

    } else if (act === "state" || act === "takedown") {
      res = await send(`/api/admin/scripts/${encodeURIComponent(scriptId)}/state`, "POST",
        { removed: act === "takedown" ? true : btn.dataset.removed !== "1" });

    } else if (act === "counters") {
      const views = prompt("Views:", btn.dataset.views ?? "0");
      if (views === null) { btn.disabled = false; return; }
      const copies = prompt("Copies:", btn.dataset.copies ?? "0");
      if (copies === null) { btn.disabled = false; return; }
      res = await send(`/api/admin/scripts/${encodeURIComponent(scriptId)}/counters`, "POST",
        { views, copies });

    } else if (act === "dismiss") {
      res = await send(`/api/admin/reports/${encodeURIComponent(reportId)}/dismiss`);
    }

    if (res.status === 423) { toast("The passcode timed out", "warn"); return paint(); }
    toast(res.ok ? "Done" : (res.error || "That didn't work"), res.ok ? "ok" : "warn");

    // Repaint either way: a refused action must not leave the table showing a
    // state the server never agreed to.
    panel();
    if (res.ok) onChanged?.();
  });

  return {
    open() {
      sheet.open();
      paint();
    },
    close: () => sheet.close(),
    get isOpen() { return sheet.isOpen; },
  };
}
