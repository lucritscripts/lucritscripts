// Staff labels ("Risky", "Patched", "Working"…) and the bigger admin panel.
//
// Asked for (15 Oct 2026): "make it to where an admin could label a script as
// risk etc through the admin panel, make the admin panel have so many new
// features and correspond it to this".
//
// Starts from a database WITHOUT the new columns, like production, so the
// self-adding schema step is what's under test — not schema.sql.
import crypto from "node:crypto";
import fs from "node:fs";
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, ROOT, freshEnv, serve, counter, person } from "./harness.mjs";
import { ADMIN_LABELS } from "../assets/js/data/scripts.js";

const PORT = 8171;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const derive = (p) =>
  crypto.pbkdf2Sync(p, Buffer.from("lucrit-admin-v1", "utf8"), 310000, 32, "sha256").toString("hex");
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

console.log("The two label lists agree");
const src = fs.readFileSync(ROOT + "/_worker.js", "utf8");
const serverIds = JSON.parse(src.match(/const ADMIN_LABEL_IDS = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, "]"));
check("worker and site list the same labels, same order",
  JSON.stringify(serverIds) === JSON.stringify(ADMIN_LABELS.map((l) => l.id)), serverIds.join());
check("there is a Risky label", ADMIN_LABELS.some((l) => l.id === "risky" && l.warn));

/* ── a production-shaped database: no labels, no note, no log ─────────── */
const env = freshEnv(worker, { LOOTLABS_TOKEN: "t", ADMIN_PASS_HASH: hex(derive("open-sesame")) });
env.DB._raw.exec(`ALTER TABLE scripts DROP COLUMN labels; ALTER TABLE scripts DROP COLUMN admin_note; DROP TABLE admin_log;`);
const cols = () => env.DB._raw.prepare("PRAGMA table_info(scripts)").all().map((c) => c.name);
check("test DB starts without the new columns", !cols().includes("labels") && !cols().includes("admin_note"));

let ipN = 0;
async function call(method, path, body, cookie) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": `10.2.0.${++ipN % 250}` };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }), env, { waitUntil: () => {} });
  const set = res.headers.getSetCookie?.() || [];
  return { status: res.status, json: await res.json().catch(() => ({})), cookie: set.map((c) => c.split(";")[0]).join("; ") };
}

const LONG = ("A movement script that lets you fly, noclip and run faster around the whole map. ").repeat(8);
async function publish(cookie, title, game) {
  env.DB._raw.prepare("DELETE FROM ratelimits").run();
  const out = await call("POST", "/api/scripts", {
    title, game, category: "movement", desc: LONG, keyless: true, captcha: true, tags: ["demo"],
    code: 'local Players = game:GetService("Players")\nprint(Players.LocalPlayer)',
    thumbnail: "https://tr.rbxcdn.com/" + title.replace(/\W/g, "") + "/768/432/Image/Png",
  }, cookie);
  if (!out.json.ok) throw new Error("publish failed: " + JSON.stringify(out.json));
  return out.json.data;
}

const up = await call("POST", "/api/auth/signup", { username: "Maker", email: "maker@example.com", authKey: hex("pw-maker") });
const maker = up.cookie;
const a = await publish(maker, "Fly Hub", "Pet Simulator X");
const b = await publish(maker, "Speed Hub", "Pet Simulator X");
const c = await publish(maker, "Noclip Hub", "Blox Fruits");

console.log("\nBefore any admin request (old database)");
let pub = await call("GET", `/api/scripts/${a.id}`);
check("public script reads fine without the columns", pub.json.ok === true, JSON.stringify(pub.json).slice(0, 200));
check("…with no labels and no note", JSON.stringify(pub.json.data.labels) === "[]" && pub.json.data.staffNote === "");

console.log("\nOnly staff can label");
let r = await call("POST", `/api/admin/scripts/${a.id}/labels`, { labels: ["risky"] });
check("no ticket → refused", r.status === 423, String(r.status));
r = await call("POST", `/api/admin/scripts/${a.id}/labels`, { labels: ["risky"] }, maker);
check("a signed-in creator → refused", r.status === 423, String(r.status));

