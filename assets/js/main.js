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
import { createCreatorPage } from "./creator.js";
import {
  createRouter, pathForScript, pathForCreator, pathForDashboard, setTitle,
} from "./router.js";

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
  onOpenScript: (s) => openScript(s),
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

/* --------------------------------------------------------------- routing */

// Every page on this site now has an address.
//
// The pattern below is the same for all three: a wrapper that opens the
// overlay AND names the URL after it, a close listener that hands the address
// bar back, and a route handler for arriving at that URL cold. Opening from
// inside the app uses `setPath` rather than `go` — the page is already being
// drawn, and resolving the route would draw it a second time on top of itself.

const creatorPage = createCreatorPage({
  onOpenScript: (s) => openScript(s),
  onOpenDashboard: () => openDashboard(),
  onCorrectName: (name) => router.correct(pathForCreator(name)),
});

/** Opens a script and gives it its URL: /creations/<creator>/<slug>. */
function openScript(script) {
  if (!script) return;
  closeRoutedPages("creation");
  router.setPath(pathForScript(script));
  setTitle(script.title);
  scriptPage.open(script);
}

/** Opens your own dashboard at /dashboard/<you>. */
function openDashboard(tab = "stats") {
  if (!account.isSignedIn) { auth.open("signup"); return; }
  closeRoutedPages("dashboard");
  router.setPath(pathForDashboard(account.session.username));
  setTitle("Dashboard");
  dashboard.open(tab);
}

/** Opens somebody's public page at /creators/<name>. */
function openCreator(name) {
  if (!name) return;
  closeRoutedPages("creator");
  router.setPath(pathForCreator(name));
  creatorPage.open(name);
}

const adminPage = createAdminPage({
  // An admin action can take a script down, put one back, or delete an account
  // along with everything it published. The cached library knows none of that,
  // so it is refetched rather than patched.
  onChanged: () => { refreshLibrary(); },
});

/**
 * Shuts the URL-owning overlays, optionally sparing one.
 *
 * Only one of these can be the address at a time, so only one may be on
 * screen. Without this, "Your public page" on the dashboard stacked the
 * profile on top of the dashboard, and closing it left the dashboard sitting
 * there with the home page's URL.
 */
function closeRoutedPages(keep = null) {
  if (keep !== "creation") scriptPage.close();
  if (keep !== "dashboard") dashboard.close();
  if (keep !== "creator") creatorPage.close();
  if (keep !== "admin") adminPage.close();
}

const router = createRouter({
  home() {
    closeRoutedPages();
    setTitle("");
  },

  admin() {
    closeRoutedPages("admin");
    adminPage.open();
    setTitle("Admin");
  },

  creator({ creator }) {
    closeRoutedPages("creator");
    creatorPage.open(creator);
  },

  /**
   * A script, from a URL and nothing else.
   *
   * The cached library is tried first so an in-app back button is instant, and
   * the server is asked otherwise — a shared link must work on a cold tab,
   * before any listing has loaded.
   *
   * The creator's name in the URL is not used to find the script; the slug is
   * unique on its own. It is checked afterwards, and a mismatch corrects the
   * address bar rather than 404ing, so a link keeps working after a rename.
   */
  async creation({ creator, slug }) {
    closeRoutedPages("creation");
    const id = "s_" + String(slug).replace(/^s_/, "");
    const known = library.find((x) => x.id === id);

    setTitle(known ? known.title : "Script");
    const script = known ? (scriptPage.open(known), known) : await scriptPage.openById(id);

    if (!script) {
      router.correct("/");
      closeRoutedPages();
      toast("That script isn't on the site any more", "warn");
      return;
    }

    setTitle(script.title);
    if (script.author && script.author !== creator) router.correct(pathForScript(script));
  },

  /**
   * The dashboard is yours and only yours.
   *
   * Somebody else's name at this path is not an error and not a 403 — it is a
   * person who followed a link to the wrong half of the pair. They get sent to
   * the public page, which is the one they actually wanted.
   */
  dashboard({ creator }) {
    if (!account.isSignedIn) {
      router.correct("/");
      closeRoutedPages();
      auth.open("signin");
      return;
    }

    const me = account.session.username;
    if (creator && creator.toLowerCase() !== me.toLowerCase()) {
      router.go(pathForCreator(creator), { replace: true });
      return;
    }

    closeRoutedPages("dashboard");
    router.correct(pathForDashboard(me));
    setTitle("Dashboard");
    dashboard.open();
  },

  // A path the app does not own reached the shell somehow. Draw the home page
  // rather than an empty screen.
  unknown() { closeRoutedPages(); setTitle(""); router.correct("/"); },
});

