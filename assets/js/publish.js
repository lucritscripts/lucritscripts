// The publishing pipeline.
//
// Create → fill in → thumbnail → AI-assisted description → detect Lua →
// validate → publish → appear on the game and category page.
//
// This replaces a form that asked for six things loosely and reported problems
// one toast at a time, so a submission with three gaps took three round trips
// to discover. Everything here is about making the state of the form legible
// before the submit button is pressed rather than after.
//
// Two rules that are not style preferences and should survive any rewrite:
//
// 1. **Nothing in this file decides whether a script is verified.** There is no
//    `verified` field in the payload, no checkbox, no derived flag. The server
//    binds a literal 0 on insert and only an admin route can change it. A
//    publisher who edits this file, or posts to the API by hand, gets the same
//    answer.
//
// 2. **"Lua Detected" and "Verified" are different claims and never share a
//    badge.** Detection is a syntax guess made from text the publisher typed;
//    verification is a person saying they looked. Merging them would have the
//    site vouching for code nobody read, which is the most harmful thing this
//    page could do.

import { esc, toast, captchaMarkup, captchaPassed, captchaReset,
         mountTurnstile, turnstileToken } from "./pages.js";
import { CATEGORIES } from "./data/scripts.js";
import { account } from "./account.js";
import { createGamePicker } from "./gamepicker.js";
import { robloxThumb, addScript } from "./ui.js";
import { libraryOnline, publishScript, describeScript } from "./library-api.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export const MIN_WORDS = 100;
const MAX_THUMB_BYTES = 3 * 1024 * 1024;
const MIN_THUMB_PX = 160;
const THUMB_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Hosts a script link may point at. Mirrors LINK_HOSTS in `_worker.js`.
 *
 * Duplicated rather than fetched, and that is a deliberate trade: the browser
 * copy exists only to give a useful message before a round trip. The server's
 * copy is the one that decides. If they drift, the form is optimistic and the
 * server still refuses — which is the safe direction for them to drift in.
 */
const LINK_HOSTS = [
  "pastebin.com", "github.com", "githubusercontent.com", "gist.github.com",
  "gitlab.com", "rentry.co", "rentry.org", "paste.ee", "hastebin.com",
  "sourceb.in", "pastefy.app", "controlc.com", "codeshare.io",
];

export const wordCount = (s) => String(s || "").trim().split(/\s+/).filter(Boolean).length;

function linkOk(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw); }
  catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return LINK_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/* ═══════════════════════════════════════════════ Lua/Luau detection ══ */

/**
 * Does this look like Luau?
 *
 * A syntax guess, and the naming is careful for the same reason the server's
 * `looksLikeCode` is: passing means the text has Lua shapes in it. It does NOT
 * mean the script is safe, working, or reviewed, and the badge it drives says
 * "Lua Detected" precisely so it cannot be read as any of those.
 *
 * Deliberately generous on true positives and quiet about it: a false negative
 * costs a publisher a badge, while a false positive costs a visitor nothing,
 * because the badge never claimed anything about quality in the first place.
 */
