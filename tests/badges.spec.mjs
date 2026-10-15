// Script page badges.
//
// Asked for (15 Oct 2026): "for the script page remove the lua detected, and
// if a script is verified by an admin through the admin panel make sure it
// has a bright yellow bubble that says Verified".
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8161;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const env = freshEnv(worker, { LOOTLABS_TOKEN: "t" });
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

const make = (p, s) => p.evaluate(async (s) => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ category: "movement", keyless: true, captcha: true, tags: ["nuwn"],
    thumbnail: "https://tr.rbxcdn.com/" + s.title.replace(/\W/g, "") + "/768/432/Image/Png",
    code: 'local Players = game:GetService("Players")\nprint(Players.LocalPlayer)',
    desc: ("A movement script that lets you fly, noclip and run faster around the whole map. ").repeat(8), ...s }),
})).json(), s);

const a = await person(browser, AT, "Lucrit");
const plain = await make(a.page, { title: "Plain One", game: "Pet Simulator X" });
env.DB._raw.prepare("DELETE FROM ratelimits").run();
const ok = await make(a.page, { title: "Checked One", game: "Pet Simulator X" });
check("test scripts published", plain.ok && ok.ok, JSON.stringify([plain.error, ok.error]));
check("the server read both as Lua", plain.data.lua && ok.data.lua);
// What the admin panel's Verify button does (POST /api/admin/scripts/:id/verify).
env.DB._raw.prepare("UPDATE scripts SET verified = 1 WHERE id = ?").run(ok.data.id);
await a.ctx.close();

const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(e.message));
await page.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));

const open = async (s) => {
  await page.goto(`${AT}/creations/Lucrit/${s.data.slug}`);
  await page.locator("#script h2").waitFor();
  return page.locator("#script .sheet__head .chips");
};

console.log("Not verified");
let chips = await open(plain);
check("no Lua Detected on the script page", await chips.locator(".badge--lua").count() === 0);
check("…and not as text either", !/lua detected/i.test(await chips.textContent()));
check("still says Not reviewed", await chips.locator(".badge--unverified").count() === 1);
check("no Verified bubble", await chips.locator(".badge--verified").count() === 0);

console.log("\nVerified by an admin");
chips = await open(ok);
const v = chips.locator(".badge--verified");
check("a Verified bubble is shown", await v.count() === 1);
check("it says Verified", /Verified/.test(await v.textContent()), await v.textContent());
const look = await v.evaluate((el) => {
  const cs = getComputedStyle(el);
  const rgb = cs.backgroundColor.match(/\d+(\.\d+)?/g).map(Number);
  return { rgb, radius: parseFloat(cs.borderRadius), h: el.getBoundingClientRect().height };
});
const [r, g, b] = look.rgb;
check("its background is bright yellow", r > 230 && g > 200 && b < 120, look.rgb.join(","));
check("it's a bubble (fully rounded)", look.radius >= look.h / 2 - 1, JSON.stringify(look));
check("no Not reviewed beside it", await chips.locator(".badge--unverified").count() === 0);
check("no Lua Detected here either", await chips.locator(".badge--lua").count() === 0);

console.log("\nLibrary cards are unchanged");
await page.goto(AT);
for (let i = 0; i < 40 && !(await page.evaluate(() => (window.__lucrit?.library?.length || 0) >= 2)); i++)
  await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector("#search-mount")?.scrollIntoView());
await page.waitForTimeout(800);
check("cards still carry Lua Detected", await page.locator(".results__grid .card .badge--lua").count() === 2);
check("the verified card shows the yellow Verified bubble", await page.locator(".results__grid .card .badge--verified").count() === 1);

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
done();
