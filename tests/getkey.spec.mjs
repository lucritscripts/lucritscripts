// /getkey — the Script Maniac Hub key system on lucritscripts.site.
//
// Asked for (15 Oct 2026): "add a new page called get key, also add that
// button to the home screen ... use that template ... keep all firebase stuff
// ... make new lootlabs for the keys".
//
// Firebase is stubbed at the network boundary (the gstatic module URLs), so
// this checks what the page WRITES — the exact Firestore document the Roblox
// loader reads — without touching the real smh-keysystem project.
import fs from "node:fs";
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, ROOT, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8181;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const env = freshEnv(worker);
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];
const PAGE = fs.readFileSync(ROOT + "/getkey.html", "utf8");

console.log("The page source");
check("same Firebase project as the loader", /projectId:\s*"smh-keysystem"/.test(PAGE));
check("full Firebase config kept", /appId:\s*"1:619718800070:web:56ea94a00d5dfcd8e09dc7"/.test(PAGE) && /messagingSenderId:\s*"619718800070"/.test(PAGE));
check("step 1 link is the new LootLabs key link", PAGE.includes("https://loot-link.com/s?9YxZvLfL"));
check("step 2 link is the new LootLabs key link", PAGE.includes("https://lootdest.org/s?33Kx6iTB"));
check("old SMH links are gone", !/rYmzSp1H|lGzg5zVy/.test(PAGE));
check("never wipes the whole site's storage", !/localStorage\.clear\(\)/.test(PAGE));
check("keys start with LUCRIT-", PAGE.includes('let key = "LUCRIT-";') && !PAGE.includes('let key = "SMH-"'));
check("lastPing every 30 seconds, not every second", /\}, 30000\);/.test(PAGE) && !/lastPing[\s\S]{0,400}\}, 1000\);/.test(PAGE));