const staff = (await call("POST", "/api/admin/unlock", { derived: derive("open-sesame") })).cookie;
r = await call("POST", `/api/admin/scripts/${a.id}/labels`, { labels: ["working", "risky"], note: "  Alt accounts   only. " }, staff);
check("staff can label", r.json.ok === true, JSON.stringify(r.json));
check("the columns were added on the fly", cols().includes("labels") && cols().includes("admin_note"));
check("labels saved in canonical order", JSON.stringify(r.json.data.labels) === '["risky","working"]');
check("note tidied", r.json.data.note === "Alt accounts only.", r.json.data.note);
r = await call("POST", `/api/admin/scripts/${a.id}/labels`, { labels: ["risky", "virus"] }, staff);
check("unknown label refused", r.status === 400);
r = await call("POST", `/api/admin/scripts/s_nope/labels`, { labels: [] }, staff);
check("unknown script → 404", r.status === 404);

pub = await call("GET", `/api/scripts/${a.id}`);
check("public script carries the labels", JSON.stringify(pub.json.data.labels) === '["risky","working"]');
check("…and the staff note", pub.json.data.staffNote === "Alt accounts only.");
const list = await call("GET", "/api/scripts");
check("library listing carries them too", JSON.stringify(list.json.data.find((x) => x.id === a.id).labels) === '["risky","working"]');

console.log("\nPublishers can't set them");
await call("POST", `/api/scripts/${b.id}/edit`, { labels: ["featured"], admin_note: "trust me", desc: LONG }, maker);
pub = await call("GET", `/api/scripts/${b.id}`);
check("edit route ignores labels/notes", JSON.stringify(pub.json.data.labels) === "[]" && pub.json.data.staffNote === "");

console.log("\nFilters, sort, overview, activity");
await call("POST", `/api/admin/scripts/${c.id}/verify`, { verified: true }, staff);
await call("POST", `/api/admin/scripts/${b.id}/labels`, { labels: ["patched"] }, staff);
const ids = async (q) => (await call("GET", `/api/admin/scripts?${q}`, undefined, staff)).json.data.map((s) => s.title).sort().join();
check("f=risky → risky + patched", await ids("f=risky") === "Fly Hub,Speed Hub", await ids("f=risky"));
check("f=label:working", await ids("f=label:working") === "Fly Hub");
check("f=verified", await ids("f=verified") === "Noclip Hub");
check("f=labeled", await ids("f=labeled") === "Fly Hub,Speed Hub");
check("search by game", await ids("q=blox") === "Noclip Hub");
env.DB._raw.prepare("UPDATE scripts SET views = 99 WHERE id = ?").run(b.id);
const byViews = (await call("GET", "/api/admin/scripts?sort=views", undefined, staff)).json.data;
check("sort by views", byViews[0].title === "Speed Hub");
check("rows include slug, labels and note", byViews.every((s) => s.slug && Array.isArray(s.labels)) && byViews.find((s) => s.id === a.id).staffNote === "Alt accounts only.");
const ov = (await call("GET", "/api/admin/overview", undefined, staff)).json.data;
check("overview has key-unlock counts", ov.keyUnlocks === 0 && ov.keyUnlocksToday === 0, JSON.stringify({ k: ov.keyUnlocks }));
check("overview counts", ov.risky === 2 && ov.labeled === 2 && ov.verifiedScripts === 1, JSON.stringify(ov));
console.log("\nStaff skip the unlock");
const copiesOf = (id) => env.DB._raw.prepare("SELECT copies FROM scripts WHERE id = ?").get(id).copies;
check("a visitor without an unlock gets 403 for the code", (await call("GET", `/api/scripts/${a.id}/code`)).status === 403);
const c0 = copiesOf(a.id);
r = await call("GET", `/api/scripts/${a.id}/code`, undefined, staff);
check("staff get the code with no unlock", r.json.ok && /GetService/.test(r.json.data.code) && r.json.staff === true, JSON.stringify(r.json).slice(0, 120));
check("…not counted as a copy", copiesOf(a.id) === c0);
const listed = (await call("GET", "/api/scripts?limit=50", undefined, staff)).json.data;
check("every script lists as unlocked for staff", listed.length > 0 && listed.every((x) => x.unlocked && x.unlockedFor === null));
check("…but not for a visitor", (await call("GET", "/api/scripts?limit=50")).json.data.every((x) => !x.unlocked));
r = await call("GET", `/api/admin/scripts/${a.id}/code`, undefined, staff);
check("admin Get code endpoint returns code + title", r.json.ok && r.json.data.title === a.title && /GetService/.test(r.json.data.code));
check("…and is staff-only", (await call("GET", `/api/admin/scripts/${a.id}/code`, undefined, maker)).status === 423);
const log = (await call("GET", "/api/admin/log", undefined, staff)).json.data;
check("activity log records labels + verify", log.some((l) => l.action === "Labels changed" && l.target === "Fly Hub")
  && log.some((l) => l.action === "Verified" && l.target === "Noclip Hub"), JSON.stringify(log.map((l) => l.action)));
