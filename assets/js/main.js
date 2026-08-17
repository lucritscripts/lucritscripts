// Entry point: capability detection, the render loop, and wiring.

import { World, BANDS } from "./engine/world.js";
import { SmoothScroll } from "./engine/scroll.js";
import {
  createLibraryPanel, buildChapters, buildChrome, createChoreography,
  CHAPTERS, library, onLibraryChange, removeScript, refreshLibrary, cardMarkup,
} from "./ui.js";
import { createGameLibrary, createGamePage } from "./browse.js";
import {
  createAuth, createDashboard, createInfoPage, createScriptPage, toast,
} from "./pages.js";
import { createAssistant } from "./assistant.js";
import { createGenerator } from "./generator.js";
import { createMyScripts } from "./mine.js";
import { createAdminPage } from "./admin.js";
import { toggleSaved, getDraft, onVaultChange } from "./vault.js";
import { account } from "./account.js";
import { runBotCheck } from "./gate.js";
import { capturePendingUnlock, takePendingUnlock, deleteScript } from "./library-api.js";

/* ------------------------------------------------------- capabilities */

function detect() {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  const narrow = window.innerWidth < 820;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;

  let quality = "high";
  if (coarse || narrow) quality = "medium";
  if (cores <= 4 || mem <= 3) quality = quality === "high" ? "medium" : "low";
  if ((coarse || narrow) && (cores <= 4 || mem <= 3)) quality = "low";

  return { reducedMotion, coarse, narrow, quality };
}

const caps = detect();
document.documentElement.dataset.quality = caps.quality;
if (caps.reducedMotion) document.documentElement.classList.add("reduced-motion");

/* ------------------------------------------------------------- 3D world */

const canvas = document.getElementById("scene");
let world = null;

// The canvas is decorative — everything readable lives in the DOM.
try {
  world = new World(canvas, { quality: caps.quality, reducedMotion: caps.reducedMotion });
  if (!world.init()) world = null;
} catch (err) {
  console.warn("[lucrit] 3D unavailable:", err);
  world = null;
}

if (!world) {
  document.documentElement.classList.add("no-webgl");
  canvas.setAttribute("hidden", "");
}

/* ------------------------------------------------------------- overlays */

let choreography = null;

function jumpTo(key) {
  if (!choreography || !BANDS[key]) return;
  scroller.scrollToProgress(choreography.targetFor(key));
}

const auth = createAuth({
  onDone: () => { dashboard.refresh(); },
});

const info = createInfoPage();

const scriptPage = createScriptPage({
  onRequireAuth: () => { toast("Sign in to rate scripts", "warn"); auth.open("signup"); },
});

const dashboard = createDashboard({
  onRequireAuth: () => auth.open("signup"),
  getPublishes: (user) => library.filter((s) => s.authorId === user.id),
  onOpenScript: (s) => scriptPage.open(s),
  onDeleteScript: async (s) => {
    // Remove it where it actually lives, then from the cached list. Doing only
    // the second is what "deleted" used to mean, and it came back on refresh.
    const res = await deleteScript(s.id);
    if (res.ok || res.absent) removeScript(s.id);
    else toast(res.error || "Couldn't delete that", "warn");
  },
  getScript: (id) => library.find((s) => s.id === id),
  onOpenDraft: (id) => generator.openDraft(getDraft(account.session?.id, id)),
  onGenerate: () => generator.open(),
  onUnheart: (id) => toggleSaved(account.session?.id, id),
});

/* ------------------------------------------------------------ generator */

/**
 * Hands a draft to the publish form. The form owns game, category and
 * description, so we fill in what we know and leave the rest to the person
 * rather than inventing values on their behalf.
 */
function sendToPublishForm(draft) {
  jumpTo("submit");
  setTimeout(() => {
    const form = document.querySelector(".publish__form");
    if (!form) return;
    form.querySelector('[name="title"]').value = draft.title;
    const code = form.querySelector('[name="code"]');
    code.value = draft.code;
    code.dispatchEvent(new Event("input", { bubbles: true }));
    form.querySelector('[name="title"]').focus();
    toast("Fill in the game and description, then publish");
  }, 700);
}

const generator = createGenerator({
  onRequireAuth: () => auth.open("signup"),
  onOpenDashboard: (tab) => dashboard.open(tab),
  onOpenMine: () => mine.open("drafts"),
  onPublish: (draft) => sendToPublishForm(draft),
});

