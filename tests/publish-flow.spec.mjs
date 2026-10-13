// Publishing and viewing a script: the October fixes.
//
// Each block guards one thing that was reported broken:
//   - the Lua checker (form and server disagreed; the most common one-line
//     loadstring script was called "not Lua" by the page),
//   - Lua code required, script link optional,
//   - thumbnails (anything over ~300 KB was refused with a misleading error;
//     listings carried every image as base64),
//   - the AI description helper (always answered "already reads well"),
//   - the unlock step looking "removed" to the author,
//   - pages that didn't resize with the window.
import fs from "node:fs";
import { chromium } from "playwright";
import worker from "../_worker.js";
import { checkLua } from "../assets/js/luacheck.js";
import { ROOT, CHROME, freshEnv, serve, counter, person } from "./harness.mjs";

const PORT = 8146;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

/* ------------------------------------------------------------ Lua checker */

console.log("Lua checker: one implementation, shared");
{
  const mod = fs.readFileSync(ROOT + "/assets/js/luacheck.js", "utf8");
  const wk = fs.readFileSync(ROOT + "/_worker.js", "utf8");
  const grab = (s) => s.slice(s.indexOf("/* LUACHECK:BEGIN */"), s.indexOf("/* LUACHECK:END */"));
  check("the worker's copy is identical to assets/js/luacheck.js", grab(mod) === grab(wk) && grab(mod).length > 1000);
}

console.log("\nLua checker: real scripts pass");
const GOOD = {
  "loadstring one-liner": 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()',
  "services + print": 'local Players = game:GetService("Players")\nprint(Players.LocalPlayer.Name)',
  "functions, if/elseif, for": 'local function f(n)\n  if n > 1 then\n    print(n)\n  elseif n == 0 then\n    warn("0")\n  else\n    for i = 1, 3 do print(i) end\n  end\nend\nf(2)',
  "Luau if-expression and +=": 'local x = if game.PlaceId == 1 then "a" else "b"\nlocal t: number = 5\nt += 1\nprint(x, t)',
  "repeat/until": 'local n = 0\nrepeat\n  n += 1\n  task.wait()\nuntil n >= 10\nprint(n)',
  "keywords inside strings/comments": 'local s = "end end function"\nlocal l = [[\nfunction\n]]\n--[[ if then ]]\nprint(s, l)',
  "event connection": 'game:GetService("RunService").Heartbeat:Connect(function(dt)\n  local hrp = game.Players.LocalPlayer.Character.HumanoidRootPart\nend)',
  "obfuscated style": 'return(function(...) local a={...} local b=a[1] if b then return b end end)(...)',
};
for (const [name, src] of Object.entries(GOOD)) {
  const r = checkLua(src);
  check(`passes: ${name}`, r.ok, r.why);
}

console.log("\nLua checker: real problems are named, with a line");
const BAD = {
  "missing end": ['local function f()\n  if true then\n    print("x")\n  end\n', /never closed with `end`/],
  "stray end": ['local Players = game:GetService("Players")\nprint(Players)\nend', /no block/],
  "unclosed string": ['local s = "abc\nprint(s)\nlocal function f() end', /never closed/],
  "mismatched bracket": ['local t = {1, 2, 3)\nprint(t)\nlocal function f() end', /doesn't match/],
  "JavaScript": ['const x = 5;\nfunction foo() {\n  console.log(x);\n}', /JavaScript/],
  "Python": ['import os\ndef main():\n    print("hi")\nmain()', /Python/],
  "plain text": ['This script auto farms everything in pet simulator and it is very good', /plain text/],
  "empty": ['   ', /Paste the script/],
};
for (const [name, [src, re]] of Object.entries(BAD)) {
  const r = checkLua(src);
  check(`refuses: ${name}`, !r.ok && re.test(r.why), r.why);
}
check("errors carry line numbers", checkLua(BAD["missing end"][0]).errors[0]?.line === 1);

/* ------------------------------------------------------------ server */

let aiReply = null;           // what the stubbed Workers AI answers with
const env = freshEnv(worker, {
  LOOTLABS_TOKEN: "t", LINKVERTISE_TOKEN: "t", LINKVERTISE_USER_ID: "1",
  AI: { run: async (model, input) => {
    if (aiReply instanceof Error) throw aiReply;
    return typeof aiReply === "function" ? aiReply(input) : aiReply;
  } },
});
const server = await serve(worker, env, PORT);
const browser = await chromium.launch({ executablePath: CHROME });
const author = await person(browser, AT, "Writer");
const pageErrors = [];
author.page.on("pageerror", (e) => pageErrors.push(e.message));

const DESC = ("Auto farms coins and hatches eggs for you. Toggle each feature from the menu. "
  + "Works on mobile and PC executors, tested on the latest update. ").repeat(5);
const PNG = "data:image/png;base64," + fs.readFileSync(ROOT + "/assets/img/mark.png").toString("base64");
const publish = (over) => author.page.evaluate(async (body) => (await fetch("/api/scripts", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})).json(), {
  title: "Farm", game: "Pet Simulator 99", category: "farming", keyless: true, desc: DESC,
  tags: ["AutoFarm"], thumbnail: PNG, captcha: true,
  code: 'loadstring(game:HttpGet("https://raw.githubusercontent.com/a/b/main/c.lua"))()',
  ...over,
});