check("activity log is staff-only", (await call("GET", "/api/admin/log", undefined, maker)).status === 423);

/* ── in the browser: the panel, the script page and the cards ─────────── */
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, bypassCSP: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));

console.log("\nThe admin panel");
await page.goto(`${AT}/admin`);
await page.locator("#admin [name=passcode]").fill("open-sesame");
await page.locator("#admin [data-passform] button[type=submit]").click();
await page.locator('#admin [data-admintab="scripts"]').waitFor({ timeout: 30000 });
check("new overview tiles", /Marked risky/.test(await page.locator("#admin .stats").textContent()));
check("Paid key unlocks tile sits right after Paid unlocks", await page.evaluate(() => {
  const t = [...document.querySelectorAll("#admin .stats > *")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
  const i = t.findIndex((x) => x.startsWith("Paid unlocks"));
  return i >= 0 && /^Paid key unlocks 0/.test(t[i + 1] || "");
}));
check("Activity tab exists", await page.locator('#admin [data-admintab="activity"]').count() === 1);
await page.locator('#admin [data-admintab="scripts"]').click();
await page.locator("#admin [data-adminfilter]").first().waitFor();
check("filter pills", await page.locator("#admin [data-adminfilter]").count() >= 8);
check("rows show the same badges as the site", await page.locator(`#admin tr[data-script="${a.id}"] .badge--label[data-label="risky"]`).count() === 1);
await page.locator(`#admin tr[data-script="${a.id}"] [data-adminact="getcode"]`).click();
await page.locator("#admin [data-coderow] [data-codebox]").waitFor({ timeout: 15000 });
check("Get code shows the script's code under its row", /GetService/.test(await page.locator("#admin [data-coderow] [data-codebox]").textContent()));
await page.locator('#admin [data-adminact="closecode"]').click();
check("…and closes", await page.locator("#admin [data-coderow]").count() === 0);

// Label editor
await page.locator(`#admin tr[data-script="${c.id}"] [data-adminact="labels"]`).click();
const ed = page.locator(`#admin [data-editor="${c.id}"]`);
await ed.waitFor();
check("editor lists every label", await ed.locator('input[name="lbl"]').count() === ADMIN_LABELS.length);
await ed.locator('input[value="banrisk"]').check();
await ed.locator('input[value="mobile"]').check();
await ed.locator('input[name="staffnote"]').fill("Kicks on the newest update — use an alt.");
await ed.locator('[data-adminact="savelabels"]').click();
await page.locator(`#admin tr[data-script="${c.id}"]:not(.adm__editor) .badge--label[data-label="banrisk"]`).waitFor();
check("saving shows the labels on the row", await page.locator(`#admin tr[data-script="${c.id}"]:not(.adm__editor) .badge--label`).count() === 2);
check("editor closes after saving", await page.locator(`#admin [data-editor="${c.id}"]`).count() === 0);

// Filters
await page.locator('#admin [data-adminfilter="verified"]').click();
await page.waitForFunction(() => document.querySelectorAll("#admin tr[data-script]:not(.adm__editor)").length === 1);
check("Verified filter", /Noclip Hub/.test(await page.locator("#admin tbody").textContent()));
await page.locator('#admin [data-adminfilter="all"]').click();
await page.waitForFunction(() => document.querySelectorAll("#admin tr[data-script]:not(.adm__editor)").length === 3);

// Bulk
await page.locator(`#admin [data-select="${a.id}"]`).check();
await page.locator(`#admin [data-select="${b.id}"]`).check();
check("bulk bar appears", /2 selected/.test(await page.locator("#admin [data-bulkbar]").textContent()));
await page.locator("#admin [data-bulklabel]").selectOption("hot");
await page.locator('#admin [data-bulk="addlabel"]').click();
await page.waitForFunction(() => document.querySelectorAll('#admin .badge--label[data-label="hot"]').length === 2);
const hot = env.DB._raw.prepare(`SELECT title FROM scripts WHERE labels LIKE '%"hot"%' ORDER BY title`).all().map((x) => x.title).join();
check("bulk add label hit both", hot === "Fly Hub,Speed Hub", hot);
check("bulk kept their other labels", parseFloat(env.DB._raw.prepare(`SELECT COUNT(*) AS n FROM scripts WHERE labels LIKE '%"risky"%'`).get().n) === 1);

await page.locator('#admin [data-admintab="activity"]').click();
await page.locator("#admin tbody tr").first().waitFor();
check("Activity tab lists actions", /Labels changed/.test(await page.locator("#admin tbody").textContent()));

console.log("\nThe script page");
const open = async (s) => {
  await page.goto(`${AT}/creations/Maker/${s.slug}`);
  await page.locator("#script h2").waitFor();
};
await open(c);
check("labels on the script page", await page.locator('#script .sheet__head .badge--label[data-label="banrisk"]').count() === 1);
check("verified bubble still there", await page.locator("#script .sheet__head .badge--verified").count() === 1);
check("warning box for a red label", await page.locator("#script .staffbox--warn").count() === 1);
check("…showing the staff note", /Kicks on the newest update/.test(await page.locator("#script .staffbox").textContent()));
// Read after the sheet's open transition settles; mid-fade the colour is still blending.
let red = "";
for (let i = 0; i < 20 && !/rgb\(229, 57, 75\)/.test(red); i++) {
  red = await page.locator('#script .badge--label[data-label="banrisk"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  if (!/rgb\(229, 57, 75\)/.test(red)) await page.waitForTimeout(100);
}
check("risk labels are filled red", /rgb\(229, 57, 75\)/.test(red), red);
await open({ slug: String(b.id).replace(/^s_/, "") });
check("Patched also warns (no note → its own tip)", /no longer works/.test(await page.locator("#script .staffbox--warn").textContent()));

console.log("\nCards");
await page.goto(AT);
for (let i = 0; i < 40 && !(await page.evaluate(() => (window.__lucrit?.library?.length || 0) >= 3)); i++) await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector("#search-mount")?.scrollIntoView());
await page.waitForTimeout(800);
const perCard = await page.$$eval(".results__grid .card", (els) => els.map((e) => e.querySelectorAll(".badge--label").length));
check("cards show at most 2 labels", perCard.length === 3 && perCard.every((n) => n <= 2), perCard.join());
const flyCard = await page.$$eval(".results__grid .card", (els) => els.map((e) => ({
  t: e.querySelector(".card__title")?.textContent, l: [...e.querySelectorAll(".badge--label")].map((x) => x.dataset.label) })));
const fly = flyCard.find((x) => /Fly Hub/.test(x.t));
check("warnings come first on a card", fly && fly.l[0] === "risky", JSON.stringify(fly));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
done();
