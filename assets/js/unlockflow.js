// /unlock/lootlabs — the two-step unlock page.
//
// The Script Maniac Hub key system, rebuilt on the site:
//
//   Step 1 of 2 → LootLabs → back here → Step 2 of 2 → LootLabs → back here
//   → the script opens.
//
// Anti-bypass is the server's job, not this page's: every step is a click id
// LootLabs must confirm through its postback before the server lets the flow
// move on. Opening this address by hand, or coming back without finishing,
// just shows the same step again. (The old SMH page checked document.referrer,
// which anyone can fake; this can't be.)
import { createOverlay, esc, toast } from "./pages.js";
import { safeImageSrc } from "./safe.js";
import { savedFlow, rememberFlow, startFlow, getFlow, goFlow, checkFlow } from "./library-api.js";

// The LootLabs site tag (publisher 1247178), the same one the SMH key pages
// carried. Loaded only once someone is on an unlock page, never site-wide.
const LOOT_TAG = "https://dcbbwymplbhf.cloudfront.net/?wbbcd=1247178";
let tagLoaded = false;
function loadLootTag() {
  if (tagLoaded || window.__lucritNoAdTag) return;
  tagLoaded = true;
  const s = document.createElement("script");
  s.src = LOOT_TAG;
  s.async = true;
  s.setAttribute("data-cfasync", "false");
  document.head.appendChild(s);
}

const NAMES = { lootlabs: "LootLabs" };

