// Phone layout: the things that made the site feel broken on a phone.
import fs from "node:fs";
import { chromium } from "playwright";
import worker from "../_worker.js";
import { ROOT, CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8149;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();
const env = freshEnv(worker, { LOOTLABS_TOKEN: "t" });
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

const maker = await person(browser, AT, "Maker");
const PNG = "data:image/png;base64," + fs.readFileSync(ROOT + "/assets/img/mark.png").toString("base64");
const pub = await maker.page.evaluate(async (t) => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "Blox Fruits Auto Farm", game: "Blox Fruits", category: "combat", keyless: true,
    tags: ["AutoFarm"], captcha: true, thumbnail: t,
    desc: "Auto farms levels and bosses for you with a simple menu that works on phones. ".repeat(14),
    code: 'local p = game:GetService("Players")\nprint(p.LocalPlayer)' }),
})).json(), PNG);
await maker.ctx.close();

for (const [w, h] of [[360, 740], [390, 844]]) {
  console.log(`\n${w}×${h}`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
  await page.goto(AT + "/");
  await page.waitForTimeout(1600);

  const hero = await page.evaluate(() => {
    const btns = [...document.querySelectorAll(".hero__cta .btn")].filter((b) => b.getBoundingClientRect().height > 0);
    const cue = document.querySelector(".scrollcue").getBoundingClientRect();
    const lowest = Math.max(...btns.map((b) => b.getBoundingClientRect().bottom));
    return { lowest, cueTop: cue.top, vh: innerHeight, n: btns.length };
  });
  check("all hero buttons are on the first screen, above the swipe cue", hero.lowest < hero.cueTop && hero.n >= 4, JSON.stringify(hero));
  check("'Publish a Script' is one of them", await page.locator('.hero__cta [data-jump="submit"]').isVisible());
  check("no sideways scrolling", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  // Floating buttons step aside while scrolling down, and come back.
  const cdp = await ctx.newCDPSession(page);
  const swipe = async (dy) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: w / 2, y: h * 0.7 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: w / 2, y: h * 0.7 + (dy * i) / 10 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(-360);
  await page.waitForTimeout(450);
  const hidden = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".dashbtn")).opacity));
  check("the floating buttons get out of the way while scrolling down", hidden < 0.3, String(hidden));
  await swipe(200);
  await page.waitForTimeout(600);
  const back = await page.evaluate(() => Number(getComputedStyle(document.querySelector(".dashbtn")).opacity));
  check("…and come back on scroll up", back > 0.9, String(back));

  // Script page: a bottom sheet, edge to edge, close button always reachable.
  await page.goto(`${AT}/creations/Maker/${pub.data.slug}`);
  await page.waitForTimeout(1500);
  const sheet = await page.evaluate(() => {
    const p = document.querySelector("#script .sheet__panel").getBoundingClientRect();
    return { left: p.left, right: p.right, bottom: p.bottom, vw: innerWidth, vh: innerHeight };
  });
  check("the script page is an edge-to-edge sheet from the bottom", sheet.left <= 0.5 && sheet.right >= sheet.vw - 0.5 && Math.abs(sheet.bottom - sheet.vh) < 1.5, JSON.stringify(sheet));
  await page.evaluate(() => document.querySelector("#script .sheet__panel").scrollBy(0, 1500));
  await page.waitForTimeout(300);
  const close = await page.evaluate(() => {
    const r = document.querySelector("#script .sheet__close").getBoundingClientRect();
    return { top: r.top, h: r.height, w: r.width };
  });
  check("the close button is still on screen after scrolling the sheet", close.top >= 0 && close.top < 120, JSON.stringify(close));
  check("…and big enough to tap", close.h >= 36 && close.w >= 36, JSON.stringify(close));
  check("the unlock buttons are there", await page.locator("#script .gate .btn").count() >= 1);
  await ctx.close();
}

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
process.exit(done() ? 1 : 0);
