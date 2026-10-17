// Admin → Keys tab: the Get Key keys, live from Firebase.
//
// Asked for (15 Oct 2026): "on the admin page put a view where i can view
// active keys" — recycled from the old SMH Key Cleaner page (active/expired
// lists, delete, delete-all-expired, unlock).
//
// Firestore's REST API is faked at the network boundary, AFTER the browser's
// CSP check — so a missing connect-src would fail this test the same way it
// would fail on the live site.
import crypto from "node:crypto";
import { chromium } from "playwright";
import worker from "../_worker.js";
import { CHROME, freshEnv, serve, counter } from "./harness.mjs";

const PORT = 8211;
const AT = `http://localhost:${PORT}`;
const { check, done } = counter();

const derive = (p) =>
  crypto.pbkdf2Sync(p, Buffer.from("lucrit-admin-v1", "utf8"), 310000, 32, "sha256").toString("hex");
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const env = freshEnv(worker, { ADMIN_PASS_HASH: hex(derive("open-sesame")) });
const server = await serve(worker, env, PORT);

/* ── a fake Firestore "keys" collection ─────────────────────────────── */
const now = Date.now();
const store = new Map(Object.entries({
  "LUCRIT-AAAAAAAAAAAAAAAA": { valid: { booleanValue: true }, expiresAt: { integerValue: String(now + 5 * 3600e3) },
    inUse: { booleanValue: true }, sessionId: { stringValue: "sess-1" }, userId: { stringValue: "123456" },
    boundTo: { stringValue: "12345678" }, lastPing: { integerValue: String(now - 20e3) } },
  "LUCRIT-BBBBBBBBBBBBBBBB": { valid: { booleanValue: true }, expiresAt: { doubleValue: now + 7 * 3600e3 },
    inUse: { booleanValue: false }, boundTo: { stringValue: "12345678" }, lastPing: { integerValue: String(now - 3600e3) } },
  "SMH-OLD1OLD1OLD1OLD1": { valid: { booleanValue: true }, expiresAt: { integerValue: String(now - 3600e3) }, inUse: { booleanValue: false } },
  "SMH-OLD2OLD2OLD2OLD2": { valid: { booleanValue: true }, expiresAt: { timestampValue: new Date(now - 86400e3).toISOString() } },
  "LUCRIT-REVOKEDREVOKED00": { valid: { booleanValue: false }, expiresAt: { integerValue: String(now + 3600e3) } },
}));
const patches = [];
const doc = (id) => ({ name: `projects/smh-keysystem/databases/(default)/documents/keys/${id}`, fields: store.get(id) });

const browser = await chromium.launch({ executablePath: CHROME });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await ctx.route("https://firestore.googleapis.com/**", async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const ok = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.searchParams.get("key") !== "AIzaSyDpgv4ZMQ_VKdW565VsDReKGYKJMTVeK58") return route.fulfill({ status: 403, body: "{}" });
  const m = url.pathname.match(/\/documents\/keys(?:\/([^/]+))?$/);
  if (!m) return route.fulfill({ status: 404, body: "{}" });
  const id = m[1] && decodeURIComponent(m[1]);
  if (req.method() === "GET" && !id) return ok({ documents: [...store.keys()].map(doc) });
  if (req.method() === "DELETE") { store.delete(id); return ok({}); }
  if (req.method() === "POST" && !id) {
    const newId = url.searchParams.get("documentId");
    if (store.has(newId)) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: { message: "exists" } }) });
    store.set(newId, JSON.parse(req.postData()).fields);
    return ok(doc(newId));
  }
  if (req.method() === "PATCH") {
    const body = JSON.parse(req.postData());
    patches.push({ id, mask: url.searchParams.getAll("updateMask.fieldPaths"), fields: body.fields });
    store.set(id, { ...store.get(id), ...body.fields });
    return ok(doc(id));
  }
  return route.fulfill({ status: 400, body: "{}" });
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => { if (/Refused to connect|Content Security Policy/i.test(m.text())) errors.push(m.text()); });
page.on("dialog", (d) => d.accept());
// The site's CSP blocks waitForFunction's eval, so poll with evaluate instead.
async function until(fn, arg, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await page.evaluate(fn, arg)) return true; await page.waitForTimeout(150); }
  throw new Error("timed out waiting for " + fn.toString().slice(0, 80));
}
await page.addInitScript(() => localStorage.setItem("lucrit:human", JSON.stringify({ at: Date.now(), v: 1 })));

console.log("Opening the Keys tab");
await page.goto(`${AT}/admin`);
await page.locator("#admin [name=passcode]").fill("open-sesame");
await page.locator("#admin [data-passform] button[type=submit]").click();
await page.locator('#admin [data-admintab="keys"]').waitFor({ timeout: 30000 });
check("there's a Keys tab", true);
await page.locator('#admin [data-admintab="keys"]').click();
await page.locator("#admin [data-keysbody]").waitFor();
const tiles = async () => (await page.locator("#admin [data-keystats]").textContent()).replace(/\s+/g, " ");
check("counts: 2 active, 1 in use, 3 expired", /Active keys 2/.test(await tiles()) && /In use now 1/.test(await tiles()) && /Expired 3/.test(await tiles()), await tiles());
let rows = await page.$$eval("#admin [data-keysbody] tr[data-key]", (t) => t.map((r) => r.dataset.key));
check("active list shows the 2 live keys", rows.length === 2, rows.join());
check("the one in use is first", rows[0] === "LUCRIT-AAAAAAAAAAAAAAAA");
const first = (await page.locator("#admin [data-keysbody] tr").first().textContent()).replace(/\s+/g, " ");
check("shows time left, session, user, last ping", /4h \d+m left/.test(first) && /sess-1/.test(first) && /123456/.test(first) && /ago|just now/.test(first), first);

