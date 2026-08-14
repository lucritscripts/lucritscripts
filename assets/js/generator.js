// "Create a Script with AI".
//
// Describe what you want, get Luau back, edit it, then save it as a private
// draft or publish it to the library. Generating is free and needs no
// account; saving does, because a draft has to belong to somebody.
//
// The model is reached through the same Cloud Function as the assistant, so
// the API key stays server-side. With no function deployed the panel says so
// plainly rather than spinning forever.

import { createOverlay, esc, toast } from "./pages.js";
import { account } from "./account.js";
import { ASSISTANT_URL } from "./config.js";
import { highlightLuau } from "./engine/highlight.js";
import { CATEGORIES } from "./data/scripts.js";
import { saveDraft, quotaLeft, spendQuota, QUOTA } from "./vault.js";

const $ = (sel, root = document) => root.querySelector(sel);

const EXAMPLES = [
  "A sprint toggle on shift with a stamina bar that drains and refills",
  "An ESP that outlines every player through walls, toggled with a key",
  "A draggable GUI menu with tabs, sliders and a close button",
  "Smooth camera shake when the character lands from a fall",
];

/**
 * The instruction wrapped around the person's description. The assistant's
 * own system prompt already covers house style and scope; this adds only what
 * is specific to producing one finished file.
 */
function buildRequest(description) {
  return `Write one complete, working Roblox LocalScript for this request:

"${description}"

Rules for this answer:
- Return the script in a single \`\`\`lua code block, nothing after it.
- It must be a LocalScript — client-side, always, even if the job would
  normally sit on the server. Do not write a server Script.
- Start with a short comment saying where it goes: StarterPlayerScripts,
  StarterCharacterScripts, or StarterGui.
- If one step genuinely needs the server, fire a RemoteEvent for that step and
  add a single comment naming the remote. Keep the rest client-side.
- It must run as-is. No placeholders, no "TODO", no pseudo-code.`;
}

/** Pulls the code out of a fenced block, or falls back to the whole reply. */
function extractCode(text) {
  const fenced = /```[a-zA-Z]*\n([\s\S]*?)(?:```|$)/.exec(text);
  return (fenced ? fenced[1] : text).replace(/\s+$/, "");
}

