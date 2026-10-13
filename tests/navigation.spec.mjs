// Getting around the home page.
//
// Reported: "people didn't know they could scroll", "the scrolling animations
// are so tough", and on phones "the scroll only worked when you used the outer
// parts of the screen". The last one was literal: every section was a pinned
// 100vh box that scrolled on its own, so a swipe that started on the content
// scrolled that box instead of the page — only the empty margins moved the page.
//
// What these checks hold the page to:
//   - one scroll: no section (or results list) is its own vertical scroller;
//   - a swipe in the MIDDLE of a phone screen moves the page;
//   - the page is a sane length (it was ~20 screens for nine sections);
//   - the wheel stops where you stop — no glide to somewhere else afterwards;
//   - a visible cue says there's more, and dots/menu jump anywhere;
//   - the animations are still there: sections glide in as they arrive.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8148;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const env = freshEnv(worker);
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const errors = [];

async function open(opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));
  await page.goto(AT + "/");
  await page.waitForTimeout(1400);
  return { ctx, page };
}

const innerScrollers = (page) => page.evaluate(() =>
  [...document.querySelectorAll("#content *")].filter((e) => {
    const cs = getComputedStyle(e);
    return /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 4;
  }).map((e) => e.className || e.tagName));

/* ------------------------------------------------------------------ phone */

console.log("Phone");
{
  const { ctx, page } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const cdp = await ctx.newCDPSession(page);
  // A real finger: touch down, drag in steps, lift. (This reproduces the bug:
  // on the old layout a drag from the middle moved the page 0px, from the
  // edge ~400px.)
  const swipe = async (x, y, dy) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 12; i++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + (dy * i) / 12 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(450);
  };

  check("the cue says 'swipe up' and is on screen at load", await page.evaluate(() => {
    const c = document.querySelector(".scrollcue");
    const r = c.getBoundingClientRect();
    const label = [...c.querySelectorAll("span")].find((s) => getComputedStyle(s).display !== "none" && /Swipe/.test(s.textContent));
    return Boolean(label) && r.bottom <= innerHeight && r.top >= 0 && getComputedStyle(c).opacity > 0.5;
  }));

  // Swipe up in the centre of the screen, over content, several times.
  const y0 = await page.evaluate(() => scrollY);
  await swipe(195, 650, -420);
  const y1 = await page.evaluate(() => scrollY);
  check("a swipe in the MIDDLE of the screen scrolls the page", y1 - y0 > 300, `${y0} → ${y1}`);
  check("…and the cue gets out of the way", await page.evaluate(() => Number(getComputedStyle(document.querySelector(".scrollcue")).opacity) < 0.3));

  // Keep going through the search panel, the vault and the forms.
  let last = y1, stuck = 0;
  for (let i = 0; i < 16; i++) {
    await swipe(195, 650, -420);
    const y = await page.evaluate(() => scrollY);
    if (y - last < 60 && y < (await page.evaluate(() => document.documentElement.scrollHeight - innerHeight)) - 2) stuck++;
    last = y;
  }
  const end = await page.evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
  check("swiping over the content goes all the way down without getting stuck", stuck <= 1 && end.y > end.max * 0.75, JSON.stringify({ stuck, ...end }));
  check("no section is its own scroll box", (await innerScrollers(page)).length === 0, (await innerScrollers(page)).join(", "));
  await ctx.close();
}

/* ---------------------------------------------------------------- desktop */

