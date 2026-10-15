// Shared test harness.
//
// This lives in the REPOSITORY, not in a scratch directory, and that is the
// whole point of the file. An earlier suite of ~974 assertions was written in
// a sandbox /tmp and was lost the moment the container was reclaimed — the
// code it guarded survived because it was committed, and the tests did not
// because they were not. Tests that only exist on one machine are notes.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".json": "application/json", ".svg": "image/svg+xml",
};

/** A D1-shaped wrapper over node:sqlite, matching the subset the Worker uses. */
export function makeD1(schema) {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const prep = (sql) => {
    let params = [];
    const stmt = {
      bind(...p) { params = p.map((v) => (v === undefined ? null : v)); return stmt; },
      async run() { db.prepare(sql).run(...params); return { success: true }; },
      async first() { return db.prepare(sql).get(...params) ?? null; },
      async all() { return { results: db.prepare(sql).all(...params) }; },
    };
    return stmt;
  };
  return { prepare: prep, async batch(l) { for (const s of l) await s.run(); return []; }, _raw: db };
}

export function freshEnv(worker, extra = {}) {
  return {
    DB: makeD1(fs.readFileSync(ROOT + "/schema.sql", "utf8")),
    AI: { run: async () => null },
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
    ...extra,
  };
}

/** Static files from disk, /api/* through the real Worker. */
export async function serve(worker, env, port) {
  const APP_ROUTES = [
    /^\/admin\/?$/, /^\/creators\/[^/]+\/?$/, /^\/creations\/[^/]+\/[^/]+\/?$/,
    /^\/dashboard(\/[^/]+)?\/?$/, /^\/executors(\/[^/]+)?\/?$/, /^\/unlock\/[a-z]+\/?$/,
  ];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "https://lucrit.test");
    if (url.pathname.startsWith("/api/")) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      headers.set("CF-Connecting-IP", "203.0.113.5");
      const wres = await worker.fetch(
        new Request("https://lucrit.test" + req.url, { method: req.method, headers, body }), env);
      const out = {};
      wres.headers.forEach((v, k) => { if (k.toLowerCase() !== "set-cookie") out[k] = v; });
      const cookies = wres.headers.getSetCookie?.() || [];
      res.writeHead(wres.status, cookies.length ? { ...out, "Set-Cookie": cookies } : out);
      return res.end(Buffer.from(await wres.arrayBuffer()));
    }
    const spa = APP_ROUTES.some((re) => re.test(url.pathname));
    const name = spa || url.pathname === "/" ? "/index.html" : url.pathname;
    const file = path.join(ROOT, name);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("no");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(port, r));
  return server;
}

export function counter() {
  let pass = 0, fail = 0;
  return {
    check(name, cond, extra = "") {
      if (cond) { pass++; console.log("  ok   " + name); }
      else { fail++; console.log("  FAIL " + name + (extra ? "  → " + extra : "")); }
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed`);
      return fail;
    },
  };
}

/** A signed-in person with a real browser profile. */
export async function person(browser, at, name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 }));
  });
  await page.goto(at + "/", { waitUntil: "domcontentloaded" });
  // Polled with evaluate() rather than waitForFunction(): the site's CSP has
  // no 'unsafe-eval', and waitForFunction can fall back to evaluating its
  // predicate as a string, which the CSP then (correctly) refuses — flakily,
  // depending on timing. evaluate() passes a real function and never trips it.
  for (let i = 0; i < 40 && !(await page.evaluate(() => Boolean(window.__lucrit?.account))); i++)
    await page.waitForTimeout(500);
  await page.evaluate(() => window.__lucrit.account.ready);
  if (name) {
    await page.evaluate((n) => window.__lucrit.account.signUp({
      username: n, email: n.toLowerCase() + "@example.com",
      password: "hunter2hunter2", captcha: true,
    }), name);
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(400);
  return { ctx, page };
}
