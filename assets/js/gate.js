// First-visit bot check.
//
// A full-screen gate shown once per device. Passing it writes a note to
// storage, so a returning visitor never sees it again until that note
// expires — this is a doorman, not a turnstile you queue at every time.
//
// Where the verdict comes from depends on what is configured:
//
//   Turnstile available  → Cloudflare issues a token, the server verifies it
//                          against the secret, and only then does the gate
//                          open. This is a real boundary.
//   Turnstile absent     → the hand-rolled widget, which is friction only.
//                          Anyone with devtools walks past it. It exists so
//                          the door still asks *something* on static hosting.
//
// It FAILS OPEN by design. If storage is blocked, the widget is missing, the
// network is down, or anything at all throws, the site opens. A bot check that
// can lock real people out of the whole site is worse than the bots it stops.

import { account } from "./account.js";
import { captchaMarkup, captchaPassed, mountTurnstile, turnstileToken } from "./pages.js";

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
 * Asks the server to verify a Turnstile token.
 *
 * Returns true if the server is happy, and also true if we could not reach it
 * — an outage must not become a locked front door.
 */
async function serverAccepts(token) {
  try {
    const res = await fetch("/api/human", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turnstile: token }),
    });
    if (res.status === 404) return true;      // no API behind this host
    const data = await res.json().catch(() => null);
    return data ? data.ok === true : true;
  } catch {
    return true;
  }
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

    // Whether Turnstile is configured is only known once the account layer has
    // read /api/config, so the gate waits for that before drawing. It is a few
    // hundred milliseconds against a logo splash, and it avoids drawing the
    // fallback widget and then swapping it underneath the visitor.
    const decide = account.ready || Promise.resolve();
    let settled = false;
    const timeout = setTimeout(() => { if (!settled) draw(false); }, 2500);

    decide.then(() => {
      if (settled) return;
      clearTimeout(timeout);
      draw(Boolean(account.turnstileKey));
    }).catch(() => {
      if (settled) return;
      clearTimeout(timeout);
      draw(false);
    });

    function draw(useTurnstile) {
      settled = true;

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
            ${useTurnstile
              ? `<div class="turnstile botgate__turnstile" data-turnstile></div>`
              : captchaMarkup("botgate-check")}
            <p class="botgate__note">${useTurnstile
              ? "Verified by Cloudflare. Passing leaves a note in this browser so you aren't asked again."
              : "Nothing is sent anywhere — passing just leaves a note in this browser so you aren't asked again."}</p>
          </div>`;

        document.body.appendChild(node);
        document.documentElement.classList.add("is-locked", "is-gated");
      } catch (err) {
        console.warn("[lucrit] bot check could not render, letting you in:", err);
        return finish("error");
      }

      const pass = (how) => {
        remember();
        node.classList.add("is-going");
        document.documentElement.classList.remove("is-locked", "is-gated");
        setTimeout(() => node.remove(), 420);
        finish(how);
      };

      if (useTurnstile) return runTurnstile(node, pass, finish);
      return runFallback(node, pass, finish);
    }

    /** Cloudflare issues the token; our server decides whether it counts. */
    function runTurnstile(node, pass, bail) {
      const host = node.querySelector("[data-turnstile]");
      let handled = false;

      // If Turnstile never answers — offline, a slow challenge, an ad blocker
      // eating challenges.cloudflare.com — open the door rather than stranding
      // someone at a spinner they cannot do anything about.
      const giveUp = setTimeout(() => {
        if (!handled) { handled = true; pass("timeout"); }
      }, 12000);

      const settle = async () => {
        if (handled) return;
        const token = turnstileToken(node) || host?.dataset.token || "";
        if (!token) return;
        handled = true;
        clearTimeout(giveUp);
        const accepted = await serverAccepts(token);
        if (accepted) return pass("passed");

        // Rejected. Say so plainly and let them try again rather than
        // silently sitting there.
        handled = false;
        const note = node.querySelector(".botgate__note");
        if (note) note.textContent = "That didn't go through. Give it another try.";
        try { window.turnstile?.reset?.(); } catch { /* nothing useful to do */ }
      };

      // mountTurnstile writes the token onto the host's dataset; watch for it.
      const observer = new MutationObserver(settle);
      if (host) observer.observe(host, { attributes: true, attributeFilter: ["data-token"] });

      // If the widget could not be put up at all there is nothing to wait for,
      // so open immediately instead of making them sit out the timeout.
      const opened = (why) => {
        if (handled) return;
        handled = true;
        clearTimeout(giveUp);
        pass(why);
      };
      mountTurnstile(node)
        .then((up) => { if (!up) opened("unavailable"); })
        .catch(() => opened("error"));

      // Managed mode often resolves with no interaction at all, and a dataset
      // write can land before the observer attaches — poll briefly as well.
      const poll = setInterval(() => {
        if (handled) { clearInterval(poll); return; }
        if (turnstileToken(node)) settle();
      }, 400);
      setTimeout(() => clearInterval(poll), 13000);

      void bail;
    }

    /** The old widget: friction only, kept for hosts with no API behind them. */
    function runFallback(node, pass, bail) {
      const box = node.querySelector("[data-hcheck]");
      if (!box) return bail("error");

      const observer = new MutationObserver(() => {
        if (box.dataset.state === "ok") { observer.disconnect(); pass("passed"); }
      });
      observer.observe(box, { attributes: true, attributeFilter: ["data-state"] });

      // Belt and braces: some paths set the state without an attribute mutation
      // this observer sees, so re-check on interaction too.
      node.addEventListener("click", () => {
        setTimeout(() => { if (captchaPassed(node)) pass("passed"); }, 700);
      });
      node.addEventListener("pointerup", () => {
        setTimeout(() => { if (box.dataset.state === "ok") pass("passed"); }, 120);
      });

      setTimeout(() => node.querySelector(".hcheck__box")?.focus(), 120);
    }
  });
}
