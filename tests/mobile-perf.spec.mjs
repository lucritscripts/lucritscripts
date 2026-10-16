// Phones: the site has to scroll smoothly on a mid-range phone.
//
// It didn't. Profiling an emulated phone (390x844 @3x, 4x CPU throttle) put
// the page at ~4 fps idle and while scrolling. Hiding the 3D canvas alone took
// it to 60 fps idle — the WebGL backdrop was ~95% of the cost, rendered at
// 1.35x CSS pixels with a 4-pass blur every frame. Second was backdrop-filter:
// fourteen frosted-glass rules re-blurring a canvas that repaints every frame.
//
// The fix has several parts and each one can be undone by an innocent edit, so
// each has its own check:
//   - phones render the world well below CSS resolution, capped at 30 fps;
//   - a watchdog steps a phone down (lower res, then a frozen frame) when it
//     still can't keep up — this sandbox renders WebGL in software, so it is
//     exactly that weak phone, and must end up scrolling smoothly;
//   - no backdrop-filter anywhere on phones;
//   - the canvas doesn't resize (and reallocate its render targets) when the
//     address bar slides away;
//   - nothing is drawn while a full-screen sheet covers the canvas;
//   - desktop is capped at 30 fps / 1x, trickles when unfocused, never freezes.
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

// Counts instanced draws (two per rendered frame: boxes + shards).
function instrument() {
  localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 }));
  window.__draws = 0;
  const orig = WebGL2RenderingContext.prototype.drawArraysInstanced;
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...a) {
    window.__draws++;
    return orig.apply(this, a);
  };
}

async function open(opts, { throttle = 0 } = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(instrument);
  if (throttle) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  await page.goto(AT + "/", { waitUntil: "load" });
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}

const framesOver = (page, ms) => page.evaluate(async (ms) => {
  const a = window.__draws;
  await new Promise((r) => setTimeout(r, ms));
  return (window.__draws - a) / 2;
}, ms);

const canvasInfo = (page) => page.evaluate(() => {
  const c = document.getElementById("scene");
  return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight,
           fx: document.documentElement.dataset.fx,
           mobile: "mobile" in document.documentElement.dataset };
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

/* ------------------------------------------------------------- phone */

console.log("Phone: lightweight backdrop");
{
  const { ctx, page, errors } = await open(PHONE);
  const c = await canvasInfo(page);
  check("phone is detected", c.mobile === true);
  check("starts on the top rung", c.fx === "0", c.fx);
  check("world renders below CSS resolution (was 1.35x)", c.w <= c.cw * 0.75 && c.w > 0,
    `${c.w}px for ${c.cw} css px`);

  const fps = (await framesOver(page, 2000)) / 2;
  check("world is capped at ~30 fps", fps <= 32, fps.toFixed(1));
  check("world is still animating", fps >= 1, fps.toFixed(1));

  console.log("\nPhone: no frosted glass");
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(300);
  const hits = await blurred(page);
  check("no element uses backdrop-filter", hits.length === 0, hits.slice(0, 5).join(", "));

  console.log("\nPhone: address bar sliding away");
  // Emulation has no real address bar (resizing the viewport resizes lvh too),
  // so this checks the rule that pins the canvas to the large viewport is live.
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

  console.log("\nCovered by a sheet");
  await page.evaluate(() => document.documentElement.classList.add("is-locked"));
  await page.waitForTimeout(150);
  const covered = await framesOver(page, 800);
  check("nothing is drawn while a sheet covers the canvas", covered === 0, String(covered));
  await page.evaluate(() => document.documentElement.classList.remove("is-locked"));
  const back = await framesOver(page, 800);
  check("drawing resumes when the sheet closes", back >= 1, String(back));

  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

console.log("\nWeak phone: watchdog steps down until scrolling is smooth");
{
  // Software WebGL + 4x CPU throttle: the weakest phone we can make.
  const { ctx, page, errors } = await open(PHONE, { throttle: 4 });
  let fx = "0";
  for (let i = 0; i < 40 && fx !== "2"; i++) {
    await page.waitForTimeout(500);
    fx = (await canvasInfo(page)).fx;
  }
  check("reaches the frozen rung", fx === "2", fx);
  const c = await canvasInfo(page);
  check("dropped resolution on the way down", c.w <= c.cw * 0.55, `${c.w}/${c.cw}`);
  const frozen = await framesOver(page, 1000);
  check("frozen means no more drawing", frozen === 0, String(frozen));

  const fps = await page.evaluate(() => new Promise((res) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    let y = 0, n = 0; const t0 = performance.now();
    function s(t) {
      n++; y += max / 120; window.scrollTo(0, Math.min(y, max * 0.6));
      if (t - t0 < 2000) requestAnimationFrame(s); else res(n * 1000 / (t - t0));
    }
    requestAnimationFrame(s);
  }));
  // Was ~4 fps on this setup before the fix.
  check("scrolling runs at a usable frame rate", fps >= 30, fps.toFixed(1));
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

/* ----------------------------------------------------------- desktop */

console.log("\nDesktop: on a budget too (it used to draw at full refresh, up to 2x res)");
{
  const { ctx, page, errors } = await open({ viewport: { width: 1280, height: 800 } });
  const c = await canvasInfo(page);
  check("desktop is not treated as a phone", c.mobile === false);
  check("desktop renders at no more than 1x CSS pixels", c.w > 0 && c.w <= c.cw, `${c.w}/${c.cw}`);
  const lite = () => page.evaluate(() => "lite" in document.documentElement.dataset);
  const hits = await blurred(page);
  check("frosted glass is on unless the watchdog stepped down",
    (await lite()) ? hits.length === 0 : hits.length > 0, `${hits.length} / lite=${await lite()}`);

  const fps = (await framesOver(page, 2000)) / 2;
  check("desktop world is capped at ~30 fps", fps <= 32, fps.toFixed(1));
  check("desktop world is still animating", fps >= 1, fps.toFixed(1));

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const bg = (await framesOver(page, 2500)) / 2.5;
  check("unfocused window drops to a trickle (~8 fps)", bg <= 10 && bg >= 1, bg.toFixed(1));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));

  await page.waitForTimeout(3500);
  const after = await canvasInfo(page);
  check("desktop never freezes (no rung past 2)", Number(after.fx) <= 2, after.fx);
  check("…and keeps animating", (await framesOver(page, 1500)) >= 1);
  if (Number(after.fx) >= 1) check("a stepped-down desktop drops the frosted glass", (await blurred(page)).length === 0);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
server.close();
process.exit(done() ? 1 : 0);
