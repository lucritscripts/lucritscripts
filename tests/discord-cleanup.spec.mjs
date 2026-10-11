// Discord posts must not outlive their scripts.
//
// Reproduces a production bug exactly: two test accounts were deleted from the
// admin panel, their scripts went with them (ON DELETE CASCADE), and their six
// Discord posts stayed up with live "Get Script" buttons pointing at nothing.
// `script_posts` has no foreign key — it also tracks executors — so nothing
// cascaded to it and nothing told Discord.
//
// Suspending an account had the same gap: the site hid the scripts, the server
// kept advertising them.
//
// API-level, no browser: the subject is what reaches Discord, and that is
// cheaper and more exact to observe at the fetch boundary.
import crypto from "node:crypto";
import worker from "../_worker.js";
import { freshEnv, counter } from "./harness.mjs";

const { check, done } = counter();

const derive = (p) =>
  crypto.pbkdf2Sync(p, Buffer.from("lucrit-admin-v1", "utf8"), 310000, 32, "sha256").toString("hex");
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

/* ── a fake Discord guild at the fetch boundary ─────────────────────────── */

const channels = [];
const messages = [];
let nextId = 5000;
const json = (b, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url;
  const method = init.method || "GET";
  if (!url.includes("discord.com/api")) return realFetch(input, init);

  if (/\/guilds\/\d+\/channels$/.test(url)) {
    if (method === "GET") return json(channels);
    const made = { id: String(++nextId), ...JSON.parse(init.body) };
    channels.push(made);
    return json(made);
  }
  const m = /\/channels\/(\d+)\/messages(?:\/(\d+))?$/.exec(url);
  if (m) {
    const [, channelId, messageId] = m;
    if (method === "POST") {
      const msg = { id: String(++nextId), channel_id: channelId, ...JSON.parse(init.body) };
      messages.push(msg);
      return json(msg);
    }
    const msg = messages.find((x) => x.id === messageId);
    if (method === "GET") return msg ? json(msg) : json({ message: "Unknown Message" }, 404);
    if (method === "PATCH") {
      if (!msg) return json({ message: "Unknown Message" }, 404);
      Object.assign(msg, JSON.parse(init.body));
      return json(msg);
    }
    if (method === "DELETE") {
      const i = messages.findIndex((x) => x.id === messageId);
      if (i >= 0) messages.splice(i, 1);
      return new Response(null, { status: 204 });
    }
  }
  return json({}, 404);
};

/* ── the Worker, with waitUntil collected so tests can settle it ───────── */

const env = freshEnv(worker, {
  DISCORD_BOT_TOKEN: "tok", DISCORD_GUILD_ID: "42",
  ADMIN_PASS_HASH: hex(derive("open-sesame")),
});
let pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
async function settle() { while (pending.length) { const p = pending; pending = []; await Promise.allSettled(p); } }

let ipN = 0;
async function call(method, path, body, cookie) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": `10.1.0.${++ipN % 250}` };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  const set = res.headers.getSetCookie?.() || [];
  return { res, json: await res.json().catch(() => ({})), cookie: set.map((c) => c.split(";")[0]).join("; ") };
}

async function signUp(username) {
  const out = await call("POST", "/api/auth/signup", {
    username, email: username.toLowerCase() + "@example.com",
    authKey: hex("pw-" + username),
  });
  if (!out.json.ok) throw new Error("signup failed: " + JSON.stringify(out.json));
  return { cookie: out.cookie, id: out.json.data?.id || out.json.data?.user?.id };
}

const LONG = Array.from({ length: 110 }, (_, i) => "word" + i).join(" ");
async function publish(cookie, title, game) {
  env.DB._raw.prepare("DELETE FROM ratelimits").run();
  const out = await call("POST", "/api/scripts", {
    title, game, category: "combat", desc: LONG,
    code: 'local Players = game:GetService("Players")\nprint(Players.LocalPlayer)',
    link: "https://pastebin.com/raw/x", thumbnail: "https://tr.rbxcdn.com/x", tags: ["demo"],
  }, cookie);
  await settle();
  if (!out.json.ok) throw new Error("publish failed: " + JSON.stringify(out.json));
  return out.json.data;
}

const postsFor = (scriptId) => {
  const rows = env.DB._raw.prepare("SELECT channel_id, message_id FROM script_posts WHERE script_id = ?").all(scriptId);
  return rows.map((r) => messages.find((m) => m.id === r.message_id)).filter(Boolean);
};
const isRetired = (m) => /^~~.*~~$/.test(m.embeds?.[0]?.title || "") && (m.components || []).length === 0;
const hasButton = (m) => (m.components?.[0]?.components || []).some((b) => /Get Script/.test(b.label || ""));

/* ── setup ──────────────────────────────────────────────────────────────── */

const admin = await call("POST", "/api/admin/unlock", { derived: derive("open-sesame") });
check("staff ticket issued", admin.json.ok === true, JSON.stringify(admin.json));
const staff = admin.cookie;

const doomed = await signUp("Doomed");
const keeper = await signUp("Keeper");
const s1 = await publish(doomed.cookie, "Doomed One", "Blox Fruits");
const s2 = await publish(doomed.cookie, "Doomed Two", "Da Hood");
const s3 = await publish(keeper.cookie, "Keeper Script", "Blox Fruits");

console.log("\nPublishing posts to Discord, with a button");
const s1Posts = postsFor(s1.id);
check("each script lands in #all-scripts and its game channel", s1Posts.length === 2, String(s1Posts.length));
check("with a live Get Script button", s1Posts.every(hasButton));

