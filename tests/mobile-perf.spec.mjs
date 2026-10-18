// The background has to stay cheap on phones and on computers.
//
// History: the 3D WebGL world (depth of field, bloom, a 4-pass blur) put an
// emulated mid-range phone at ~4 fps and made computers lag. On 18 Oct 2026 it
// was replaced by a plain 2D canvas (engine/simplebg.js): a CSS glow painted
// once, plus a faint grid and a few dozen dots, drawn at 20 fps on computers
// and 15 on phones. Each part of that budget can be undone by an innocent edit,
// so each has its own check:
//   - no WebGL context is created by default (?world=3d still opts in);
//   - frame caps: <= ~20 fps desktop, <= ~15 fps phone, still animating;
//     while scrolling (the background follows the page) <= ~30 / ~24 fps;
//   - resolution: 1x CSS pixels on desktop, 0.75x on phones;
//   - nothing is drawn while a sheet covers the page or the window is blurred;
//   - no backdrop-filter anywhere (it re-blurs the page every frame);
//   - no full-screen grain overlay;
//   - the canvas is pinned to the large viewport (100lvh);
//   - a throttled phone still scrolls smoothly.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter } from "./harness.mjs";

const PORT = 8144;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const env = freshEnv(worker);
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });

const PHONE = {
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
};

// Counts background frames (each draw starts with one clearRect) and any
// WebGL context creation.
function instrument() {
  localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 }));
  window.__frames = 0;
  window.__webgl = 0;
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...a) {
    if (this.canvas && this.canvas.id === "scene") window.__frames++;
    return clear.apply(this, a);
  };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    if (/webgl/i.test(String(kind))) window.__webgl++;
    return getContext.call(this, kind, ...rest);
  };
}

async function open(opts, { throttle = 0, path = "/" } = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(instrument);
  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  await page.goto(AT + path, { waitUntil: "load" });
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}

const framesOver = (page, ms) => page.evaluate(async (ms) => {
  const a = window.__frames;
  await new Promise((r) => setTimeout(r, ms));
  return window.__frames - a;
}, ms);

const info = (page) => page.evaluate(() => {
  const c = document.getElementById("scene");
  const g = document.getElementById("grain");
  return {
    w: c.width, cw: c.clientWidth, hidden: c.hidden,
    simple: document.documentElement.classList.contains("simple-bg"),
    mobile: "mobile" in document.documentElement.dataset,
    webgl: window.__webgl,
    grain: g ? getComputedStyle(g).display : "none",
  };
});

const blurred = (page) => page.evaluate(() => {
  const hits = [];
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const v = cs.backdropFilter || cs.webkitBackdropFilter;
    if (v && v !== "none") hits.push(el.className || el.tagName);
  }
  return hits;
});

// Frames per second while the page is being scrolled (the background follows
// the scroll, so it is allowed a little more while it moves).
const scrollFps = (page) => page.evaluate(async () => {
  const a = window.__frames, t0 = performance.now();
  for (let i = 0; i < 40; i++) {
    window.scrollBy(0, 40);
    await new Promise((r) => setTimeout(r, 50));
  }
  const s = (performance.now() - t0) / 1000;
  return (window.__frames - a) / s;
});

async function pauses(page) {
  await page.evaluate(() => document.documentElement.classList.add("is-locked"));
  await page.waitForTimeout(150);
  const covered = await framesOver(page, 800);
  check("nothing is drawn while a sheet covers the page", covered === 0, String(covered));
  await page.evaluate(() => document.documentElement.classList.remove("is-locked"));
  check("drawing resumes when the sheet closes", (await framesOver(page, 800)) >= 1);

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await page.waitForTimeout(150);
  const away = await framesOver(page, 800);
  check("nothing is drawn while the window is in the background", away === 0, String(away));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  check("drawing resumes when the window is focused again", (await framesOver(page, 800)) >= 1);
}

/* ------------------------------------------------------------- phone */

