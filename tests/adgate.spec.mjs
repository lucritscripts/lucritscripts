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

// 20 Oct, "calm it down": browsing taps wait for the second card of a visit
// and then come at most once every 10 minutes; unlock-button pops at most
// once every 5 minutes.
opened.length = 0;
check("the first card of a visit opens nothing (it only arms)", sponsorTap() === false && opened.length === 0);
check("browsing tap opens one sponsor tab after that", sponsorTap() === true && opened.length === 1);
check("…but not again within ten minutes", sponsorTap() === false && opened.length === 1);
store["lucrit:tap"] = String(Date.now() - 3 * 60 * 1000);
check("…not even three minutes later (was two)", sponsorTap() === false && opened.length === 1);
store["lucrit:tap"] = String(Date.now() - 11 * 60 * 1000);
check("…and again after ten", sponsorTap() === true && opened.length === 2);

opened.length = 0;
const { sponsorPop, sponsorTransfer } = await import("../assets/js/adgate.js");
check("an unlock button press opens a sponsor tab", sponsorPop() === true && opened.length === 1);
check("…but a second press within 5 minutes doesn't", sponsorPop() === false && opened.length === 1);
store["lucrit:pop"] = String(Date.now() - 6 * 60 * 1000);
check("…and again after 5 minutes", sponsorPop() === true && opened.length === 2);

// The transfer screen: a tab on the press, a 5-second countdown, then the sponsor.
const nodes = [];
globalThis.location = { href: "https://lucritscripts.site/unlock/lootlabs" };
globalThis.document = {
  body: { appendChild: (n) => nodes.push(n) },
  createElement: () => {
    const el = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, remove() { el.gone = true; },
      _q: {}, querySelector(sel) { return (el._q[sel] ||= { textContent: "" }); } };
    Object.defineProperty(el, "innerHTML", { set() {}, get() { return ""; } });
    return el;
  },
};
opened.length = 0;
const tr = sponsorTransfer("LootLabs");
tr.go("https://loot-link.com/s?x");
check("transfer: one sponsor tab on the press", opened.length === 1);
check("transfer: shows 'Taking you to LootLabs in 5…'", nodes.length === 1 && nodes[0]._q["[data-t]"].textContent === "Taking you to LootLabs in 5…", nodes[0]?._q["[data-t]"]?.textContent);
check("transfer: hasn't left yet", location.href.includes("lucritscripts.site"));
await new Promise((r) => setTimeout(r, 5300));
check("transfer: goes to the sponsor after 5 seconds", location.href === "https://loot-link.com/s?x", location.href);
const tr2 = sponsorTransfer("Linkvertise");
tr2.cancel();
check("transfer: a failed link closes the screen", nodes[1].gone === true);

Object.defineProperty(globalThis, "navigator", { value: { webdriver: true }, configurable: true });
store["lucrit:tap"] = "0";
check("automated browsers never open sponsor tabs", sponsorTap() === false && createAdGate("bot").left === 0);

done();