console.log("\nServer: Lua code required, link optional");
let r = await publish({ code: "" });
check("no code → refused", !r.ok && /Lua code/.test(r.error), r.error);
r = await publish({ code: BAD.JavaScript[0] });
check("JavaScript → refused", !r.ok && /JavaScript/.test(r.error), r.error);
r = await publish({ code: BAD["missing end"][0] });
check("unclosed block → refused with the line", !r.ok && /Line 1/.test(r.error), r.error);
r = await publish({ link: "https://bit.ly/abc" });
check("a link on a host we don't allow → refused", !r.ok && /host/.test(r.error), r.error);
r = await publish({ link: "" });
check("no link → publishes", r.ok, r.error);
const s1 = r.data;
check("Lua badge set", s1?.lua === true);
r = await publish({ title: "With link", link: "https://pastebin.com/raw/abc123" });
check("with a pastebin link → publishes", r.ok, r.error);

console.log("\nServer: thumbnails");
const list = await author.page.evaluate(async () => (await fetch("/api/scripts")).text());
check("the listing no longer carries base64 images", !/data:image/.test(list), String(list.length));
const thumbUrl = JSON.parse(list).data[0].thumbnail;
check("the listing points at /api/thumbs/…?v=…", /^\/api\/thumbs\/s_[a-f0-9]+\?v=[a-z0-9]+$/.test(thumbUrl), thumbUrl);
const img = await author.page.evaluate(async (u) => {
  const res = await fetch(u);
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get("content-type"), cache: res.headers.get("cache-control"),
           n: buf.length, sig: Array.from(buf.slice(0, 4)) };
}, thumbUrl);
check("the image is served as a real PNG", img.status === 200 && img.type === "image/png" && img.sig[1] === 80, JSON.stringify(img));
check("…and cached for a year (the URL changes when the image does)", /max-age=31536000/.test(img.cache || ""), img.cache);
check("…byte-for-byte the upload", img.n === fs.statSync(ROOT + "/assets/img/mark.png").size, String(img.n));
r = await publish({ thumbnail: "data:image/png;base64," + "A".repeat(500000) });
check("an oversized upload gets a helpful message", !r.ok && /too large/.test(r.error), r.error);

console.log("\nServer: AI description helper");
const describe = () => author.page.evaluate(async () => (await (await fetch("/api/scripts/describe", {
  method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ desc: "af script for pet sim, hatches eggs, works on mobile", title: "Farm", game: "Pet Simulator 99",
    code: 'local AutoFarm = true\nprint("hi")' }),
})).json()).data);
const LONG = "This auto farm script for Pet Simulator 99 collects coins and hatches eggs. Features:\n- Auto farm\n- Egg hatching";
aiReply = { response: { description: LONG, tags: ["AutoFarm", "Eggs"] } };     // already-parsed JSON
let d = await describe();
check("works when Workers AI returns the JSON already parsed (the old bug)", d.ai === true && d.description === LONG, JSON.stringify(d).slice(0, 160));
aiReply = { response: '{"description":"Line one.\nLine two with more words.","tags":["A"]}' };   // raw newline in JSON
d = await describe();
check("works when the model puts real newlines inside the JSON", d.ai === true && /Line two/.test(d.description), JSON.stringify(d).slice(0, 160));
aiReply = { choices: [{ message: { content: '```json\n{"description":"OpenAI shaped.","tags":[]}\n```' } }] };
d = await describe();
check("works with the OpenAI-style reply shape", d.ai === true && d.description === "OpenAI shaped.", JSON.stringify(d).slice(0, 160));
const HUNDRED = Array.from({ length: 125 }, (_, i) => "word" + i).join(" ");
aiReply = (input) => ({ response: { description: input.messages.length > 2 ? HUNDRED : LONG, tags: ["A"] } });
d = await describe();
check("a rewrite under the 100-word minimum is expanded in a second pass", d.ai === true && d.description === HUNDRED,
  String(d.description).split(/\s+/).length + " words");
