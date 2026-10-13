// Linkvertise: an unlock that actually opens.
//
// Found on the live site: 7 Linkvertise unlocks started, 0 ever claimed. The
// return address was `/?unlocked=<script>` and Linkvertise appends its proof
// as `?hash=…` — a second question mark — so the page read the script id as
// "s_1?hash=…", saw no hash, and did nothing. Now the return address is a
// path (/api/unlock/lv/<click>) and the server checks the hash on arrival.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8151;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

// Stand in for Linkvertise's anti-bypass API.
const GOOD = "a".repeat(64), JSONGOOD = "B7".repeat(32), BAD = "f".repeat(64);
const asked = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://publisher.linkvertise.com/")) {
    const q = new URL(u).searchParams;
    asked.push({ method: init.method, token: q.get("token"), hash: q.get("hash") });
    const body = q.get("hash") === GOOD ? "TRUE" : q.get("hash") === JSONGOOD ? '{"status":true}' : "FALSE";
    return new Response(body, { status: 200 });
  }
  return realFetch(url, init);
};

const env = freshEnv(worker, { LINKVERTISE_TOKEN: "lv-test-token", LINKVERTISE_USER_ID: "8428262" });
const call = async (method, path, body, ip = "198.51.100.7") => {
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, redirect: "manual", headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  const text = res.status === 302 ? "" : await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, location: res.headers.get("Location") || "", cache: res.headers.get("Cache-Control") };
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
const id = pub.data.id;

console.log("The link we send people to");
const config = await call("GET", "/api/config");
check("Linkvertise is offered", config.json.data.unlockProviders.includes("linkvertise"));
let r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "linkvertise" });
const link = new URL(r.json.data.url);
const click1 = r.json.data.clickId;
check("a Linkvertise dynamic link for publisher 8428262", link.host === "link-to.net" && link.pathname.startsWith("/8428262/") && link.pathname.endsWith("/dynamic"), link.href);
const target = decodeURI(atob(link.searchParams.get("r")));
check("it returns to /api/unlock/lv/<click>", target === `https://lucrit.test/api/unlock/lv/${click1}`, target);
check("…an address with no '?' of its own, so Linkvertise's ?hash= lands cleanly", !target.includes("?"));

console.log("\nComing back with a good hash");
r = await call("GET", `/api/unlock/lv/${click1}?hash=${GOOD}`);
check("the hash is checked with Linkvertise straight away", asked.length === 1 && asked[0].hash === GOOD && asked[0].method === "POST");
check("…using the anti-bypass token", asked[0].token === "lv-test-token");
check("then on to the script with the click id", r.status === 302 && r.location === `/?unlocked=${id}&click=${click1}`, r.location);
check("the redirect is never cached", r.cache === "no-store");
r = await call("GET", `/api/unlock/lv/${click1}?hash=${GOOD}`);
check("a refresh doesn't spend another check (the hash is single-use)", asked.length === 1 && r.status === 302);
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click1 }, "203.0.113.99");
check("the claim succeeds — even from a different IP (phones change address)", r.json?.ok === true && r.json.data.verified === true, JSON.stringify(r.json));
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click1 });
check("and works once only", !r.json?.ok);

console.log("\nA JSON answer from Linkvertise");
r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "linkvertise" });
const click2 = r.json.data.clickId;
await call("GET", `/api/unlock/lv/${click2}?hash=${JSONGOOD}`);
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click2 });
check('{"status":true} counts as a pass (and a mixed-case hash is fine)', r.json?.ok === true, JSON.stringify(r.json));

console.log("\nRefuses what it should");
r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "linkvertise" });
const click3 = r.json.data.clickId;
await call("GET", `/api/unlock/lv/${click3}?hash=${BAD}`);
const t0 = Date.now();
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click3 });
check("a hash Linkvertise rejects → no unlock", !r.json?.ok && r.status === 400, JSON.stringify(r.json));
check("…said at once, not after a LootLabs-style wait", Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
check("…with a message that names Linkvertise", /Linkvertise/.test(r.json?.error || ""), r.json?.error);
r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "linkvertise" });
const click4 = r.json.data.clickId;
await call("GET", `/api/unlock/lv/${click4}`);
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click4 });
check("no hash at all → no unlock", !r.json?.ok);
const diag = env.DB._raw.prepare("SELECT v FROM cache WHERE k = ?").get("lvdiag:" + click4);
check("…and the reason is recorded for debugging", /no usable hash/.test(diag?.v || ""), diag?.v);
const diag3 = env.DB._raw.prepare("SELECT v FROM cache WHERE k = ?").get("lvdiag:" + click3);
check("what Linkvertise answered is recorded too (never the token)", /FALSE/.test(diag3?.v || "") && !/lv-test-token/.test(diag3?.v || ""), diag3?.v);
r = await call("GET", `/api/unlock/lv/${"0".repeat(32)}?hash=${GOOD}`);
check("an unknown click goes home with a notice, and costs no check", r.location.endsWith("/?lv=expired") && asked.filter((a) => a.hash === GOOD).length === 1, r.location);
const lootClick = "c".repeat(32);
env.DB._raw.prepare(`INSERT INTO unlock_clicks (click_id, script_id, subject, provider, done, at, expires)
  VALUES (?, ?, 'x', 'lootlabs', 0, ?, ?)`).run(lootClick, id, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 3600);
r = await call("GET", `/api/unlock/lv/${lootClick}?hash=${GOOD}`);
const lootRow = env.DB._raw.prepare("SELECT done FROM unlock_clicks WHERE click_id = ?").get(lootClick);
check("a LootLabs click can't be finished with a Linkvertise hash", r.location.endsWith("/?lv=expired") && lootRow.done === 0, r.location);

console.log("\nIn the browser, end to end");
const visitor = await person(browser, AT, null);
r = await visitor.page.evaluate(async (scriptId) => (await (await fetch("/api/unlock/start", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, provider: "linkvertise" }),
})).json()), id);
const back = decodeURI(atob(new URL(r.data.url).searchParams.get("r"))).replace(/^https?:\/\/[^/]+/, AT);
await visitor.page.goto(`${back}?hash=${GOOD}`);
let opened = false;
for (let i = 0; i < 20 && !opened; i++) {
  await visitor.page.waitForTimeout(500);
  opened = await visitor.page.evaluate(() => Boolean(document.querySelector("#script .script__code .code, #script .script__code pre")));
}
check("Linkvertise → our return address → the script, open", opened);
check("the address bar doesn't keep the click id or hash", await visitor.page.evaluate(() => !/click=|hash=/.test(location.href)));

console.log("\nAn older link still in flight (?unlocked=…?hash=…)");
const v2 = await person(browser, AT, null);
await v2.page.evaluate(async (scriptId) => fetch("/api/unlock/start", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, provider: "linkvertise" }),
}), id);
await v2.page.goto(`${AT}/?unlocked=${id}?hash=${GOOD}`);
opened = false;
for (let i = 0; i < 20 && !opened; i++) {
  await v2.page.waitForTimeout(500);
  opened = await v2.page.evaluate(() => Boolean(document.querySelector("#script .script__code .code, #script .script__code pre")));
}
check("the hash is unpicked from the doubled '?' and the script opens", opened);

await browser.close();
server.close();
globalThis.fetch = realFetch;
process.exit(done() ? 1 : 0);
