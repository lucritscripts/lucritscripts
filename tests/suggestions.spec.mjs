// Suggested scripts on the script (unlock) page.
//
// Asked for: "suggest scripts for that game, and the script that has a
// description closest similar to the one the player is trying to unlock".
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";
import { rankSimilar, suggestionsFor, tokens, sameGame } from "../assets/js/similar.js";

const PORT = 8152;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

/* ------------------------------------------------------------ the ranking */
console.log("Ranking");
const T = { id: "t", game: "Pet Simulator X", title: "PSX Auto Hatch", category: "farming", tags: ["AutoFarm"],
  desc: "Auto hatches eggs for you and farms coins while you are away. Hatch faster with triple eggs." };
const pool = [
  T,
  { id: "a", game: "Pet Simulator X", title: "PSX Trade Helper", category: "utility", tags: ["Trading"], desc: "Shows trade values and scams so you can trade pets safely in the trading plaza.", views: 900 },
  { id: "b", game: "pet simulator x!", title: "Egg Hatcher", category: "farming", tags: ["AutoFarm"], desc: "Hatches eggs automatically, triple hatch supported, and farms coins between eggs.", views: 3 },
  { id: "c", game: "Pet Simulator 99", title: "PS99 Auto Hatch", category: "farming", tags: ["AutoFarm"], desc: "Auto hatch eggs and farm coins in Pet Simulator 99." },
  { id: "d", game: "Blox Fruits", title: "Fruit Notifier", category: "utility", tags: ["ESP"], desc: "Pings you when a devil fruit spawns on your server." },
];
const r = rankSimilar(T, pool);
check("the script itself is never suggested", ![...r.sameGame, ...r.otherGames].some((x) => x.script.id === "t"));
check("same game, with spelling/case ignored ('pet simulator x!')", r.sameGame.map((x) => x.script.id).sort().join() === "a,b", JSON.stringify(r.sameGame.map((x) => x.script.id)));
check("closest description first — the egg hatcher, not the more-viewed trade tool", r.sameGame[0].script.id === "b", r.sameGame.map((x) => `${x.script.id}:${x.score.toFixed(2)}`).join(" "));
check("an unrelated other-game script isn't offered", !r.otherGames.some((x) => x.script.id === "d"));
const picks = suggestionsFor(T, pool, 4);
check("same-game picks come before other games", picks.map((p) => p.script.id).join() === "b,a,c", picks.map((p) => p.script.id).join());
check("other games only top up a short list", suggestionsFor(T, pool, 2).every((p) => p.sameGame));
check("common words don't count ('the', 'script', 'roblox')", tokens("The best Roblox script for the game").length === 0);
check("plurals fold together", tokens("eggs pets").join() === "egg,pet");
check("game names match loosely", sameGame("Blox Fruits", "blox-fruits") && !sameGame("", ""));

/* -------------------------------------------------------------- the page */
const env = freshEnv(worker, { LOOTLABS_TOKEN: "t" });
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

const make = (p, s) => p.evaluate(async (s) => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ category: "farming", keyless: true, captcha: true, tags: ["AutoFarm"], thumbnail: "https://tr.rbxcdn.com/" + s.title.replace(/\W/g, "") + "/768/432/Image/Png",
    code: 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()', ...s }),
})).json(), s);
const long = (t) => (t + " ").repeat(8);

const a = await person(browser, AT, "Maker");
const target = await make(a.page, { title: "PSX Auto Hatch", game: "Pet Simulator X",
  desc: long("Auto hatches eggs for you and farms coins while you are away. Hatch faster with triple eggs.") });
const hatcher = await make(a.page, { title: "Egg Hatcher Pro", game: "Pet Simulator X",
  desc: long("Hatches eggs automatically with triple hatch, and farms coins between eggs so you never stop.") });