console.log("\nDesktop");
{
  const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } });
  const screens = await page.evaluate(() => document.documentElement.scrollHeight / innerHeight);
  check("the page is about one screen per section (was ~20 screens)", screens <= 11, screens.toFixed(1));
  check("no section is its own scroll box", (await innerScrollers(page)).length === 0, (await innerScrollers(page)).join(", "));

  check("the cue says 'scroll' at load", await page.evaluate(() =>
    [...document.querySelectorAll(".scrollcue span")].some((s) => getComputedStyle(s).display !== "none" && /Scroll to explore/.test(s.textContent))));
  await page.locator(".scrollcue").click();
  await page.waitForTimeout(1300);
  const afterCue = await page.evaluate(() => Math.round(document.getElementById("ch-universe").getBoundingClientRect().top));
  check("clicking the cue brings up the next section", Math.abs(afterCue) < 40, String(afterCue));

  // Wheel, then stop: the page should stay where the reader stopped it.
  await page.mouse.move(720, 450);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 140); await page.waitForTimeout(30); }
  await page.waitForTimeout(1600);
  const a = await page.evaluate(() => scrollY);
  await page.waitForTimeout(2000);
  const b = await page.evaluate(() => scrollY);
  check("after the wheel stops, the page doesn't glide off somewhere else", Math.abs(b - a) < 3, `${a} → ${b}`);
  check("the wheel moves the page", a > 0, String(a));

  // Section dots.
  check("section dots for all nine sections", await page.locator(".sectiondots button").count() === 9);
  await page.locator('.sectiondots [data-jump="submit"]').click();
  await page.waitForTimeout(2800);
  const pub = await page.evaluate(() => ({
    top: Math.round(document.getElementById("ch-submit").getBoundingClientRect().top),
    on: document.querySelector(".sectiondots .is-on")?.dataset.jump,
  }));
  check("a dot jumps straight to its section", Math.abs(pub.top) < 40, JSON.stringify(pub));
  check("…and lights up as the current one", pub.on === "submit", JSON.stringify(pub));

  // The front page has its own way to the publish form.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  check("the front page has a 'Publish a Script' button", await page.locator('.hero__cta [data-jump="submit"]').isVisible());
  await page.locator('.hero__cta [data-jump="submit"]').click();
  await page.waitForTimeout(2800);
  const viaHero = await page.evaluate(() => Math.round(document.getElementById("ch-submit").getBoundingClientRect().top));
  check("…which takes you straight to the publish form", Math.abs(viaHero) < 40, String(viaHero));

  // The animation is kept: a section further down starts hidden and glides in.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => getComputedStyle(document.querySelector("#ch-finale .chapter__stage")).opacity);
  await page.evaluate(() => document.getElementById("ch-finale").scrollIntoView());
  await page.waitForTimeout(2600);
  const after = await page.evaluate(() => getComputedStyle(document.querySelector("#ch-finale .chapter__stage")).opacity);
  check("sections still glide in as they arrive (hidden before, shown after)", Number(before) < 0.2 && Number(after) > 0.95, `${before} → ${after}`);

  // Category tabs (they used to change only with scroll position).
  await page.evaluate(() => document.getElementById("ch-categories").scrollIntoView());
  await page.waitForTimeout(900);
  await page.locator('.worlds__rail [data-world-tab="3"]').click();
  await page.waitForTimeout(500);
  check("category tabs are clickable", await page.evaluate(() => document.querySelector('.world[data-i="3"]').classList.contains("is-on")));
  await page.waitForTimeout(4800);
  check("…and stay on the one you picked", await page.evaluate(() => document.querySelector('.world[data-i="3"]').classList.contains("is-on")));
  await ctx.close();
}

/* ----------------------------------------------------- results, paged */

console.log("\nSearch results page with a button, not an inner scroll box");
{
  // Publishing is capped at 10 an hour per account, so two accounts.
  for (const [who, n] of [["PagerA", 8], ["PagerB", 8]]) {
  const me = await person(browser, AT, who);
  for (let i = 0; i < n; i++) {
    await me.page.evaluate(async (i) => fetch("/api/scripts", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Script " + i, game: "Blox Fruits", category: "combat", keyless: true, tags: ["T"],
        captcha: true, thumbnail: "https://tr.rbxcdn.com/x" + i,
        desc: "Auto farms levels and bosses for you with a simple menu. ".repeat(12),
        code: 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()' }),
    }), i);
  }
  await me.ctx.close();
  }
  const { ctx, page } = await open({ viewport: { width: 1280, height: 860 } });
  await page.evaluate(() => document.getElementById("ch-search").scrollIntoView());
  await page.waitForTimeout(1500);
  const n1 = await page.locator("#search-mount .results__grid .card").count();
  check("first page shows 12", n1 === 12, String(n1));
  check("with a 'Show more' button", /Show 4 more/.test(await page.locator("[data-more-results]").textContent()));
  await page.locator("[data-more-results]").click();
  await page.waitForTimeout(300);
  check("which shows the rest", await page.locator("#search-mount .results__grid .card").count() === 16);
  check("and goes away when there's nothing left", await page.locator("[data-more-results]").count() === 0);
  await ctx.close();
}

check("no page errors", errors.length === 0, errors.join(" | "));

await browser.close();
server.close();
process.exit(done() ? 1 : 0);