aiReply = new Error("3036: neurons limit exceeded");
d = await describe();
check("a model failure says why instead of 'already reads well'", d.ai === false && d.why === "limit", JSON.stringify(d));

/* ------------------------------------------------------------ the form */

console.log("\nPublish form (browser)");
await author.page.setViewportSize({ width: 1280, height: 860 });
await author.page.goto(AT + "/");
await author.page.waitForTimeout(900);
await author.page.evaluate(() => window.__lucrit.jumpTo("submit"));
await author.page.waitForTimeout(1500);
const form = author.page.locator(".pubform");

const hiddenShown = await author.page.evaluate(() =>
  [...document.querySelectorAll(".publish [hidden]")].filter((e) => getComputedStyle(e).display !== "none").length);
check("nothing marked hidden is showing (the empty AI boxes, the stray Remove button)", hiddenShown === 0, String(hiddenShown));

const linkLabel = await form.locator('[data-for="link"] .field__label').textContent();
const codeLabel = await form.locator('[data-for="code"] .field__label').textContent();
check("Script link is labelled optional", /optional/i.test(linkLabel), linkLabel);
check("Lua code is marked required", /\*/.test(codeLabel), codeLabel);

const code = form.locator('textarea[name="code"]');
await code.fill(GOOD["loadstring one-liner"]);
check("the form calls the loadstring one-liner Lua", /Lua Detected/.test(await form.locator("[data-luachip]").textContent()));
await code.fill(BAD["missing end"][0]);
await author.page.waitForTimeout(100);
const err = await form.locator('[data-err="code"]').textContent();
check("an unclosed block shows the line in the form", /Line 1/.test(err), err);
await code.fill("");

