// The two-step LootLabs unlock: /unlock/lootlabs.
//
// Step 1 → LootLabs → back → Step 2 → LootLabs → back → script. Every step has
// to be confirmed by LootLabs' postback; nothing else moves the flow on.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8153;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const lockers = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith("https://creators.lootlabs.gg/")) {
    lockers.push(JSON.parse(init.body || "{}"));
    return new Response(JSON.stringify({ type: "created", message: [{ loot_url: `https://loot-link.com/s?L${lockers.length}` }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};

// "api" switches off the built-in dashboard links so the API path is tested too.
const env = freshEnv(worker, { LOOTLABS_TOKEN: "t", SITE_URL: "https://lucritscripts.site", LOOTLABS_LINKS: "api" });
const call = async (method, path, body, ip = "198.51.100.7") => {
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* */ }
  return { status: res.status, json };
};
const postback = (url) => call("GET", `/api/unlock/postback?click_id=${new URL(url).searchParams.get("puid")}&ip=1.2.3.4&unique_id=${Math.random()}`);

const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const maker = await person(browser, AT, "Maker");
const pub = await maker.page.evaluate(async () => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Blox Fruits Auto Farm", game: "Blox Fruits", category: "combat", keyless: true,
    tags: ["AutoFarm"], captcha: true, thumbnail: "https://tr.rbxcdn.com/a/768/432/Image/Png",
    desc: "Auto farms levels and bosses for you with a simple menu. ".repeat(12),
    code: 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()' }),
})).json());
const id = pub.data.id;
await maker.ctx.close();

console.log("The flow, on the server");
let r = await call("POST", "/api/unlock/flow", { scriptId: id, provider: "lootlabs" });
const flowId = r.json?.data?.flowId;
check("starts at step 1 of 2", r.json?.data?.step === 1 && r.json.data.total === 2, JSON.stringify(r.json));
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("checking before going anywhere does nothing", !r.json?.ok && r.status === 400);
r = await call("POST", "/api/unlock/flow/go", { flowId });
const go1 = r.json?.data?.url || "";
check("step 1 sends you to LootLabs with a puid to verify", /^https:\/\/loot-link\.com\/s\?L\d+&puid=[a-f0-9]{32}$/.test(go1), go1);
check("…and LootLabs sends you back to /unlock/lootlabs", lockers.at(-1)?.url === "https://lucritscripts.site/unlock/lootlabs", lockers.at(-1)?.url);
check("step 1 is its own LootLabs locker, titled 'Step 1/2 · …'", /^Step 1\/2 · Blox Fruits/.test(lockers.at(-1)?.title || "") && lockers.at(-1).title.length <= 30, lockers.at(-1)?.title);
let t0 = Date.now();
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("coming back WITHOUT finishing → not confirmed (bypass refused)", r.status === 409 && r.json?.pending, JSON.stringify(r.json));
check("…after a short wait for a late postback", Date.now() - t0 >= 5000, `${Date.now() - t0}ms`);
r = await call("GET", `/api/scripts/${id}/code`);
check("…and the code is still locked", r.status === 403, String(r.status));

await postback(go1);
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("step 1 confirmed by LootLabs → on to step 2", r.json?.ok && r.json.data.step === 2 && r.json.data.advanced, JSON.stringify(r.json));
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("step 1 can't be counted twice", !r.json?.ok && r.status === 400, JSON.stringify(r.json));
r = await call("GET", `/api/scripts/${id}/code`);
check("one step isn't enough for the code", r.status === 403);

r = await call("POST", "/api/unlock/flow/go", { flowId });
const go2 = r.json?.data?.url || "";
check("step 2 is a new link with a new puid", go2 && new URL(go2).searchParams.get("puid") !== new URL(go1).searchParams.get("puid"));
check("…from a second LootLabs locker, titled 'Step 2/2 · …'", /^Step 2\/2 · /.test(lockers.at(-1)?.title || "") && new URL(go2).search.split("&")[0] !== new URL(go1).search.split("&")[0], lockers.at(-1)?.title);
await postback(go1);   // a replayed step-1 postback
t0 = Date.now();
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("an old step's postback can't finish step 2", r.status === 409, JSON.stringify(r.json));
await postback(go2);
r = await call("POST", "/api/unlock/flow/check", { flowId }, "203.0.113.50");
check("step 2 confirmed → done", r.json?.ok && r.json.data.done === true, JSON.stringify(r.json));
r = await call("GET", `/api/scripts/${id}/code`, null, "203.0.113.50");
check("…and the code opens for that visitor", r.status === 200, String(r.status));
r = await call("GET", `/api/unlock/flow?id=${flowId}`);
check("a finished flow is gone (can't be replayed)", r.status === 404);
r = await call("POST", "/api/unlock/flow/check", { flowId: "a".repeat(32) });
check("a made-up flow id gets nothing", r.status === 404);
const events = env.DB._raw.prepare("SELECT COUNT(*) n FROM unlock_events WHERE script_id = ? AND verified = 1 AND provider = 'lootlabs'").get(id);
check("the author is credited one verified unlock", events.n === 1, JSON.stringify(events));

