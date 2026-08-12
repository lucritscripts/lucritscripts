// Floating site assistant, bottom-left.
//
// It does three real jobs:
//   1. Finds scripts — searches the live library and returns results inline.
//   2. Walks people through publishing, keys and payouts, step by step.
//   3. Takes action — its buttons jump sections, open the info tab, or start
//      a signup, so an answer is never a dead end.
//
// Questions about the site are answered locally — instant, free, and more
// accurate than a model guessing at how this particular site works. Anything
// that looks like "write me a script" goes to the Cloudflare Worker, which
// holds the API key and streams a model's reply back.
//
// If the Worker is not deployed, or is down, or refuses, every question falls
// back to the local answers. The assistant never breaks; it just gets simpler.

import { CATEGORIES, categoryOf } from "./data/scripts.js";
import { account } from "./account.js";
import { ASSISTANT_URL } from "./config.js";
import { highlightLuau } from "./engine/highlight.js";
import { copyText } from "./pages.js";

/* ---------------------------------------------------------------- intent */

/** Words that point at a category, beyond the category label itself. */
const CATEGORY_HINTS = {
  combat: ["fight", "fighting", "weapon", "sword", "gun", "damage", "hitbox", "pvp", "melee", "kill"],
  movement: ["walk", "run", "sprint", "jump", "fly", "speed", "parkour", "wallrun", "dash", "climb"],
  ui: ["gui", "interface", "menu", "hud", "button", "screen", "dialogue", "notification", "shop ui"],
  npc: ["ai", "bot", "enemy", "mob", "pathfind", "pathfinding", "follow", "zombie", "villager"],
  admin: ["command", "moderation", "ban", "kick", "mod", "staff", "permission"],
  data: ["save", "saving", "datastore", "store", "persist", "load", "profile save"],
  anticheat: ["exploit", "cheat", "hack", "anti cheat", "anticheat", "protection", "secure"],
  inventory: ["backpack", "items", "item", "hotbar", "stack", "storage"],
  shops: ["shop", "store", "buy", "purchase", "sell", "market"],
  economy: ["coins", "cash", "currency", "money system", "credits"],
  tycoon: ["tycoon", "dropper", "conveyor", "base"],
  simulator: ["simulator", "sim", "clicker", "rebirth"],
  obby: ["obby", "parkour map", "checkpoint", "stage"],
  towerdefense: ["tower defense", "td", "tower", "wave", "defense"],
  roleplay: ["roleplay", "rp", "job", "police", "city"],
  minigames: ["minigame", "round", "lobby", "match"],
  pets: ["pet", "companion", "follower"],
  farming: ["farm", "crop", "plant", "harvest", "grow"],
  crafting: ["craft", "recipe", "forge", "smelt"],
  building: ["build", "place", "placement", "furniture", "plot"],
  vehicles: ["car", "vehicle", "drive", "boat", "plane", "bike"],
  quests: ["quest", "mission", "objective", "task"],
  chat: ["chat", "message", "say", "text filter"],
  teleport: ["teleport", "tp", "portal", "warp"],
  camera: ["camera", "cam", "first person", "third person", "shake"],
  lighting: ["light", "lighting", "day night", "night cycle", "shadow"],
  audio: ["sound", "music", "audio", "song", "sfx"],
  effects: ["vfx", "particle", "effect", "explosion", "trail"],
  animation: ["animation", "animate", "emote", "dance", "idle"],
  leaderboard: ["leaderboard", "leaderstats", "ranking", "top players"],
  utilities: ["utility", "module", "helper", "signal", "cleanup", "debounce"],
};

const FIND_RE = /\b(find|search|looking for|look for|need|want|got|have|any|is there|show me|recommend|suggest|where.*(get|find))\b/i;
const STOPWORDS = new Set([
  "a","an","the","for","me","my","i","you","do","does","did","can","could","would",
  "please","script","scripts","some","any","got","have","need","want","looking","look",
  "find","search","show","recommend","suggest","is","there","to","of","on","in","with",
  "roblox","lua","luau","code","good","best","nice","pls","plz","help","about","how",
]);

