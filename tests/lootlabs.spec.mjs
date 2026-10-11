// LootLabs: the locker we ask for, and an unlock that actually opens.
//
// Found in the live database: a LootLabs unlock whose postback had arrived
// (done = 1) but which was never claimed. LootLabs sends the visitor back the
// moment the last task ends and its postback lands a few seconds later; the
// claim ran first, was refused, and a finished, paid unlock never opened.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8147;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

// Stand in for LootLabs' API. Everything the Worker sends is recorded.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith("https://creators.lootlabs.gg/")) {
    const body = JSON.parse(init.body || "{}");
    sent.push({ url: String(url), body, auth: init.headers?.Authorization });
    // The live API wraps `message` in an array; the docs say object. Use the live shape.
    return new Response(JSON.stringify({ type: "created", message: [{ short: "abcd", loot_url: "https://loot-link.com/s?abcd" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return realFetch(url, init);
};

const env = freshEnv(worker, { LOOTLABS_TOKEN: "test-token", SITE_URL: "https://lucritscripts.site" });
const call = async (method, path, body, ip = "198.51.100.7") => {
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};

const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const author = await person(browser, AT, "Maker");
const pub = await author.page.evaluate(async () => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "A very long script title that goes past thirty", game: "Blox Fruits", category: "combat",
    keyless: true, tags: ["Combat"], captcha: true,
    thumbnail: "https://tr.rbxcdn.com/abc/768/432/Image/Png",
    desc: "Auto farms levels and bosses for you with a simple menu. ".repeat(12),
    code: 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()' }),
})).json());
const id = pub.data.id;

console.log("The locker we ask LootLabs for");
let r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "lootlabs" });
const req = sent.at(-1)?.body || {};
check("tier 4 — LootLabs' 'Maximum Profit' tier", req.tier_id === 4, JSON.stringify(req));
check("5 tasks — the most LootLabs allows per session", req.number_of_tasks === 5);
check("Classic theme (1), not the old Minecraft skin (3)", req.theme === 1);
check("title cut to LootLabs' 30-character limit", typeof req.title === "string" && req.title.length <= 30);
check("the script's art goes on the locker", req.thumbnail === "https://tr.rbxcdn.com/abc/768/432/Image/Png");
check("returns to the site naming the script and click", /^https:\/\/lucritscripts\.site\/\?unlocked=s_[a-f0-9]+&click=[a-f0-9]+$/.test(req.url), req.url);
check("token sent as a Bearer header", sent.at(-1)?.auth === "Bearer test-token");
check("the link carries puid for the postback", /&puid=[a-f0-9]{32}$/.test(r.json?.data?.url || ""), r.json?.data?.url);
const config = await call("GET", "/api/config");
check("/api/config reports the settings in force", JSON.stringify(config.json.data.lootlabs) === '{"tier":4,"tasks":5,"theme":1}',
  JSON.stringify(config.json.data.lootlabs));

console.log("\nPostback arrives AFTER the visitor is back (the real-world order)");
const click1 = new URL(r.json.data.url).searchParams.get("puid");
const t0 = Date.now();
const late = setTimeout(() => call("GET", `/api/unlock/postback?click_id=${click1}&ip=1.2.3.4&unique_id=u1`), 2500);
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click1 });
clearTimeout(late);
check("the claim waits for it and succeeds", r.json?.ok === true && r.json.data.verified === true, JSON.stringify(r.json));
check("…in a few seconds, not instantly refused", Date.now() - t0 >= 2000, `${Date.now() - t0}ms`);
const code = await call("GET", `/api/scripts/${id}/code`);
check("the code then opens for that visitor", code.status === 200, String(code.status));
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click1 });
check("a click id works once only", !r.json?.ok, JSON.stringify(r.json));

console.log("\nPostback very late");
r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "lootlabs" }, "198.51.100.8");
const click2 = new URL(r.json.data.url).searchParams.get("puid");
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click2 }, "198.51.100.8");
check("the server says 'pending' (not 'not completed') so the page keeps asking", r.status === 409 && r.json?.pending === true, JSON.stringify(r.json));
await call("GET", `/api/unlock/postback?click_id=${click2}&ip=1.2.3.4&unique_id=u2`);
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click2 }, "203.0.113.99");
check("then succeeds — even though the visitor's IP changed on the way back", r.json?.ok === true, JSON.stringify(r.json));

console.log("\nPostbacks are counted per task, duplicates ignored");
r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "lootlabs" });
const click3 = new URL(r.json.data.url).searchParams.get("puid");
for (const u of ["t1", "t1", "t2", "t3"]) await call("GET", `/api/unlock/postback?click_id=${click3}&ip=1.2.3.4&unique_id=${u}`);
const row = env.DB._raw.prepare("SELECT done FROM unlock_clicks WHERE click_id = ?").get(click3);
check("3 distinct tasks recorded (a repeated postback doesn't count twice)", row?.done === 3, JSON.stringify(row));

console.log("\nStill refuses what it should");
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: "f".repeat(32) });
check("a made-up click id", !r.json?.ok && r.status === 400);
r = await call("POST", "/api/unlock/start", { scriptId: id, provider: "lootlabs" });
const click4 = new URL(r.json.data.url).searchParams.get("puid");
const t1 = Date.now();
r = await call("POST", "/api/unlock/claim", { scriptId: id, clickId: click4 });
check("no postback at all → never opens", !r.json?.ok && r.json?.pending === true, JSON.stringify(r.json));
check("…and the server gives up waiting after ~6s", Date.now() - t1 < 9000, `${Date.now() - t1}ms`);

console.log("\nIn the browser: back from LootLabs before the postback");
const visitor = await person(browser, AT, null);
r = await visitor.page.evaluate(async (scriptId) => (await (await fetch("/api/unlock/start", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scriptId, provider: "lootlabs" }),
})).json()), id);
const click5 = new URL(r.data.url).searchParams.get("puid");
setTimeout(() => call("GET", `/api/unlock/postback?click_id=${click5}&ip=1.2.3.4&unique_id=v1`), 9000);
await visitor.page.goto(`${AT}/?unlocked=${id}&click=${click5}`);
let opened = false;
for (let i = 0; i < 30 && !opened; i++) {
  await visitor.page.waitForTimeout(1000);
  opened = await visitor.page.evaluate(() => Boolean(document.querySelector("#script .script__code .code, #script .script__code pre")));
}
check("the page keeps asking and opens the script once LootLabs confirms", opened);

await browser.close();
server.close();
globalThis.fetch = realFetch;
process.exit(done() ? 1 : 0);