export function detectLua(code) {
  const text = String(code || "");
  if (text.trim().length < 12) return { lua: false, hits: 0 };

  const signals = [
    /\blocal\s+[A-Za-z_]/,                       // local x
    /\bfunction\b[\s\S]{0,80}\bend\b/,           // function … end
    /\bgame:GetService\s*\(/i,                   // Roblox service
    /\b(workspace|Players|ReplicatedStorage|LocalPlayer|Instance)\b/,
    /\b(then|elseif)\b[\s\S]{0,120}\bend\b/,     // if … then … end
    /\bfor\b[\s\S]{0,60}\b(do)\b/,               // for … do
    /\bwhile\b[\s\S]{0,60}\bdo\b/,
    /--\[\[|^\s*--(?!\[)/m,                      // Lua comments
    /\b(pairs|ipairs|tostring|tonumber|pcall|task\.wait|wait)\s*\(/,
    /\b(loadstring|require)\s*\(/,
    /:\s*Connect\s*\(|\.\s*(Touched|Changed|Heartbeat)\b/,
    /\bend\s*\)?\s*$/m,
  ];
  const hits = signals.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0);
  return { lua: hits >= 3, hits };
}

/* ═════════════════════════════════════════ description gap analysis ══ */

/**
 * What a description is missing, judged only on what is or is not mentioned.
 *
 * These are prompts to the publisher, never edits. Nothing here rewrites
 * anything and nothing here blocks publishing — a description can be perfectly
 * good and still not mention compatibility.
 */
export function describeGaps(text, { keyless } = {}) {
  const t = String(text || "").toLowerCase();
  const has = (...words) => words.some((w) => t.includes(w));
  const gaps = [];

  if (wordCount(t) < MIN_WORDS)
    gaps.push({ id: "length", text: `${MIN_WORDS - wordCount(t)} more words needed.` });

  if (!has("feature", "does", "lets you", "adds", "auto", "toggle", "menu", "gui"))
    gaps.push({ id: "features", text: "Say what it actually does — the main features." });

  if (!has("update", "version", "patch", "works on", "tested"))
    gaps.push({ id: "version", text: "Mention which game version or update it's for." });

  if (!has("executor", "exploit", "inject", "run it", "how to use", "execute", "paste"))
    gaps.push({ id: "setup", text: "Add how to run it — executor, injection, paste steps." });

  if (!has("require", "need", "must have", "premium"))
    gaps.push({ id: "requires", text: "List anything it requires to work." });

  // Only asked when the publisher has said a key IS needed. Nagging a keyless
  // script about key steps is how a helpful hint becomes noise people learn to
  // scroll past.
  if (keyless === false && !has("key", "getkey", "keysystem"))
    gaps.push({ id: "key", text: "This needs a key — say where people get one." });

  if (!has("mobile", "pc", "android", "ios", "windows", "compatib", "device"))
    gaps.push({ id: "compat", text: "Say which devices or platforms it works on." });

  return gaps;
}

/* ══════════════════════════════════════════════════════ the form ══ */

const FIELDS = ["title", "game", "category", "thumbnail", "keyless", "link", "desc", "tags"];

export function createPublishForm({ onAuth, onPublished }) {
  const node = document.createElement("div");
  node.className = "publish";

  let picker = null;
  let thumb = { value: "", auto: "", name: "" };
  let aiBusy = false;
  let aiOffer = null;        // { improved, original } awaiting a decision
  let descTimer = 0;

  /* ------------------------------------------------------------ paint */

  function signedOut() {
    node.innerHTML = `
      <header class="panel__head">
        <h2>Publish a script</h2>
        <p>Share your work and earn every time someone unlocks it.</p>
      </header>
      <div class="empty empty--lg">
        <strong>You need an account to publish.</strong>
        <span>It takes about twenty seconds — username, email, password.</span>
        <button class="btn btn--primary btn--sm" data-act="auth">Create an account</button>
      </div>`;
  }

  function render() {
    if (!account.isSignedIn) return signedOut();

    node.innerHTML = `
      <header class="panel__head">
        <h2>Publish a script</h2>
        <p>Publishing as <b>@${esc(account.session.username)}</b>.</p>
      </header>

      <form class="form publish__form pubform" novalidate>
        <div class="pubform__grid">

          <label class="field" data-for="title">
            <span class="field__label">Script name <b class="req">*</b></span>
            <input name="title" maxlength="70" placeholder="Inventory System" autocomplete="off">
            <span class="field__err" data-err="title"></span>
          </label>

          <label class="field" data-for="game">
            <span class="field__label">Roblox game <b class="req">*</b></span>
            <span data-gamepick></span>
            <span class="field__err" data-err="game"></span>
          </label>

          <label class="field" data-for="category">
            <span class="field__label">Category <b class="req">*</b></span>
            <select name="category">
              <option value="">Choose a category…</option>
              ${CATEGORIES.map((c) => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}
            </select>
            <span class="field__err" data-err="category"></span>
          </label>

          <label class="field" data-for="place">
            <span class="field__label">Game link or place ID <span class="opt">optional</span></span>
            <input name="place" placeholder="roblox.com/games/123456789" autocomplete="off">
            <span class="field__hint">Used to fetch the game's thumbnail automatically.</span>
          </label>

          <div class="field field--wide" data-for="thumbnail">
            <span class="field__label">Thumbnail <b class="req">*</b></span>
            <div class="thumbdrop" data-thumbdrop>
              <div class="thumbdrop__preview" data-thumbpreview>
                <span class="thumbdrop__empty">No image yet</span>
              </div>
              <div class="thumbdrop__side">
                <p class="thumbdrop__lead">Drop an image here, or choose a file.</p>
                <p class="thumbdrop__spec">PNG, JPEG or WebP · under 3 MB · at least ${MIN_THUMB_PX}×${MIN_THUMB_PX}</p>
                <div class="thumbdrop__acts">
                  <label class="btn btn--ghost btn--sm">
                    Choose image
                    <input type="file" name="thumbnail" accept="image/png,image/jpeg,image/webp" hidden>
                  </label>
                  <button class="btn btn--ghost btn--sm" type="button" data-act="thumbclear" hidden>Remove</button>
                </div>
                <p class="thumbdrop__state" data-thumbstate></p>
              </div>
            </div>
            <span class="field__err" data-err="thumbnail"></span>
          </div>

          <div class="field" data-for="keyless">
            <span class="field__label">Does it need a key? <b class="req">*</b></span>
            <div class="choicerow">
              <label class="choice">
                <input type="radio" name="keyless" value="yes">
                <span class="choice__body"><b>Keyless</b><small>Runs straight away</small></span>
              </label>
              <label class="choice">
                <input type="radio" name="keyless" value="no">
                <span class="choice__body"><b>Key required</b><small>Needs a key first</small></span>
              </label>
            </div>
            <span class="field__err" data-err="keyless"></span>
          </div>

          <label class="field" data-for="link">
            <span class="field__label">Script link <b class="req">*</b></span>
            <input name="link" placeholder="https://pastebin.com/raw/…" autocomplete="off" inputmode="url">
            <span class="field__hint">
              Where people get the script. Hidden until someone completes the sponsor
              step — the same gate the code sits behind, so it still earns.
            </span>
            <span class="field__err" data-err="link"></span>
          </label>

          <div class="field field--wide" data-for="desc">
            <span class="field__label">Description <b class="req">*</b></span>
            <textarea name="desc" rows="6"
              placeholder="What it does, how to run it, what it needs. At least ${MIN_WORDS} words."></textarea>
            <div class="descbar">
              <span class="counter" data-counter>0 / ${MIN_WORDS} words</span>
              <button class="btn btn--ai btn--xs" type="button" data-act="enhance">
                <span aria-hidden="true">✦</span> Enhance with AI
              </button>
            </div>
            <div class="aihints" data-hints hidden></div>
            <div class="aioffer" data-offer hidden></div>
            <span class="field__err" data-err="desc"></span>
          </div>

          <div class="field field--wide" data-for="code">
            <span class="field__label">Luau code <span class="opt">optional</span></span>
            <textarea name="code" rows="8" spellcheck="false"
              placeholder="--!strict&#10;local Module = {}&#10;return Module"></textarea>
            <div class="luabar" data-luabar>
              <span class="chip chip--soft" data-luachip>No code pasted</span>
              <span class="field__hint" data-luanote>
                Optional. Pasting the code adds a “Lua Detected” badge — that only means
                the text looks like Luau, not that anyone has checked it.
              </span>
            </div>
          </div>

          <label class="field" data-for="tags">
            <span class="field__label">Tags <b class="req">*</b> <span class="opt">comma separated</span></span>
            <input name="tags" maxlength="80" placeholder="autofarm, teleport, gui" autocomplete="off">
            <span class="chips" data-tagchips></span>
            <span class="field__err" data-err="tags"></span>
          </label>

          <div class="field field--wide">
            <div class="pubstatus">
              <span class="pubstatus__k">Verification</span>
              <span class="chip chip--soft">Not verified yet</span>
              <span class="field__hint">
                Verification is done by the site after a review. It can't be set from
                this form, and pasting Lua doesn't grant it.
              </span>
            </div>
          </div>

          <div class="field field--wide">${account.turnstileKey
            ? `<div class="turnstile" data-turnstile></div>`
            : captchaMarkup("publish-captcha")}</div>

          <div class="field field--wide publish__actions">
            <button class="btn btn--primary" type="submit">Publish script</button>
            <span class="note">By publishing you confirm this is yours to share.</span>
            <p class="formerror" data-formerror role="alert" hidden></p>
          </div>
        </div>
      </form>`;
  }

  function mountPicker() {
    const slot = $("[data-gamepick]", node);
    if (!slot) { picker = null; return; }
    picker = createGamePicker({ name: "game", placeholder: "Search Roblox games, or type your own" });
    slot.replaceWith(picker.node);
    mountTurnstile(node);
  }

  /* -------------------------------------------------------- validation */

  const values = () => {
    const form = $("form", node);
    if (!form) return {};
    const d = Object.fromEntries(new FormData(form));
    return {
      title: String(d.title || "").trim(),
      game: String(d.game || "").trim(),
      category: String(d.category || ""),
      place: String(d.place || "").trim(),
      keyless: d.keyless === "yes" ? true : d.keyless === "no" ? false : null,
      link: String(d.link || "").trim(),
      desc: String(d.desc || "").trim(),
      code: String(d.code || ""),
      tags: String(d.tags || "").split(",").map((t) => t.trim()).filter(Boolean).slice(0, 6),
      thumbnail: thumb.value || thumb.auto || robloxThumb(String(d.place || "")) || "",
    };
  };

  /** One message per field, or nothing. The single source of truth for "can this publish". */
  function problems(v) {
    const p = {};
    if (!v.title) p.title = "Give the script a name.";
    if (!v.game) p.game = "Pick or type the Roblox game.";
    if (!v.category) p.category = "Choose a category.";
    if (!v.thumbnail) p.thumbnail = "A thumbnail is required.";
    if (v.keyless === null) p.keyless = "Say whether it needs a key.";
    if (!v.link) p.link = "Add the link where people get the script.";
    else if (!linkOk(v.link)) p.link = "That host isn't accepted. Use Pastebin, GitHub, Gist, Rentry or similar — no shorteners.";
    const words = wordCount(v.desc);
    if (!v.desc) p.desc = "Write a description.";
    else if (words < MIN_WORDS) p.desc = `${MIN_WORDS - words} more word${MIN_WORDS - words === 1 ? "" : "s"} needed.`;
    if (!v.tags.length) p.tags = "Add at least one tag.";
    return p;
  }

  /**
   * Paint errors.
   *
   * `only` limits it to fields the person has already touched, so the form does
   * not greet somebody with eight red messages before they have typed a
   * character. On submit it is called with everything.
   */
  function showProblems(p, only = null) {
    for (const f of FIELDS) {
      const slot = $(`[data-err="${f}"]`, node);
      const wrap = $(`[data-for="${f}"]`, node);
      if (!slot || !wrap) continue;
      const msg = (only && !only.has(f)) ? "" : (p[f] || "");
      slot.textContent = msg;
      wrap.classList.toggle("is-bad", Boolean(msg));
    }
  }

  const touched = new Set();

  function repaintLive() {
    const v = values();
    showProblems(problems(v), touched);
    paintCounter(v);
    paintTags(v);
    paintLua(v);
    paintHints(v);
  }

  function paintCounter(v) {
    const n = wordCount(v.desc);
    const c = $("[data-counter]", node);
    if (!c) return;
    c.textContent = `${n} / ${MIN_WORDS} words`;
    c.classList.toggle("is-ok", n >= MIN_WORDS);
  }

  function paintTags(v) {
    const box = $("[data-tagchips]", node);
    if (!box) return;
    box.innerHTML = v.tags.map((t) => `<span class="chip chip--soft">${esc(t)}</span>`).join("");
  }

  function paintLua(v) {
    const chip = $("[data-luachip]", node);
    const note = $("[data-luanote]", node);
    if (!chip) return;
    const has = Boolean(v.code.trim());
    const { lua, hits } = detectLua(v.code);

    chip.className = "chip " + (lua ? "chip--ok" : has ? "chip--warn" : "chip--soft");
    chip.textContent = !has ? "No code pasted"
      : lua ? "Lua Detected"
      : "Doesn't look like Lua yet";

    // The wording here is the whole point of the feature. "Lua Detected" has to
    // read as a statement about syntax, never as approval.
    if (note) {
      note.textContent = !has
        ? "Optional. Pasting the code adds a “Lua Detected” badge — that only means the text looks like Luau, not that anyone has checked it."
        : lua
          ? `Luau syntax found (${hits} signals). This says the text looks like code — it is not a safety check and not verification.`
          : "No Luau syntax found yet. You can still publish; the badge just won't appear.";
    }
  }

  function paintHints(v) {
    const box = $("[data-hints]", node);
    if (!box) return;
    // Silent until there is something to react to. Hints on an empty box are
    // a lecture, not help — but the threshold is low, because a short first
    // sentence is exactly when "you haven't said how to run it" is most
    // useful, and waiting for a paragraph means the advice arrives after the
    // paragraph is written.
    if (wordCount(v.desc) < 6) { box.hidden = true; box.innerHTML = ""; return; }

    const gaps = describeGaps(v.desc, { keyless: v.keyless });
    if (!gaps.length) {
      box.hidden = false;
      box.innerHTML = `<p class="aihints__ok">✓ That covers the usual questions.</p>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = `
      <p class="aihints__head">Worth adding</p>
      <ul class="aihints__list">
        ${gaps.map((g) => `<li>${esc(g.text)}</li>`).join("")}
      </ul>`;
  }

  /* ----------------------------------------------------------- the AI */

  function paintOffer() {
    const box = $("[data-offer]", node);
    if (!box) return;
    if (!aiOffer) { box.hidden = true; box.innerHTML = ""; return; }

    box.hidden = false;
    box.innerHTML = `
      <div class="aioffer__head">
        <b>Suggested rewrite</b>
        <span class="field__hint">Your words are kept until you accept this.</span>
      </div>
      <div class="aioffer__cols">
        <div class="aioffer__col">
          <span class="aioffer__k">Yours</span>
          <p>${esc(aiOffer.original)}</p>
        </div>
        <div class="aioffer__col aioffer__col--new">
          <span class="aioffer__k">Suggested</span>
          <p>${esc(aiOffer.improved)}</p>
        </div>
      </div>
      <div class="aioffer__acts">
        <button class="btn btn--primary btn--sm" type="button" data-act="accept">Use this</button>
        <button class="btn btn--ghost btn--sm" type="button" data-act="reject">Keep mine</button>
      </div>`;
  }

  async function enhance() {
    if (aiBusy) return;
    const v = values();
    if (wordCount(v.desc) < 8) return toast("Write a little more first", "warn");

    aiBusy = true;
    const btn = $('[data-act="enhance"]', node);
    const label = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.textContent = "Thinking…"; }

    try {
      const out = await describeScript({ desc: v.desc, title: v.title, game: v.game });
      // The endpoint answers with the author's own text when the model returns
      // something unusable. Offering that back as a "rewrite" would be a lie
      // dressed as a feature, so it is reported as no change instead.
      if (!out || !out.description || out.description.trim() === v.desc.trim()) {
        toast("The description already reads well — nothing to change", "ok");
      } else {
        aiOffer = { improved: out.description.trim(), original: v.desc };
        paintOffer();
      }
    } catch {
      toast("Couldn't reach the description helper", "warn");
    } finally {
      aiBusy = false;
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
    }
  }

  /* ------------------------------------------------------- thumbnails */

  function paintThumb() {
    const prev = $("[data-thumbpreview]", node);
    const state = $("[data-thumbstate]", node);
    const clear = $('[data-act="thumbclear"]', node);
    if (!prev) return;

    const src = thumb.value || thumb.auto;
    prev.innerHTML = src
      ? `<img src="${esc(src)}" alt="Thumbnail preview">`
      : `<span class="thumbdrop__empty">No image yet</span>`;
    prev.classList.toggle("is-set", Boolean(src));

    if (clear) clear.hidden = !thumb.value;
    if (state) {
      state.textContent = thumb.value
        ? `Using your upload${thumb.name ? ` — ${thumb.name}` : ""}.`
        : thumb.auto
          ? "Using the game's Roblox thumbnail. Upload one to override it."
          : "";
      state.classList.toggle("is-ok", Boolean(thumb.value || thumb.auto));
    }
  }

  /** Reads a chosen file, or explains exactly why it was not accepted. */
  function takeFile(file) {
    if (!file) return;
    if (!THUMB_TYPES.includes(file.type))
      return failThumb("That file type isn't supported. Use PNG, JPEG or WebP.");
    if (file.size > MAX_THUMB_BYTES)
      return failThumb(`That image is ${(file.size / 1048576).toFixed(1)} MB. The limit is 3 MB.`);

    const reader = new FileReader();
    reader.onerror = () => failThumb("That file couldn't be read.");
    reader.onload = () => {
      // Dimensions can only be known once it decodes, so the size check
      // happens here rather than up front.
      const img = new Image();
      img.onerror = () => failThumb("That doesn't look like an image.");
      img.onload = () => {
        if (img.naturalWidth < MIN_THUMB_PX || img.naturalHeight < MIN_THUMB_PX)
          return failThumb(`That image is ${img.naturalWidth}×${img.naturalHeight}. `
            + `It needs to be at least ${MIN_THUMB_PX}×${MIN_THUMB_PX}.`);
        thumb = { value: String(reader.result), auto: thumb.auto, name: file.name };
        touched.add("thumbnail");
        paintThumb();
        repaintLive();
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function failThumb(message) {
    const slot = $('[data-err="thumbnail"]', node);
    const wrap = $('[data-for="thumbnail"]', node);
    if (slot) slot.textContent = message;
    if (wrap) wrap.classList.add("is-bad");
    touched.add("thumbnail");
    const input = $('input[name="thumbnail"]', node);
    if (input) input.value = "";
  }

  /* -------------------------------------------------------- listeners */

  node.addEventListener("click", async (e) => {
    if (e.target.closest('[data-act="auth"]')) return onAuth?.();
    if (e.target.closest('[data-act="enhance"]')) return enhance();

    if (e.target.closest('[data-act="accept"]')) {
      const box = $('textarea[name="desc"]', node);
      if (box && aiOffer) { box.value = aiOffer.improved; box.dataset.original = aiOffer.original; }
      aiOffer = null;
      paintOffer();
      touched.add("desc");
      repaintLive();
      toast("Description updated — your original is kept underneath");
      return;
    }
    if (e.target.closest('[data-act="reject"]')) {
      aiOffer = null;
      paintOffer();
      return;
    }
    if (e.target.closest('[data-act="thumbclear"]')) {
      thumb = { value: "", auto: thumb.auto, name: "" };
      const input = $('input[name="thumbnail"]', node);
      if (input) input.value = "";
      paintThumb();
      repaintLive();
      return;
    }
  });

  node.addEventListener("input", (e) => {
    const name = e.target.name;
    if (name) touched.add(name === "place" ? "thumbnail" : name);

    if (name === "place") {
      const url = robloxThumb(e.target.value);
      thumb.auto = url || "";
      paintThumb();
    }

    // The description repaints on a timer; everything else is cheap enough to
    // do on the keystroke.
    if (name === "desc") {
      clearTimeout(descTimer);
      descTimer = setTimeout(repaintLive, 220);
      paintCounter(values());
      return;
    }
    repaintLive();
  });

  node.addEventListener("change", (e) => {
    if (e.target.name === "keyless" || e.target.name === "category") {
      touched.add(e.target.name);
      repaintLive();
    }
    const input = e.target.closest('input[name="thumbnail"]');
    if (input?.files?.[0]) takeFile(input.files[0]);
  });

  // Drag and drop onto the preview. Kept to the drop zone rather than the
  // whole page so dragging an image into the browser by accident does nothing.
  node.addEventListener("dragover", (e) => {
    const zone = e.target.closest("[data-thumbdrop]");
    if (!zone) return;
    e.preventDefault();
    zone.classList.add("is-over");
  });
  node.addEventListener("dragleave", (e) => {
    e.target.closest("[data-thumbdrop]")?.classList.remove("is-over");
  });
  node.addEventListener("drop", (e) => {
    const zone = e.target.closest("[data-thumbdrop]");
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("is-over");
    takeFile(e.dataTransfer?.files?.[0]);
  });

  node.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const v = values();
    const p = problems(v);

    // Everything is "touched" once submit is pressed — this is the moment the
    // person has asked for the full picture.
    FIELDS.forEach((f) => touched.add(f));
    showProblems(p);
    paintCounter(v); paintTags(v); paintLua(v); paintHints(v);

    const banner = $("[data-formerror]", node);
    const bad = Object.keys(p);
    if (bad.length) {
      if (banner) {
        banner.hidden = false;
        banner.textContent = bad.length === 1
          ? "One field still needs attention."
          : `${bad.length} fields still need attention.`;
      }
      $(`[data-for="${bad[0]}"] input, [data-for="${bad[0]}"] select, [data-for="${bad[0]}"] textarea`, node)?.focus();
      $(`[data-for="${bad[0]}"]`, node)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (banner) banner.hidden = true;

    if (!account.turnstileKey && !captchaPassed(node))
      return toast("Complete the human check", "warn");

    const descBox = $('textarea[name="desc"]', node);
    const draft = {
      title: v.title, game: v.game, category: v.category,
      desc: v.desc, code: v.code, link: v.link,
      tags: v.tags, keyless: v.keyless,
      thumbnail: v.thumbnail,
      // Their own words, when an AI rewrite was accepted. The server keeps
      // this so a rewrite that drifted is recoverable.
      descOriginal: descBox?.dataset.original || v.desc,
      turnstile: turnstileToken(node),
    };

    const submit = $('[type="submit"]', form);
    const was = submit?.textContent;
    if (submit) { submit.disabled = true; submit.textContent = "Publishing…"; }

    let script = null;
    try {
      if (!(await libraryOnline())) {
        toast("The library isn't reachable, so this can't be published right now", "warn");
        return;
      }
      const res = await publishScript(draft);
      if (!res.ok) {
        // The server refused. It knows things the browser cannot — the real
        // host list, the spam checker — so its wording wins over ours.
        if (banner) { banner.hidden = false; banner.textContent = res.error || "Couldn't publish that."; }
        toast(res.error || "Couldn't publish that. Try again.", "warn");
        return;
      }
      script = res.data;
      addScript(script);
    } finally {
      if (submit) { submit.disabled = false; submit.textContent = was; }
    }

    if (!script) return;
    await account.addPublish(script.id);

    thumb = { value: "", auto: "", name: "" };
    aiOffer = null;
    touched.clear();
    form.reset();
    picker?.reset();
    captchaReset(node);
    render();
    mountPicker();
    paintThumb();

    toast(script.status === "review"
      ? "Submitted — it's waiting on a quick review before it appears"
      : "Published — it's live in the library");
    onPublished?.(script);
  });

  account.onChange(() => { render(); mountPicker(); paintThumb(); });
  render();
  mountPicker();
  paintThumb();

  return { node, refresh: () => { render(); mountPicker(); paintThumb(); } };
}
