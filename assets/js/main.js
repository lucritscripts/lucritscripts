// Entry point: capability detection, the render loop, and wiring.

import { World, BANDS } from "./engine/world.js";
import { SmoothScroll } from "./engine/scroll.js";
import {
  createLibrary, createReader, buildChapters, buildChrome,
  createChoreography, CHAPTERS, toast,
} from "./ui.js";

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

/* ------------------------------------------------------------------ UI */

const reader = createReader();

const mainLibrary = createLibrary({
  id: "library-main",
  onOpen: (script) => reader.open(script),
});

const scroller = new SmoothScroll({ reducedMotion: caps.reducedMotion });

// Assigned below; jumpTo is only ever called from user interaction, but a
// declared binding keeps it safe rather than relying on that.
let choreography = null;

// Chapter content is only readable inside its sticky "pinned" window, which
// is a different fraction of every band. Land in the middle of that window.
function jumpTo(key) {
  if (!choreography || !BANDS[key]) return;
  scroller.scrollToProgress(choreography.targetFor(key));
}

buildChapters({
  library: mainLibrary,
  onOpenScript: (s) => reader.open(s),
  onJump: jumpTo,
});

const chrome = buildChrome({
  onJump: jumpTo,
  onSearch: () => {
    jumpTo("search");
    setTimeout(() => mainLibrary.focus(), 420);
  },
});

choreography = createChoreography({ chrome });

/* --------------------------------------------------------------- input */

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
    e.preventDefault();
    jumpTo("search");
    setTimeout(() => mainLibrary.focus(), 420);
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

  // Ease the camera toward scroll position so it glides rather than snaps.
  // Framerate-independent, so a 30fps device tracks at the same speed as 120fps.
  const k = caps.reducedMotion ? 1 : 1 - Math.pow(1 - 0.09, dt * 60);
  smoothed += (progress - smoothed) * k;

  if (world) {
    world.resize();
    // Remap real scroll position onto the camera path's canonical bands so the
    // 3D world and the DOM chapters stay locked together at any page height.
    world.setProgress(choreography ? choreography.toCameraProgress(smoothed) : smoothed);
    world.render(dt);
  }
}

requestAnimationFrame(frame);

/* ------------------------------------------------------------ startup */

document.documentElement.classList.add("is-ready");

// Deep link: #script=<id> opens the reader straight away.
const deep = /#script=([\w-]+)/.exec(location.hash);
if (deep) {
  import("./data/scripts.js").then(({ SCRIPTS }) => {
    const s = SCRIPTS.find((x) => x.id === deep[1]);
    if (s) reader.open(s);
  });
}

// Expose a tiny surface for debugging and for the test harness.
window.__lucrit = {
  world, scroller, reader, library: mainLibrary,
  jumpTo, chapters: CHAPTERS, caps, toast,
  setProgress(p) { scroller.scrollToProgress(p); },
  /** Test hook: drop the camera straight onto the current scroll position. */
  snap() {
    smoothed = progress;
    world?.setProgress(choreography ? choreography.toCameraProgress(smoothed) : smoothed);
  },
};
