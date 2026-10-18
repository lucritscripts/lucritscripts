// Executors: on the front page, and behind the two sponsor steps (18 Oct 2026).
//
// The download link (the executor's official site) comes out only with a
// grant — the same LootLabs/Linkvertise two-step flow a script uses. The
// listing never carries it. Name, status, description and Discord stay public.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter } from "./harness.mjs";

const PORT = 8161;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

// Dashboard links (the built-in two LootLabs links), no API call needed.
const env = freshEnv(worker, { LOOTLABS_TOKEN: "t", SITE_URL: "https://lucritscripts.site" });
const now = new Date().toISOString();
env.DB._raw.prepare(`INSERT INTO executors (id, name, developer, descr, platforms, status, version, website, discord, created_at, updated_at)
  VALUES ('x_synz', 'Synapse Z', 'Synapse', 'Fast PC executor.', '["PC"]', 'working', '2.1', 'https://synapsez.example/download', 'https://discord.gg/abc', ?, ?)`).run(now, now);
env.DB._raw.prepare(`INSERT INTO executors (id, name, developer, descr, platforms, status, version, website, created_at, updated_at)
  VALUES ('x_delta', 'Delta', 'Delta Team', 'Mobile executor.', '["Android","iOS"]', 'updating', '1.0', 'https://delta.example/', ?, ?)`).run(now, now);

const call = async (method, path, body, ip = "198.51.100.9") => {
  const res = await worker.fetch(new Request("https://lucrit.test" + path, {
    method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: body ? JSON.stringify(body) : undefined,
  }), env, { waitUntil() {} });
  let json = null; try { json = JSON.parse(await res.text()); } catch { /* */ }
  return { status: res.status, json };
};
const postback = (url) => call("GET", `/api/unlock/postback?click_id=${new URL(url).searchParams.get("puid")}&ip=1.2.3.4&unique_id=${Math.random()}`);

console.log("The download link is locked");
let r = await call("GET", "/api/executors");
check("the listing never carries download links", r.json.data.length === 2 && r.json.data.every((x) => x.website === "" && x.hasDownload));
r = await call("GET", "/api/executors/synz");
check("one executor: no link, marked locked", r.json.data.website === "" && r.json.data.locked === true, JSON.stringify(r.json.data).slice(0, 160));
check("…but name, status and Discord stay public", r.json.data.name === "Synapse Z" && r.json.data.status === "working" && r.json.data.discord === "https://discord.gg/abc");

console.log("\nTwo LootLabs steps unlock it");
r = await call("POST", "/api/unlock/flow", { scriptId: "x_synz", provider: "lootlabs" });
const flowId = r.json?.data?.flowId;
check("the flow starts for an executor", r.json?.ok && r.json.data.step === 1 && r.json.data.script?.kind === "executor" && r.json.data.script.title === "Synapse Z", JSON.stringify(r.json));
check("…shown as 'by Synapse', slug synz", r.json.data.script.author === "Synapse" && r.json.data.script.slug === "synz");
r = await call("POST", "/api/unlock/flow/go", { flowId });
const go1 = r.json.data.url;
check("step 1 → LootLabs with a puid", /^https:\/\/lootdest\.org\/s\?\w+&puid=[a-f0-9]{32}$/.test(go1), go1);
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("back without finishing → refused", r.status === 409 && r.json?.pending);
await postback(go1);
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("step 1 confirmed → step 2", r.json?.ok && r.json.data.step === 2);
check("one step isn't enough", (await call("GET", "/api/executors/synz")).json.data.locked === true);
r = await call("POST", "/api/unlock/flow/go", { flowId });
await postback(r.json.data.url);
r = await call("POST", "/api/unlock/flow/check", { flowId });
check("step 2 confirmed → done", r.json?.ok && r.json.data.done === true && r.json.data.script.kind === "executor", JSON.stringify(r.json));
r = await call("GET", "/api/executors/synz");
check("now the download link comes out", r.json.data.website === "https://synapsez.example/download" && r.json.data.locked === false && r.json.data.unlockedFor > 0, JSON.stringify(r.json.data).slice(0, 200));
check("…only for that executor", (await call("GET", "/api/executors/delta")).json.data.locked === true);
check("…and only for this visitor", (await call("GET", "/api/executors/synz", null, "203.0.113.50")).json.data.locked === true);
check("…and the listing still carries no links", (await call("GET", "/api/executors")).json.data.every((x) => x.website === ""));
check("an executor unlock counts as a paid unlock", env.DB._raw.prepare("SELECT COUNT(*) AS n FROM unlock_events WHERE script_id = 'x_synz' AND verified = 1").get().n === 1);
check("a removed or made-up executor can't start a flow", (await call("POST", "/api/unlock/flow", { scriptId: "x_nope", provider: "lootlabs" })).status === 404);

console.log("\nWith no sponsor switched on, nothing is locked");
const env2 = freshEnv(worker, {});
env2.DB._raw.prepare(`INSERT INTO executors (id, name, developer, descr, website, created_at, updated_at) VALUES ('x_a', 'A', 'B', 'C', 'https://a.example/', ?, ?)`).run(now, now);
const g = await (await worker.fetch(new Request("https://lucrit.test/api/executors/a"), env2, { waitUntil() {} })).json();
check("free mode: the link is shown", g.data.website === "https://a.example/" && g.data.locked === false);

console.log("\nIn the browser");
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
await ctx.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(AT + "/");
await page.locator("#ch-executors [data-xlib] .xcard").first().waitFor({ timeout: 20000 });
const order = await page.evaluate(() => [...document.querySelectorAll(".chapter")].map((c) => c.dataset.chapter));
check("front page: an Executor library section right after Find a script", order.indexOf("executors") === order.indexOf("search") + 1, order.join(","));
check("…listing the executors, working first", (await page.locator("#ch-executors .xcard__name").first().textContent()) === "Synapse Z"
  && await page.locator("#ch-executors .xcard").count() === 2);
check("…with a link to all of them", (await page.locator("#ch-executors [data-xlib-all]").getAttribute("href")) === "/executors");
await page.locator("#ch-executors .xcard").first().click();
await page.locator("#executors [data-xunlock]").first().waitFor({ timeout: 15000 });
check("an executor's page asks for the sponsor steps instead of showing the download",
  await page.locator('#executors a[href^="https://synapsez"]').count() === 0
  && (await page.locator("#executors [data-xunlock]").first().getAttribute("href")) === "/unlock/lootlabs?s=x_synz");
check("…while its Discord link is still there", await page.locator('#executors a[href="https://discord.gg/abc"]').count() === 1);
await page.locator("#executors [data-xunlock]").first().click();
await page.waitForURL(/\/unlock\/lootlabs/);
await page.locator("#unlock .ufl__go").waitFor({ timeout: 15000 });
check("the unlock page shows the executor, step 1 of 2", /Synapse Z/.test(await page.locator("#unlock").textContent()) && /Checkpoint 1 of 2/.test(await page.locator("#unlock").textContent()));
check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
process.exit(done() ? 1 : 0);
