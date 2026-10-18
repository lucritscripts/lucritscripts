// What search engines see (Oct 2026).
//
// Google showed the bare domain as the site name, a blue smudge for the icon,
// and — because every route is served the same index.html — would have read
// every script page as a copy of the homepage. This checks the shell the
// Worker actually sends, the icons, robots.txt and the sitemap.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import worker from "../_worker.js";
import { ROOT, freshEnv, counter } from "./harness.mjs";

const { check, done } = counter();
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon",
  ".txt": "text/plain", ".webmanifest": "application/manifest+json", ".js": "text/javascript" };
// Pages-like asset server: "/" → index.html, otherwise the file, else 404.
const ASSETS = { fetch: async (req) => {
  const p = new URL(req.url).pathname;
  const file = path.join(ROOT, p === "/" ? "index.html" : p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response("nope", { status: 404 });
  return new Response(fs.readFileSync(file), { headers: { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" } });
} };
const env = freshEnv(worker, { ASSETS, SITE_URL: "https://lucritscripts.site" });
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

let ipN = 0;
async function call(method, p, body, cookie) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": `10.9.0.${++ipN % 250}` };
  if (cookie) headers.Cookie = cookie;
  const res = await worker.fetch(new Request("https://lucritscripts.site" + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { waitUntil: () => {} });
  const set = res.headers.getSetCookie?.() || [];
  return { res, cookie: set.map((c) => c.split(";")[0]).join("; ") };
}
const page = async (p) => { const { res } = await call("GET", p); return { status: res.status, type: res.headers.get("Content-Type") || "", text: await res.text() }; };
const tag = (html, re) => (html.match(re) || [])[1];

console.log("Homepage");
const home = await page("/");
check("title names the site", tag(home.text, /<title>([^<]*)<\/title>/) === "Lucrit Script — The Ultimate Roblox Script Library");
check("canonical is the root", /<link rel="canonical" href="https:\/\/lucritscripts\.site\/">/.test(home.text));
check("og:site_name is Lucrit Script", /<meta property="og:site_name" content="Lucrit Script">/.test(home.text));
const ld = JSON.parse(tag(home.text, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/));
const site = ld["@graph"].find((x) => x["@type"] === "WebSite");
check("WebSite structured data names the site", site?.name === "Lucrit Script" && site?.url === "https://lucritscripts.site/");
check("description is real copy", (tag(home.text, /<meta name="description" content="([^"]*)">/) || "").length > 80);
check("Monetag ownership tag is on the homepage", /<meta name="monetag" content="091a1ecc38117d2bb82b05169c41c606">/.test(home.text));
check("homepage is indexable", !/name="robots" content="noindex"/.test(home.text));

console.log("\nIcons");
for (const f of ["/favicon.ico", "/assets/img/icon-48.png", "/assets/img/icon-96.png", "/assets/img/icon-192.png", "/assets/img/icon-512.png", "/site.webmanifest"]) {
  check(`${f} is served`, (await page(f)).status === 200);
  if (!f.endsWith(".png")) continue;
  const b = fs.readFileSync(path.join(ROOT, f));
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  check(`${f} is square and a multiple of 48`, w === h && w % 48 === 0 || (w === h && w === 512), `${w}x${h}`);
}
check("every icon the page links to exists", [...home.text.matchAll(/<link rel="(?:icon|shortcut icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)]
  .every((m) => fs.existsSync(path.join(ROOT, m[1].split("?")[0]))));

const fake404 = { fetch: async () => new Response("<!doctype html><title>shell</title>", { headers: { "Content-Type": "text/html" } }) };
const r404 = await worker.fetch(new Request("https://lucritscripts.site/assets/img/nope.png"), { ...env, ASSETS: fake404 }, { waitUntil: () => {} });
check("a missing image is a 404, not the homepage HTML", r404.status === 404 && !(await r404.text()).includes("doctype"));
check("the homepage links a PNG favicon first", /<link rel="icon" type="image\/png" sizes="48x48" href="\/assets\/img\/icon-48\.png">/.test(home.text));

console.log("\nrobots.txt");
const robots = fs.readFileSync(path.join(ROOT, "robots.txt"), "utf8");
check("points at this domain's sitemap (not GitHub Pages)", /Sitemap: https:\/\/lucritscripts\.site\/sitemap\.xml/.test(robots) && !/github\.io/.test(robots));
check("keeps admin and dashboards out", /Disallow: \/admin/.test(robots) && /Disallow: \/dashboard/.test(robots));

console.log("\nScript and creator pages have their own titles");
const up = await call("POST", "/api/auth/signup", { username: "Maker", email: "maker@example.com", authKey: hex("pw") });
const LONG = ("Auto farm every island, collect fruits and fight bosses with one tap — works on mobile and PC. ").repeat(8);
env.DB._raw.prepare("DELETE FROM ratelimits").run();
const pub = await call("POST", "/api/scripts", { title: "Auto Farm Hub", game: "Blox Fruits", category: "combat", desc: LONG,
  keyless: true, captcha: true, tags: ["farm"], code: 'local P = game:GetService("Players")\nprint(P.LocalPlayer)',
  thumbnail: "https://tr.rbxcdn.com/abc/768/432/Image/Png" }, up.cookie);
const pubBody = await pub.res.json();
const s = pubBody.data;
if (!s) console.log(JSON.stringify(pubBody));
check("published a script", !!s?.id);
const sp = await page(`/creations/Maker/${s.slug}`);
check("script page: its own title", tag(sp.text, /<title>([^<]*)<\/title>/) === "Auto Farm Hub — Blox Fruits Script | Lucrit Script", tag(sp.text, /<title>([^<]*)<\/title>/));
check("…its own description, trimmed", /^Auto farm every island/.test(tag(sp.text, /<meta name="description" content="([^"]*)">/) || "")
  && tag(sp.text, /<meta name="description" content="([^"]*)">/).length <= 160);
check("…its own canonical URL", tag(sp.text, /<link rel="canonical" href="([^"]*)">/) === `https://lucritscripts.site/creations/Maker/${s.slug}`);
check("…its thumbnail as the preview image", tag(sp.text, /<meta property="og:image" content="([^"]*)">/) === "https://tr.rbxcdn.com/abc/768/432/Image/Png");
check("…still the app shell", /\/assets\/js\/main\.js/.test(sp.text) && sp.type.includes("text/html"));
const cp = await page("/creators/maker");
check("creator page: its own title", tag(cp.text, /<title>([^<]*)<\/title>/) === "@Maker — Roblox scripts | Lucrit Script");
const gone = await page("/creations/Maker/ffffffff");
check("unknown script keeps the default title (no crash)", gone.status === 200 && /The Ultimate Roblox Script Library/.test(gone.text));
const evil = await page("/creations/Maker/%22%3E%3Cscript%3E");
check("nothing from the URL is echoed unescaped", !/"><script>/.test(evil.text));
const adm = await page("/admin");
check("/admin is noindex", /<meta name="robots" content="noindex">/.test(adm.text));

console.log("\nSitemap");
const sm = await page("/sitemap.xml");
check("served as XML", sm.status === 200 && sm.type.includes("application/xml"));
check("lists the homepage", sm.text.includes("<loc>https://lucritscripts.site/</loc>"));
check("lists the script page", sm.text.includes(`<loc>https://lucritscripts.site/creations/Maker/${s.slug}</loc>`));
check("lists the creator", sm.text.includes("<loc>https://lucritscripts.site/creators/Maker</loc>"));

done();