/* ------------------------------------------------------------ my scripts */

const mine = createMyScripts({
  getPublished: (user) => library.filter((s) => s.authorId === user.id),
  onContinue: (id) => generator.openDraft(getDraft(account.session?.id, id)),
  onPublishDraft: (id) => {
    const draft = getDraft(account.session?.id, id);
    if (draft) sendToPublishForm(draft);
  },
  onOpenScript: (id) => {
    const s = library.find((x) => x.id === id);
    if (s) scriptPage.open(s);
  },
  onGenerate: () => generator.open(),
  onRequireAuth: () => auth.open("signup"),
});

/* --------------------------------------------------------------- browse */

const gamePage = createGamePage({
  getLibrary: () => library,
  onOpenScript: (s) => scriptPage.open(s),
  onPublish: () => jumpTo("submit"),
  cardMarkup,
});

const gameLibrary = createGameLibrary({
  getLibrary: () => library,
  onOpenGame: (id) => gamePage.open(id),
  onPublish: () => jumpTo("submit"),
});

// "All games" on a game page walks back to the Library rather than nowhere.
document.addEventListener("lucrit:library", () => gameLibrary.open());

/* ------------------------------------------------------------------ UI */

const libraryPanel = createLibraryPanel({
  id: "library-main",
  onOpen: (script) => scriptPage.open(script),
  onPublish: () => jumpTo("submit"),
  onOpenGame: (id) => gamePage.open(id),
  onOpenLibrary: () => gameLibrary.open(),
});

const scroller = new SmoothScroll({ reducedMotion: caps.reducedMotion });

const chapters = buildChapters({
  libraryPanel,
  onOpenScript: (s) => scriptPage.open(s),
  onJump: jumpTo,
  onPublish: () => { dashboard.refresh(); },
  onAuth: () => (account.isSignedIn ? dashboard.open() : auth.open("signup")),
  onInfo: () => info.open(),
});

const chrome = buildChrome({
  onJump: jumpTo,
  onSearch: () => { jumpTo("search"); setTimeout(() => libraryPanel.focus(), 420); },
  onDashboard: () => dashboard.open(),
  onAuth: () => auth.open("signup"),
  onLibrary: () => gameLibrary.open(),
  onMine: () => mine.open("drafts"),
});

choreography = createChoreography({ chrome });

// Once input goes quiet, ease onto the nearest chapter instead of resting
// half-faded between two of them.
scroller.setSnap((p, dir) => choreography.snapTarget(p, dir));

createAssistant({
  getLibrary: () => library,
  onJump: jumpTo,
  onOpenScript: (s) => scriptPage.open(s),
  onInfo: () => info.open(),
  onAuth: () => auth.open("signup"),
  onPublish: () => jumpTo("submit"),
});

// The heart lives on every card, so one delegated listener covers the whole
// site — search results, the vault, game pages, trending.
document.addEventListener("click", (e) => {
  const heart = e.target.closest("[data-heart]");
  if (!heart) return;
  e.preventDefault();
  e.stopPropagation();

  if (!account.isSignedIn) {
    toast("Sign in to save scripts to your tabs", "warn");
    auth.open("signup");
    return;
  }

  const now = toggleSaved(account.session.id, heart.dataset.heart);
  heart.classList.toggle("is-on", now);
  heart.setAttribute("aria-pressed", String(now));
  heart.setAttribute("aria-label", now ? "Remove from your tabs" : "Save to your tabs");
  toast(now ? "Saved to your tabs" : "Removed from your tabs");
}, true);

document.addEventListener("lucrit:generate", () => generator.open());
document.addEventListener("lucrit:mine", () => mine.open("drafts"));

// Hearts are drawn per-account, so every surface that shows cards has to
// repaint when the session or the shelf changes. Without this, signing out
// leaves someone else's hearts filled in on the page.
function repaintShelf() {
  libraryPanel.refresh();
  chapters.refresh();
  gamePage.refresh();
  gameLibrary.refresh();
  mine.refresh();
}
account.onChange(repaintShelf);
onVaultChange(repaintShelf);

// Dashboard's "publish a script" shortcut.
document.addEventListener("lucrit:publish", () => jumpTo("submit"));

// Chapter heights change when the library fills, so the bands must re-measure.
onLibraryChange(() => {
  gameLibrary.refresh();
  gamePage.refresh();
  setTimeout(() => choreography.measure(), 60);
});

