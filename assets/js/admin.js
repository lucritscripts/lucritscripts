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
      : tab === "executors" ? await get("/api/admin/executors")
      : tab === "queue" ? await get("/api/admin/discord/queue")
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
        ${[["users", "Accounts"], ["scripts", "Scripts"], ["executors", "Executors"],
           ["queue", "Discord queue"], ["reports", "Reports"]]
          .map(([id, label]) => `<button class="tab${tab === id ? " is-on" : ""}"
            data-admintab="${id}" role="tab">${label}</button>`).join("")}
      </nav>

      ${tab === "reports" || tab === "executors" || tab === "queue" ? "" : `
        <div class="library__search" style="margin:14px 0">
          <input class="library__input" type="search" data-adminq
                 placeholder="${tab === "users" ? "Search name or email" : "Search title or author"}"
                 value="${esc(query)}">
        </div>`}

      ${!rows.ok ? `<p class="note note--warn">${esc(rows.error || "Couldn't load that list.")}</p>`
        // The executors tab draws even when empty: the publish form lives
        // inside it, so "Nothing here" would be a dead end with no way to add
        // the first one.
        : tab === "executors" ? executorsPanel(rows.data)
        : tab === "queue" ? queuePanel(rows.data, rows.configured)
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
    const flagged = rows.filter((s) => s.state && s.state !== "approved" && !s.removed).length;
    return `
      ${flagged ? `
        <p class="note note--warn">
          ${flagged} script${flagged === 1 ? " is" : "s are"} flagged by the checker.
          ${flagged === 1 ? "It is" : "They are"} live and visible like any other —
          this is a note to look, not a takedown.
        </p>` : ""}
      <table class="rows">
        <thead><tr><th>Script</th><th>Views</th><th>Copies</th><th>Reports</th><th></th></tr></thead>
        <tbody>
          ${rows.map((s) => `
            <tr data-script="${esc(s.id)}">
              <td>
                <b>${esc(s.title)}</b>
                ${s.removed ? ` <span class="chip chip--warn">removed</span>` : ""}
                ${s.state && s.state !== "approved" && !s.removed
                  ? ` <span class="chip chip--warn" title="${esc(s.note || "The checker wasn't confident.")}">flagged</span>`
                  : ""}
                ${s.verified ? ` <span class="badge badge--verified">✓ Verified</span>` : ""}
                ${s.lua ? ` <span class="badge badge--lua">Lua Detected</span>` : ""}
                <br><span class="muted">@${esc(s.author)} · ${esc(s.game)} · ${esc(s.createdAt)}</span>
                ${s.state && s.state !== "approved" && s.note
                  ? `<br><span class="muted">Checker: ${esc(s.note)}</span>`
                  : ""}
              </td>
              <td>${fmt(s.views)}</td>
              <td>${fmt(s.copies)}</td>
              <td>${s.reports ? `<b>${fmt(s.reports)}</b>` : "0"}</td>
              <td>
                ${s.state && s.state !== "approved"
                  ? `<button class="btn btn--ghost btn--xs" data-adminact="clearflag">Clear flag</button>`
                  : ""}
                <button class="btn btn--ghost btn--xs" data-adminact="verify"
                        data-verified="${s.verified ? "1" : "0"}">
                  ${s.verified ? "Unverify" : "Verify"}
                </button>
                <button class="btn btn--ghost btn--xs" data-adminact="state"
                        data-removed="${s.removed ? "1" : "0"}">
                  ${s.removed ? "Restore" : "Take down"}
                </button>
                <button class="btn btn--ghost btn--xs" data-adminact="counters"
                        data-views="${s.views}" data-copies="${s.copies}">Counters</button>
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted">A script stays on the site until it is taken down here, or its
         author is suspended. Nothing else hides one.</p>`;
  }

  /**
   * The one place on this site that publishes an executor.
   *
   * It is a convenience, not a permission. Every button here calls a route
   * that starts with `requireAdmin` in the Worker, and that check is what
   * makes executors staff-only — not the fact that this panel sits behind a
   * passcode screen. Deleting this whole file would change nothing about who
   * is allowed to publish.
   */
  function executorsPanel(rows) {
    const opts = [["working", "Working"], ["updating", "Updating"], ["unavailable", "Unavailable"]];
    return `
      <details class="pane" data-xform ${rows.length ? "" : "open"}>
        <summary><b>Publish an executor</b></summary>
        <form class="form form--grid" data-xnew style="margin-top:14px">
          <label class="field"><span>Name</span>
            <input name="name" required maxlength="60" placeholder="Solara"></label>
          <label class="field"><span>Developer</span>
            <input name="developer" required maxlength="60" placeholder="Who makes it"></label>
          <label class="field"><span>Version</span>
            <input name="version" maxlength="30" placeholder="3.1"></label>
          <label class="field"><span>Status</span>
            <select name="status">${opts.map(([v, l]) =>
              `<option value="${v}">${l}</option>`).join("")}</select></label>
          <label class="field"><span>Platforms</span>
            <input name="platforms" maxlength="120" placeholder="Windows, Android"></label>
          <label class="field"><span>Roblox versions</span>
            <input name="robloxVersions" maxlength="60" placeholder="Latest"></label>
          <label class="field" style="grid-column:1/-1"><span>Official site</span>
            <input name="website" maxlength="300" placeholder="https://…"></label>
          <label class="field" style="grid-column:1/-1"><span>Their Discord</span>
            <input name="discord" maxlength="300" placeholder="https://discord.gg/…"></label>
          <label class="field" style="grid-column:1/-1"><span>Description</span>
            <textarea name="desc" required rows="4" maxlength="2000"
              placeholder="What it is, in the developer's own terms."></textarea></label>
          <p class="submit__note" style="grid-column:1/-1">
            Links are checked against a fixed host list before they are stored;
            anything else is dropped rather than saved. The description goes
            through the same tidy-up creators get, which may not add a claim
            you did not write.
          </p>
          <div class="publish__actions" style="grid-column:1/-1">
            <button class="btn btn--primary" type="submit">Publish</button>
          </div>
        </form>
      </details>

      ${rows.length ? `
        <table class="rows">
          <thead><tr><th>Executor</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            ${rows.map((x) => `
              <tr data-executor="${esc(x.slug)}">
                <td>
                  <b>${esc(x.name)}</b>${x.removed ? ` <span class="chip chip--warn">removed</span>` : ""}
                  <br><span class="muted">${esc(x.developer)}${x.version ? ` · v${esc(x.version)}` : ""}</span>
                </td>
                <td>${esc(x.status)}</td>
                <td class="muted">${esc(x.updated || "")}</td>
                <td>
                  <button class="btn btn--ghost btn--xs" data-adminact="xstatus"
                          data-status="${esc(x.status)}">Status</button>
                  <button class="btn btn--ghost btn--xs" data-adminact="xversion"
                          data-version="${esc(x.version || "")}">Version</button>
                  <button class="btn btn--ghost btn--xs" data-adminact="xstate"
                          data-removed="${x.removed ? "1" : "0"}">
                    ${x.removed ? "Restore" : "Take down"}
                  </button>
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
        <p class="muted">Taking one down strikes its Discord posts through rather
           than deleting them, and restoring puts them back. Status and version
           changes post a note in #executor-updates saying what changed.</p>`
        : `<p class="muted">No executors listed yet.</p>`}`;
  }

  /**
   * Discord work that failed and is waiting to be retried.
   *
   * This panel exists because "it retries automatically" and "you can see that
   * it is retrying" are different properties, and only the second one lets
   * somebody answer "why is my script not in the server". An empty table here
   * is the good state and says so.
   */
  function queuePanel(rows, configured) {
    const when = (secs) => secs <= 0 ? "due now"
      : secs < 60 ? `in ${secs}s`
      : secs < 3600 ? `in ${Math.round(secs / 60)}m`
      : `in ${Math.round(secs / 3600)}h`;

    if (!configured) {
      return `<p class="note note--warn">The Discord bot isn't configured, so nothing is
        being sent and nothing is queued.</p>`;
    }
    if (!rows.length) {
      return `<div class="empty">
        <p><b>Nothing queued.</b> Every Discord post has gone through.</p>
      </div>`;
    }

    return `
      <p class="note note--warn">
        ${rows.length} Discord ${rows.length === 1 ? "post" : "posts"} did not go through.
        The site retries these on its own; this is here so you can see them and push them now.
      </p>
      <div class="gate__actions" style="justify-content:flex-start;margin-bottom:14px">
        <button class="btn btn--primary btn--sm" data-adminact="retryqueue">Retry all now</button>
      </div>
      <table class="rows">
        <thead><tr><th>Script</th><th>What</th><th>Tries</th><th>Next</th><th>Error</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>
                <b>${esc(r.title)}</b>${r.gaveUp ? ` <span class="chip chip--warn">gave up</span>` : ""}
                <br><span class="muted">${r.author ? "@" + esc(r.author) + " · " : ""}${esc(r.scriptId)}</span>
              </td>
              <td>${esc(r.kind)}</td>
              <td>${fmt(r.attempts)}</td>
              <td class="muted">${esc(when(r.dueIn))}</td>
              <td class="muted">${esc(r.error || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted">A failed Discord post never fails the publish — the script is on the
         site either way. These retry with a growing delay, and stop retrying on their own
         after several attempts so a permanently broken one doesn't hammer Discord forever.</p>`;
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
    // Two forms live in this sheet now. The publish form is handled first and
    // returns, so the passcode branch below can keep assuming it owns the
    // event rather than growing a nested conditional.
    const xform = e.target.closest("[data-xnew]");
    if (xform) {
      e.preventDefault();
      const btn = xform.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Publishing…";

      const list = (v) => String(v || "").split(",").map((t) => t.trim()).filter(Boolean);
      // Through `elements`, not `xform.<field>` directly.
      //
      // The shorthand does work: HTMLFormElement is [LegacyOverrideBuiltIns],
      // so a control named "name" shadows the form's own `name` property and
      // `xform.name.value` reads the input — which is exactly the problem. The
      // shadowing runs the other way too, and it is silent: a field named
      // `submit`, `action`, `method` or `reset` would quietly replace the form
      // API of the same name for everyone else holding this element. Reading
      // through `elements` means naming a field can never do that.
      const f = (k) => xform.elements[k]?.value || "";
      const res = await send("/api/admin/executors", "POST", {
        name: f("name"),
        developer: f("developer"),
        version: f("version"),
        status: f("status"),
        platforms: list(f("platforms")),
        robloxVersions: f("robloxVersions"),
        website: f("website"),
        discord: f("discord"),
        desc: f("desc"),
      });

      btn.disabled = false;
      btn.textContent = "Publish";

      if (res.status === 423) { toast("The passcode timed out", "warn"); return paint(); }
      if (!res.ok) return toast(res.error || "That didn't publish", "warn");
      toast(`Published ${res.data.name}`);
      panel();
      return;
    }

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
    if (e.target.closest('[data-adminact="retryqueue"]')) {
      const btn = e.target.closest("[data-adminact]");
      btn.disabled = true;
      btn.textContent = "Retrying…";
      const res = await send("/api/admin/discord/queue", "POST");
      if (res.status === 423) { toast("The passcode timed out", "warn"); return paint(); }
      toast(res.ok
        ? `Ran ${res.data.ran}, ${res.data.succeeded} went through, ${res.data.remaining} left`
        : (res.error || "That didn't work"), res.ok ? "ok" : "warn");
      panel();
      return;
    }

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
    const executor = btn.closest("[data-executor]")?.dataset.executor;
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

    } else if (act === "clearflag") {
      res = await send(`/api/admin/scripts/${encodeURIComponent(scriptId)}/state`, "POST",
        { status: "approved" });

    } else if (act === "verify") {
      res = await send(`/api/admin/scripts/${encodeURIComponent(scriptId)}/verify`, "POST",
        { verified: btn.dataset.verified !== "1" });

    } else if (act === "counters") {
      const views = prompt("Views:", btn.dataset.views ?? "0");
      if (views === null) { btn.disabled = false; return; }
      const copies = prompt("Copies:", btn.dataset.copies ?? "0");
      if (copies === null) { btn.disabled = false; return; }
      res = await send(`/api/admin/scripts/${encodeURIComponent(scriptId)}/counters`, "POST",
        { views, copies });

    } else if (act === "xstatus") {
      const next = prompt("Status — working, updating or unavailable:", btn.dataset.status || "working");
      if (next === null) { btn.disabled = false; return; }
      res = await send(`/api/admin/executors/${encodeURIComponent(executor)}`, "POST",
        { status: String(next).trim().toLowerCase() });

    } else if (act === "xversion") {
      const next = prompt("Version:", btn.dataset.version || "");
      if (next === null) { btn.disabled = false; return; }
      res = await send(`/api/admin/executors/${encodeURIComponent(executor)}`, "POST",
        { version: String(next).trim() });

    } else if (act === "xstate") {
      res = await send(`/api/admin/executors/${encodeURIComponent(executor)}/state`, "POST",
        { removed: btn.dataset.removed !== "1" });

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