/** First line of a script, turned into something that reads like a title. */
function guessTitle(code, description) {
  const comment = /^\s*--\[?\[?\s*(.+)$/m.exec(code || "");
  const from = comment ? comment[1] : description;
  return String(from || "Untitled script")
    .replace(/^\W+/, "")
    .split(/[.\n]/)[0]
    .slice(0, 60) || "Untitled script";
}

export function createGenerator({ onPublish, onRequireAuth, onOpenDashboard }) {
  const overlay = createOverlay({ id: "generator", label: "Create a script with AI", wide: true });

  let code = "";
  let busy = false;
  let lastDescription = "";

  function render() {
    const signedIn = account.isSignedIn;
    const left = quotaLeft(signedIn);
    const cap = signedIn ? QUOTA.signedIn : QUOTA.signedOut;

    overlay.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">AI</span>
        <h2>Create a script with AI</h2>
        <p>Describe what you want in plain English. You'll get working Luau you can edit,
           then keep as a private draft or publish for everyone.</p>
      </header>

      <label class="gen__label" for="gen-prompt">What should the script do?</label>
      <textarea id="gen-prompt" class="gen__prompt" rows="3" maxlength="2000"
        placeholder="A script that saves each player's coins and loads them again when they rejoin"
      >${esc(lastDescription)}</textarea>

      <div class="gen__examples">
        ${EXAMPLES.map((e) => `<button type="button" class="gen__eg" data-eg="${esc(e)}">${esc(e)}</button>`).join("")}
      </div>

      <div class="gen__bar">
        <button class="btn btn--primary" type="button" data-act="generate" ${busy ? "disabled" : ""}>
          ${busy ? "Generating…" : "Generate"}
        </button>
        <span class="gen__quota" aria-live="polite">
          ${left > 0
            ? `${left} of ${cap} generations left today${signedIn ? "" : " — sign in for more"}`
            : "You've used today's generations. They reset tomorrow."}
        </span>
      </div>

      <div class="gen__out" data-out ${code || busy ? "" : "hidden"}>
        <div class="gen__outhead">
          <span>Your script</span>
          <span class="gen__hint">Edit anything below before saving</span>
        </div>
        <div class="gen__editor" data-native-scroll>
          <pre class="gen__ghost" aria-hidden="true"><code data-ghost></code></pre>
          <textarea class="gen__code" data-native-scroll spellcheck="false" aria-label="Generated script">${esc(code)}</textarea>
        </div>

        <div class="gen__save">
          <button class="btn btn--primary btn--sm" type="button" data-act="draft">Save as draft</button>
          <button class="btn btn--gold btn--sm" type="button" data-act="publish">Save &amp; publish</button>
          <span class="gen__note">Publishing is free — always.</span>
        </div>
      </div>`;

    paintGhost();
  }

  /** The highlighted layer sitting under the transparent textarea. */
  function paintGhost() {
    const ghost = $("[data-ghost]", overlay.body);
    if (ghost) ghost.innerHTML = highlightLuau(code || "").join("\n") + "\n";
  }

  function setCode(next) {
    code = next;
    const area = $(".gen__code", overlay.body);
    if (area && area.value !== next) area.value = next;
    paintGhost();
  }

  async function generate() {
    const area = $(".gen__prompt", overlay.body);
    const description = String(area?.value || "").trim();

    if (!description) return toast("Describe what the script should do", "warn");
    if (description.length < 10) return toast("Give me a bit more to work with", "warn");
    if (!quotaLeft(account.isSignedIn)) {
      return toast("That's today's generations used up", "warn");
    }
    if (!ASSISTANT_URL) {
      return toast("The AI isn't connected yet — the backend still needs deploying", "warn");
    }

    lastDescription = description;
    busy = true;
    code = "";
    render();

    let response;
    try {
      response = await fetch(ASSISTANT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: buildRequest(description) }),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      busy = false; render();
      return toast("Couldn't reach the AI. Try again in a moment.", "warn");
    }

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      busy = false; render();
      return toast(error || "The AI had a problem with that one", "warn");
    }

    spendQuota();

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let raw = "";

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        setCode(extractCode(raw));
      }
    }

    busy = false;
    render();
    setCode(extractCode(raw));

    if (!code.trim()) toast("The AI came back empty — try rewording it", "warn");
  }

  function requireAccount(what) {
    if (account.isSignedIn) return true;
    toast(`Sign in to ${what}`, "warn");
    overlay.close();
    onRequireAuth?.();
    return false;
  }

  function keep(publish) {
    if (!code.trim()) return toast("Generate or paste a script first", "warn");
    if (!requireAccount(publish ? "publish a script" : "save a draft")) return;

    const draft = saveDraft(account.session.id, {
      title: guessTitle(code, lastDescription),
      prompt: lastDescription,
      code,
    });

    if (!publish) {
      toast("Saved to your drafts");
      overlay.close();
      onOpenDashboard?.("drafts");
      return;
    }

    // Publishing needs a game and a category, so hand the draft to the
    // publish form rather than inventing values on the person's behalf.
    overlay.close();
    onPublish?.(draft);
  }

  overlay.node.addEventListener("click", (e) => {
    const eg = e.target.closest("[data-eg]");
    if (eg) {
      const area = $(".gen__prompt", overlay.body);
      if (area) { area.value = eg.dataset.eg; area.focus(); }
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "generate") generate();
    if (act === "draft") keep(false);
    if (act === "publish") keep(true);
  });

  overlay.node.addEventListener("input", (e) => {
    if (e.target.classList.contains("gen__code")) setCode(e.target.value);
  });

  // The highlighted layer has to scroll with the text it sits under.
  overlay.node.addEventListener("scroll", (e) => {
    if (!e.target.classList?.contains("gen__code")) return;
    const ghost = $(".gen__ghost", overlay.body);
    if (ghost) { ghost.scrollTop = e.target.scrollTop; ghost.scrollLeft = e.target.scrollLeft; }
  }, true);

  return {
    open(seed = "") {
      if (seed) lastDescription = seed;
      overlay.open();
      render();
      setTimeout(() => $(".gen__prompt", overlay.body)?.focus(), 60);
    },
    openDraft(draft) {
      lastDescription = draft?.prompt || "";
      code = draft?.code || "";
      overlay.open();
      render();
    },
    close: () => overlay.close(),
    get isOpen() { return overlay.isOpen; },
  };
}

export { CATEGORIES };
