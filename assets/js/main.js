// Entry point: capability detection, the render loop, and wiring.

import { World, BANDS } from "./engine/world.js";
import { SmoothScroll } from "./engine/scroll.js";
import {
  createLibraryPanel, buildChapters, buildChrome, createChoreography,
  CHAPTERS, library, onLibraryChange, removeScript,
} from "./ui.js";
import {
  createAuth, createDashboard, createInfoPage, createScriptPage, toast,
} from "./pages.js";
import { createAssistant } from "./assistant.js";
import { account } from "./account.js";

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
  onDeleteScript: (s) => removeScript(s.id),
});

/* ------------------------------------------------------------------ UI */

const libraryPanel = createLibraryPanel({
  id: "library-main",
  onOpen: (script) => scriptPage.open(script),
  onPublish: () => jumpTo("submit"),
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
});

choreography = createChoreography({ chrome });

createAssistant({
  getLibrary: () => library,
  onJump: jumpTo,
  onOpenScript: (s) => scriptPage.open(s),
  onInfo: () => info.open(),
  onAuth: () => auth.open("signup"),
  onPublish: () => jumpTo("submit"),
});

// Dashboard's "publish a script" shortcut.
document.addEventListener("lucrit:publish", () => jumpTo("submit"));

// Chapter heights change when the library fills, so the bands must re-measure.
onLibraryChange(() => setTimeout(() => choreography.measure(), 60));

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

const deep = /#script=([\w-]+)/.exec(location.hash);
if (deep) {
  const s = library.find((x) => x.id === deep[1]);
  if (s) scriptPage.open(s);
}

window.__lucrit = {
  world, scroller, library, account,
  auth, dashboard, info, scriptPage, libraryPanel,
  ui: chapters, jumpTo, chapters: CHAPTERS, caps, toast,
  snap() {
    smoothed = progress;
    world?.setProgress(choreography.toCameraProgress(smoothed));
  },
};
