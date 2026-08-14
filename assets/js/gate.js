// First-visit bot check.
//
// A full-screen gate shown once per device. Passing it writes a note to
// storage, so a returning visitor never sees it again until that note
// expires — this is a doorman, not a turnstile you queue at every time.
//
// It FAILS OPEN by design. If storage is blocked, the widget is missing, or
// anything at all throws, the site opens. A bot check that can lock real
// people out of the whole site is worse than the bots it stops. What it
// actually buys is friction against casual scripted traffic; the real
// boundary is App Check verified server-side, which needs billing enabled.

import { captchaMarkup, captchaPassed } from "./pages.js";

const KEY = "lucrit:human";
const TTL_DAYS = 30;

function alreadyPassed() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "null");
    if (!raw?.at) return false;
    return Date.now() - raw.at < TTL_DAYS * 86400000;
  } catch {
    // Storage blocked (private mode, locked-down browser). Do not trap them
    // behind a gate whose result we could never remember.
    return true;
  }
}

function remember() {
  try { localStorage.setItem(KEY, JSON.stringify({ at: Date.now(), v: 1 })); }
  catch { /* nothing to do — they simply see it again next visit */ }
}

/**
 * Shows the gate if this device has not passed recently.
 * Returns a promise that resolves once the site may be used.
 */
export function runBotCheck() {
  if (alreadyPassed()) return Promise.resolve("skipped");

  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      resolve(how);
    };

    let node;
    try {
      node = document.createElement("div");
      node.className = "botgate";
      node.setAttribute("role", "dialog");
      node.setAttribute("aria-modal", "true");
      node.setAttribute("aria-labelledby", "botgate-title");
      node.innerHTML = `
        <div class="botgate__panel">
          <img class="botgate__logo" src="assets/img/logo.png" alt="Lucrit Script"
               width="460" height="236" fetchpriority="high">
          <h1 class="botgate__title" id="botgate-title">Quick check</h1>
          <p class="botgate__sub">Confirm you're a person to carry on. This happens
             once on this device.</p>
          ${captchaMarkup("botgate-check")}
          <p class="botgate__note">Nothing is sent anywhere — passing just leaves a note
             in this browser so you aren't asked again.</p>
        </div>`;

      document.body.appendChild(node);
      document.documentElement.classList.add("is-locked", "is-gated");
    } catch (err) {
      console.warn("[lucrit] bot check could not render, letting you in:", err);
      return finish("error");
    }

    const pass = () => {
      remember();
      node.classList.add("is-going");
      document.documentElement.classList.remove("is-locked", "is-gated");
      setTimeout(() => node.remove(), 420);
      finish("passed");
    };

    // The widget owns its own interaction — click to verify, escalating to a
    // drag slider if it is unconvinced. We only watch for the verdict.
    const box = node.querySelector("[data-hcheck]");
    if (!box) return finish("error");

    const observer = new MutationObserver(() => {
      if (box.dataset.state === "ok") { observer.disconnect(); pass(); }
    });
    observer.observe(box, { attributes: true, attributeFilter: ["data-state"] });

    // Belt and braces: some paths set the state without an attribute mutation
    // this observer sees, so re-check on interaction too.
    node.addEventListener("click", () => {
      setTimeout(() => { if (captchaPassed(node)) pass(); }, 700);
    });
    node.addEventListener("pointerup", () => {
      setTimeout(() => { if (box.dataset.state === "ok") pass(); }, 120);
    });

    setTimeout(() => node.querySelector(".hcheck__box")?.focus(), 120);
  });
}