const FAKE_APP = `export function initializeApp(c){ window.__fbConfig = c; return { c }; }`;
const FAKE_FS = `
const K = "__fs_test";
const load = () => JSON.parse(localStorage.getItem(K) || "{}");
const save = (s) => localStorage.setItem(K, JSON.stringify(s));
export function getFirestore(app){ return { app }; }
export function doc(db, col, id){ return { col, id }; }
export async function getDoc(ref){ const s = load(); const d = s[ref.col + "/" + ref.id];
  return { exists: () => !!d, data: () => d }; }
export async function setDoc(ref, data, opts){ const s = load(); const k = ref.col + "/" + ref.id;
  s[k] = opts && opts.merge ? { ...(s[k] || {}), ...data } : data; save(s); window.__writes = (window.__writes||0)+1; }`;

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  return { ctx, page: await routes(ctx) };
}
async function routes(ctx, seedStore = null) {
  if (seedStore) await ctx.addInitScript((s) => { if (!localStorage.getItem("__fs_test")) localStorage.setItem("__fs_test", s); }, seedStore);
  await ctx.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: FAKE_APP }));
  await ctx.route("https://www.gstatic.com/firebasejs/**/firebase-firestore.js", (r) =>
    r.fulfill({ contentType: "text/javascript", body: FAKE_FS }));
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css", body: "" }));
  // Pages serves getkey.html at /getkey; the test server doesn't do pretty URLs.
  await ctx.route(/\/getkey(\?.*)?$/, (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  // Where the LootLabs buttons go — record, don't really leave.
  await ctx.route(/^https:\/\/(loot-link\.com|lootdest\.org)\//, (r) =>
    r.fulfill({ contentType: "text/html", body: "<title>lootlabs</title>" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const msg = (p) => p.locator("#messageText").textContent();
// The page's CSP has no 'unsafe-eval', which waitForFunction can trip; poll instead.
async function until(p, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await p.evaluate(fn).catch(() => false)) return; await p.waitForTimeout(150); }
  throw new Error("timed out: " + fn.toString().slice(0, 90));
}

console.log("\nCheckpoint one");
let { ctx, page } = await newPage();
await page.goto(`${AT}/getkey`);
await until(page, () => document.querySelector("#messageText")?.textContent === "Checkpoint One");
check("starts at Checkpoint One", (await msg(page)) === "Checkpoint One");
check("Firebase initialised with the smh-keysystem config",
  await page.evaluate(() => window.__fbConfig?.projectId === "smh-keysystem" && !!window.__fbConfig?.appId));
const snap = () => page.evaluate(() => document.getElementById("bg").toDataURL());
const f1 = await snap(); await page.waitForTimeout(600); const f2 = await snap();
check("background is animating", f1 !== f2);
check("Lucrit look: logo + Inter font", await page.locator(".brand img").count() === 1
  && /Inter/.test(await page.evaluate(() => getComputedStyle(document.body).fontFamily)));
await page.locator("#finishBtn").click();
await page.waitForURL(/loot-link\.com/);
check("Get Key → LootLabs key step 1", page.url() === "https://loot-link.com/s?9YxZvLfL", page.url());

console.log("\nAnti-skip");
await page.goto(`${AT}/getkey?step=1`);
await page.waitForURL(`${AT}/getkey`);
check("?step=1 typed in by hand (no LootLabs referrer) → back to checkpoint one", page.url() === `${AT}/getkey`);
const fresh = await newPage();
await fresh.page.goto(`${AT}/getkey?step=2`, { referer: "https://lootdest.org/" });
await fresh.page.waitForURL(`${AT}/getkey`);
check("?step=2 without having done step 1 → back to checkpoint one", fresh.page.url() === `${AT}/getkey`);
await fresh.ctx.close();

console.log("\nBack from LootLabs step 1");
await page.goto(`${AT}/getkey?step=1`, { referer: "https://lootdest.org/" });
await until(page, () => document.querySelector("#messageText")?.textContent === "Final Checkpoint");
check("shows Final Checkpoint", (await msg(page)) === "Final Checkpoint");
check("progress shows checkpoint 1 done", await page.locator('#steps li.is-done').count() === 1);
await page.locator("#finishBtn").click();
await page.waitForURL(/lootdest\.org/);
check("Get Key → LootLabs key step 2", page.url() === "https://lootdest.org/s?33Kx6iTB", page.url());

console.log("\nBack from LootLabs step 2");
await page.goto(`${AT}/getkey?step=2`, { referer: "https://links.lootlabs.gg/" });
await until(page, () => document.querySelector("#messageText")?.textContent === "Your Key is Ready");
check("shows Your Key is Ready", (await msg(page)) === "Your Key is Ready");
await page.evaluate(() => localStorage.setItem("lucrit:human", "keep-me"));
await page.locator("#finishBtn").click();
await page.locator("#keyActiveSection").waitFor({ state: "visible" });
const key = (await page.locator("#keyBox").textContent()).trim();
check("key starts with LUCRIT- (+ 16)", /^LUCRIT-[A-HJ-NP-Z2-9]{16}$/.test(key), key);
const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem("__fs_test"))["keys/" + k], key);
check("written to Firestore keys/<key>", !!stored);
check("…with valid:true, inUse:false, boundTo, lastPing",
  stored?.valid === true && stored?.inUse === false && typeof stored?.boundTo === "string" && typeof stored?.lastPing === "number");
const hours = (stored.expiresAt - Date.now()) / 3600000;
check("…expiring in 8 hours", hours > 7.9 && hours <= 8, hours.toFixed(3));
check("timer shows", /Key valid for: 0[78]:/.test(await page.locator("#countdown").textContent()));

console.log("\nPaid key unlocks (admin tile)");
for (let i = 0; i < 30 && !env.DB._raw.prepare("SELECT 1 FROM sqlite_master WHERE name='key_events'").get(); i++) await page.waitForTimeout(100);
const keyRows = () => env.DB._raw.prepare("SELECT * FROM key_events").all();
for (let i = 0; i < 30 && keyRows().length < 1; i++) await page.waitForTimeout(100);
check("making a key reports it once", keyRows().length === 1, JSON.stringify(keyRows()));
check("…as a LootLabs key (not server-verified)", keyRows()[0]?.via === "lootlabs" && keyRows()[0]?.verified === 0);
check("…and the key itself isn't stored", !JSON.stringify(keyRows()).includes(key));
const made = (body) => page.evaluate(async (b) => {
  const r = await fetch("/api/getkey/made", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  return { status: r.status, ...(await r.json()) };
}, body);
check("the same key twice counts once", (await made({ key, via: "lootlabs" })).counted === false && keyRows().length === 1);
check("a non-Lucrit key is refused", (await made({ key: "SMH-ABC", via: "lootlabs" })).status === 400);
const gkHex = "ab".repeat(16);
env.DB._raw.prepare("INSERT INTO cache (k, v, expires) VALUES (?, ?, ?)").run("gk:" + gkHex, JSON.stringify({ s1: 1, s2: 1 }), Math.floor(Date.now() / 1000) + 600);
const lvRes = await made({ key: "LUCRIT-ABCDEFGHJKLMNPQR", via: "linkvertise", gk: gkHex });
check("a Linkvertise key whose flow passed both steps is verified", lvRes.counted && lvRes.verified, JSON.stringify(lvRes));
const fake = await made({ key: "LUCRIT-BCDEFGHJKLMNPQRS", via: "linkvertise", gk: "cd".repeat(16) });
check("…one that didn't pass isn't", fake.counted && !fake.verified, JSON.stringify(fake));
env.DB._raw.prepare("DELETE FROM key_events WHERE key_hash <> ?").run(keyRows()[0].key_hash);
check("the rest of the site's storage survives", await page.evaluate(() => localStorage.getItem("lucrit:human")) === "keep-me");

console.log("\nComing back later");
await page.goto(`${AT}/getkey`);
await page.locator("#keyActiveSection").waitFor({ state: "visible" });
check("shows the existing key instead of starting again", (await page.locator("#keyBox").textContent()).trim() === key);
await page.evaluate((k) => { const s = JSON.parse(localStorage.getItem("__fs_test")); s["keys/" + k].expiresAt = Date.now() - 1; localStorage.setItem("__fs_test", JSON.stringify(s)); }, key);
await page.reload();
await until(page, () => document.querySelector("#messageText")?.textContent === "Checkpoint One");
check("an expired key sends you back to checkpoint one", (await msg(page)) === "Checkpoint One");
await ctx.close();

console.log("\nReduced motion");
{
  const rm = await browser.newContext({ reducedMotion: "reduce" });
  await rm.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_APP }));
  await rm.route("https://www.gstatic.com/firebasejs/**/firebase-firestore.js", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_FS }));
  await rm.route(/\/getkey(\?.*)?$/, (r) => r.fulfill({ contentType: "text/html", body: PAGE }));
  const rp = await rm.newPage();
  await rp.goto(`${AT}/getkey`); await rp.waitForTimeout(400);
  const a = await rp.evaluate(() => document.getElementById("bg").toDataURL());
  await rp.waitForTimeout(600);
  const b = await rp.evaluate(() => document.getElementById("bg").toDataURL());
  check("still frame when the visitor turned motion off", a === b && a.length > 1000);
  await rm.close();
}