console.log("\nHand-made LootLabs links (LOOTLABS_LINKS)");
env.LOOTLABS_LINKS = "https://loot-link.com/s?StepOne, https://loot-link.com/s?StepTwo";
const before = lockers.length;
r = await call("POST", "/api/unlock/flow", { scriptId: id, provider: "lootlabs" });
const f2 = r.json.data.flowId;
r = await call("POST", "/api/unlock/flow/go", { flowId: f2 });
check("step 1 uses your first link + puid", /^https:\/\/loot-link\.com\/s\?StepOne&puid=[a-f0-9]{32}$/.test(r.json?.data?.url || ""), r.json?.data?.url);
await postback(r.json.data.url);
await call("POST", "/api/unlock/flow/check", { flowId: f2 });
r = await call("POST", "/api/unlock/flow/go", { flowId: f2 });
check("step 2 uses your second link", /^https:\/\/loot-link\.com\/s\?StepTwo&puid=/.test(r.json?.data?.url || ""), r.json?.data?.url);
check("…and no API call at all", lockers.length === before, `${lockers.length - before} calls`);
env.LOOTLABS_LINKS = "api";

console.log("\nThe real dashboard links (default)");
delete env.LOOTLABS_LINKS;
r = await call("POST", "/api/unlock/flow", { scriptId: id, provider: "lootlabs" });
const f3 = r.json.data.flowId;
r = await call("POST", "/api/unlock/flow/go", { flowId: f3 });
check("step 1 → lootdest.org/s?gBsJVZu6 + puid", /^https:\/\/lootdest\.org\/s\?gBsJVZu6&puid=[a-f0-9]{32}$/.test(r.json?.data?.url || ""), r.json?.data?.url);
await postback(r.json.data.url);
await call("POST", "/api/unlock/flow/check", { flowId: f3 });
r = await call("POST", "/api/unlock/flow/go", { flowId: f3 });
check("step 2 → lootdest.org/s?3c4ePbHu + puid", /^https:\/\/lootdest\.org\/s\?3c4ePbHu&puid=/.test(r.json?.data?.url || ""), r.json?.data?.url);
env.LOOTLABS_LINKS = "api";

console.log("\nIn the browser");
const errors = [];
const v = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await v.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => { localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })); window.__lucritNoAdTag = true; });
let lastLoot = "";
await page.route("https://loot-link.com/**", (route) => { lastLoot = route.request().url(); route.fulfill({ status: 200, contentType: "text/html", body: "<p>LootLabs</p>" }); });

await page.goto(`${AT}/creations/Maker/${pub.data.slug}`);
await page.waitForTimeout(1500);
await page.locator('#script [data-act="lootlabs"]').click();
await page.waitForTimeout(1500);
check("'Unlock with LootLabs' opens /unlock/lootlabs", new URL(page.url()).pathname === "/unlock/lootlabs", page.url());
check("…showing step 1 of 2", /Checkpoint 1 of 2/.test(await page.locator("#unlock").textContent()));
check("…with the script's name on it", /Blox Fruits Auto Farm/.test(await page.locator("#unlock .ufl__title").textContent()));
const fit = await page.evaluate(() => { const p = document.querySelector("#unlock .sheet__panel"); return p.scrollWidth <= p.clientWidth + 1; });
check("fits a phone screen", fit);

await page.locator('#unlock [data-ufl="go"]').click();
await page.waitForTimeout(1200);
check("the button goes to LootLabs", /loot-link\.com/.test(lastLoot), lastLoot);
await postback(lastLoot);
await page.goto(`${AT}/unlock/lootlabs`);         // LootLabs sends them back
await page.waitForTimeout(2500);
let text = await page.locator("#unlock").textContent();
check("back from LootLabs → step 1 ticked, step 2 up", /Step 1 complete/.test(text) && /Final checkpoint/.test(text) && /Final step/.test(text), text.slice(0, 200));

await page.locator('#unlock [data-ufl="go"]').click();
await page.waitForTimeout(1200);
await postback(lastLoot);
await page.goto(`${AT}/unlock/lootlabs`);
let opened = false;
for (let i = 0; i < 20 && !opened; i++) {
  await page.waitForTimeout(500);
  opened = await page.evaluate(() => Boolean(document.querySelector("#script .script__code .code, #script .script__code pre")));
}
check("back from step 2 → the script page, code open", opened);
check("…at the script's own address", page.url().endsWith(`/creations/Maker/${pub.data.slug}`), page.url());

// Skipping: open /unlock/lootlabs by hand after starting, without LootLabs.
const sneaky = await browser.newContext();
const sp = await sneaky.newPage();
await sp.addInitScript(() => { localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })); window.__lucritNoAdTag = true; });
await sp.route("https://loot-link.com/**", (route) => route.fulfill({ status: 200, body: "x" }));
await sp.goto(`${AT}/unlock/lootlabs?s=${id}`);
await sp.waitForTimeout(1200);
await sp.locator('#unlock [data-ufl="go"]').click();
await sp.waitForTimeout(800);
await sp.goto(`${AT}/unlock/lootlabs`);   // came back without doing anything
await sp.waitForTimeout(4000);
check("while it waits, there's a way to redo the step", await sp.locator('#unlock [data-ufl="retry"]').count() === 1);
await sp.waitForTimeout(36000);
text = await sp.locator("#unlock").textContent();
check("coming back without doing the step → still step 1", /Checkpoint 1 of 2/.test(text), text.slice(0, 160));
check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();
globalThis.fetch = realFetch;
process.exit(done() ? 1 : 0);
