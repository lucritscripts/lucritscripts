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
import { CHROME, ROOT, freshEnv, serve, counter } from "./harness.mjs";

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
  return { ctx, page };
}
const msg = (p) => p.locator("#messageText").textContent();

console.log("\nCheckpoint one");
let { ctx, page } = await newPage();
await page.goto(`${AT}/getkey`);
await page.waitForFunction(() => document.querySelector("#messageText")?.textContent === "CheckPoint One");
check("starts at CheckPoint One", (await msg(page)) === "CheckPoint One");
check("Firebase initialised with the smh-keysystem config",
  await page.evaluate(() => window.__fbConfig?.projectId === "smh-keysystem" && !!window.__fbConfig?.appId));
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
await page.waitForFunction(() => document.querySelector("#messageText")?.textContent === "Final Checkpoint");
check("shows Final Checkpoint", (await msg(page)) === "Final Checkpoint");
check("progress shows checkpoint 1 done", await page.locator('#steps li.is-done').count() === 1);
await page.locator("#finishBtn").click();
await page.waitForURL(/lootdest\.org/);
check("Get Key → LootLabs key step 2", page.url() === "https://lootdest.org/s?33Kx6iTB", page.url());

console.log("\nBack from LootLabs step 2");
await page.goto(`${AT}/getkey?step=2`, { referer: "https://links.lootlabs.gg/" });
await page.waitForFunction(() => document.querySelector("#messageText")?.textContent === "Your Key is Ready");
check("shows Your Key is Ready", (await msg(page)) === "Your Key is Ready");
await page.evaluate(() => localStorage.setItem("lucrit:human", "keep-me"));
await page.locator("#finishBtn").click();
await page.locator("#keyActiveSection").waitFor({ state: "visible" });
const key = (await page.locator("#keyBox").textContent()).trim();
check("key looks like the loader expects (SMH- + 16)", /^SMH-[A-HJ-NP-Z2-9]{16}$/.test(key), key);
const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem("__fs_test"))["keys/" + k], key);
check("written to Firestore keys/<key>", !!stored);
check("…with valid:true, inUse:false, boundTo, lastPing",
  stored?.valid === true && stored?.inUse === false && typeof stored?.boundTo === "string" && typeof stored?.lastPing === "number");
const hours = (stored.expiresAt - Date.now()) / 3600000;
check("…expiring in 8 hours", hours > 7.9 && hours <= 8, hours.toFixed(3));
check("timer shows", /Key valid for: 0[78]:/.test(await page.locator("#countdown").textContent()));
check("the rest of the site's storage survives", await page.evaluate(() => localStorage.getItem("lucrit:human")) === "keep-me");

console.log("\nComing back later");
await page.goto(`${AT}/getkey`);
await page.locator("#keyActiveSection").waitFor({ state: "visible" });
check("shows the existing key instead of starting again", (await page.locator("#keyBox").textContent()).trim() === key);
await page.evaluate((k) => { const s = JSON.parse(localStorage.getItem("__fs_test")); s["keys/" + k].expiresAt = Date.now() - 1; localStorage.setItem("__fs_test", JSON.stringify(s)); }, key);
await page.reload();
await page.waitForFunction(() => document.querySelector("#messageText")?.textContent === "CheckPoint One");
check("an expired key sends you back to checkpoint one", (await msg(page)) === "CheckPoint One");
await ctx.close();

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

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
done();
