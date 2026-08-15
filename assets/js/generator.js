// "Create a script with AI".
//
// A conversation, not a vending machine. The first message writes a script;
// every message after that CHANGES that script rather than starting a new one,
// so "now add a stamina bar" does what you'd expect. The thread and the code
// live side by side — the thread is what you said, the editor is what you have.
//
// Everything it writes is a LocalScript. That rule lives in three places: this
// file's request wrapper, the Worker's system prompt, and a client-side check
// that warns when a reply slips through with a server-only API in it.
//
// The model is reached through a Cloudflare Worker, so there is no API key in
// the browser. With no Worker deployed the panel says so plainly rather than
// spinning forever.

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

/** Services a LocalScript cannot touch. Used to warn, never to block. */
const SERVER_ONLY = /\b(DataStoreService|ServerStorage|ServerScriptService|MessagingService)\b|:SetAsync\(|:GetAsync\(/;

/** The rules appended to every message, first or follow-up. */
const RULES = `Rules:
- It must be a LocalScript — client-side, always, even if the job would
  normally sit on the server. Do not write a server Script.
- Start with a short comment saying where it goes: StarterPlayerScripts,
  StarterCharacterScripts, or StarterGui.
- NEVER call a service the client cannot reach: no DataStoreService, no
  ServerStorage, no ServerScriptService, no MessagingService, no
  :SetAsync/:GetAsync, no Player:Kick from the client. Those throw at runtime
  from a LocalScript, so the script would not work.
- If one step genuinely needs the server, fire a RemoteEvent for that step and
  add a single comment naming the remote. Keep the rest client-side.
- Return the script in a single \`\`\`lua code block, nothing after it.
- It must run as-is. No placeholders, no "TODO", no pseudo-code.`;

/** The opening message: build something from nothing. */
function buildRequest(description) {
  return `Write one complete, working Roblox LocalScript for this request:

"${description}"

${RULES}`;
}

/**
 * A follow-up. The current script goes in the message rather than being left
 * to history, because the person may have hand-edited it since — what is in
 * the editor is the truth, not what the model last said.
 */
function buildFollowUp(instruction, code) {
  return `Here is the script as it stands right now:

\`\`\`lua
${code}
\`\`\`

Change it: ${instruction}

Return the COMPLETE updated script, not a diff and not a fragment. Keep
everything I did not ask you to change.

${RULES}`;
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

export function createGenerator({ onPublish, onRequireAuth, onOpenDashboard, onOpenMine }) {
  const overlay = createOverlay({ id: "generator", label: "Create a script with AI", wide: true });

  let code = "";           // the script as it stands
  let turns = [];          // [{ role, text }] — what the thread shows
  let busy = false;
  let draftId = null;      // set once saved, so re-saving updates in place
  let firstAsk = "";       // the opening description, used for the title

  const started = () => turns.length > 0;

  /* ------------------------------------------------------------- rendering */

  function threadMarkup() {
    if (!started()) return "";
    return `
      <ol class="chat" data-chat>
        ${turns.map((t) => t.role === "user"
          ? `<li class="chat__row chat__row--you"><span class="chat__who">You</span>
               <p class="chat__bubble">${esc(t.text)}</p></li>`
          : `<li class="chat__row chat__row--ai"><span class="chat__who">Lucrit AI</span>
               <p class="chat__bubble chat__bubble--ai">${esc(t.text)}</p></li>`
        ).join("")}
        ${busy ? `<li class="chat__row chat__row--ai"><span class="chat__who">Lucrit AI</span>
               <p class="chat__bubble chat__bubble--ai chat__bubble--busy">Writing…</p></li>` : ""}
      </ol>`;
  }

  function render() {
    const signedIn = account.isSignedIn;
    const left = quotaLeft(signedIn);
    const cap = signedIn ? QUOTA.signedIn : QUOTA.signedOut;
    const going = started();

    overlay.body.innerHTML = `
      <header class="sheet__head">
        <span class="sheet__eyebrow">AI</span>
        <h2>${going ? "Your script" : "Create a script with AI"}</h2>
        <p>${going
          ? "Keep talking to it. Every message changes the script below — ask for a key bind, a toggle, a fix, whatever's missing."
          : "Describe what you want in plain English. You'll get a working LocalScript you can keep changing, then save or publish."}</p>
      </header>

      ${threadMarkup()}

      <label class="gen__label" for="gen-prompt">
        ${going ? "What should change?" : "What should the script do?"}
      </label>
      <textarea id="gen-prompt" class="gen__prompt" rows="${going ? 2 : 3}" maxlength="2000"
        placeholder="${going
          ? "add a stamina bar that drains while sprinting"
          : "a sprint toggle on shift with a stamina bar"}"></textarea>

      ${going ? "" : `
        <div class="gen__examples">
          ${EXAMPLES.map((e) => `<button type="button" class="gen__eg" data-eg="${esc(e)}">${esc(e)}</button>`).join("")}
        </div>`}

      <div class="gen__bar">
        <button class="btn btn--primary" type="button" data-act="send" ${busy ? "disabled" : ""}>
          ${busy ? "Working…" : going ? "Send" : "Generate"}
        </button>
        ${going ? `<button class="btn btn--ghost btn--sm" type="button" data-act="reset">Start a new script</button>` : ""}
        <span class="gen__quota" aria-live="polite">
          ${left > 0
            ? `${left} of ${cap} left today${signedIn ? "" : " — sign in for more"}`
            : "You've used today's messages. They reset tomorrow."}
        </span>
      </div>

      <div class="gen__out" data-out ${code || busy ? "" : "hidden"}>
        <div class="gen__outhead">
          <span>Your script</span>
          <span class="gen__hint">Edit anything below — the AI works from what's here</span>
        </div>
        <div class="gen__editor" data-native-scroll>
          <pre class="gen__ghost" aria-hidden="true"><code data-ghost></code></pre>
          <textarea class="gen__code" data-native-scroll spellcheck="false" aria-label="Your script">${esc(code)}</textarea>
        </div>

        ${SERVER_ONLY.test(code) ? `
          <p class="gen__warn" role="status">
            Heads up — this uses something a LocalScript can't reach. Ask it to
            "route that through a RemoteEvent instead" and it'll fix it.
          </p>` : ""}

        <div class="gen__save">
          <button class="btn btn--primary btn--sm" type="button" data-act="draft">
            ${draftId ? "Save changes" : "Save to My Scripts"}
          </button>
          <button class="btn btn--gold btn--sm" type="button" data-act="publish">Publish it</button>
          <span class="gen__note">Publishing is free — always.</span>
        </div>
      </div>`;

    paintGhost();
    const chat = $("[data-chat]", overlay.body);
    if (chat) chat.scrollTop = chat.scrollHeight;
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

  /* -------------------------------------------------------------- sending */

  /**
   * Prior turns, in the shape the model wants. Assistant turns are summarised
   * rather than carrying their full script: the current code is already in the
   * latest message, and repeating every past version would eat the context
   * window for nothing.
   */
  function historyForModel() {
    return turns.slice(-10).map((t) => t.role === "user"
      ? { role: "user", content: t.text }
      : { role: "assistant", content: t.text });
  }

  async function send() {
    const area = $(".gen__prompt", overlay.body);
    const said = String(area?.value || "").trim();

    if (!said) return toast(started() ? "Tell it what to change" : "Describe what the script should do", "warn");
    if (!started() && said.length < 10) return toast("Give me a bit more to work with", "warn");
    if (!quotaLeft(account.isSignedIn)) return toast("That's today's messages used up", "warn");
    if (!ASSISTANT_URL) {
      return toast("The AI isn't connected yet — the backend still needs deploying", "warn");
    }

    const followUp = started() && Boolean(code.trim());
    const history = historyForModel();

    turns.push({ role: "user", text: said });
    if (!firstAsk) firstAsk = said;
    busy = true;
    render();

    let response;
    try {
      response = await fetch(ASSISTANT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: followUp ? buildFollowUp(said, code) : buildRequest(said),
          history,
        }),
        signal: AbortSignal.timeout(120000),
      });
    } catch {
      busy = false;
      turns.push({ role: "ai", text: "Couldn't reach the AI. Try that again." });
      render();
      return;
    }

    if (!response.ok) {
      const { error } = await response.json().catch(() => ({}));
      busy = false;
      turns.push({ role: "ai", text: error || "That one didn't work. Try rewording it." });
      render();
      return;
    }

    spendQuota();

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const before = code;

    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
        // Only replace the editor once a fenced block has actually started,
        // so a chatty preamble does not blank the script someone can see.
        if (raw.includes("```")) setCode(extractCode(raw));
      }
    }

    const next = extractCode(raw).trim();
    busy = false;

    if (next) {
      code = next;
      const lines = code.split("\n").length;
      turns.push({
        role: "ai",
        text: followUp ? `Updated it — ${lines} lines now.` : `Written — ${lines} lines.`,
      });
    } else {
      // A reply with no code block is an answer to a question, not a rewrite.
      code = before;
      turns.push({ role: "ai", text: raw.trim().slice(0, 400) || "It came back empty — try rewording that." });
    }

    render();
  }

  /* --------------------------------------------------------------- saving */

  function requireAccount(what) {
    if (account.isSignedIn) return true;
    toast(`Sign in to ${what}`, "warn");
    overlay.close();
    onRequireAuth?.();
    return false;
  }

  function keep(publish) {
    if (!code.trim()) return toast("Generate a script first", "warn");
    if (!requireAccount(publish ? "publish a script" : "save to My Scripts")) return;

    const draft = saveDraft(account.session.id, {
      id: draftId,
      title: guessTitle(code, firstAsk),
      prompt: firstAsk,
      code,
      turns,
    });
    draftId = draft?.id || draftId;

    if (!publish) {
      toast("Saved to My Scripts");
      render();
      onOpenMine?.();
      return;
    }

    // Publishing needs a game and a category, so hand the draft to the
    // publish form rather than inventing values on the person's behalf.
    overlay.close();
    onPublish?.(draft);
  }

  function reset() {
    code = ""; turns = []; draftId = null; firstAsk = "";
    render();
    setTimeout(() => $(".gen__prompt", overlay.body)?.focus(), 60);
  }

  /* --------------------------------------------------------------- events */

  overlay.node.addEventListener("click", (e) => {
    const eg = e.target.closest("[data-eg]");
    if (eg) {
      const area = $(".gen__prompt", overlay.body);
      if (area) { area.value = eg.dataset.eg; area.focus(); }
      return;
    }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "send") send();
    if (act === "reset") reset();
    if (act === "draft") keep(false);
    if (act === "publish") keep(true);
  });

  overlay.node.addEventListener("input", (e) => {
    if (e.target.classList.contains("gen__code")) setCode(e.target.value);
  });

  // Enter sends, Shift+Enter makes a new line — the shape people expect from
  // a chat box. The code editor is exempt; Enter there is just a newline.
  overlay.node.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("gen__prompt")) return;
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // The highlighted layer has to scroll with the text it sits under.
  overlay.node.addEventListener("scroll", (e) => {
    if (!e.target.classList?.contains("gen__code")) return;
    const ghost = $(".gen__ghost", overlay.body);
    if (ghost) { ghost.scrollTop = e.target.scrollTop; ghost.scrollLeft = e.target.scrollLeft; }
  }, true);

  return {
    open(seed = "") {
      overlay.open();
      render();
      const area = $(".gen__prompt", overlay.body);
      if (seed && area) area.value = seed;
      setTimeout(() => $(".gen__prompt", overlay.body)?.focus(), 60);
    },
    /** Reopens a saved script with its conversation intact. */
    openDraft(draft) {
      code = draft?.code || "";
      turns = Array.isArray(draft?.turns) ? draft.turns.slice() : [];
      firstAsk = draft?.prompt || "";
      draftId = draft?.id || null;
      // An older draft saved before conversations existed still deserves a thread.
      if (!turns.length && firstAsk) {
        turns = [
          { role: "user", text: firstAsk },
          { role: "ai", text: `Written — ${code.split("\n").length} lines.` },
        ];
      }
      overlay.open();
      render();
    },
    close: () => overlay.close(),
    get isOpen() { return overlay.isOpen; },
  };
}

export { CATEGORIES };
