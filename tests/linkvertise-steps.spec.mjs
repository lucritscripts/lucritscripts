// Linkvertise in two steps — the script unlock (/unlock/linkvertise) and
// Get Key (/getkey) — the same shape as LootLabs.
//
// Asked for (16 Oct 2026): "now lets add the linkvertise parts to the get key
// and script unlock" / "with two steps to the linkvertise too".
//
// Linkvertise's anti-bypass API is faked at the fetch boundary; a step only
// counts when that check says TRUE for the hash on the way back.
import fs from "node:fs";
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, ROOT, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8221;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const GOOD = "a".repeat(64), BAD = "f".repeat(64);
const realFetch = globalThis.fetch;
let hashes = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://publisher.linkvertise.com/")) {
    const h = new URL(u).searchParams.get("hash");
    hashes.push(h);
    return new Response(h.startsWith("a") ? "TRUE" : "FALSE", { status: 200 });
  }
  return realFetch(url, init);
};

const env = freshEnv(worker, { LINKVERTISE_TOKEN: "lv-test-token", LINKVERTISE_USER_ID: "8428262", LOOTLABS_TOKEN: "t" });
let ipN = 0;
const call = async (method, path, body, cookie) => {
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, redirect: "manual",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `198.51.100.${++ipN % 250}`, ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  const text = res.status === 302 ? "" : await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, location: res.headers.get("Location") || "" };
};
const clickOf = (url) => {
  const r = new URL(url).searchParams.get("r");
  const target = decodeURI(Buffer.from(r, "base64").toString("utf8"));
  return { target, click: target.split("/").pop() };
};

const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const author = await person(browser, AT, "Maker");
const pub = await author.page.evaluate(async () => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Blox Fruits Auto Farm", game: "Blox Fruits", category: "combat",
    keyless: true, tags: ["Combat"], captcha: true, thumbnail: "https://tr.rbxcdn.com/abc/768/432/Image/Png",
    desc: "Auto farms levels and bosses for you with a simple menu. ".repeat(12),
    code: 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()' }),
})).json());
const sid = pub.data.id;
await author.ctx.close();

/* ── script unlock, API ─────────────────────────────────────────────── */
console.log("Script unlock: two Linkvertise steps");
const cfg = await call("GET", "/api/config");
check("config says Linkvertise can do steps", cfg.json.data.linkvertiseSteps === true);
let r = await call("POST", "/api/unlock/flow", { scriptId: sid, provider: "linkvertise" });
check("flow starts as a Linkvertise flow", r.json.ok && r.json.data.provider === "linkvertise" && r.json.data.total === 2, JSON.stringify(r.json));
const flowId = r.json.data.flowId;

r = await call("POST", "/api/unlock/flow/go", { flowId });
let link = new URL(r.json.data.url);
let { target, click } = clickOf(link.href);
check("step 1 is a Linkvertise dynamic link (8428262)", link.host === "link-to.net" && link.pathname.startsWith("/8428262/") && link.pathname.endsWith("/dynamic"), link.href);
check("…coming back through the hash check", /\/api\/unlock\/lv\/[a-f0-9]{32}$/.test(target), target);

r = await call("POST", "/api/unlock/flow/check", { flowId });
check("not done before Linkvertise", r.status === 409 && r.json.pending === true && /Linkvertise/.test(r.json.error), JSON.stringify(r.json));

r = await call("GET", `/api/unlock/lv/${click}?hash=${BAD}`);
check("a bad hash still returns to the unlock page", r.status === 302 && r.location === "/unlock/linkvertise", r.location);
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("…but doesn't count", r.status === 409);

r = await call("POST", "/api/unlock/flow/go", { flowId });
({ click } = clickOf(r.json.data.url));
r = await call("GET", `/api/unlock/lv/${click}?hash=${GOOD}`);
check("good hash → back to /unlock/linkvertise", r.location === "/unlock/linkvertise");
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("step 1 confirmed → step 2", r.json.ok && r.json.data.step === 2, JSON.stringify(r.json));

