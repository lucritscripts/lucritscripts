// The AI offer that arrives when you stop typing.
//
// "Enhance with AI" was a button under the description box, and a button
// nobody looks at is a feature nobody uses — publishers typed a few rushed
// words and submitted. The offer now comes to them.
//
// Which makes the interesting assertions the ones about RESTRAINT, not about
// the card appearing. A popup that nags is worse than a button nobody clicks,
// so most of what follows checks that it stays away: while they are still
// typing, before there is anything to work with, and after they have said no.
import { chromium } from "playwright";
import worker from "../_worker.js";
import { ROOT, CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8131;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const env = freshEnv(worker);
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });

const alice = await person(browser, AT, "Alice");
const { page } = alice;

const prompt = () => page.evaluate(() => {
  const box = document.querySelector("[data-aiprompt]");
  return {
    shown: Boolean(box) && box.hidden === false,
    text: (box?.innerText || "").replace(/\s+/g, " ").trim(),
    hasEnhance: Boolean(box?.querySelector('[data-act="enhance"]')),
    hasDismiss: Boolean(box?.querySelector('[data-act="nothanks"]')),
  };
});

/** Type into the description the way a person does, without blurring. */
async function typeDesc(text) {
  await page.evaluate((t) => {
    const el = document.querySelector('.pubform [name="desc"]');
    el.focus();
    el.value = t;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, text);
}

const SHORT = "sprint toggle";
const ENOUGH = "A sprint toggle for Blox Fruits that turns running on and off from a small menu";
const LONGER = ENOUGH + ". It has a keybind, a draggable window, and remembers the last state you left it in, which is the part people ask about most.";

console.log("\nIt stays away until there is something to work with");
{
  await typeDesc(SHORT);
  await page.waitForTimeout(2200);
  const s = await prompt();
  check("nothing appears for a couple of words", s.shown === false, s.text);
}

console.log("\nIt waits for a pause rather than interrupting");
{
  await typeDesc(ENOUGH);
  await page.waitForTimeout(400);           // still mid-flow
  const mid = await prompt();
  check("silent while they are still typing", mid.shown === false, mid.text);

  await page.waitForTimeout(1800);          // now they have stopped
  const after = await prompt();
  check("appears once they stop", after.shown === true, after.text);
  check("offering to enhance", after.hasEnhance === true, after.text);
  check("and to decline", after.hasDismiss === true, after.text);
  check("without claiming it will add anything",
    /only what you|without changing what you said/i.test(after.text), after.text);
}

console.log("\nTyping again takes it away");
{
  await typeDesc(ENOUGH + " and");
  await page.waitForTimeout(300);
  const s = await prompt();
  check("the card goes as soon as they resume", s.shown === false, s.text);

  await page.waitForTimeout(1800);
  check("and comes back on the next pause", (await prompt()).shown === true);
}

console.log("\nIt never steals the cursor");
{
  const where = await page.evaluate(() => document.activeElement?.name || document.activeElement?.tagName);
  check("focus stays in the description", where === "desc", String(where));
}

console.log("\n'No thanks' means no");
{
  await page.evaluate(() => document.querySelector('[data-act="nothanks"]').click());
  await page.waitForTimeout(300);
  check("the card goes", (await prompt()).shown === false);

  // A small edit must not bring it straight back — that is the nagware
  // failure mode this guard exists to prevent.
  await typeDesc(ENOUGH + " now");
  await page.waitForTimeout(2200);
  const small = await prompt();
  check("a small edit does not reopen it", small.shown === false, small.text);

  // A substantial rewrite is a different description, so it may ask again.
  await typeDesc(LONGER);
  await page.waitForTimeout(2200);
  const big = await prompt();
  check("but a real rewrite earns another ask", big.shown === true, big.text);
}

console.log("\nLeaving the field offers immediately");
{
  await page.evaluate(() => document.querySelector('[data-act="nothanks"]').click());
  await page.waitForTimeout(200);
  await typeDesc(LONGER + " It also has a configuration panel with several toggles for the different farming modes, which is new.");
  await page.evaluate(() => document.querySelector('.pubform [name="title"]').focus());
  await page.waitForTimeout(600);           // well under the idle timer
  const s = await prompt();
  check("blurring the field asks right away", s.shown === true, s.text);
  const where = await page.evaluate(() => document.activeElement?.name);
  check("and focus stays where they moved it", where === "title", String(where));
}

console.log("\nEnhancing closes the card and leaves their words alone");
{
  const before = await page.evaluate(() => document.querySelector('.pubform [name="desc"]').value);
  await page.evaluate(() => document.querySelector('[data-act="enhance"]').click());
  await page.waitForTimeout(1500);

  check("the card closes", (await prompt()).shown === false);
  const after = await page.evaluate(() => document.querySelector('.pubform [name="desc"]').value);
  // The AI stub answers null here, so there is nothing to apply — and the
  // point stands either way: nothing is replaced without being accepted.
  check("the description is untouched", after === before, JSON.stringify({ before, after }));
}

await alice.ctx.close();
await browser.close();
server.close();
process.exit(done() ? 1 : 0);