console.log("\nYour key on every device (signed in)");
{
  const acct = await person(browser, AT, "Keyholder");
  const a = await routes(acct.ctx);
  await a.goto(`${AT}/getkey?step=1`, { referer: "https://lootdest.org/" });
  await a.locator("#finishBtn").waitFor();
  await a.goto(`${AT}/getkey?step=2`, { referer: "https://lootdest.org/" });
  await a.locator("#finishBtn", { hasText: "Get Your Key" }).waitFor();
  await a.locator("#finishBtn").click();
  await a.locator("#keyActiveSection").waitFor({ state: "visible" });
  const k1 = (await a.locator("#keyBox").textContent()).trim();
  await a.waitForTimeout(600);
  const saved = env.DB._raw.prepare("SELECT v FROM cache WHERE k LIKE 'getkey:%'").all().map((r) => JSON.parse(r.v));
  check("the new key is saved on the account", saved.length === 1 && saved[0].key === k1, JSON.stringify(saved));
  const fsStore = await a.evaluate(() => localStorage.getItem("__fs_test"));

  // Another device: same account, empty browser (the Firestore fake is seeded
  // with the same data, standing in for the real shared Firebase).
  const devB = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await devB.addCookies(await acct.ctx.cookies());
  const b = await routes(devB, fsStore);
  await b.goto(`${AT}/getkey`);
  await b.locator("#keyActiveSection").waitFor({ state: "visible" });
  check("another device shows the same key", (await b.locator("#keyBox").textContent()).trim() === k1);
  check("…and says it came from the account", /Restored from your Lucrit account/.test(await b.locator("#stepNote").textContent()));
  await b.goto(AT);
  await b.locator(".hero__cta a[data-getkey]").waitFor();
  check("home button now says Your Key", /Your Key/.test(await b.locator(".hero__cta a[data-getkey]").textContent()));
  await devB.close();

  // The key was deleted in Firebase (e.g. from the admin Keys tab): no loop, back to checkpoint one.
  const devC = await browser.newContext();
  await devC.addCookies(await acct.ctx.cookies());
  const c = await routes(devC, "{}");
  await c.goto(`${AT}/getkey`);
  await c.waitForTimeout(1500);
  check("a key gone from Firebase isn't restored (and the page doesn't loop)",
    (await msg(c)) === "Checkpoint One" && c.url() === `${AT}/getkey` && await c.locator("#keyActiveSection").isHidden());
  await devC.close();
  await acct.ctx.close();

  // Signed out on a new device: nothing to restore, and a hint to sign in.
  const anon = await newPage();
  await anon.page.goto(`${AT}/getkey`);
  await anon.page.locator("#stepNote a", { hasText: "Sign in" }).waitFor();
  check("signed-out visitors get a 'sign in to keep your key' hint", true);
  await anon.ctx.close();

  const api = async (method, body, cookie) => (await worker.fetch(new Request("https://lucrit.test/api/getkey/mine", {
    method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} }));
  check("saving needs an account (401)", (await api("POST", { key: k1, expiresAt: Date.now() + 3600e3 })).status === 401);
  check("signed-out GET just says no key", (await (await api("GET")).json()).data === null);
}

