// More sponsor tabs (18 Oct 2026, "more ads … MAXX PROFIT"): the gates right
// after someone finishes a task take 4–7 presses, an unlocked executor's
// download is gated too, and browsing (a card, a game) opens one tab now and
// then. Unit-level: window.open is counted, nothing real is opened.
import { counter } from "./harness.mjs";
const { check, done } = counter();

const store = {}, sess = {};
const mk = (o) => ({ getItem: (k) => o[k] ?? null, setItem: (k, v) => { o[k] = String(v); }, removeItem: (k) => { delete o[k]; } });
globalThis.localStorage = mk(store);
globalThis.sessionStorage = mk(sess);
Object.defineProperty(globalThis, "navigator", { value: { webdriver: false }, configurable: true });
const opened = [];
globalThis.window = { open: (u) => { opened.push(u); return {}; } };

const { createAdGate, sponsorTap, SPONSOR_LINKS } = await import("../assets/js/adgate.js");

const needs = new Set();
for (let i = 0; i < 200; i++) needs.add(createAdGate("t" + i).need);
check("gates ask for 4–7 presses", [...needs].every((n) => n >= 4 && n <= 7) && needs.has(4) && needs.has(7), [...needs].sort().join(","));

store["lucrit:staff"] = "1";
const g = createAdGate("xdl:x_1");
check("the owner's browser gets the sponsor tabs too now", g.left > 0, String(g.left));
let presses = 0;
while (!g.press()) presses++;
check("executor download: one tab per press, then the download", presses === g.need && opened.length === g.need && opened.every((u) => u === SPONSOR_LINKS.xdl), `${presses}/${g.need}/${opened.length}`);

opened.length = 0;
check("browsing tap opens one sponsor tab", sponsorTap() === true && opened.length === 1);
check("…but not again within two minutes", sponsorTap() === false && opened.length === 1);
store["lucrit:tap"] = String(Date.now() - 3 * 60 * 1000);
check("…and again after that", sponsorTap() === true && opened.length === 2);

Object.defineProperty(globalThis, "navigator", { value: { webdriver: true }, configurable: true });
store["lucrit:tap"] = "0";
check("automated browsers never open sponsor tabs", sponsorTap() === false && createAdGate("bot").left === 0);

done();