export function createUnlockFlowPage({ onDone, onExit } = {}) {
  const sheet = createOverlay({ id: "unlock", label: "Unlock script" });
  sheet.node.classList.add("sheet--unlock");

  let flow = null;        // the server's view: { flowId, step, total, out, script }
  let state = "loading";  // loading | ready | going | checking | waiting | done | error | none
  let message = "";
  let run = 0;            // bumps on every open, so a stale check loop stops

  function stepsHtml() {
    const total = flow?.total || 2;
    const at = flow?.step || 1;
    return `<ol class="ufl__steps" aria-label="Progress">
      ${Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const cls = state === "done" || n < at ? "is-done" : n === at ? "is-now" : "";
        return `<li class="${cls}"><span>${cls === "is-done" ? "✓" : n}</span><b>Step ${n}</b></li>`;
      }).join('<li class="ufl__bar" aria-hidden="true"></li>')}
    </ol>`;
  }

  function render() {
    const s = flow?.script;
    const name = NAMES[flow?.provider || "lootlabs"] || "LootLabs";
    const img = s?.thumbnail ? esc(safeImageSrc(s.thumbnail)) : "";
    const step = flow?.step || 1;
    const total = flow?.total || 2;

    let main = "";
    if (state === "loading") {
      main = `<p class="ufl__msg">Loading your unlock…</p>`;
    } else if (state === "none") {
      main = `
        <p class="ufl__msg">There's no unlock in progress here. Open a script and press
           <b>Unlock with ${esc(name)}</b> to start.</p>
        <button class="btn btn--primary" data-ufl="home">Browse scripts</button>`;
    } else if (state === "error") {
      main = `
        <p class="ufl__msg ufl__msg--warn">${esc(message || "Something went wrong.")}</p>
        <div class="ufl__acts">
          ${s ? `<button class="btn btn--primary" data-ufl="restart">Start again</button>` : ""}
          <button class="btn btn--ghost" data-ufl="home">Back to scripts</button>
        </div>`;
    } else if (state === "checking" || state === "waiting") {
      main = `
        <div class="ufl__spin" aria-hidden="true"></div>
        <p class="ufl__msg">${state === "waiting"
          ? `Waiting for ${esc(name)} to confirm step ${step}… this can take a few seconds.`
          : `Checking step ${step} with ${esc(name)}…`}</p>
        <button class="btn btn--ghost btn--sm" data-ufl="retry">Didn't finish it? Do step ${step} again</button>`;
    } else if (state === "done") {
      main = `
        <p class="ufl__msg ufl__msg--ok">All done — opening your script…</p>`;
    } else {
      main = `
        <p class="ufl__kicker">Checkpoint ${step} of ${total}</p>
        ${message ? `<p class="ufl__msg ufl__msg--ok">${esc(message)}</p>` : ""}
        <p class="ufl__msg">Press the button, finish the ${esc(name)} page, and you'll come
           straight back here${step < total ? " for the next step" : " with the script unlocked"}.</p>
        <button class="btn btn--primary ufl__go" data-ufl="go" ${state === "going" ? "disabled" : ""}>
          ${state === "going" ? "Opening…" : `Continue to step ${step}`}
        </button>
        <p class="ufl__note">Each step is checked with ${esc(name)} — skipping it or opening this page
           directly won't unlock anything.</p>`;
    }

    sheet.body.innerHTML = `
      <div class="ufl">
        ${s ? `
          <header class="ufl__head">
            ${img ? `<img class="ufl__thumb" src="${img}" alt="">` : ""}
            <div>
              <p class="ufl__eyebrow">Unlocking</p>
              <h2 class="ufl__title">${esc(s.title)}</h2>
              ${s.author ? `<p class="ufl__by">by @${esc(s.author)}</p>` : ""}
            </div>
          </header>` : `<h2 class="ufl__title">Unlock a script</h2>`}
        ${state === "none" ? "" : stepsHtml()}
        <div class="ufl__main">${main}</div>
      </div>`;
  }

  async function begin(scriptId) {
    const res = await startFlow(scriptId, "lootlabs");
    if (!res.ok) { state = "error"; message = res.error || "Couldn't start the unlock."; flow = null; render(); return null; }
    flow = res.data;
    rememberFlow({ flowId: flow.flowId, scriptId, at: Date.now() });
    return flow;
  }

  async function check(myRun) {
    state = "checking"; render();
    let res = await checkFlow(flow.flowId);
    for (let tries = 0; myRun === run && !res.ok && res.pending && tries < 3; tries++) {
      state = "waiting"; render();
      await new Promise((r) => setTimeout(r, 4000));
      res = await checkFlow(flow.flowId);
    }
    if (myRun !== run) return;
    if (!res.ok) {
      // Not confirmed: back to the same step's button (it mints a fresh click).
      const now = await getFlow(flow.flowId);
      if (now.ok) flow = now.data;
      state = "ready";
      message = "";
      toast(res.pending
        ? "LootLabs hasn't confirmed that step. If you finished it, give it a moment and try again."
        : (res.error || "That step wasn't completed."), "warn");
      render();
      return;
    }
    flow = res.data;
    if (res.data.done) {
      state = "done"; render();
      rememberFlow(null);
      toast("Unlocked — here's the script");
      setTimeout(() => onDone?.(flow.script, res.data.unlockedFor), 600);
      return;
    }
    state = "ready";
    message = `Step ${flow.step - 1} complete ✓`;
    render();
  }

  // A thumbnail that won't load is dropped rather than shown as a broken box.
  sheet.body.addEventListener("error", (e) => {
    if (e.target instanceof HTMLImageElement && e.target.classList.contains("ufl__thumb")) e.target.remove();
  }, true);

  sheet.body.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-ufl]")?.dataset.ufl;
    if (!act) return;
    if (act === "home") { sheet.close(); onExit?.(); return; }
    if (act === "restart") {
      const id = flow?.script?.id;
      rememberFlow(null);
      if (id) { state = "loading"; render(); if (await begin(id)) { state = "ready"; message = ""; render(); } }
      return;
    }
    if (act === "retry" && flow) { run++; state = "ready"; message = ""; render(); return; }
    if (act === "go" && flow && state === "ready") {
      state = "going"; render();
      const res = await goFlow(flow.flowId);
      if (!res.ok) {
        state = "ready"; render();
        toast(res.error || "Couldn't reach LootLabs. Try again.", "warn");
        return;
      }
      location.href = res.data.url;
    }
  });

  return {
    /**
     * @param scriptId  set when arriving from a script page (?s=…); absent when
     *                  LootLabs sends the visitor back to the bare address.
     */
    async open({ scriptId = "" } = {}) {
      const myRun = ++run;
      flow = null; state = "loading"; message = "";
      sheet.open(); render();
      loadLootTag();

      const saved = savedFlow();
      const fresh = saved && Date.now() - (saved.at || 0) < 2 * 3600 * 1000;

      // Coming from a script page: carry on with that script's flow if one is
      // already under way (a refresh, or back from LootLabs with ?s= kept),
      // otherwise start at step 1.
      if (scriptId && !(fresh && saved.scriptId === scriptId)) {
        if (!(await begin(scriptId))) return;
        if (myRun !== run) return;
        state = "ready"; render();
        return;
      }
      if (!fresh) { state = "none"; render(); return; }

      const res = await getFlow(saved.flowId);
      if (myRun !== run) return;
      if (!res.ok) {
        rememberFlow(null);
        if (scriptId) { if (await begin(scriptId)) { state = "ready"; render(); } return; }
        state = "error"; message = res.error || "That unlock has expired."; render();
        return;
      }
      flow = res.data;
      // A step is out with LootLabs: this visit is the way back. Check it.
      if (flow.out) return check(myRun);
      state = "ready"; render();
    },
    close: () => sheet.close(),
    get isOpen() { return sheet.isOpen; },
  };
}