console.log("\nHome screen button");
const home = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const hp = await home.newPage();
hp.on("pageerror", (e) => errors.push(e.message));
await hp.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
await hp.goto(AT);
const btn = hp.locator(".hero__cta a[data-getkey]");
await btn.waitFor();
check("Get Key button on the home screen", /Get Key/.test(await btn.textContent()));
check("…pointing at /getkey", (await btn.getAttribute("href")) === "/getkey");
await home.close();

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const pp = await phone.newPage();
await pp.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
await pp.goto(AT);
await pp.locator(".hero__cta a[data-getkey]").waitFor();
const boxes = await pp.$$eval(".hero__cta > *", (els) => els.filter((e) => getComputedStyle(e).display !== "none")
  .map((e) => ({ t: e.textContent.trim().slice(0, 12), ...e.getBoundingClientRect().toJSON() })));
const overlap = boxes.some((a, i) => boxes.some((b, j) => i < j &&
  a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
check("phone: hero buttons don't overlap", !overlap, JSON.stringify(boxes.map((b) => [b.t, Math.round(b.left), Math.round(b.top)])));
const key2 = boxes.find((b) => /Get Key/.test(b.t));
check("phone: Get Key fits on screen", key2 && key2.right <= 390 && key2.left >= 0);
await phone.close();

console.log("\nSponsor tabs before the key (adgate.js)");
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(() => localStorage.setItem("lucrit:adtest", "1"));
  const page = await routes(ctx);
  let sponsor = 0;
  await ctx.route(/^https:\/\/uplcm\.com\//, (r) => r.fulfill({ contentType: "text/html", body: "<title>sponsor</title>" }));
  ctx.on("page", (p) => { if (/uplcm\.com/.test(p.url()) || p !== page) sponsor++; });
  await page.goto(`${AT}/getkey?step=1`, { referer: "https://lootdest.org/" });
  await until(page, () => document.querySelector("#messageText")?.textContent === "Final Checkpoint");
  await page.goto(`${AT}/getkey?step=2`, { referer: "https://links.lootlabs.gg/" });
  await until(page, () => document.querySelector("#messageText")?.textContent === "Your Key is Ready");
  const first = await page.locator("#finishBtn").textContent();
  const m = first.match(/\((\d)\/(\d)\)/);
  const need = m ? Number(m[2]) : 0;
  check("button shows progress before the key, e.g. 'Get Your Key (0/4)'", !!m && m[1] === "0", first);
  check("asks for 3–5 presses", need >= 3 && need <= 5, String(need));
  check("the note says how many presses are left", /Press \d more time/.test(await page.locator("#stepNote").textContent()));
  await page.locator("#finishBtn").click();
  await page.waitForTimeout(400);
  check("one press = one sponsor tab, and no key yet", sponsor === 1 && await page.locator("#keyActiveSection").isHidden(), String(sponsor));
  check("…and the count goes up", (await page.locator("#finishBtn").textContent()).includes(`(1/${need})`));
  await page.reload();
  await until(page, () => document.querySelector("#messageText")?.textContent === "Your Key is Ready");
  check("a refresh keeps the presses already done", (await page.locator("#finishBtn").textContent()).includes(`(1/${need})`));
  for (let i = 1; i < need; i++) { await page.locator("#finishBtn").click(); await page.waitForTimeout(250); }
  check(`${need} presses opened ${need} sponsor tabs, still no key`, sponsor === need && await page.locator("#keyActiveSection").isHidden(), String(sponsor));
  check("the button is plain again", (await page.locator("#finishBtn").textContent()).trim() === "Get Your Key");
  await page.locator("#finishBtn").click();
  await page.locator("#keyActiveSection").waitFor({ state: "visible" });
  check("the next press makes the key, with no extra tab", sponsor === need, String(sponsor));
  check("the count starts over for the next key", await page.evaluate(() => sessionStorage.getItem("lucrit:gate:key") === null));
  await ctx.close();
}

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
done();