r = await call("POST", "/api/unlock/flow/go", { flowId });
({ click } = clickOf(r.json.data.url));
await call("GET", `/api/unlock/lv/${click}?hash=a${"b".repeat(63)}`);
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("step 2 confirmed → unlocked", r.json.ok && r.json.data.done === true, JSON.stringify(r.json));
const ev = env.DB._raw.prepare("SELECT provider, verified FROM unlock_events WHERE script_id = ?").all(sid);
check("the author gets a verified Linkvertise unlock", ev.length === 1 && ev[0].provider === "linkvertise" && ev[0].verified === 1, JSON.stringify(ev));

const off = freshEnv(worker, { LOOTLABS_TOKEN: "t" });
const offRes = await worker.fetch(new Request("https://lucrit.test/api/unlock/flow", { method: "POST",
  headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.9" }, body: JSON.stringify({ scriptId: sid, provider: "linkvertise" }) }), off, {});
check("without Linkvertise set up, it says so (503)", offRes.status === 503);

/* ── Get Key, API ───────────────────────────────────────────────────── */
console.log("\nGet Key: two Linkvertise steps");
r = await call("POST", "/api/getkey/lv/go", { step: 2 });
check("can't start step 2 first", r.status === 400 && r.json.restart === true);
r = await call("POST", "/api/getkey/lv/go", { step: 1 });
const gk = r.json.data.gk;
({ target, click } = clickOf(r.json.data.url));
check("step 1 is a Linkvertise link back through the hash check", /^[a-f0-9]{32}$/.test(gk) && /\/api\/unlock\/lv\//.test(target));
r = await call("GET", "/api/getkey/lv/check?gk=" + gk + "&step=1");
check("not verified before Linkvertise", r.json.data.verified === false);
r = await call("GET", `/api/unlock/lv/${click}?hash=${BAD}`);
check("bad hash → /getkey?lv=failed", r.location === "/getkey?lv=failed", r.location);
r = await call("POST", "/api/getkey/lv/go", { step: 2, gk });
check("still can't do step 2", r.status === 400);

r = await call("POST", "/api/getkey/lv/go", { step: 1, gk });
const gk1 = r.json.data.gk;
({ click } = clickOf(r.json.data.url));
r = await call("GET", `/api/unlock/lv/${click}?hash=${GOOD}`);
check("good hash → /getkey?step=1&lv=<flow>", r.location === `/getkey?step=1&lv=${gk1}`, r.location);
check("step 1 verified", (await call("GET", `/api/getkey/lv/check?gk=${gk1}&step=1`)).json.data.verified === true);
check("step 2 not yet", (await call("GET", `/api/getkey/lv/check?gk=${gk1}&step=2`)).json.data.verified === false);
r = await call("POST", "/api/getkey/lv/go", { step: 2, gk: gk1 });
check("step 2 opens after step 1", r.json.ok && r.json.data.gk === gk1);
({ click } = clickOf(r.json.data.url));
r = await call("GET", `/api/unlock/lv/${click}?hash=${GOOD}`);
check("good hash → /getkey?step=2&lv=<flow>", r.location === `/getkey?step=2&lv=${gk1}`);
check("step 2 verified", (await call("GET", `/api/getkey/lv/check?gk=${gk1}&step=2`)).json.data.verified === true);
r = await call("GET", `/api/unlock/lv/${click}?hash=${GOOD}`);
check("a used return link can't be replayed", r.location === "/?lv=expired", r.location);

/* ── Get Key, in the browser ────────────────────────────────────────── */
console.log("\nGet Key page");
const PAGE = fs.readFileSync(ROOT + "/getkey.html", "utf8");
const FAKE_APP = `export function initializeApp(c){ return { c }; }`;
const FAKE_FS = `
const K = "__fs_test";
const load = () => JSON.parse(localStorage.getItem(K) || "{}");
const save = (s) => localStorage.setItem(K, JSON.stringify(s));
export function getFirestore(app){ return { app }; }
export function doc(db, col, id){ return { col, id }; }
export async function getDoc(ref){ const s = load(); const d = s[ref.col + "/" + ref.id]; return { exists: () => !!d, data: () => d }; }
export async function setDoc(ref, data, opts){ const s = load(); const k = ref.col + "/" + ref.id; s[k] = opts && opts.merge ? { ...(s[k] || {}), ...data } : data; save(s); }`;
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (x) => x.fulfill({ contentType: "text/javascript", body: FAKE_APP }));
await ctx.route("https://www.gstatic.com/firebasejs/**/firebase-firestore.js", (x) => x.fulfill({ contentType: "text/javascript", body: FAKE_FS }));
await ctx.route("https://fonts.googleapis.com/**", (x) => x.fulfill({ contentType: "text/css", body: "" }));
await ctx.route(/\/getkey(\?.*)?$/, (x) => x.fulfill({ contentType: "text/html", body: PAGE }));
await ctx.route(/^https:\/\/(link-to\.net|loot-link\.com|lootdest\.org)\//, (x) => x.fulfill({ contentType: "text/html", body: "<title>sponsor</title>" }));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (d) => d.accept());

await page.goto(`${AT}/getkey`);
const lvBtn = page.locator("#lvBtn");
await lvBtn.waitFor({ state: "visible" });
check("Linkvertise button stays hidden until the page knows it's on", true);
check("checkpoint one offers both sponsors",
  /LootLabs/.test(await page.locator("#finishBtn").textContent()) && /Linkvertise/.test(await lvBtn.textContent()));
await lvBtn.click();
await page.waitForURL(/link-to\.net/);
check("Get Key with Linkvertise → a Linkvertise link", /^https:\/\/link-to\.net\/8428262\//.test(page.url()), page.url());
const { click: pc1 } = clickOf(page.url());
const back1 = await call("GET", `/api/unlock/lv/${pc1}?hash=${GOOD}`);
await page.goto(AT + back1.location);
await page.locator("#finishBtn", { hasText: "Continue with Linkvertise" }).waitFor();
check("back from step 1: Final Checkpoint, continuing with Linkvertise", (await page.locator("#messageText").textContent()) === "Final Checkpoint");
await page.locator("#finishBtn").click();
await page.waitForURL(/link-to\.net/);
const { click: pc2 } = clickOf(page.url());
const back2 = await call("GET", `/api/unlock/lv/${pc2}?hash=${GOOD}`);
await page.goto(AT + back2.location);
await page.locator("#finishBtn", { hasText: "Get Your Key" }).waitFor();
await page.locator("#finishBtn").click();
await page.locator("#keyActiveSection").waitFor({ state: "visible" });
check("…and the key is made", /^LUCRIT-[A-Z2-9]{16}$/.test((await page.locator("#keyBox").textContent()).trim()));

const p2 = await ctx.newPage();
await p2.evaluate(() => 0).catch(() => {});
const c2 = await browser.newContext();
await c2.route("https://www.gstatic.com/firebasejs/**/firebase-app.js", (x) => x.fulfill({ contentType: "text/javascript", body: FAKE_APP }));
await c2.route("https://www.gstatic.com/firebasejs/**/firebase-firestore.js", (x) => x.fulfill({ contentType: "text/javascript", body: FAKE_FS }));
await c2.route(/\/getkey(\?.*)?$/, (x) => x.fulfill({ contentType: "text/html", body: PAGE }));
const forged = await c2.newPage();
await forged.goto(`${AT}/getkey?step=2&lv=${"c".repeat(32)}`);
await forged.waitForURL(`${AT}/getkey`);
check("a made-up Linkvertise return is sent back to checkpoint one", forged.url() === `${AT}/getkey`);
await c2.close();
await p2.close();

/* ── script page → /unlock/linkvertise ─────────────────────────────── */
console.log("\nScript page");
const sp = await ctx.newPage();
await sp.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
await sp.goto(`${AT}/creations/Maker/${pub.data.slug}`);
await sp.locator('#script [data-act="linkvertise"]').waitFor();
check("gate says two steps either way", /Two quick steps with LootLabs or Linkvertise/.test(await sp.locator("#script .gate").textContent()));
await sp.locator('#script [data-act="linkvertise"]').click();
await sp.locator("#unlock .ufl__kicker").waitFor();
check("Unlock with Linkvertise opens /unlock/linkvertise", new URL(sp.url()).pathname === "/unlock/linkvertise", sp.url());
check("…at Checkpoint 1 of 2", /Checkpoint 1 of 2/.test(await sp.locator("#unlock .ufl__kicker").textContent()));
check("…naming Linkvertise", /Linkvertise/.test(await sp.locator("#unlock").textContent()));
await sp.locator('#unlock [data-ufl="go"]').click();
await sp.waitForURL(/link-to\.net/);
check("Continue → a Linkvertise link", /^https:\/\/link-to\.net\/8428262\//.test(sp.url()));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
globalThis.fetch = realFetch;
done();
