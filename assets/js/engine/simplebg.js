// The site background, simple edition (18 Oct 2026).
//
// "Make the background more simple and use less frames — it's lagging too
// much." The 3D WebGL world (depth of field, bloom, four blur passes, tens of
// thousands of instanced points) is no longer started. This draws the same
// mood on a plain 2D canvas: the blue glow is CSS (painted once, never
// redrawn), and the canvas only adds a few dozen drifting dots and a faint
// perspective grid floor.
//
// Budget: 20 fps on computers, 15 on phones, at 1x CSS pixels (0.75x on
// phones). Nothing is drawn while the tab is hidden, the window is in the
// background, or a full-screen sheet covers the page. Reduced motion gets one
// still frame.

const COLORS = ["61,155,255", "72,229,255", "154,107,255"];

export function startSimpleBackground(canvas, { mobile = false, reducedMotion = false } = {}) {
  const cx = canvas.getContext("2d");
  if (!cx) return null;
  const FPS = mobile ? 15 : 20;
  const SCALE = mobile ? 0.75 : 1;
  const root = document.documentElement;

  let W = 0, H = 0, t = 0, last = 0, raf = 0, focused = true;
  let dots = [];

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.max(1, Math.round(W * SCALE));
    canvas.height = Math.max(1, Math.round(H * SCALE));
    cx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    const n = W < 700 ? 28 : 56;
    dots = Array.from({ length: n }, () => ({
      x: Math.random(), y: Math.random(),
      r: 0.6 + Math.random() * 1.6,
      sp: 4 + Math.random() * 10,            // px per second, upward
      ph: Math.random() * 6.283,
      c: COLORS[(Math.random() * COLORS.length) | 0],
    }));
    draw();
  }

  function grid() {
    const horizon = H * 0.64;
    const vx = W / 2;
    cx.strokeStyle = "rgba(61,155,255,0.10)";
    cx.lineWidth = 1;
    cx.beginPath();
    for (let i = -10; i <= 10; i++) {          // lines to the vanishing point
      cx.moveTo(vx + i * 16, horizon);
      cx.lineTo(vx + i * W * 0.14, H + 30);
    }
    const off = (t * 0.12) % 1;                // rows sliding slowly toward you
    for (let r = 0; r < 10; r++) {
      const y = horizon + (H - horizon) * (0.9 / (r + 1 - off));
      if (y > horizon && y < H + 2) { cx.moveTo(0, y); cx.lineTo(W, y); }
    }
    cx.stroke();
  }

  function draw() {
    cx.clearRect(0, 0, W, H);
    grid();
    for (const d of dots) {
      const y = ((d.y * H - t * d.sp) % H + H) % H;
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
    if (now - last < 1000 / FPS - 2) return;
    t += Math.min(0.1, (now - last) / 1000);
    last = now;
    draw();
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("focus", () => { focused = true; });
  window.addEventListener("blur", () => { focused = false; });
  resize();
  if (!reducedMotion) raf = requestAnimationFrame(frame);

  return {
    fps: FPS,
    scale: SCALE,
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