console.log("\nSearch");
await page.locator("#admin [data-keyq]").fill("BBBB");
rows = await page.$$eval("#admin [data-keysbody] tr[data-key]", (t) => t.map((r) => r.dataset.key));
check("search narrows to one key", rows.length === 1 && rows[0] === "LUCRIT-BBBBBBBBBBBBBBBB");
await page.locator("#admin [data-keyq]").fill("");

console.log("\nUnlock a stuck key");
await page.locator('#admin tr[data-key="LUCRIT-AAAAAAAAAAAAAAAA"] [data-keyact="unlock"]').click();
await until(() => /free/.test(document.querySelector('#admin tr[data-key="LUCRIT-AAAAAAAAAAAAAAAA"]')?.textContent || ""));
const p0 = patches[0];
check("unlock clears exactly inUse, sessionId, userId, lastPing",
  p0 && p0.mask.sort().join() === "inUse,lastPing,sessionId,userId" && p0.fields.inUse.booleanValue === false && "nullValue" in p0.fields.lastPing,
  JSON.stringify(p0));
check("…and leaves the key itself alone", store.get("LUCRIT-AAAAAAAAAAAAAAAA").valid.booleanValue === true);

console.log("\nExpired keys");
await page.locator('#admin [data-keyview="expired"]').click();
await page.locator("#admin [data-keysbody]").waitFor();
rows = await page.$$eval("#admin [data-keysbody] tr[data-key]", (t) => t.map((r) => r.dataset.key));
check("expired list: 2 past expiry + 1 revoked", rows.length === 3, rows.join());
check("revoked one is labelled", /revoked/.test(await page.locator('#admin tr[data-key="LUCRIT-REVOKEDREVOKED00"]').textContent()));
await page.locator('#admin [data-keyact="deleteexpired"]').click();
await until(() => /✓ No expired keys/.test(document.querySelector("#admin [data-keysbody]")?.textContent || ""));
check("delete all expired removes exactly those 3", store.size === 2 && store.has("LUCRIT-AAAAAAAAAAAAAAAA") && store.has("LUCRIT-BBBBBBBBBBBBBBBB"), [...store.keys()].join());

console.log("\nDelete an active key");
await page.locator('#admin [data-keyview="active"]').click();
await page.locator('#admin tr[data-key="LUCRIT-BBBBBBBBBBBBBBBB"] [data-keyact="delete"]').click();
await until(() => !document.querySelector('#admin tr[data-key="LUCRIT-BBBBBBBBBBBBBBBB"]'));
check("active key deleted (after a confirm)", !store.has("LUCRIT-BBBBBBBBBBBBBBBB"));

console.log("\nMake a key instantly (no sponsor steps)");
check("there's a Make key button", await page.locator('#admin [data-keyact="make"]').count() === 1);
await page.locator("#admin [data-keyhours]").selectOption("24");
const before = new Set(store.keys());
await page.locator('#admin [data-keyact="make"]').click();
await until(() => !!document.querySelector("#admin [data-madekey]"));
const made = [...store.keys()].find((k) => !before.has(k));
const mf = made && store.get(made);
check("a new LUCRIT- key is written to Firebase", /^LUCRIT-[A-HJ-NP-Z2-9]{16}$/.test(made || ""), made);
check("…shaped like a /getkey key (valid, not in use, bound, pinged)",
  mf?.valid?.booleanValue === true && mf?.inUse?.booleanValue === false && mf?.boundTo?.stringValue === "admin" && Number(mf?.lastPing?.integerValue) > 0);
const hrs = (Number(mf?.expiresAt?.integerValue) - Date.now()) / 3600e3;
check("…lasting the picked 24 hours", hrs > 23.9 && hrs <= 24, hrs.toFixed(3));
check("…shown in the panel", (await page.locator("#admin [data-madekey]").textContent()).includes(made));
await until((k) => !!document.querySelector(`#admin tr[data-key="${k}"]`), made);
check("…and in the active list", true);

console.log("\nActivity log");
await page.waitForTimeout(500);
await page.locator('#admin [data-admintab="activity"]').click();
await page.locator("#admin tbody tr").first().waitFor();
const act = await page.locator("#admin tbody").textContent();
check("unlock, clean-up and delete are logged", /Key unlocked/.test(act) && /Expired keys cleaned/.test(act) && /Key deleted \(active\)/.test(act), act.replace(/\s+/g, " ").slice(0, 300));
check("making a key is logged", /Key made by admin/.test(act));

console.log("\nThe log endpoint is locked down");
const call = async (body, cookie) => (await worker.fetch(new Request("https://lucrit.test/api/admin/log", {
  method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body),
}), env, { waitUntil() {} })).status;
check("no ticket → 423", await call({ action: "Key unlocked", target: "x" }) === 423);
const cookies = (await ctx.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
check("staff can't forge non-key entries", await call({ action: "Verified", target: "x" }, cookies) === 400);

check("no page errors or CSP blocks", errors.length === 0, errors.join(" | "));
await browser.close();
server.close();
done();
