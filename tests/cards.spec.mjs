// Script cards: size, and the button that matters.
//
// The size assertions are loose on purpose — "smaller than it was", not exact
// pixels — because pinning a layout to the pixel makes every harmless tweak a
// failing test, and people learn to delete those.
//
// The button assertion is NOT loose. Cards with a thumbnail used to clip the
// Get Script button clean off: `.card__body` was `height: 100%` of the card,
// a thumbnail above it pushed the body taller than the space left, and
// `overflow: hidden` cut off the bottom row. The live library had no
// thumbnails so nobody saw it — and then thumbnails became REQUIRED, which
// would have shipped every new card without a way to get the script. A card
// you cannot act on is the worst failure this page has, so it is checked by
// geometry, not by "is the element in the DOM" (it always was).
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8134;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const env = freshEnv(worker);
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const me = await person(browser, AT, "Kiwi");
const LONG = Array.from({ length: 110 }, (_, i) => "word" + i).join(" ");

const rows = [
  ["With Thumb A", "Blox Fruits", "combat", "https://tr.rbxcdn.com/a"],
  ["With Thumb B", "Grow a Garden", "movement", "https://tr.rbxcdn.com/b"],
  ["With Thumb C", "Da Hood", "utilities", "https://tr.rbxcdn.com/c"],
];
for (const [t, g, c, thumb] of rows) {
  await me.page.evaluate(async ({ t, g, c, thumb, desc }) => {
    await fetch("/api/scripts", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t, game: g, category: c, desc, thumbnail: thumb,
        code: 'local Players = game:GetService("Players")\nprint(Players.LocalPlayer)',
        link: "https://pastebin.com/raw/x", tags: ["demo"] }),
    });
  }, { t, g, c, thumb, desc: LONG });
  env.DB._raw.prepare("DELETE FROM ratelimits").run();
}

await me.page.setViewportSize({ width: 1280, height: 900 });
await me.page.reload({ waitUntil: "domcontentloaded" });
for (let i = 0; i < 40 && !(await me.page.evaluate(() => (window.__lucrit?.library?.length || 0) >= 3)); i++)
  await me.page.waitForTimeout(500);
await me.page.evaluate(() => document.querySelector("#search-mount")?.scrollIntoView());
await me.page.waitForTimeout(1200);

const cards = await me.page.evaluate(() =>
  [...document.querySelectorAll(".results__grid .card")].map((card) => {
    const c = card.getBoundingClientRect();
    const btn = card.querySelector('[data-act="get"]');
    const b = btn?.getBoundingClientRect();
    const desc = card.querySelector(".card__desc");
    const lh = parseFloat(getComputedStyle(desc).lineHeight);
    return {
      title: card.querySelector(".card__title")?.textContent,
      hasThumb: Boolean(card.querySelector(".card__thumb")),
      w: c.width, h: c.height,
      btnTop: b ? b.top - c.top : null,
      btnBottom: b ? b.bottom - c.top : null,
      descLines: Math.round(desc.getBoundingClientRect().height / lh),
    };
  }));

console.log("\nEvery card can still be acted on");
check("three cards rendered", cards.length === 3, String(cards.length));
for (const c of cards) {
  check(`${c.title} has a thumbnail`, c.hasThumb === true);
  // Geometry, not presence. The button was always in the DOM — it was just
  // below the bottom edge of a card with overflow: hidden.
  check(`${c.title}: Get Script sits fully inside the card`,
    c.btnBottom !== null && c.btnTop >= 0 && c.btnBottom <= c.h + 0.5,
    JSON.stringify({ btnTop: c.btnTop, btnBottom: c.btnBottom, cardH: c.h }));
}

console.log("\nCards are compact");
const perRow = await me.page.evaluate(() =>
  getComputedStyle(document.querySelector(".results__grid")).gridTemplateColumns.split(" ").length);
check("at least four per row on a 1280px screen", perRow >= 4, String(perRow));
check("narrower than the old 258px minimum", cards.every((c) => c.w < 258),
  JSON.stringify(cards.map((c) => Math.round(c.w))));
check("descriptions clamp to two lines", cards.every((c) => c.descLines <= 2),
  JSON.stringify(cards.map((c) => c.descLines)));

// 16 Oct 2026: "for the mobile version make the scripts cards smaller, they're
// too big" — one full-width card per screen became two compact ones per row.
console.log("\nPhones get two compact cards per row");
await me.page.setViewportSize({ width: 390, height: 844 });
await me.page.waitForTimeout(600);
const phone = await me.page.evaluate(() =>
  getComputedStyle(document.querySelector(".results__grid")).gridTemplateColumns.split(" ").length);
check("two columns at phone width", phone === 2, String(phone));
const small = await me.page.evaluate(() =>
  [...document.querySelectorAll(".results__grid .card")].map((card) => {
    const c = card.getBoundingClientRect();
    const b = card.querySelector('[data-act="get"]').getBoundingClientRect();
    return { w: c.width, h: c.height, top: b.top - c.top, bottom: b.bottom - c.top, bw: b.width,
      desc: getComputedStyle(card.querySelector(".card__desc")).display };
  }));
check("cards are short (under 245px tall)", small.every((c) => c.h < 245), JSON.stringify(small.map((c) => Math.round(c.h))));
check("no card is wider than half the screen", small.every((c) => c.w < 195), JSON.stringify(small.map((c) => Math.round(c.w))));
check("Get Script still sits fully inside every card", small.every((c) => c.top >= 0 && c.bottom <= c.h + 0.5));
check("…and spans the card so it's easy to tap", small.every((c) => c.bw > c.w * 0.75));
check("description hidden on phones (it's on the script page)", small.every((c) => c.desc === "none"));

await me.ctx.close();
await browser.close();
server.close();
process.exit(done() ? 1 : 0);