console.log("Phone: simple background");
{
  const { ctx, page, errors } = await open(PHONE);
  const c = await info(page);
  check("phone is detected", c.mobile === true);
  check("simple background is on", c.simple && !c.hidden);
  check("no WebGL context is created", c.webgl === 0, String(c.webgl));
  check("no full-screen grain overlay", c.grain === "none", c.grain);
  check("canvas renders at 0.75x CSS pixels (not 3x)", c.w > 0 && c.w <= c.cw * 0.76, `${c.w}px for ${c.cw} css px`);

  const fps = (await framesOver(page, 2000)) / 2;
  check("capped at ~15 fps", fps <= 17, fps.toFixed(1));
  check("still animating", fps >= 3, fps.toFixed(1));
  const sf = await scrollFps(page);
  check("follows the scroll at no more than ~24 fps", sf <= 26 && sf >= 3, sf.toFixed(1));
  await page.evaluate(() => window.scrollTo(0, 0));

  console.log("\nPhone: no frosted glass");
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(300);
  const hits = await blurred(page);
  check("no element uses backdrop-filter", hits.length === 0, hits.slice(0, 5).join(", "));

  console.log("\nPhone: address bar sliding away");
  const pinned = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText && r.selectorText.includes("#scene")
            && document.getElementById("scene").matches(r.selectorText)
            && /lvh/.test(r.style.height)) return true;
      }
    }
    return false;
  });
  check("canvas height is pinned to the large viewport (100lvh)", pinned);

  console.log("\nPhone: pauses");
  await pauses(page);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

console.log("\nWeak phone (4x CPU throttle) still scrolls smoothly");
{
  const { ctx, page, errors } = await open(PHONE, { throttle: 4 });
  const fps = await page.evaluate(() => new Promise((res) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    let y = 0, n = 0; const t0 = performance.now();
    function s(t) {
      n++; y += max / 120; window.scrollTo(0, Math.min(y, max * 0.6));
      if (t - t0 < 2000) requestAnimationFrame(s); else res(n * 1000 / (t - t0));
    }
    requestAnimationFrame(s);
  }));
  // Was ~4 fps on this setup with the 3D world.
  check("scrolling runs at a usable frame rate", fps >= 30, fps.toFixed(1));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ----------------------------------------------------------- desktop */

console.log("\nDesktop: simple background");
{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  const c = await info(page);
  check("desktop is not treated as a phone", c.mobile === false);
  check("simple background is on", c.simple && !c.hidden);
  check("no WebGL context is created", c.webgl === 0, String(c.webgl));
  check("no full-screen grain overlay", c.grain === "none", c.grain);
  check("canvas renders at 1x CSS pixels", c.w > 0 && c.w <= c.cw, `${c.w}/${c.cw}`);
  const hits = await blurred(page);
  check("no element uses backdrop-filter", hits.length === 0, hits.slice(0, 5).join(", "));

  const fps = (await framesOver(page, 2000)) / 2;
  check("capped at ~20 fps (was 30, and full refresh before that)", fps <= 22, fps.toFixed(1));
  check("still animating", fps >= 5, fps.toFixed(1));
  const sf = await scrollFps(page);
  check("follows the scroll at no more than ~30 fps", sf <= 32 && sf >= 5, sf.toFixed(1));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1200);
  const settled = (await framesOver(page, 2000)) / 2;
  check("drops back to ~20 fps once scrolling stops", settled <= 22, settled.toFixed(1));

  console.log("\nDesktop: pauses");
  await pauses(page);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

console.log("\nReduced motion: one still frame");
{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  check("no frames after the first", (await framesOver(page, 1200)) === 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

console.log("\nThe old 3D world is still there behind ?world=3d");
{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } }, { path: "/?world=3d" });
  const c = await info(page);
  check("opting in creates the WebGL world", c.webgl >= 1 && !c.simple, JSON.stringify(c));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
server.close();
process.exit(done() ? 1 : 0);