/* ── deleting an account ────────────────────────────────────────────────── */

console.log("\nDeleting an account retires its posts");
const doomedMsgIds = [...postsFor(s1.id), ...postsFor(s2.id)].map((m) => m.id);
const doomedTitles = [...postsFor(s1.id), ...postsFor(s2.id)].map((m) => m.embeds[0].title);

const del = await call("DELETE", `/api/admin/users/${doomed.id}`, { confirm: "Doomed" }, staff);
await settle();
check("the account is deleted", del.json.ok === true, JSON.stringify(del.json));
check("its scripts went with it (cascade)",
  env.DB._raw.prepare("SELECT COUNT(*) n FROM scripts WHERE author_id = ?").get(doomed.id).n === 0);

const after = doomedMsgIds.map((id) => messages.find((m) => m.id === id));
check("all four of its posts still exist (edited, not vanished)", after.every(Boolean), String(after.filter(Boolean).length));
check("every one is struck through with no button", after.every(isRetired),
  JSON.stringify(after.map((m) => ({ t: m?.embeds?.[0]?.title, c: m?.components }))));
check("keeping the original title, so readers see what it was",
  after.every((m, i) => m.embeds[0].title === `~~${doomedTitles[i]}~~`),
  JSON.stringify(after.map((m) => m.embeds[0].title)));
check("and saying why",
  after.every((m) => /no longer available/i.test(m.embeds[0].description || "")));
check("the orphaned tracking rows are cleaned up",
  env.DB._raw.prepare("SELECT COUNT(*) n FROM script_posts WHERE script_id IN (?, ?)").get(s1.id, s2.id).n === 0);

check("another author's posts are untouched", postsFor(s3.id).every((m) => hasButton(m) && !isRetired(m)),
  JSON.stringify(postsFor(s3.id).map((m) => m.embeds[0].title)));

/* ── the production state: orphans that already exist ───────────────────── */

console.log("\nPosts orphaned before this fix are swept by an ordinary page view");
{
  // Exactly what happened live: the account was deleted by the OLD code, so
  // nothing touched Discord. Simulated by deleting at the database level.
  const ghost = await signUp("Ghost");
  const g = await publish(ghost.cookie, "Ghost Script", "Arsenal");
  const ghostIds = postsFor(g.id).map((m) => m.id);
  env.DB._raw.prepare("DELETE FROM users WHERE id = ?").run(ghost.id);   // cascades the script

  const stale = ghostIds.map((id) => messages.find((m) => m.id === id));
  check("before: the orphaned posts still have a live button", stale.every(hasButton));

  await call("GET", "/api/scripts");          // any visitor
  await settle();

  const swept = ghostIds.map((id) => messages.find((m) => m.id === id));
  check("after one page view they are retired", swept.every(isRetired),
    JSON.stringify(swept.map((m) => m.embeds[0].title)));
  check("and a line goes to #bot-logs",
    messages.some((m) => /no longer exist/i.test(m.content || "")),
    JSON.stringify(messages.filter((m) => m.content).map((m) => m.content)));
}

console.log("\nA post deleted by hand in Discord doesn't jam the sweep");
{
  const lost = await signUp("Lost");
  const l = await publish(lost.cookie, "Lost Script", "Brookhaven");
  const ids = postsFor(l.id).map((m) => m.id);
  // Someone deleted the messages in Discord directly, then the account went.
  for (const id of ids) messages.splice(messages.findIndex((m) => m.id === id), 1);
  env.DB._raw.prepare("DELETE FROM users WHERE id = ?").run(lost.id);

  await call("GET", "/api/scripts");
  await settle();
  check("the dangling tracking rows are cleared anyway",
    env.DB._raw.prepare("SELECT COUNT(*) n FROM script_posts WHERE script_id = ?").get(l.id).n === 0);
}

console.log("\nExecutor posts are never mistaken for orphans");
{
  env.DB._raw.prepare(
    `INSERT INTO script_posts (script_id, channel_id, message_id, kind, at) VALUES ('x_exec1', '1', '999', 'executor', 0)`).run();
  await call("GET", "/api/scripts");
  await settle();
  check("an executor's tracking row survives the sweep",
    env.DB._raw.prepare("SELECT COUNT(*) n FROM script_posts WHERE script_id = 'x_exec1'").get().n === 1);
}

/* ── suspending and restoring ───────────────────────────────────────────── */

console.log("\nSuspending retires posts; lifting it restores them");
{
  const ban = await call("POST", `/api/admin/users/${keeper.id}/ban`, { banned: true }, staff);
  await settle();
  check("suspended", ban.json.ok === true, JSON.stringify(ban.json));
  const off = postsFor(s3.id);
  check("their posts are struck through", off.length === 2 && off.every(isRetired),
    JSON.stringify(off.map((m) => ({ t: m.embeds[0].title, c: m.components }))));

  const before = messages.length;
  const unban = await call("POST", `/api/admin/users/${keeper.id}/ban`, { banned: false }, staff);
  await settle();
  check("restored", unban.json.ok === true, JSON.stringify(unban.json));
  const on = postsFor(s3.id);
  check("the same posts come back live", on.length === 2 && on.every((m) => hasButton(m) && !isRetired(m)),
    JSON.stringify(on.map((m) => ({ t: m.embeds[0].title }))));
  const newScriptPosts = messages.slice(before).filter((m) => m.embeds?.[0]?.title === "Keeper Script");
  check("edited in place, not re-announced as duplicates", newScriptPosts.length === 0, String(newScriptPosts.length));
}

globalThis.fetch = realFetch;
process.exit(done() ? 1 : 0);
