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
import { statusBadges, labelBadge, ADMIN_LABELS } from "./data/scripts.js";
import { listKeys, deleteKey, unlockKey, deleteMany, isExpired, makeKey } from "./keysadmin.js";

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

  // Scripts tab state.
  let filter = "all";        // see FILTERS below
  let sort = "new";
  let editing = null;        // script id whose label editor is open
  const selected = new Set();
  let scriptRows = [];       // last list drawn, for bulk actions
  let codeOpen = null;       // { id, title, code, link } — a script's code shown under its row
  let madeKey = null;        // { id, expiresAt } — the key "Make key" just made

  // Keys tab state (keys live in Firebase, not D1 — see keysadmin.js).
  let keyView = "active";    // active | expired
  let keyQuery = "";
  let keyRows = [];
  let keyTimer = 0;

  const FILTERS = [
    ["all", "All"], ["live", "Live"], ["verified", "Verified"], ["unverified", "Not verified"],
    ["labeled", "Labeled"], ["risky", "Risky"], ["reported", "Reported"],
    ["flagged", "Flagged"], ["removed", "Taken down"],
  ];
  const SORTS = [["new", "Newest"], ["old", "Oldest"], ["views", "Most views"],
    ["copies", "Most copies"], ["reports", "Most reports"], ["title", "Title A–Z"]];

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
      : tab === "scripts" ? await get(`/api/admin/scripts?limit=200${q}&f=${encodeURIComponent(filter)}&sort=${encodeURIComponent(sort)}`)
      : tab === "activity" ? await get("/api/admin/log")
      : tab === "keys" ? await listKeys().then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: e.message }))
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
        ${tile("Accounts", o.users, o.newUsersWeek ? `+${fmt(o.newUsersWeek)} this week` : "")}
        ${tile("Suspended", o.banned)}
        ${tile("Live scripts", o.scripts, o.newScriptsWeek ? `+${fmt(o.newScriptsWeek)} this week` : "")}
        ${tile("Verified scripts", o.verifiedScripts)}
        ${tile("Labeled", o.labeled)}
        ${tile("Marked risky", o.risky)}
        ${tile("Flagged", o.flagged)}
        ${tile("Taken down", o.removed)}
        ${tile("Unlocks today", o.unlocksToday, `${fmt(o.unlocksWeek)} this week`)}
        ${tile("Paid unlocks", o.verified)}
        ${tile("Paid key unlocks", o.keyUnlocks ?? 0, o.keyUnlocks ? `${fmt(o.keyUnlocksToday || 0)} today · ${fmt(o.keyUnlocksWeek || 0)} this week` : "")}
        ${tile("Open reports", o.reports)}
      </div>

      <nav class="tabs" role="tablist">
        ${[["users", "Accounts"], ["scripts", "Scripts"], ["executors", "Executors"],
           ["queue", "Discord queue"], ["reports", "Reports"], ["keys", "Keys"], ["activity", "Activity"]]
          .map(([id, label]) => `<button class="tab${tab === id ? " is-on" : ""}"
            data-admintab="${id}" role="tab">${label}</button>`).join("")}
      </nav>

      ${tab === "reports" || tab === "executors" || tab === "queue" || tab === "activity" || tab === "keys" ? "" : `
        <div class="library__search" style="margin:14px 0">
          <input class="library__input" type="search" data-adminq
                 placeholder="${tab === "users" ? "Search name or email" : "Search title, author or game"}"
                 value="${esc(query)}">
        </div>`}
      ${tab === "scripts" ? scriptsToolbar() : ""}

      ${!rows.ok ? `<p class="note note--warn">${esc(rows.error || "Couldn't load that list.")}</p>`
        // The executors tab draws even when empty: the publish form lives
        // inside it, so "Nothing here" would be a dead end with no way to add
        // the first one.
        : tab === "executors" ? executorsPanel(rows.data)
        : tab === "queue" ? queuePanel(rows.data, rows.configured)
        : tab === "activity" ? activityPanel(rows.data)
        : tab === "keys" ? keysPanel(rows.data)
        : !rows.data.length ? `<p class="muted">Nothing here${tab === "scripts" && filter !== "all" ? " for this filter" : ""}.</p>`
        : tab === "users" ? usersTable(rows.data)
        : tab === "scripts" ? scriptsTable(rows.data)
        : reportsTable(rows.data)}`;

    // The Keys tab refreshes itself every 10 s (like the old key cleaner) —
    // just the table, so typing in its search box isn't interrupted.
    clearInterval(keyTimer);
    if (tab === "keys" && rows.ok) keyTimer = setInterval(() => {
      if (!sheet.isOpen || tab !== "keys") return clearInterval(keyTimer);
      refreshKeys();
    }, 10000);

    // Typing into the search box must not steal focus back on every repaint.
    const box = $("[data-adminq]", sheet.body);
    if (box && query) { box.focus(); box.setSelectionRange(query.length, query.length); }
  }

  const tile = (label, value, sub = "") => `
    <div class="stat">
      <span class="stat__k">${esc(label)}</span>
      <span class="stat__v">${fmt(value || 0)}</span>
      ${sub ? `<span class="stat__sub">${esc(sub)}</span>` : ""}
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

  function scriptsToolbar() {
    const labelOpts = ADMIN_LABELS.map((l) =>
      `<option value="label:${l.id}"${filter === "label:" + l.id ? " selected" : ""}>Label: ${esc(l.text)}</option>`).join("");
    return `
      <div class="adm__bar">
        <div class="adm__pills" role="group" aria-label="Filter">
          ${FILTERS.map(([id, label]) => `<button class="adm__pill${filter === id ? " is-on" : ""}"
             data-adminfilter="${id}">${label}</button>`).join("")}
          <select class="adm__select" data-adminfilterlabel aria-label="Filter by label">
            <option value="">By label…</option>${labelOpts}
          </select>
        </div>
        <label class="adm__sort">Sort
          <select class="adm__select" data-adminsort>
            ${SORTS.map(([id, label]) => `<option value="${id}"${sort === id ? " selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
      </div>`;
  }

  function bulkBar() {
    if (!selected.size) return "";
    return `
      <div class="adm__bulk" data-bulkbar>
        <b>${selected.size} selected</b>
        <button class="btn btn--ghost btn--xs" data-bulk="verify">Verify</button>
        <button class="btn btn--ghost btn--xs" data-bulk="unverify">Unverify</button>
        <select class="adm__select" data-bulklabel aria-label="Label">
          ${ADMIN_LABELS.map((l) => `<option value="${l.id}">${esc(l.text)}</option>`).join("")}
        </select>
        <button class="btn btn--ghost btn--xs" data-bulk="addlabel">Add label</button>
        <button class="btn btn--ghost btn--xs" data-bulk="removelabel">Remove label</button>
        <button class="btn btn--ghost btn--xs btn--danger" data-bulk="takedown">Take down</button>
        <button class="btn btn--ghost btn--xs" data-bulk="restore">Restore</button>
        <button class="btn btn--ghost btn--xs" data-bulk="clear">Clear selection</button>
      </div>`;
  }

  // The label editor shows each label exactly as visitors will see it.
  function labelEditor(s) {
    return `
      <tr class="adm__editor" data-editor="${esc(s.id)}" data-script="${esc(s.id)}">
        <td colspan="6">
          <p class="adm__edhead"><b>Labels for “${esc(s.title)}”</b>
            <span class="muted">Shown on the script page and its card. Red ones also put a warning box on the page.</span></p>
          <div class="adm__labels">
            ${ADMIN_LABELS.map((l) => `
              <label class="adm__labelpick${l.warn ? " is-warn" : ""}">
                <input type="checkbox" name="lbl" value="${l.id}"${(s.labels || []).includes(l.id) ? " checked" : ""}>
                ${labelBadge(l.id)}
                <span class="muted">${esc(l.tip)}</span>
              </label>`).join("")}
          </div>
          <label class="field" style="margin-top:12px"><span>Staff note (optional, shown on the script page)</span>
            <input name="staffnote" maxlength="280" value="${esc(s.staffNote || "")}"
                   placeholder="e.g. Uses remote spam that the game's anti-cheat catches — alt accounts only."></label>
          <div class="gate__actions" style="justify-content:flex-start;margin-top:10px">
            <button class="btn btn--primary btn--sm" data-adminact="savelabels">Save labels</button>
            <button class="btn btn--ghost btn--sm" data-adminact="clearlabels">Remove all</button>
            <button class="btn btn--ghost btn--sm" data-adminact="closeeditor">Cancel</button>
          </div>
        </td>
      </tr>`;
  }

  // A script's code and link, straight from the server — no unlock needed.
  function codeRow(c) {
    return `
      <tr class="adm__editor" data-script="${esc(c.id)}" data-coderow>
        <td colspan="6">
          <p class="adm__edhead"><b>Code for “${esc(c.title || "")}”</b>
            <span class="muted">Staff view — no sponsor step, not counted as a copy.</span></p>
          ${c.link ? `<p style="margin:6px 0">Link: <a href="${esc(c.link)}" target="_blank" rel="noopener noreferrer">${esc(c.link)}</a></p>` : ""}
          ${c.code ? `<pre class="adm__code" data-codebox>${esc(c.code)}</pre>` : `<p class="muted">No code saved — this script is link-only.</p>`}
          <div class="gate__actions" style="justify-content:flex-start;margin-top:10px">
            ${c.code ? `<button class="btn btn--primary btn--sm" data-adminact="copycode">Copy code</button>` : ""}
            ${c.link ? `<button class="btn btn--ghost btn--sm" data-adminact="copylink">Copy link</button>` : ""}
            <button class="btn btn--ghost btn--sm" data-adminact="closecode">Close</button>
          </div>
        </td>
      </tr>`;
  }

  function scriptsTable(rows) {
    scriptRows = rows;
    for (const id of [...selected]) if (!rows.some((r) => r.id === id)) selected.delete(id);
    const flagged = rows.filter((s) => s.state && s.state !== "approved" && !s.removed).length;
    const allOn = rows.length && rows.every((r) => selected.has(r.id));
    return `
      ${flagged && filter !== "flagged" ? `
        <p class="note note--warn">
          ${flagged} script${flagged === 1 ? " is" : "s are"} flagged by the checker.
          ${flagged === 1 ? "It is" : "They are"} live and visible like any other —
          this is a note to look, not a takedown.
        </p>` : ""}
      <p class="muted" style="margin:0 0 8px">${fmt(rows.length)} script${rows.length === 1 ? "" : "s"}${rows.length >= 200 ? " (first 200 — search or filter to narrow)" : ""}</p>
      ${bulkBar()}
      <table class="rows">
        <thead><tr>
          <th style="width:28px"><input type="checkbox" data-selectall aria-label="Select all"${allOn ? " checked" : ""}></th>
          <th>Script</th><th>Views</th><th>Copies</th><th>Reports</th><th></th></tr></thead>
        <tbody>
          ${rows.map((s) => `
            <tr data-script="${esc(s.id)}"${s.removed ? ' class="is-removed"' : ""}>
              <td><input type="checkbox" data-select="${esc(s.id)}" aria-label="Select ${esc(s.title)}"${selected.has(s.id) ? " checked" : ""}></td>
              <td>
                <b>${esc(s.title)}</b>
                ${s.removed ? ` <span class="chip chip--warn">removed</span>` : ""}
                ${s.state && s.state !== "approved" && !s.removed
                  ? ` <span class="chip chip--warn" title="${esc(s.note || "The checker wasn't confident.")}">flagged</span>`
                  : ""}
                <div class="adm__badges">${statusBadges(s)}</div>
                <span class="muted">@${esc(s.author)} · ${esc(s.game)} · ${esc(s.createdAt)}</span>
                ${s.staffNote ? `<br><span class="muted">Staff note: ${esc(s.staffNote)}</span>` : ""}
                ${s.state && s.state !== "approved" && s.note
                  ? `<br><span class="muted">Checker: ${esc(s.note)}</span>`
                  : ""}
              </td>
              <td>${fmt(s.views)}</td>
              <td>${fmt(s.copies)}</td>
              <td>${s.reports ? `<b>${fmt(s.reports)}</b>` : "0"}</td>
              <td class="adm__acts">
                ${s.removed ? "" : `<a class="btn btn--ghost btn--xs" target="_blank" rel="noopener"
                   href="/creations/${encodeURIComponent(s.author)}/${encodeURIComponent(s.slug || "")}">View ↗</a>`}
                <button class="btn btn--primary btn--xs" data-adminact="getcode">${codeOpen?.id === s.id ? "Hide code" : "Get code"}</button>
                <button class="btn btn--ghost btn--xs" data-adminact="labels">Labels${s.labels?.length ? ` (${s.labels.length})` : ""}</button>
                <button class="btn btn--ghost btn--xs" data-adminact="verify"
                        data-verified="${s.verified ? "1" : "0"}">
                  ${s.verified ? "Unverify" : "Verify"}
                </button>
                ${s.state && s.state !== "approved"
                  ? `<button class="btn btn--ghost btn--xs" data-adminact="clearflag">Clear flag</button>`
                  : ""}
                <button class="btn btn--ghost btn--xs" data-adminact="state"
                        data-removed="${s.removed ? "1" : "0"}">
                  ${s.removed ? "Restore" : "Take down"}
                </button>
                <button class="btn btn--ghost btn--xs" data-adminact="counters"
                        data-views="${s.views}" data-copies="${s.copies}">Counters</button>
                <button class="btn btn--ghost btn--xs" data-adminact="copyid">Copy ID</button>
              </td>
            </tr>
            ${editing === s.id ? labelEditor(s) : ""}
            ${codeOpen?.id === s.id ? codeRow(codeOpen) : ""}`).join("")}
        </tbody>
      </table>
      <p class="muted">A script stays on the site until it is taken down here, or its
         author is suspended. Nothing else hides one.</p>`;
  }

  /* ------------------------------------------------------------- keys */

  const LEFT = (ms) => {
    if (ms <= 0) return "expired";
    const m = Math.floor(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
  };
  const PINGED = (ms) => typeof ms === "number" && ms > 0 ? AGO(Math.floor(ms / 1000)) : "—";

  function keyRowsHtml() {
    const now = Date.now();
    const q = keyQuery.trim().toUpperCase();
    const list = keyRows
      .filter((k) => (keyView === "expired") === isExpired(k, now))
      .filter((k) => !q || k.id.toUpperCase().includes(q) || String(k.userId).includes(q) || String(k.boundTo).includes(q))
      .sort((a, b) => keyView === "expired"
        ? (b.expiresAt || 0) - (a.expiresAt || 0)
        : (Number(b.inUse) - Number(a.inUse)) || ((b.lastPing || 0) - (a.lastPing || 0)) || ((b.expiresAt || 0) - (a.expiresAt || 0)));
    if (!list.length) {
      return `<tr><td colspan="${keyView === "expired" ? 4 : 7}" class="muted" style="text-align:center;padding:18px">
        ${q ? "No keys match that search." : keyView === "expired" ? "✓ No expired keys." : "No active keys right now."}</td></tr>`;
    }
    return list.map((k) => keyView === "expired" ? `
      <tr data-key="${esc(k.id)}">
        <td><code class="adm__key">${esc(k.id)}</code></td>
        <td class="muted">${typeof k.expiresAt === "number" ? esc(new Date(k.expiresAt).toLocaleString()) : "no expiry set"}</td>
        <td class="muted">${k.valid === false ? "revoked" : "expired"}</td>
        <td class="adm__acts"><button class="btn btn--ghost btn--xs btn--danger" data-keyact="delete">Delete</button></td>
      </tr>` : `
      <tr data-key="${esc(k.id)}">
        <td><code class="adm__key">${esc(k.id)}</code>
          <button class="adm__copy" data-keyact="copy" title="Copy key" aria-label="Copy key">⧉</button></td>
        <td title="${esc(new Date(k.expiresAt).toLocaleString())}">${esc(LEFT(k.expiresAt - now))}</td>
        <td>${k.inUse ? `<span class="chip chip--ok">in use</span>` : `<span class="muted">free</span>`}</td>
        <td class="muted">${esc(k.sessionId || "—")}</td>
        <td class="muted">${esc(k.userId || "—")}${k.boundTo && k.boundTo !== k.userId ? `<br><span title="boundTo">bound: ${esc(k.boundTo)}</span>` : ""}</td>
        <td class="muted">${esc(PINGED(k.lastPing))}</td>
        <td class="adm__acts">
          <button class="btn btn--ghost btn--xs" data-keyact="unlock" ${k.inUse || k.sessionId || k.userId ? "" : "disabled"}>🔓 Unlock</button>
          <button class="btn btn--ghost btn--xs btn--danger" data-keyact="delete">Delete</button>
        </td>
      </tr>`).join("");
  }

  function keyCounts() {
    const now = Date.now();
    const expired = keyRows.filter((k) => isExpired(k, now)).length;
    const active = keyRows.length - expired;
    const inUse = keyRows.filter((k) => !isExpired(k, now) && k.inUse).length;
    return { active, expired, inUse };
  }

  function keysPanel(rows) {
    keyRows = rows;
    const c = keyCounts();
    return `
      <div class="stats" data-keystats style="margin-bottom:14px">
        ${tile("Active keys", c.active)}
        ${tile("In use now", c.inUse)}
        ${tile("Expired", c.expired)}
      </div>
      <div class="adm__make" data-makekey>
        <b>Make a key</b>
        <span class="muted">Instantly, with no LootLabs or Linkvertise steps. It works in the loader like any other key.</span>
        <select class="adm__select" data-keyhours aria-label="How long the key lasts">
          <option value="8">8 hours (same as /getkey)</option>
          <option value="24">24 hours</option>
          <option value="168">7 days</option>
          <option value="720">30 days</option>
        </select>
        <button class="btn btn--primary btn--xs" data-keyact="make">＋ Make key</button>
        ${madeKey ? `<span class="adm__made" data-madekey>
          <code class="adm__key">${esc(madeKey.id)}</code>
          <button class="adm__copy" data-keyact="copymade" title="Copy key" aria-label="Copy key">⧉</button>
          <span class="muted">${esc(LEFT(madeKey.expiresAt - Date.now()))}</span></span>` : ""}
      </div>
      <div class="adm__bar">
        <div class="adm__pills" role="group" aria-label="Which keys">
          <button class="adm__pill${keyView === "active" ? " is-on" : ""}" data-keyview="active">Active keys</button>
          <button class="adm__pill${keyView === "expired" ? " is-on" : ""}" data-keyview="expired">Expired keys</button>
          <button class="btn btn--ghost btn--xs" data-keyact="refresh">↻ Refresh</button>
        </div>
        ${keyView === "expired"
          ? `<button class="btn btn--xs btn--danger" data-keyact="deleteexpired" ${c.expired ? "" : "disabled"}>🧹 Delete all expired (${fmt(c.expired)})</button>`
          : ""}
      </div>
      <div class="library__search" style="margin:0 0 12px">
        <input class="library__input" type="search" data-keyq placeholder="Search a key or Roblox user id" value="${esc(keyQuery)}">
      </div>
      <table class="rows">
        <thead><tr>${keyView === "expired"
          ? `<th>Key</th><th>Expired</th><th>Status</th><th></th>`
          : `<th>Key</th><th>Expires</th><th>In use</th><th>Session</th><th>User</th><th>Last ping</th><th></th>`}</tr></thead>
        <tbody data-keysbody>${keyRowsHtml()}</tbody>
      </table>
      <p class="muted">Keys from <a href="/getkey" target="_blank" rel="noopener">/getkey</a>, read live from Firebase
        (smh-keysystem) and refreshed every 10 seconds. <b>Unlock</b> frees a key that's stuck "in use" so it can be
        used again; <b>Delete</b> kills it — the loader will reject it straight away.</p>`;
  }

  async function refreshKeys() {
    try { keyRows = await listKeys(); } catch { return; }
    const body = $("[data-keysbody]", sheet.body);
    const stats = $("[data-keystats]", sheet.body);
    if (!body) return;
    body.innerHTML = keyRowsHtml();
    const c = keyCounts();
    if (stats) stats.innerHTML = tile("Active keys", c.active) + tile("In use now", c.inUse) + tile("Expired", c.expired);
    const del = $('[data-keyact="deleteexpired"]', sheet.body);
    if (del) { del.textContent = `🧹 Delete all expired (${fmt(c.expired)})`; del.disabled = !c.expired; }
  }

  // Record key actions in the Activity tab (best effort — Firebase did the work).
  const logKey = (action, target, detail = "") =>
    send("/api/admin/log", "POST", { action, target, detail }).catch(() => {});

  function activityPanel(rows) {
    if (!rows.length) return `<div class="empty"><p><b>No activity yet.</b> Verifies, labels, takedowns,
      suspensions and dismissed reports show up here as they happen.</p></div>`;
    return `
      <table class="rows">
        <thead><tr><th>When</th><th>Action</th><th>On</th><th>Details</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td class="muted" title="${esc(new Date(r.at * 1000).toLocaleString())}">${esc(AGO(r.at))}</td>
              <td><b>${esc(r.action)}</b></td>
              <td>${esc(r.target)}</td>
              <td class="muted">${esc(r.detail || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <p class="muted">The newest 200 of the last 1,000 admin actions.</p>`;
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

  sheet.body.addEventListener("change", (e) => {
    const t = e.target;
    if (t.matches("[data-adminsort]")) { sort = t.value; panel(); return; }
    if (t.matches("[data-adminfilterlabel]")) { if (t.value) { filter = t.value; selected.clear(); panel(); } return; }
    if (t.matches("[data-select]")) {
      if (t.checked) selected.add(t.dataset.select); else selected.delete(t.dataset.select);
      redrawBulk(); return;
    }
    if (t.matches("[data-selectall]")) {
      for (const r of scriptRows) { if (t.checked) selected.add(r.id); else selected.delete(r.id); }
      sheet.body.querySelectorAll("[data-select]").forEach((c) => { c.checked = t.checked; });
      redrawBulk(); return;
    }
  });

  // The bulk bar redraws on its own so ticking a box doesn't refetch the list.
  function redrawBulk() {
    const old = $("[data-bulkbar]", sheet.body);
    const html = bulkBar();
    if (old) { if (html) old.outerHTML = html; else old.remove(); return; }
    if (html) $("table.rows", sheet.body)?.insertAdjacentHTML("beforebegin", html);
  }

  async function runBulk(kind) {
    const ids = [...selected];
    const label = $("[data-bulklabel]", sheet.body)?.value;
    if (kind === "takedown" && !confirm(`Take down ${ids.length} script${ids.length === 1 ? "" : "s"}?`)) return;
    let done = 0, failed = 0;
    for (const id of ids) {
      const row = scriptRows.find((r) => r.id === id);
      const path = `/api/admin/scripts/${encodeURIComponent(id)}`;
      let res;
      if (kind === "verify" || kind === "unverify") res = await send(`${path}/verify`, "POST", { verified: kind === "verify" });
      else if (kind === "takedown" || kind === "restore") res = await send(`${path}/state`, "POST", { removed: kind === "takedown" });
      else if (kind === "addlabel" || kind === "removelabel") {
        const cur = new Set(row?.labels || []);
        if (kind === "addlabel") cur.add(label); else cur.delete(label);
        res = await send(`${path}/labels`, "POST", { labels: [...cur] });
      }
      if (res?.status === 423) { toast("The passcode timed out", "warn"); return paint(); }
      if (res?.ok) done++; else failed++;
    }
    toast(failed ? `${done} done, ${failed} failed` : `Done — ${done} script${done === 1 ? "" : "s"}`, failed ? "warn" : "ok");
    selected.clear();
    panel();
    if (done) onChanged?.();
  }

  sheet.body.addEventListener("input", (e) => {
    if (e.target.closest("[data-keyq]")) {
      keyQuery = e.target.value;
      const body = $("[data-keysbody]", sheet.body);
      if (body) body.innerHTML = keyRowsHtml();
      return;
    }
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

    const kv = e.target.closest("[data-keyview]");
    if (kv) { keyView = kv.dataset.keyview; panel(); return; }

    const kb = e.target.closest("[data-keyact]");
    if (kb) {
      const kact = kb.dataset.keyact;
      const keyId = kb.closest("[data-key]")?.dataset.key;
      if (kact === "refresh") { kb.disabled = true; await refreshKeys(); kb.disabled = false; return; }
      if (kact === "make") {
        const hours = Number($("[data-keyhours]", sheet.body)?.value) || 8;
        kb.disabled = true; kb.textContent = "Making…";
        try {
          madeKey = await makeKey(hours);
          logKey("Key made by admin", madeKey.id, `${hours}h, no sponsor steps`);
          try { await navigator.clipboard.writeText(madeKey.id); toast("Made and copied " + madeKey.id); }
          catch { toast("Made " + madeKey.id); }
          keyView = "active";
          keyRows = await listKeys().catch(() => keyRows);
        } catch (err) { toast(err.message || "Couldn't make a key", "warn"); }
        panel();
        return;
      }
      if (kact === "copymade") {
        try { await navigator.clipboard.writeText(madeKey?.id || ""); toast("Copied " + madeKey?.id); }
        catch { prompt("Key:", madeKey?.id || ""); }
        return;
      }
      if (kact === "copy") {
        try { await navigator.clipboard.writeText(keyId); toast("Copied " + keyId); }
        catch { prompt("Key:", keyId); }
        return;
      }
      if (kact === "delete") {
        const active = !isExpired(keyRows.find((k) => k.id === keyId) || {});
        if (active && !confirm(`Delete ${keyId}?\n\nIt's still active — whoever is using it will be kicked out by the loader.`)) return;
        kb.disabled = true; kb.textContent = "Deleting…";
        try {
          await deleteKey(keyId);
          logKey(active ? "Key deleted (active)" : "Key deleted", keyId);
          toast("Deleted " + keyId);
        } catch (err) { toast(err.message || "Couldn't delete that key", "warn"); }
        return refreshKeys();
      }
      if (kact === "unlock") {
        kb.disabled = true; kb.textContent = "Unlocking…";
        try {
          await unlockKey(keyId);
          logKey("Key unlocked", keyId, "cleared inUse, sessionId, userId, lastPing");
          toast("Unlocked " + keyId);
        } catch (err) { toast(err.message || "Couldn't unlock that key", "warn"); }
        return refreshKeys();
      }
      if (kact === "deleteexpired") {
        const ids = keyRows.filter((k) => isExpired(k)).map((k) => k.id);
        if (!ids.length) return;
        if (!confirm(`Delete all ${ids.length} expired key${ids.length === 1 ? "" : "s"}?`)) return;
        kb.disabled = true;
        const res = await deleteMany(ids, (d, n) => { kb.textContent = `Deleting… ${d}/${n}`; });
        logKey("Expired keys cleaned", `${res.done} key${res.done === 1 ? "" : "s"}`, res.failed ? `${res.failed} failed` : "");
        toast(res.failed ? `Deleted ${res.done}, ${res.failed} failed` : `Deleted ${res.done} expired key${res.done === 1 ? "" : "s"}`, res.failed ? "warn" : "ok");
        return refreshKeys();
      }
      return;
    }

    const tabBtn = e.target.closest("[data-admintab]");
    if (tabBtn) { tab = tabBtn.dataset.admintab; query = ""; editing = null; selected.clear(); panel(); return; }

    const pill = e.target.closest("[data-adminfilter]");
    if (pill) { filter = pill.dataset.adminfilter; selected.clear(); editing = null; panel(); return; }

    const bulk = e.target.closest("[data-bulk]");
    if (bulk) {
      if (bulk.dataset.bulk === "clear") { selected.clear(); panel(); return; }
      bulk.disabled = true;
      await runBulk(bulk.dataset.bulk);
      return;
    }

    const btn = e.target.closest("[data-adminact]");
    if (!btn) return;

    const act = btn.dataset.adminact;
    const userId = btn.closest("[data-user]")?.dataset.user;
    const executor = btn.closest("[data-executor]")?.dataset.executor;
    const scriptId = btn.closest("[data-script]")?.dataset.script;
    const reportId = btn.closest("[data-report]")?.dataset.report;

    // Editor open/close and clipboard don't call the server.
    if (act === "labels") { editing = editing === scriptId ? null : scriptId; panel(); return; }
    if (act === "closeeditor") { editing = null; panel(); return; }
    if (act === "closecode") { codeOpen = null; panel(); return; }
    if (act === "getcode") {
      if (codeOpen?.id === scriptId) { codeOpen = null; panel(); return; }
      btn.disabled = true; btn.textContent = "Loading…";
      const r = await get(`/api/admin/scripts/${encodeURIComponent(scriptId)}/code`);
      if (!r.ok) { toast(r.error || "Couldn't load the code", "warn"); btn.disabled = false; btn.textContent = "Get code"; return; }
      codeOpen = r.data;
      panel();
      return;
    }
    if (act === "copycode" || act === "copylink") {
      const text = act === "copycode" ? codeOpen?.code : codeOpen?.link;
      try { await navigator.clipboard.writeText(text || ""); toast(act === "copycode" ? "Code copied" : "Link copied"); }
      catch { prompt("Copy:", text || ""); }
      return;
    }
    if (act === "copyid") {
      try { await navigator.clipboard.writeText(scriptId); toast("Copied " + scriptId); }
      catch { prompt("Script ID:", scriptId); }
      return;
    }

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

    } else if (act === "savelabels" || act === "clearlabels") {
      const ed = btn.closest("[data-editor]");
      const labels = act === "clearlabels" ? []
        : [...ed.querySelectorAll('input[name="lbl"]:checked')].map((c) => c.value);
      const note = act === "clearlabels" ? "" : ed.querySelector('input[name="staffnote"]').value;
      res = await send(`/api/admin/scripts/${encodeURIComponent(scriptId)}/labels`, "POST", { labels, note });
      if (res.ok) editing = null;

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