router.listen();

// Overlays that own a URL hand the address bar back when they close — but only
// if it still points at them. Closing the script sheet after the router has
// already moved on must not drag the URL back to "/".
document.addEventListener("lucrit:script-closed", () => router.leave("creation"));
document.addEventListener("lucrit:dashboard-closed", () => router.leave("dashboard"));
document.addEventListener("lucrit:creator-closed", () => router.leave("creator"));
document.addEventListener("lucrit:admin-closed", () => router.leave("admin"));

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
  onOpenDashboard: (tab) => openDashboard(tab),
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
    if (s) openScript(s);
  },
  onGenerate: () => generator.open(),
  onRequireAuth: () => auth.open("signup"),
});

/* --------------------------------------------------------------- browse */

const gamePage = createGamePage({
  getLibrary: () => library,
  onOpenScript: (s) => openScript(s),
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
  onOpen: (script) => openScript(script),
  onPublish: () => jumpTo("submit"),
  onOpenGame: (id) => gamePage.open(id),
  onOpenLibrary: () => gameLibrary.open(),
});

const scroller = new SmoothScroll({ reducedMotion: caps.reducedMotion });

const chapters = buildChapters({
  libraryPanel,
  onOpenScript: (s) => openScript(s),
  onJump: jumpTo,
  onPublish: () => { dashboard.refresh(); },
  onAuth: () => (account.isSignedIn ? openDashboard() : auth.open("signup")),
  onInfo: () => info.open(),
});

const chrome = buildChrome({
  onJump: jumpTo,
  onSearch: () => { jumpTo("search"); setTimeout(() => libraryPanel.focus(), 420); },
  onDashboard: () => openDashboard(),
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
  onOpenScript: (s) => openScript(s),
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
  creatorPage.refresh();
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

// Resolve the address bar before the library loads.
//
// A deep link to one script asks the server for that one script, so it does
// not wait behind a listing of two hundred it will not show. Only the
// #script= fallback below needs the library, because an old link carries an
// id and nothing else.
router.start();

// The library lives on the server now, so fetch it before old hash links go
// looking for a script by id.
refreshLibrary()
  .then(async () => {
    const pending = takePendingUnlock();
    if (pending) {
      const done = await scriptPage.resume(pending.scriptId, pending.clickId, pending.hash);
      // The sponsor step returns people to "/" with the script named in the
      // query, not to the script's own address. Put them on it now that we
      // know which one it was, so the tab they end up on is shareable and a
      // refresh does not drop them back at the home page.
      const landed = scriptPage.current;
      if (landed) { router.setPath(pathForScript(landed), { replace: true }); setTitle(landed.title); }
      if (done) toast("Unlocked — here's the script");
      return;
    }

    // Old #script=<id> links still work; they are simply rewritten to the
    // real URL on arrival, so anything already shared keeps landing right.
    const deep = /#script=([\w-]+)/.exec(location.hash);
    if (deep) {
      const s = library.find((x) => x.id === deep[1]);
      if (s) openScript(s);
    }
  })
  .catch(() => { /* offline or static hosting — the site still works */ });

// Deleting from the script page has to reach the cached list too.
document.addEventListener("lucrit:script-removed", (e) => removeScript(e.detail.id));

const deepGame = /#game=([\w-]+)/.exec(location.hash);
if (deepGame) gamePage.open(deepGame[1]);
else if (location.hash === "#library") gameLibrary.open();

window.__lucrit = {
  adminPage, router, creatorPage, openScript, openDashboard, openCreator,
  openAdmin: () => router.go("/admin"),
  world, scroller, library, account,
  auth, dashboard, info, scriptPage, libraryPanel, gamePage, gameLibrary,
  ui: chapters, jumpTo, chapters: CHAPTERS, caps, toast, choreography, generator, mine,
  snap() {
    smoothed = progress;
    world?.setProgress(choreography.toCameraProgress(smoothed));
  },
};
