// The site background, simple edition (18 Oct 2026).
//
// "Make the background more simple and use less frames — it's lagging too
// much." The 3D WebGL world (depth of field, bloom, four blur passes, tens of
// thousands of instanced points) is no longer started. This draws the same
// mood on a plain 2D canvas: the base blue glow is CSS (painted once, never
// redrawn), and the canvas adds a faint perspective grid floor, a few dozen
// drifting dots and one soft colour wash.
//
// Scroll (18 Oct, "add some scroll animation back to the background"): the
// background follows the page again, the way the 3D camera used to.
//   - the grid floor glides toward you as you scroll down, and its vanishing
//     point sways and rises across the page;
//   - the dots move with parallax (bigger, "nearer" dots move faster);
//   - the colour wash drifts across the screen and shifts blue → cyan →
//     violet from the top of the page to the bottom.
// The scroll position is eased, so a flick glides instead of jumping.
//
// Budget: 20 fps on computers, 15 on phones while still; 30 / 24 only while
// the page is actually scrolling (and for a moment after, while it eases).
// 1x CSS pixels (0.75x on phones). Nothing is drawn while the tab is hidden,
// the window is in the background, or a full-screen sheet covers the page.
// Reduced motion gets one still frame and no scroll movement.

const COLORS = ["61,155,255", "72,229,255", "154,107,255"];
const WASH = [[61, 155, 255], [72, 229, 255], [154, 107, 255], [61, 155, 255]];

function mix(stops, p) {
  const x = Math.min(0.9999, Math.max(0, p)) * (stops.length - 1);
  const i = Math.floor(x), f = x - i, a = stops[i], b = stops[i + 1];
  return a.map((v, k) => Math.round(v + (b[k] - v) * f));
}

export function startSimpleBackground(canvas, { mobile = false, reducedMotion = false } = {}) {
  const cx = canvas.getContext("2d");
  if (!cx) return null;
  const FPS = mobile ? 15 : 20;
  const SCROLL_FPS = mobile ? 24 : 30;
  const SCALE = mobile ? 0.75 : 1;
  const root = document.documentElement;

  let W = 0, H = 0, t = 0, last = 0, raf = 0, focused = true;
  let sy = window.scrollY || 0;     // eased scroll position (CSS px)
  let busyUntil = 0;                // scrolling, or still easing toward it
  let dots = [];

  // One soft blob, drawn once small and scaled up each frame — cheap.
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = 128;
  {
    const s = sprite.getContext("2d");
    const g = s.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,0.35)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    s.fillStyle = g;
    s.fillRect(0, 0, 128, 128);
  }
  const tint = document.createElement("canvas");
  tint.width = tint.height = 128;
  const tx = tint.getContext("2d");
  let tintKey = "";

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.max(1, Math.round(W * SCALE));
    canvas.height = Math.max(1, Math.round(H * SCALE));
    cx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    const n = W < 700 ? 28 : 56;
    dots = Array.from({ length: n }, () => {
      const r = 0.6 + Math.random() * 1.6;
      return {
        x: Math.random(), y: Math.random(), r,
        sp: 4 + Math.random() * 10,            // px per second, upward drift
        par: 0.06 + (r - 0.6) * 0.16,          // scroll parallax: nearer = faster
        ph: Math.random() * 6.283,
        c: COLORS[(Math.random() * COLORS.length) | 0],
      };
    });
    draw();
  }

  const progress = () => {
    const max = Math.max(1, document.documentElement.scrollHeight - H);
    return Math.min(1, Math.max(0, sy / max));
  };

  function wash(p) {
    const [r, g, b] = mix(WASH, p);
    const key = `${r},${g},${b}`;
    if (key !== tintKey) {                     // recolour the sprite only on change
      tintKey = key;
      tx.globalCompositeOperation = "copy";
      tx.drawImage(sprite, 0, 0);
      tx.globalCompositeOperation = "source-in";
      tx.fillStyle = `rgb(${key})`;
      tx.fillRect(0, 0, 128, 128);
    }
    const size = Math.max(W, H) * 0.9;
    const x = W * (0.5 + 0.34 * Math.sin(p * Math.PI * 2.2 + 0.6)) - size / 2;
    const y = H * (0.42 + 0.22 * Math.cos(p * Math.PI * 1.6)) - size / 2;
    cx.globalAlpha = 0.2;
    cx.drawImage(tint, x, y, size, size);
    cx.globalAlpha = 1;
  }

  function grid(p) {
    const horizon = H * (0.66 - 0.14 * p);    // the floor tilts up as you go down
    const vx = W / 2 + Math.sin(p * Math.PI * 2) * W * 0.09;
    const [r, g, b] = mix(WASH, p);
    cx.strokeStyle = `rgba(${r},${g},${b},0.14)`;
    cx.lineWidth = 1;
    cx.beginPath();
    for (let i = -10; i <= 10; i++) {          // lines to the vanishing point
      cx.moveTo(vx + i * 16, horizon);
      cx.lineTo(W / 2 + i * W * 0.14, H + 30);
    }
    // Rows slide toward you slowly on their own, and faster as you scroll.
    const off = ((t * 0.12 + sy / 260) % 1 + 1) % 1;
    for (let k = 0; k < 10; k++) {
      const y = horizon + (H - horizon) * (0.9 / (k + 1 - off));
      if (y > horizon && y < H + 2) { cx.moveTo(0, y); cx.lineTo(W, y); }
    }
    cx.stroke();
  }

  function draw() {
    const p = progress();
    cx.clearRect(0, 0, W, H);
    wash(p);
    grid(p);
    for (const d of dots) {
      const y = ((d.y * H - t * d.sp - sy * d.par) % H + H) % H;
      const a = 0.22 + 0.28 * Math.sin(t * 0.8 + d.ph);
      cx.fillStyle = `rgba(${d.c},${a.toFixed(3)})`;
      cx.beginPath();
      cx.arc(d.x * W, y, d.r, 0, 6.283);
      cx.fill();
    }
  }

  const paused = () => document.hidden || !focused || root.classList.contains("is-locked");

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (paused()) { last = now; return; }
    const fps = now < busyUntil ? SCROLL_FPS : FPS;
    if (now - last < 1000 / fps - 2) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    t += dt;
    last = now;
    // Ease toward the real scroll position; keep the faster rate until settled.
    const target = window.scrollY || 0;
    const gap = target - sy;
    sy = Math.abs(gap) < 0.5 ? target : sy + gap * Math.min(1, dt * 7);
    if (Math.abs(gap) >= 0.5) busyUntil = Math.max(busyUntil, now + 120);
    draw();
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("scroll", () => { busyUntil = performance.now() + 450; }, { passive: true });
  window.addEventListener("focus", () => { focused = true; });
  window.addEventListener("blur", () => { focused = false; });
  resize();
  if (!reducedMotion) raf = requestAnimationFrame(frame);

  return {
    fps: FPS,
    scrollFps: SCROLL_FPS,
    scale: SCALE,
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