function detectCategories(text) {
  // Punctuation out, single spaces, padded — so a term has to sit between two
  // word boundaries. Matching a bare prefix would read "airspeed" as "ai" and
  // answer a question about swallows with NPC scripts.
  const q = " " + text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  const hits = [];
  for (const cat of CATEGORIES) {
    const label = cat.label.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    const terms = [label, ...(CATEGORY_HINTS[cat.id] || [])];
    if (terms.some((t) => t && q.includes(" " + t + " "))) hits.push(cat.id);
  }
  return hits;
}

function keywords(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/* --------------------------------------------------------------- answers */

const GREETING = `Hi — I'm the site assistant. I can <b>find you a script</b>, walk you through <b>publishing</b>, or explain <b>keys and getting paid</b>. What are you after?`;

const SUGGESTIONS = [
  "Find me a combat script",
  "How do I upload a script?",
  "How do I get paid?",
  "What's a key system?",
];

/* ----------------------------------------------------------------- build */

export function createAssistant({
  getLibrary = () => [],
  onJump, onOpenScript, onInfo, onAuth, onPublish,
} = {}) {
  const root = document.createElement("div");
  root.className = "assistant";
  root.innerHTML = `
    <button class="assistant__toggle" aria-expanded="false" aria-controls="assistant-panel">
      <span class="assistant__spark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>
      </span>
      <span class="assistant__label">Ask</span>
    </button>

    <div class="assistant__panel" id="assistant-panel" hidden>
      <header class="assistant__head">
        <span class="assistant__dot" aria-hidden="true"></span>
        <b>Site assistant</b>
        <button class="assistant__x" aria-label="Close">&times;</button>
      </header>
      <div class="assistant__log" role="log" aria-live="polite"></div>
      <div class="assistant__chips"></div>
      <form class="assistant__form">
        <input class="assistant__input" placeholder="Find a script, or ask anything..."
               aria-label="Ask about the site" autocomplete="off">
        <button class="assistant__send" aria-label="Send">
          <svg viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6"/></svg>
        </button>
      </form>
    </div>`;

  document.body.appendChild(root);

  const toggle = root.querySelector(".assistant__toggle");
  const panel = root.querySelector(".assistant__panel");
  const log = root.querySelector(".assistant__log");
  const chips = root.querySelector(".assistant__chips");
  const form = root.querySelector(".assistant__form");
  const input = root.querySelector(".assistant__input");

  const escape = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function bubble(html, who) {
    const b = document.createElement("div");
    b.className = `bubble bubble--${who}`;
    b.innerHTML = html;
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }

  const actions = (list) => list.length
    ? `<div class="bubble__actions">${list.map(
        (a) => `<button data-do="${a.do}"${a.arg ? ` data-arg="${escape(a.arg)}"` : ""}>${a.label}</button>`
      ).join("")}</div>`
    : "";

  /* --------------------------------------------------------- script find */

  function findScripts(question) {
    const lib = getLibrary() || [];
    const cats = detectCategories(question);
    const words = keywords(question);

    const scored = lib.map((s) => {
      let score = 0;
      if (cats.includes(s.category)) score += 6;
      const hay = [s.title, s.game, s.desc, (s.tags || []).join(" ")].join(" ").toLowerCase();
      for (const w of words) if (hay.includes(w)) score += 2;
      if (words.some((w) => String(s.title).toLowerCase().includes(w))) score += 3;
      return { s, score };
    }).filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.s.views - a.s.views);

    return { results: scored.slice(0, 4).map((r) => r.s), cats, empty: lib.length === 0 };
  }

  function resultsMarkup(list) {
    return `<div class="bubble__results">${list.map((s) => {
      const cat = categoryOf(s.category);
      return `<button class="miniscript" data-do="open" data-arg="${escape(s.id)}">
        <span class="miniscript__cat" style="--cat:${cat.accent}">${cat.label}</span>
        <span class="miniscript__title">${escape(s.title)}</span>
        <span class="miniscript__game">${escape(s.game || "Roblox")}</span>
      </button>`;
    }).join("")}</div>`;
  }

  /* ------------------------------------------------------------ answering */

  function answer(question) {
    const q = question.toLowerCase();
    const signedIn = account.isSignedIn;

    /* --- find a script --- */
    if (FIND_RE.test(q) || detectCategories(q).length) {
      const { results, cats, empty } = findScripts(question);

      if (empty) {
        return {
          html: `The library is brand new — <b>nothing has been published yet</b>. ${
            cats.length
              ? `Once someone posts a ${categoryOf(cats[0]).label.toLowerCase()} script it'll show up here instantly.`
              : `Everything on this site is creator-published.`
          }<br><br>You could be the first — and first publisher tops the leaderboard by default.`,
          acts: [
            { do: "publish", label: "Publish the first one" },
            { do: "discord", label: "Ask in Discord" },
          ],
        };
      }

      if (results.length) {
        return {
          html: `Found ${results.length === 1 ? "one" : results.length} that look${results.length === 1 ? "s" : ""} right:${resultsMarkup(results)}
                 Tap one to open it. Press <b>Get Script</b> on its page to unlock the code.`,
          acts: [{ do: "jump", arg: "search", label: "Browse everything" }],
        };
      }

      return {
        html: `Nothing matches that yet.${cats.length
          ? ` There's a <b>${categoryOf(cats[0]).label}</b> category, but it's empty right now.`
          : ""} Try a broader word, browse the full library, or ask in Discord — someone usually knows.`,
        acts: [
          { do: "jump", arg: "search", label: "Browse the library" },
          { do: "discord", label: "Ask in Discord" },
        ],
      };
    }

    /* --- publishing --- */
    if (/\b(publish|upload|post|submit|share)\b/.test(q)) {
      return {
        html: `Publishing takes about two minutes:
          <ol class="bubble__steps">
            <li><b>Sign in</b> — you need an account to publish.</li>
            <li><b>Script name</b> and the <b>Roblox game</b> it's for.</li>
            <li>Pick a <b>category</b> — there are ${CATEGORIES.length} of them.</li>
            <li><b>Description, at least 100 words.</b> The form counts as you type and won't submit short. Say what it does, how to use it, and what makes it different.</li>
            <li><b>Paste your Luau.</b> This is what people unlock.</li>
            <li><b>Tags</b>, then <b>Keyless</b> or <b>Key required</b>.</li>
            <li>Thumbnail is <b>optional</b> — paste the game link instead and the official Roblox thumbnail is pulled in for you.</li>
            <li>Pass the human check and hit <b>Publish</b>. It's live immediately.</li>
          </ol>`,
        acts: signedIn
          ? [{ do: "publish", label: "Publish a script" }]
          : [{ do: "auth", label: "Create an account" }, { do: "publish", label: "See the form" }],
      };
    }

    /* --- money --- */
    if (/\b(paid|pay|payout|money|earn|revenue|monetiz|profit|cash out|income)\b/.test(q)) {
      return {
        html: `You earn every time someone <b>unlocks</b> one of your scripts.
          <ol class="bubble__steps">
            <li>You publish a script.</li>
            <li>To get the code, a visitor completes one short sponsor step — <b>Linkvertise</b> or <b>Lootlabs</b>, their choice.</li>
            <li>That completion pays out, tracked against your account.</li>
            <li>Your dashboard shows views, likes and copies over 24h, 7d, 1m and 3m.</li>
          </ol>
          Views alone don't pay — someone has to finish the step. Rates shift with the visitor's country. And you never unlock your own scripts.`,
        acts: [
          { do: "info", label: "Full breakdown" },
          signedIn ? { do: "publish", label: "Publish a script" } : { do: "auth", label: "Create an account" },
        ],
      };
    }

    /* --- keys --- */
    if (/\bkey(less| system|s)?\b|\bexpir|\bwhitelist\b/.test(q)) {
      return {
        html: `When you publish you mark a script one of two ways:
          <ul class="bubble__steps">
            <li><b>Keyless</b> — runs as-is. Nothing extra for the user.</li>
            <li><b>Key required</b> — the user needs a key before the script runs.</li>
          </ul>
          The key system itself is <b>not live yet</b>. It's being built on Firebase, and will track when a key expires and hold it to one active user at a time. For now, mark a script key-required only if it already ships with your own key check.`,
        acts: [{ do: "info", label: "How payouts work" }],
      };
    }

    /* --- getting a script --- */
    if (/\b(get|download|copy|unlock|access|use)\b/.test(q)) {
      return {
        html: `Open any script and press <b>Get Script</b>. You'll complete one short sponsor step — Linkvertise or Lootlabs — and land back on the page with the code visible and a Copy button.<br><br>Wrote it yourself? You skip the step entirely; authors always get straight through.`,
        acts: [{ do: "jump", arg: "search", label: "Browse scripts" }],
      };
    }

    /* --- account --- */
    if (/\b(account|sign ?up|sign ?in|log ?in|register|password|reset|forgot)\b/.test(q)) {
      return {
        html: signedIn
          ? `You're signed in as <b>@${escape(account.session.username)}</b>. Your dashboard has your stats, publishes, profile and password settings.`
          : `Hit <b>View Dashboard</b> top right, or <b>View Account</b> on the front page. Signing up needs a username, email, password and a quick human check.<br><br>Forgotten password? Choose <b>Forgot password?</b> on the sign-in screen and a reset link goes to your email.`,
        acts: signedIn ? [{ do: "dashboard", label: "Open dashboard" }] : [{ do: "auth", label: "Create an account" }],
      };
    }

    /* --- profile --- */
    if (/\b(profile|avatar|picture|pfp|bio|youtube|tiktok|social|username)\b/.test(q)) {
      return {
        html: `Everything profile-related lives in your dashboard:
          <ul class="bubble__steps">
            <li><b>Profile</b> — picture, bio, and your YouTube or TikTok link.</li>
            <li><b>Security</b> — username (changeable once every 7 days) and password.</li>
          </ul>`,
        acts: signedIn ? [{ do: "dashboard", label: "Open dashboard" }] : [{ do: "auth", label: "Create an account" }],
      };
    }

    /* --- stats --- */
    if (/\b(stats|analytics|views|likes|performance|dashboard)\b/.test(q)) {
      return {
        html: `Dashboard → <b>Stats</b> gives you views, likes and copies over <b>24 hours, 7 days, 1 month and 3 months</b>, plus a per-script breakdown under <b>Publishes</b>.`,
        acts: signedIn ? [{ do: "dashboard", label: "Open dashboard" }] : [{ do: "auth", label: "Create an account" }],
      };
    }

    /* --- leaderboard --- */
    if (/\b(leaderboard|ranking|rank|top|rate|rating|review)\b/.test(q)) {
      return {
        html: `Four boards: <b>most scripts</b>, <b>most likes</b>, <b>best rating</b> and <b>highest views</b>. Anyone can look — you only need an account to rate a script.`,
        acts: [{ do: "jump", arg: "community", label: "See the leaderboard" }],
      };
    }

    /* --- discord --- */
    if (/\bdiscord\b|\b(community|updates|news|announce)\b/.test(q)) {
      return {
        html: `Daily updates, new scripts and announcements all go to Discord first. It's also the fastest way to get a question answered.`,
        acts: [{ do: "discord", label: "Join Discord" }],
      };
    }

    /* --- categories --- */
    if (/\b(category|categories|kinds?|types?)\b/.test(q)) {
      return {
        html: `${CATEGORIES.length} of them — combat, movement, UI, NPC & AI, admin, data, anti-cheat, inventory, shops, economy, tycoon, simulator, obby, tower defense, roleplay, pets, farming, vehicles, quests and more. You can filter by any of them.`,
        acts: [{ do: "jump", arg: "search", label: "Filter by category" }],
      };
    }

    /* --- safety --- */
    if (/\b(safe|virus|malware|trust|scam|legit|steal|logger)\b/.test(q)) {
      return {
        html: `Every script's full source is on its page — <b>read it before you run it</b>, always. Anything malicious gets removed and the account banned. If you spot something wrong, hit <b>Report</b> on the script page.`,
        acts: [],
      };
    }

    /* --- pleasantries --- */
    if (/^(hi|hey|hello|yo|sup|thanks|thank you|ty|cheers)\b/.test(q)) {
      return { html: GREETING, acts: [] };
    }

    // `weak` marks "nothing actually matched" — the caller uses it to decide
    // whether the question is worth sending to the model.
    return {
      weak: true,
      html: `Not sure about that one. I'm good at <b>writing Luau</b>, <b>finding scripts</b> ("find me an inventory script"), <b>publishing</b>, <b>keys</b>, <b>payouts</b>, accounts and the leaderboard.`,
      acts: [
        { do: "jump", arg: "search", label: "Browse scripts" },
        { do: "discord", label: "Ask in Discord" },
      ],
    };
  }

  /* ---------------------------------------------------------- markdown */

  /**
   * Just enough Markdown for a chat bubble: fenced code, inline code, bold,
   * and paragraphs. Everything is escaped first, so model output can never
   * inject markup — the formatting is applied to escaped text afterwards.
   *
   * `streaming` keeps a half-finished fence readable while it is still
   * arriving, instead of showing the raw backticks.
   */
  function renderMarkdown(src, { streaming = false } = {}) {
    const parts = String(src).split(/```/);
    let out = "";

    parts.forEach((part, i) => {
      if (i % 2 === 0) {
        out += prose(part);
        return;
      }
      // Odd chunks are code. A trailing unclosed fence is still code.
      const body = part.replace(/^[a-zA-Z]*\n?/, "");
      const open = streaming && i === parts.length - 1;
      out += codeBlock(body, open);
    });

    return out;
  }

  function prose(text) {
    return escape(text)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  let codeSeq = 0;

  function codeBlock(code, streamingOpen) {
    const trimmed = code.replace(/\n+$/, "");
    if (!trimmed.trim()) return "";
    const id = `ac${++codeSeq}`;
    codeStore.set(id, trimmed);

    return `
      <div class="acode${streamingOpen ? " is-open" : ""}">
        <button type="button" class="acode__copy" data-copy="${id}">Copy</button>
        <pre><code>${highlightLuau(trimmed)}</code></pre>
      </div>`;
  }

  /** Raw source per rendered block, so Copy gives code and not highlighted HTML. */
  const codeStore = new Map();

  /* ------------------------------------------------------ model-backed */

  // Routing. A model answer costs credits and a local answer does not, so the
  // model is used when the question is actually about code — a writing verb
  // aimed at a code noun, or a bare Luau API in the text — or when the local
  // matcher had nothing. "How do I publish a script" stays local; "write me a
  // datastore script" does not.
  const CODE_VERB = /\b(writ(e|ing)|mak(e|ing)|creat(e|ing)|build(ing)?|generate|cod(e|ing)|fix(ing)?|debug(ging)?|refactor|optimi[sz]e|improve|explain|convert|rewrite)\b/i;
  const CODE_NOUN = /\b(script|code|function|module ?script|module|local ?script|remote ?event|remote ?function|data ?store|gui|hud|part|brick|humanoid|workspace|instance|leaderstats|loop|tween|raycast|animation|npc|tool|hitbox|cooldown|luau|lua|error|bug|exception)\b/i;
  const CODE_API = /(instance\.new|task\.(wait|spawn|delay)|:connect\b|:fireserver|:fireclient|:waitforchild|game[.:]|\.touched|pcall\s*\(|while\s+true|for\s+\w+\s*(,|=|in))/i;

  function wantsModel(question, local) {
    if (CODE_API.test(question)) return true;
    if (CODE_VERB.test(question) && CODE_NOUN.test(question)) return true;
    return Boolean(local.weak);
  }

  /** Recent turns, so follow-ups like "now add a cooldown" make sense. */
  const history = [];

  /**
   * Streams the Worker's reply into `node`, rendering as it arrives.
   * Returns true if it produced an answer, false to fall back to local.
   */
  async function askRemote(question, node) {
    if (!ASSISTANT_URL) return false;

    let response;
    try {
      response = await fetch(ASSISTANT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, history: history.slice(-6) }),
        signal: AbortSignal.timeout(70000),
      });
    } catch {
      return false;   // offline, blocked, or timed out — local answer instead
    }

    if (!response.ok) {
      // The Worker sends a human-readable reason for the cases worth showing.
      const { error } = await response.json().catch(() => ({}));
      if (response.status === 429 && error) {
        node.innerHTML = `<p>${escape(error)}</p>`;
        return true;
      }
      return false;
    }

    const reader = response.body?.getReader();
    if (!reader) return false;

    const decoder = new TextDecoder();
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      node.innerHTML = renderMarkdown(text, { streaming: true });
      log.scrollTop = log.scrollHeight;
    }

    if (!text.trim()) return false;

    node.innerHTML = renderMarkdown(text);
    history.push({ role: "user", content: question });
    history.push({ role: "assistant", content: text });
    return true;
  }

  async function ask(question) {
    bubble(escape(question), "me");
    chips.innerHTML = "";

    const thinking = bubble('<span class="typing"><i></i><i></i><i></i></span>', "bot");

    // Site questions are answered better here than by any model. Code
    // questions, and anything the local matcher shrugs at, go to the Worker.
    const local = answer(question);
    const handled = wantsModel(question, local) ? await askRemote(question, thinking) : false;

    if (!handled) {
      await new Promise((r) => setTimeout(r, 240));
      thinking.innerHTML = local.html + actions(local.acts || []);
    }

    log.scrollTop = log.scrollHeight;
    setTimeout(renderChips, 350);
  }

  function renderChips() {
    chips.innerHTML = SUGGESTIONS.map((s) => `<button type="button">${s}</button>`).join("");
  }

  /* ---------------------------------------------------------- behaviour */

  log.addEventListener("click", async (e) => {
    const copy = e.target.closest("[data-copy]");
    if (copy) {
      const ok = await copyText(codeStore.get(copy.dataset.copy) || "");
      copy.textContent = ok ? "Copied" : "Press Ctrl+C";
      setTimeout(() => { copy.textContent = "Copy"; }, 1600);
      return;
    }

    const btn = e.target.closest("[data-do]");
    if (!btn) return;
    const { do: what, arg } = btn.dataset;

    if (what === "jump") { onJump?.(arg); close(); }
    if (what === "publish") { onPublish?.(); close(); }
    if (what === "auth") { onAuth?.(); close(); }
    if (what === "info") { onInfo?.(); close(); }
    if (what === "dashboard") { document.querySelector(".dashbtn")?.click(); close(); }
    if (what === "discord") window.open("https://discord.gg/JUSmn4ZYe", "_blank", "noopener");
    if (what === "open") {
      const s = (getLibrary() || []).find((x) => x.id === arg);
      if (s) { onOpenScript?.(s); close(); }
    }
  });

  chips.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) ask(b.textContent);
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    ask(q);
  });

  function open() {
    panel.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    root.classList.add("is-open");
    if (!log.childElementCount) { bubble(GREETING, "bot"); renderChips(); }
    setTimeout(() => input.focus(), 80);
  }

  function close() {
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    root.classList.remove("is-open");
  }

  toggle.addEventListener("click", () => (panel.hidden ? open() : close()));
  root.querySelector(".assistant__x").addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  return { open, close, ask };
}