const trader = await make(a.page, { title: "PSX Trade Helper", game: "Pet Simulator X", category: "utility", tags: ["Trading"],
  desc: long("Shows trade values and flags scams so you can trade pets safely in the trading plaza.") });
const other = await make(a.page, { title: "Fruit Notifier", game: "Blox Fruits", category: "utility", tags: ["ESP"],
  desc: long("Pings you when a devil fruit spawns on your server and shows where it landed.") });
check("test scripts published", [target, hatcher, trader, other].every((x) => x.ok), JSON.stringify([target, hatcher, trader, other].map((x) => x.error)));
await a.ctx.close();

console.log("\nOn the unlock page (desktop)");
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
await page.goto(`${AT}/creations/Maker/${target.data.slug}`);
await page.waitForTimeout(2200);
check("the script is locked (this is the unlock page)", await page.locator("#script .gate").count() > 0);
const cards = () => page.$$eval("#script .suggest__card", (els) => els.map((e) => ({
  id: e.dataset.suggest, title: e.querySelector(".suggest__title").textContent, closest: /Closest match/.test(e.textContent) })));
let shown = await cards();
check("a suggestions section is there", shown.length >= 2, JSON.stringify(shown));
check("headed with the game's name", /More\s+Pet Simulator X\s+scripts/.test(await page.locator("#script .suggest__head").textContent()));
check("first is the closest description, marked 'Closest match'", shown[0]?.id === hatcher.data.id && shown[0].closest, JSON.stringify(shown));
check("then the rest of that game", shown[1]?.id === trader.data.id, JSON.stringify(shown));
check("not the script you're on, and no unrelated game", !shown.some((c) => c.id === target.data.id || c.id === other.data.id));
await page.locator(`#script [data-suggest="${hatcher.data.id}"]`).click();
await page.waitForTimeout(1500);
check("clicking one opens that script", /Egg Hatcher Pro/.test(await page.locator("#script h2").textContent()));
check("…at its own address", page.url().endsWith(`/creations/Maker/${hatcher.data.slug}`), page.url());
shown = await cards();
check("…with suggestions for it in turn (the first script is now one of them)", shown.some((c) => c.id === target.data.id), JSON.stringify(shown));
await ctx.close();

console.log("\nOn a phone");
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const pp = await phone.newPage();
pp.on("pageerror", (e) => errors.push(e.message));
await pp.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
await pp.goto(`${AT}/creations/Maker/${target.data.slug}`);
await pp.waitForTimeout(2200);
const lay = await pp.evaluate(() => {
  const g = document.querySelector("#script .suggest__grid");
  const c = [...document.querySelectorAll("#script .suggest__card")].map((e) => e.getBoundingClientRect());
  const panel = document.querySelector("#script .sheet__panel");
  return { cols: new Set(c.map((r) => Math.round(r.left))).size, overflow: panel.scrollWidth > panel.clientWidth + 1, h: Math.round(c[0]?.height || 0), g: Boolean(g) };
});
check("two across, no sideways scrolling", lay.g && lay.cols === 2 && !lay.overflow, JSON.stringify(lay));
check("cards big enough to tap", lay.h >= 44, JSON.stringify(lay));
await phone.close();

console.log("\nNothing to suggest");
const env2 = freshEnv(worker, { LOOTLABS_TOKEN: "t" });
const server2 = await serve(worker, env2, PORT + 1);
const solo = await person(browser, `http://localhost:${PORT + 1}`, "Solo");
const only = await make(solo.page, { title: "Doors Entity ESP", game: "Doors", desc: long("Shows every entity coming down the hallway before it reaches you, with a warning sound and a timer.") });
if (!only.ok) console.log("publish failed:", only.error);
await solo.page.goto(`http://localhost:${PORT + 1}/creations/Solo/${only.data.slug}`);
await solo.page.waitForTimeout(1800);
check("no empty section when the library has nothing else", await solo.page.locator("#script .suggest").count() === 0);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close(); server2.close();
process.exit(done() ? 1 : 0);