// A big image: 2400×1600 noise, several MB as PNG — the old form refused it.
const big = await author.page.evaluate(async () => {
  const c = document.createElement("canvas"); c.width = 2400; c.height = 1600;
  const x = c.getContext("2d"); const id = x.createImageData(2400, 1600);
  for (let i = 0; i < id.data.length; i += 4) {
    id.data[i] = (i * 7) % 255; id.data[i + 1] = Math.random() * 255; id.data[i + 2] = (i >> 9) % 255; id.data[i + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
const bigBuf = Buffer.from(big, "base64");
await form.locator('input[name="thumbnail"]').setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: bigBuf });
await author.page.waitForTimeout(2500);
const shrunk = await author.page.evaluate(() => {
  const i = document.querySelector("[data-thumbpreview] .fitimg__fg");
  return { len: i?.getAttribute("src")?.length || 0, state: document.querySelector("[data-thumbstate]")?.textContent || "" };
});
check(`a ${(bigBuf.length / 1048576).toFixed(1)} MB image is accepted and shrunk to fit the server`, shrunk.len > 1000 && shrunk.len <= 380000, JSON.stringify(shrunk));
check("…and the form says it's using it", /Using your image/.test(shrunk.state), shrunk.state);

aiReply = new Error("model down");
await form.locator('textarea[name="desc"]').fill("af script for pet sim it hatches eggs and farms coins on mobile");
await form.locator('[data-act="enhance"]').first().click();
await author.page.waitForTimeout(700);
const t1 = await author.page.locator(".toast").textContent();
check("a failed AI rewrite says so (not 'already reads well')", /couldn't rewrite/i.test(t1) && !/reads well/.test(t1), t1);
aiReply = { response: { description: LONG, tags: ["AutoFarm"] } };
await form.locator('[data-act="enhance"]').first().click();
await author.page.waitForTimeout(700);
check("a working AI rewrite is offered side by side", await form.locator("[data-offer]:not([hidden]) [data-act='accept']").count() === 1);

/* ------------------------------------------------------------ script page */

console.log("\nScript page: the unlock step");
const visitor = await person(browser, AT, "Reader");
visitor.page.on("pageerror", (e) => pageErrors.push(e.message));
const path = `/creations/${encodeURIComponent(s1.author)}/${s1.slug}`;

await visitor.page.setViewportSize({ width: 1280, height: 860 });
await visitor.page.goto(AT + path);
await visitor.page.waitForTimeout(1300);
const vis = await visitor.page.evaluate(() => ({
  buttons: [...document.querySelectorAll("#script .gate .btn")].map((b) => b.textContent.trim()),
  code: Boolean(document.querySelector("#script .script__code")),
}));
check("a visitor gets LootLabs and Linkvertise", vis.buttons.some((b) => /LootLabs/.test(b)) && vis.buttons.some((b) => /Linkvertise/.test(b)), vis.buttons.join(" | "));
check("…and no code before unlocking", !vis.code);
const status = await visitor.page.evaluate(async (id) => (await fetch(`/api/scripts/${id}/code`)).status, s1.id);
check("the server refuses the code to a visitor (403)", status === 403, String(status));

await author.page.goto(AT + path);
await author.page.waitForTimeout(1300);
check("the author is told visitors must unlock", /Visitors have to complete LootLabs or Linkvertise/.test(await author.page.locator("#script .ownernote").textContent()));
await author.page.locator('#script [data-act="preview-visitor"]').click();
await author.page.waitForTimeout(200);
const prev = await author.page.evaluate(() => ({
  gate: Boolean(document.querySelector("#script .gate--preview")),
  buttons: [...document.querySelectorAll("#script .gate--preview [data-act='preview-noop']")].length,
  code: Boolean(document.querySelector("#script .script__code")),
}));
check("'See what visitors see' shows the gate with both buttons", prev.gate && prev.buttons === 2 && !prev.code, JSON.stringify(prev));
await author.page.locator('#script [data-act="preview-exit"]').click();

/* ------------------------------------------------------------ resizing */

console.log("\nEverything resizes with the window");
for (const w of [1440, 1100, 900, 700, 390]) {
  for (const [who, p] of [["visitor", visitor.page], ["author", author.page]]) {
    await p.setViewportSize({ width: w, height: 820 });
    await p.waitForTimeout(250);
    const m = await p.evaluate(() => {
      const panel = document.querySelector("#script .sheet__panel").getBoundingClientRect();
      const side = document.querySelector("#script .script__side").getBoundingClientRect();
      const media = document.querySelector("#script .script__media")?.getBoundingClientRect();
      const wide = [...document.querySelectorAll("#script *")].filter((e) => {
        const r = e.getBoundingClientRect();
        if (!r.width || r.right <= panel.right + 1 || getComputedStyle(e).position === "absolute") return false;
        // Inside a box that scrolls sideways (the code viewer) is fine.
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          if (a.classList.contains("sheet__panel")) break;
          if (/auto|scroll|hidden/.test(getComputedStyle(a).overflowX)) return false;
        }
        return true;
      }).length;
      return { pageW: document.documentElement.scrollWidth, vw: innerWidth, sideTop: side.top, wide,
               mediaH: media?.height || 0, vh: innerHeight };
    });
    check(`${w}px ${who}: no sideways scroll, nothing pokes out of the panel`, m.pageW <= m.vw && m.wide === 0, JSON.stringify(m));
    check(`${w}px ${who}: the get-script panel starts on the first screen`, m.sideTop < m.vh, JSON.stringify(m));
    check(`${w}px ${who}: the thumbnail never takes more than ~60% of the height`, m.mediaH <= m.vh * 0.6 + 2, JSON.stringify(m));
  }
}

await author.page.goto(AT + "/");
for (const w of [1440, 1180, 1000, 860, 390]) {
  await author.page.setViewportSize({ width: w, height: 820 });
  await author.page.waitForTimeout(300);
  const n = await author.page.evaluate(() => {
    const nav = document.querySelector(".nav");
    const dash = document.querySelector(".dashbtn").getBoundingClientRect();
    const items = [...document.querySelectorAll(".nav__links button, .nav__links a, .nav__search, .nav__menu")]
      .filter((e) => e.getBoundingClientRect().width > 0);
    const hit = items.filter((e) => {
      const r = e.getBoundingClientRect();
      return dash.top < 60 && r.right > dash.left && r.left < dash.right;
    }).length;
    const wrapped = [...document.querySelectorAll(".nav__links button")].filter((b) => b.getBoundingClientRect().height > 40).length;
    return { compact: nav.classList.contains("nav--compact"), hit, wrapped, off: items.filter((e) => e.getBoundingClientRect().right > innerWidth).length };
  });
  check(`${w}px nav: nothing under the Dashboard button, off-screen or wrapped`, n.hit === 0 && n.off === 0 && n.wrapped === 0, JSON.stringify(n));
}
await author.page.setViewportSize({ width: 900, height: 820 });
await author.page.waitForTimeout(300);
await author.page.locator(".nav__menu").click();
check("the menu opens with every link", await author.page.locator(".nav__drawer:not([hidden]) button, .nav__drawer:not([hidden]) a").count() === 8);

check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));

await browser.close();
server.close();
process.exit(done() ? 1 : 0);