/* --------------------------------------------------------------- input */

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
    e.preventDefault();
    jumpTo("search");
    setTimeout(() => libraryPanel.focus(), 420);
  }
});

if (world && !caps.reducedMotion && !caps.coarse) {
  window.addEventListener("pointermove", (e) => {
    world.setPointer(
      (e.clientX / window.innerWidth) * 2 - 1,
      (e.clientY / window.innerHeight) * 2 - 1
    );
  }, { passive: true });
}

/* ---------------------------------------------------------- main loop */

let progress = 0;
let smoothed = 0;

scroller.onChange((p) => { progress = p; choreography.update(p); });

let last = performance.now();
let hidden = false;

document.addEventListener("visibilitychange", () => { hidden = document.hidden; });

function frame(now) {
  requestAnimationFrame(frame);
  if (hidden) { last = now; return; }

  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  // Framerate-independent, so a 30fps device tracks at the same speed as 120fps.
  const k = caps.reducedMotion ? 1 : 1 - Math.pow(1 - 0.09, dt * 60);
  smoothed += (progress - smoothed) * k;

  if (world) {
    world.resize();
    // Remap real scroll position onto the camera path's canonical bands so the
    // 3D world and the DOM chapters stay locked together at any page height.
    world.setProgress(choreography.toCameraProgress(smoothed));
    world.render(dt);
  }
}

requestAnimationFrame(frame);

/* ------------------------------------------------------------ startup */

document.documentElement.classList.add("is-ready");

// The gate goes up before anything else is usable. The 3D world keeps
// loading behind it so the site is ready the moment it clears.
runBotCheck().then((how) => {
  if (how !== "skipped") choreography.measure();
});

// A sponsor step sends people back with ?unlocked=..&click=.. on the URL.
// Grab it before anything else touches the address bar, so a refresh cannot
// replay it and the parameters do not linger where they'd be shared around.
capturePendingUnlock();

// The library lives on the server now, so fetch it before deep links go
// looking for a script by id.
refreshLibrary()
  .then(async () => {
    const pending = takePendingUnlock();
    if (pending) {
      const done = await scriptPage.resume(pending.scriptId, pending.clickId, pending.hash);
      if (done) toast("Unlocked — here's the script");
      return;
    }

    const deep = /#script=([\w-]+)/.exec(location.hash);
    if (deep) {
      const s = library.find((x) => x.id === deep[1]);
      if (s) scriptPage.open(s);
    }
  })
  .catch(() => { /* offline or static hosting — the site still works */ });

// Deleting from the script page has to reach the cached list too.
document.addEventListener("lucrit:script-removed", (e) => removeScript(e.detail.id));

/* ----------------------------------------------------------------- /admin */

// A real URL, not a hash. The Worker serves the app shell for /admin so a
// direct visit or a refresh lands here rather than on a 404, and closing the
// page puts the address bar back rather than leaving /admin pointing at the
// library.
const adminPage = createAdminPage({
  // An admin action can take a script down, put one back, or delete an account
  // along with everything it published. The cached library knows none of that,
  // so it is refetched rather than patched.
  onChanged: () => { refreshLibrary(); },
});

function openAdmin(push = true) {
  if (push && location.pathname !== "/admin") history.pushState(null, "", "/admin");
  adminPage.open();
}

document.addEventListener("click", (e) => {
  const link = e.target.closest('a[href="/admin"], [data-open-admin]');
  if (!link) return;
  e.preventDefault();
  openAdmin();
});

// Back out of /admin the way the browser expects.
addEventListener("popstate", () => {
  if (/^\/admin\/?$/.test(location.pathname)) openAdmin(false);
  else adminPage.close();
});

document.addEventListener("lucrit:admin-closed", () => {
  if (/^\/admin\/?$/.test(location.pathname)) history.replaceState(null, "", "/");
});

if (/^\/admin\/?$/.test(location.pathname)) openAdmin(false);

const deepGame = /#game=([\w-]+)/.exec(location.hash);
if (deepGame) gamePage.open(deepGame[1]);
else if (location.hash === "#library") gameLibrary.open();

window.__lucrit = {
  adminPage, openAdmin,
  world, scroller, library, account,
  auth, dashboard, info, scriptPage, libraryPanel, gamePage, gameLibrary,
  ui: chapters, jumpTo, chapters: CHAPTERS, caps, toast, choreography, generator, mine,
  snap() {
    smoothed = progress;
    world?.setProgress(choreography.toCameraProgress(smoothed));
  },
};
