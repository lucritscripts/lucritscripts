// The persistent 3D world. One scene graph, one camera, driven entirely by scroll.

import {
  mat4, perspective, lookAt, multiply, rollView,
  makeProgram, createTarget, resizeTarget,
  clamp, lerp, ease, map, smootherstep, makeRng, hsl, hexToRgb,
} from "./core.js";

/* ================================================================
   Journey layout — scroll progress 0..1 maps to world Z 0..-JOURNEY
   ================================================================ */

export const JOURNEY = 920;

export const BANDS = {
  hero:      [0.000, 0.087],
  universe:  [0.087, 0.196],
  search:    [0.196, 0.293],
  vault:     [0.293, 0.457],
  categories:[0.457, 0.652],
  featured:  [0.652, 0.761],
  community: [0.761, 0.870],
  submit:    [0.870, 0.935],
  finale:    [0.935, 1.000],
};

const zAt = (p) => -JOURNEY * p;

/* ================================================================
   Instance buffers
   ================================================================ */

// 20 floats / instance, laid out as five vec4 attributes.
const BOX_STRIDE = 20;

class BoxBuilder {
  constructor() { this.data = []; }

  push({
    pos, scale, color, emissive = 0.0, kind = 0, seed = 0,
    spin = 0, orbit = 0, pivot = [0, 0, 0], wobble = 0, phase = 0,
  }) {
    this.data.push(
      pos[0], pos[1], pos[2], seed,
      scale[0], scale[1], scale[2], kind,
      color[0], color[1], color[2], emissive,
      pivot[0], pivot[1], pivot[2], spin,
      orbit, wobble, phase, 0
    );
  }

  get count() { return this.data.length / BOX_STRIDE; }
  toArray() { return new Float32Array(this.data); }
}

// 12 floats / instance -> three vec4s
const SHARD_STRIDE = 12;

class ShardBuilder {
  constructor() { this.data = []; }
  push({ pos, size, color, seed, row, spin = 0, bright = 1, col = 0 }) {
    this.data.push(
      pos[0], pos[1], pos[2], seed,
      size[0], size[1], row, spin,
      color[0], color[1], color[2], bright
    );
    this._lastCol = col;
  }
  get count() { return this.data.length / SHARD_STRIDE; }
  toArray() { return new Float32Array(this.data); }
}

/* ================================================================
   Palette
   ================================================================ */

const C = {
  blue:    hexToRgb("#3d9bff"),
  cyan:    hexToRgb("#48e5ff"),
  ice:     hexToRgb("#cfe8ff"),
  white:   hexToRgb("#ffffff"),
  purple:  hexToRgb("#9a6bff"),
  red:     hexToRgb("#ff4d5e"),
  charcoal:hexToRgb("#121724"),
  slate:   hexToRgb("#2a3247"),
  green:   hexToRgb("#2fe0a6"),
  pink:    hexToRgb("#ff6fd8"),
  amber:   hexToRgb("#ffb547"),
  steel:   hexToRgb("#7f93ad"),
};

const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/* ================================================================
   World content
   ================================================================ */

function buildBoxes(quality) {
  const B = new BoxBuilder();
  const rng = makeRng(20260812);
  const dense = quality === "high" ? 1 : quality === "medium" ? 0.55 : 0.3;
  const n = (x) => Math.max(4, Math.round(x * dense));

  /* ---------------- HERO : z -12 .. -70 ---------------- */

  const heroPivot = [8.5, 3.0, -31];

  // Core shell — the centrepiece object.
  const shellCount = n(74);
  for (let i = 0; i < shellCount; i++) {
    const t = (i + 0.5) / shellCount;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const r = 3.9 + rng() * 0.6;
    const p = [
      heroPivot[0] + Math.sin(phi) * Math.cos(theta) * r,
      heroPivot[1] + Math.cos(phi) * r * 0.92,
      heroPivot[2] + Math.sin(phi) * Math.sin(theta) * r,
    ];
    const hot = rng();
    B.push({
      pos: p,
      scale: [0.5 + rng() * 0.46, 0.5 + rng() * 0.46, 0.5 + rng() * 0.46],
      color: hot > 0.78 ? C.white : mixc(C.blue, C.cyan, rng()),
      emissive: hot > 0.78 ? 1.0 : 0.45 + rng() * 0.35,
      kind: 3,
      seed: rng() * 100,
      spin: 0.18 + rng() * 0.25,
      orbit: 0.11,
      pivot: heroPivot,
      wobble: 0.12,
      phase: rng() * 6.28,
    });
  }

  // Inner solid mass so the shell reads as one object.
  B.push({
    pos: heroPivot, scale: [2.7, 2.7, 2.7], color: C.ice, emissive: 1.0,
    kind: 3, seed: 3, spin: 0.09, orbit: 0.11, pivot: heroPivot, phase: 0,
  });

  // Halo: a thin ring of embers orbiting the core.
  for (let i = 0; i < n(60); i++) {
    const a = (i / n(60)) * Math.PI * 2;
    const r = 7.2 + rng() * 1.4;
    B.push({
      pos: [heroPivot[0] + Math.cos(a) * r, heroPivot[1] + (rng() - 0.5) * 1.2,
            heroPivot[2] + Math.sin(a) * r],
      scale: [0.17, 0.17, 0.17],
      color: rng() > 0.5 ? C.cyan : C.ice,
      emissive: 1.0, kind: 1, seed: rng() * 100,
      spin: 0.7, orbit: -0.16, pivot: heroPivot,
      wobble: 0.25, phase: rng() * 6.28,
    });
  }

  // Debris field around the hero.
  for (let i = 0; i < n(120); i++) {
    const a = rng() * Math.PI * 2;
    const r = 13 + rng() * 30;
    const s = 0.16 + rng() * 0.55;
    B.push({
      pos: [Math.cos(a) * r, -3 + rng() * 16, -8 - rng() * 62],
      scale: [s, s, s],
      color: rng() > 0.85 ? C.cyan : mixc(C.charcoal, C.slate, rng()),
      emissive: rng() > 0.85 ? 0.7 : 0.06,
      kind: 1, seed: rng() * 100,
      spin: (rng() - 0.5) * 0.5,
      wobble: 0.3 + rng(), phase: rng() * 6.28,
    });
  }

  // Ground grid — long thin bars, receding.
  for (let i = 0; i < n(46); i++) {
    const z = -6 - i * 3.6;
    B.push({
      pos: [0, -6.5, z], scale: [46, 0.05, 0.06],
      color: mixc(C.blue, C.charcoal, 0.78), emissive: 0.10, kind: 2, seed: i,
    });
  }
  for (let i = 0; i < n(17); i++) {
    const x = -44 + i * 5.5;
    B.push({
      pos: [x, -6.5, -90], scale: [0.06, 0.05, 176],
      color: mixc(C.blue, C.charcoal, 0.82), emissive: 0.07, kind: 2, seed: i,
    });
  }

  // Distant pillars framing the hero.
  for (let i = 0; i < n(22); i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const z = -18 - Math.floor(i / 2) * 13;
    const h = 16 + rng() * 26;
    B.push({
      pos: [side * (26 + rng() * 12), -6 + h / 2, z],
      scale: [1.4, h, 1.4],
      color: C.charcoal, emissive: 0.02, kind: 0, seed: i,
    });
  }

  /* ---------------- UNIVERSE : z -80 .. -190 ---------------- */
  // Sparse geometry; the density here comes from code shards.

  for (let i = 0; i < n(190); i++) {
    const a = rng() * Math.PI * 2;
    const r = 4 + rng() * 30;
    const s = 0.15 + rng() * 0.55;
    B.push({
      pos: [Math.cos(a) * r, Math.sin(a) * r * 0.55 + 3, -80 - rng() * 112],
      scale: [s, s, s],
      color: rng() > 0.6 ? C.cyan : C.blue,
      emissive: 0.5 + rng() * 0.5,
      kind: 1, seed: rng() * 100,
      spin: (rng() - 0.5) * 0.9,
      wobble: 0.5, phase: rng() * 6.28,
    });
  }

  /* ---------------- ARCHIVE / SEARCH : z -190 .. -285 ---------------- */
  // Two colossal walls of stacked panels: the "digital archive".

  for (let side of [-1, 1]) {
    for (let row = 0; row < n(16); row++) {
      for (let col = 0; col < n(15); col++) {
        const z = -192 - col * 6.2;
        const y = -4 + row * 2.3;
        const lit = rng() > 0.72;
        B.push({
          pos: [side * (17 + (row % 3) * 0.6), y, z],
          scale: [0.35, 1.9, 5.0],
          color: lit ? mixc(C.blue, C.cyan, rng()) : C.charcoal,
          emissive: lit ? 0.55 + rng() * 0.4 : 0.05,
          kind: 0, seed: rng() * 100,
          wobble: 0, phase: rng() * 6.28,
        });
      }
    }
  }

  // Arch ribs overhead.
  for (let i = 0; i < n(16); i++) {
    const z = -196 - i * 6;
    B.push({
      pos: [0, 34, z], scale: [40, 0.5, 0.5],
      color: C.blue, emissive: 0.5, kind: 0, seed: i,
    });
  }

  /* ---------------- VAULT : z -285 .. -430 ---------------- */
  // Hundreds of floating script cards.

  const cardCount = n(260);
  for (let i = 0; i < cardCount; i++) {
    const ring = Math.floor(i / 10);
    const idx = i % 10;
    // Cards hug a corridor wall: never inside the camera's flight path.
    const a = (idx / 10) * Math.PI * 2 + ring * 0.42;
    const r = 13 + (ring % 5) * 4.4 + rng() * 2.2;
    const z = -288 - ring * 5.4 - rng() * 2.5;
    B.push({
      pos: [Math.cos(a) * r, 2.5 + Math.sin(a) * r * 0.55, z],
      scale: [4.2, 2.6, 0.1],
      color: mixc(C.blue, C.ice, 0.25 + rng() * 0.5),
      emissive: 0.5 + rng() * 0.4,
      kind: 4, seed: rng() * 100,
      spin: 0, orbit: 0.018,
      pivot: [0, 2.5, z],
      wobble: 0.4, phase: rng() * 6.28,
    });
  }

  // A few colossal cards deeper out, for scale.
  for (let i = 0; i < n(14); i++) {
    const a = rng() * Math.PI * 2;
    const r = 34 + rng() * 14;
    const z = -292 - rng() * 128;
    B.push({
      pos: [Math.cos(a) * r, 3 + Math.sin(a) * r * 0.5, z],
      scale: [13, 8, 0.2],
      color: mixc(C.blue, C.ice, 0.4),
      emissive: 0.5,
      kind: 4, seed: rng() * 100,
      orbit: 0.01, pivot: [0, 3, z], wobble: 0.6, phase: rng() * 6.28,
    });
  }

  /* ---------------- CATEGORY WORLDS : z -430 .. -612 ----------------
     The camera flies above each world, so everything sits below the
     flight path and reads as a distinct island rather than clutter. */

  const CAT_Z = [-444, -474, -504, -534, -564, -594];
  const FLOOR = -16;   // worlds live below this; the camera stays above

  // A dark platform under every world so the frame is never empty.
  const platform = (cz, tint) => {
    for (let i = 0; i < n(26); i++) {
      const a = rng() * Math.PI * 2;
      const r = rng() * 30;
      B.push({
        pos: [Math.cos(a) * r, FLOOR - 2 - rng() * 3, cz + Math.sin(a) * r * 0.8],
        scale: [4 + rng() * 7, 0.6, 4 + rng() * 7],
        color: mixc(C.charcoal, tint, 0.10),
        emissive: 0.02, kind: 0, seed: rng() * 100,
      });
    }
  };

  // COMBAT — arena rim, energy blades, embers.
  {
    const cz = CAT_Z[0];
    platform(cz, C.red);
    for (let i = 0; i < n(52); i++) {
      const a = (i / n(52)) * Math.PI * 2;
      const r = 26;
      const h = 5 + rng() * 11;
      B.push({
        pos: [Math.cos(a) * r, FLOOR + h / 2, cz + Math.sin(a) * r * 0.8],
        scale: [3.0, h, 1.6],
        color: mixc(C.charcoal, C.red, 0.22), emissive: 0.06,
        kind: 0, seed: rng() * 100,
      });
    }
    for (let i = 0; i < n(26); i++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 18;
      B.push({
        pos: [Math.cos(a) * r, FLOOR + 2 + rng() * 10, cz + Math.sin(a) * r * 0.8],
        scale: [0.16, 3.0 + rng() * 2.4, 0.16],
        color: C.red, emissive: 0.7,
        kind: 1, seed: rng() * 100,
        spin: 0.4 + rng() * 0.6, wobble: 0.6, phase: rng() * 6.28,
      });
    }
    for (let i = 0; i < n(46); i++) {
      B.push({
        pos: [(rng() - 0.5) * 52, FLOOR + rng() * 20, cz + (rng() - 0.5) * 40],
        scale: [0.14, 0.14, 0.14],
        color: mixc(C.red, C.amber, rng()), emissive: 1.0,
        kind: 1, seed: rng() * 100, spin: 1.2, wobble: 1.3, phase: rng() * 6.28,
      });
    }
  }

  // NPC — a city of towers with blocky inhabitants.
  {
    const cz = CAT_Z[1];
    platform(cz, C.purple);
    for (let i = 0; i < n(64); i++) {
      const a = rng() * Math.PI * 2;
      const r = 9 + rng() * 26;
      const h = 8 + rng() * 17;
      B.push({
        pos: [Math.cos(a) * r, FLOOR + h / 2, cz + Math.sin(a) * r * 0.8],
        scale: [3.0 + rng() * 2.6, h, 3.0 + rng() * 2.6],
        color: mixc(C.charcoal, C.purple, 0.22 + rng() * 0.16),
        emissive: 0.06, kind: 7, seed: rng() * 100,
      });
    }
    for (let i = 0; i < n(20); i++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 22;
      const x = Math.cos(a) * r;
      const z = cz + Math.sin(a) * r * 0.8;
      const base = FLOOR;
      B.push({ pos: [x, base + 2.6, z], scale: [1.2, 1.7, 0.7], color: C.purple, emissive: 0.85, kind: 6, seed: rng() * 100, wobble: 0.18, phase: rng() * 6.28 });
      B.push({ pos: [x, base + 4.1, z], scale: [0.7, 0.7, 0.7], color: C.purple, emissive: 0.85, kind: 6, seed: rng() * 100, wobble: 0.18, phase: rng() * 6.28 });
      B.push({ pos: [x, base + 1.0, z], scale: [1.0, 1.7, 0.6], color: mixc(C.purple, C.charcoal, 0.45), emissive: 0.4, kind: 6, seed: rng() * 100, wobble: 0.18, phase: rng() * 6.28 });
    }
  }

  // UI — a lattice of holographic panels.
  {
    const cz = CAT_Z[2];
    platform(cz, C.cyan);
    for (let i = 0; i < n(76); i++) {
      const a = rng() * Math.PI * 2;
      const r = 7 + rng() * 26;
      const w = 2.4 + rng() * 5.5;
      B.push({
        pos: [Math.cos(a) * r, FLOOR + 2 + rng() * 22, cz + Math.sin(a) * r * 0.8],
        scale: [w * 0.8, w * (0.42 + rng() * 0.34), 0.06],
        color: mixc(C.cyan, C.ice, rng() * 0.28),
        emissive: 0.3 + rng() * 0.22,
        kind: 4, seed: rng() * 100,
        spin: (rng() - 0.5) * 0.12, wobble: 0.7, phase: rng() * 6.28,
      });
    }
  }

  // DATA — a lattice of cubes and vertical information streams.
  {
    const cz = CAT_Z[3];
    platform(cz, C.green);
    const g = n(8);
    for (let x = 0; x < g; x++) {
      for (let y = 0; y < g; y++) {
        for (let z = 0; z < 4; z++) {
          if (rng() > 0.5) continue;
          B.push({
            pos: [(x - g / 2) * 6.4, FLOOR + 3 + y * 3.4, cz + (z - 1.5) * 7],
            scale: [0.9, 0.9, 0.9],
            color: mixc(C.green, C.cyan, rng()),
            emissive: 0.55 + rng() * 0.45,
            kind: 1, seed: rng() * 100,
            spin: 0.25, wobble: 0.35, phase: rng() * 6.28,
          });
        }
      }
    }
    for (let i = 0; i < n(30); i++) {
      const a = rng() * Math.PI * 2;
      const r = 10 + rng() * 22;
      B.push({
        pos: [Math.cos(a) * r, FLOOR + 16, cz + Math.sin(a) * r * 0.8],
        scale: [0.07, 34, 0.07],
        color: C.green, emissive: 0.7, kind: 2, seed: rng() * 100,
      });
    }
  }

  // SHOPS — a lit marketplace of stalls.
  {
    const cz = CAT_Z[4];
    platform(cz, C.pink);
    for (let i = 0; i < n(24); i++) {
      const a = rng() * Math.PI * 2;
      const r = 8 + rng() * 24;
      const x = Math.cos(a) * r;
      const z = cz + Math.sin(a) * r * 0.8;
      B.push({ pos: [x, FLOOR + 0.4, z], scale: [5.0, 0.4, 4.0], color: C.charcoal, emissive: 0.05, kind: 0, seed: rng() * 100 });
      B.push({ pos: [x, FLOOR + 3.4, z], scale: [5.4, 0.2, 4.4], color: C.pink, emissive: 0.8, kind: 0, seed: rng() * 100 });
      B.push({ pos: [x - 2.3, FLOOR + 1.9, z], scale: [0.18, 3.0, 0.18], color: mixc(C.pink, C.ice, 0.5), emissive: 0.55, kind: 0, seed: rng() * 100 });
      B.push({ pos: [x + 2.3, FLOOR + 1.9, z], scale: [0.18, 3.0, 0.18], color: mixc(C.pink, C.ice, 0.5), emissive: 0.55, kind: 0, seed: rng() * 100 });
    }
    for (let i = 0; i < n(40); i++) {
      B.push({
        pos: [(rng() - 0.5) * 56, FLOOR + 4 + rng() * 18, cz + (rng() - 0.5) * 42],
        scale: [0.26, 0.26, 0.26], color: mixc(C.pink, C.amber, rng()),
        emissive: 1.0, kind: 1, seed: rng() * 100, spin: 0.8, wobble: 1.0, phase: rng() * 6.28,
      });
    }
  }

  // UTILITIES — interlocking gears and connected modules.
  {
    const cz = CAT_Z[5];
    platform(cz, C.steel);
    for (let g = 0; g < n(10); g++) {
      const a = rng() * Math.PI * 2;
      const r = 7 + rng() * 22;
      const gx = Math.cos(a) * r;
      const gy = FLOOR + 3 + rng() * 18;
      const gz = cz + Math.sin(a) * r * 0.8;
      const radius = 2.8 + rng() * 3.6;
      const teeth = 10 + Math.floor(rng() * 8);
      const spin = (rng() - 0.5) * 0.7;
      const pivot = [gx, gy, gz];
      for (let t = 0; t < teeth; t++) {
        const ta = (t / teeth) * Math.PI * 2;
        B.push({
          pos: [gx + Math.cos(ta) * radius, gy + Math.sin(ta) * radius, gz],
          scale: [1.0, 0.55, 0.8],
          color: mixc(C.steel, C.blue, 0.4), emissive: 0.34,
          kind: 5, seed: rng() * 100,
          orbit: spin, pivot, phase: rng() * 6.28,
        });
      }
      B.push({
        pos: pivot, scale: [1.3, 1.3, 1.0],
        color: mixc(C.steel, C.ice, 0.35), emissive: 0.45, kind: 5,
        seed: rng() * 100, spin: spin * 0.5, pivot, phase: 0,
      });
    }
    for (let i = 0; i < n(26); i++) {
      const horiz = rng() > 0.5;
      B.push({
        pos: [(rng() - 0.5) * 50, FLOOR + 3 + rng() * 20, cz + (rng() - 0.5) * 38],
        scale: [horiz ? 10 + rng() * 10 : 0.09, 0.09, horiz ? 0.09 : 10 + rng() * 10],
        color: C.steel, emissive: 0.35, kind: 2, seed: rng() * 100,
      });
    }
  }

  /* ---------------- FEATURED : z -615 .. -715 ---------------- */
  // Enormous cards in a slow orbit the camera arcs around.

  {
    const pivot = [0, 4, -664];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = 20;
      B.push({
        pos: [Math.cos(a) * r, 4 + Math.sin(i * 1.7) * 4, -664 + Math.sin(a) * r],
        scale: [9.5, 6.0, 0.16],
        color: mixc(C.blue, C.ice, 0.35 + (i % 3) * 0.16),
        emissive: 0.75,
        kind: 4, seed: i * 13,
        orbit: 0.055, pivot, wobble: 0.5, phase: i * 0.8,
      });
    }
    for (let i = 0; i < n(80); i++) {
      B.push({
        pos: [(rng() - 0.5) * 70, -6 + rng() * 30, -618 - rng() * 92],
        scale: [0.2, 0.2, 0.2],
        color: mixc(C.blue, C.white, rng()), emissive: 0.9,
        kind: 1, seed: rng() * 100, spin: 0.5, wobble: 1.4, phase: rng() * 6.28,
      });
    }
  }

  /* ---------------- COMMUNITY : z -718 .. -812 ---------------- */
  // Floating islands with small settlements.

  {
    for (let i = 0; i < n(34); i++) {
      const x = (rng() - 0.5) * 70;
      const y = -14 + rng() * 34;
      const z = -722 - rng() * 86;
      const w = 5 + rng() * 9;
      B.push({ pos: [x, y, z], scale: [w, 0.8, w * 0.8], color: C.charcoal, emissive: 0.06, kind: 1, seed: rng() * 100, wobble: 0.5, phase: rng() * 6.28 });
      const huts = 2 + Math.floor(rng() * 3);
      for (let h = 0; h < huts; h++) {
        const hh = 1.4 + rng() * 3.4;
        B.push({
          pos: [x + (rng() - 0.5) * w * 0.7, y + 0.4 + hh / 2, z + (rng() - 0.5) * w * 0.6],
          scale: [1.1 + rng(), hh, 1.1 + rng()],
          color: mixc(C.slate, C.blue, 0.3 + rng() * 0.3),
          emissive: 0.3,
          kind: 7, seed: rng() * 100, wobble: 0.5, phase: rng() * 6.28,
        });
      }
    }
    // Light bridges between islands.
    for (let i = 0; i < n(24); i++) {
      B.push({
        pos: [(rng() - 0.5) * 60, -10 + rng() * 28, -726 - rng() * 78],
        scale: [10 + rng() * 16, 0.06, 0.06],
        color: C.cyan, emissive: 0.65, kind: 2, seed: rng() * 100,
      });
    }
  }

  /* ---------------- SUBMIT : z -815 .. -866 ---------------- */

  {
    const cz = -840;
    const w = 11, h = 7;
    B.push({ pos: [0,  h, cz], scale: [w * 2, 0.16, 0.16], color: C.cyan, emissive: 0.9, kind: 0, seed: 1 });
    B.push({ pos: [0, -h, cz], scale: [w * 2, 0.16, 0.16], color: C.cyan, emissive: 0.9, kind: 0, seed: 2 });
    B.push({ pos: [-w, 0, cz], scale: [0.16, h * 2, 0.16], color: C.cyan, emissive: 0.9, kind: 0, seed: 3 });
    B.push({ pos: [ w, 0, cz], scale: [0.16, h * 2, 0.16], color: C.cyan, emissive: 0.9, kind: 0, seed: 4 });

    for (let i = 0; i < n(46); i++) {
      const a = rng() * Math.PI * 2;
      const r = 13 + rng() * 12;
      B.push({
        pos: [Math.cos(a) * r, Math.sin(a) * r * 0.7, cz + (rng() - 0.5) * 30],
        scale: [0.3, 0.3, 0.3],
        color: mixc(C.cyan, C.ice, rng()), emissive: 0.95,
        kind: 1, seed: rng() * 100, spin: 0.6,
        orbit: 0.09, pivot: [0, 0, cz], wobble: 0.6, phase: rng() * 6.28,
      });
    }
  }

  /* ---------------- FINALE : z -872 .. -930 ---------------- */
  // Everything falls away. One object remains.

  {
    const pivot = [0, 5.2, -946];
    const shell = n(96);
    for (let i = 0; i < shell; i++) {
      const t = (i + 0.5) / shell;
      const phi = Math.acos(1 - 2 * t);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const r = 6.6 + rng() * 0.9;
      B.push({
        pos: [
          pivot[0] + Math.sin(phi) * Math.cos(theta) * r,
          pivot[1] + Math.cos(phi) * r,
          pivot[2] + Math.sin(phi) * Math.sin(theta) * r,
        ],
        scale: [0.78, 0.78, 0.78],
        color: rng() > 0.5 ? C.white : C.ice,
        emissive: 1.0,
        kind: 3, seed: rng() * 100,
        spin: 0.3, orbit: 0.14, pivot, wobble: 0.1, phase: rng() * 6.28,
      });
    }
    B.push({
      pos: pivot, scale: [5.0, 5.0, 5.0], color: C.white, emissive: 1.0,
      kind: 3, seed: 9, spin: 0.1, orbit: 0.14, pivot, phase: 0,
    });
  }

  return B;
}

/* ---------------------------------------------------------------- */

const CODE_LINES = [
  "local Players = game:GetService(\"Players\")",
  "function Inventory:Add(id: string, count: number)",
  "humanoid:MoveTo(waypoint.Position)",
  "if not self:Allow(player) then return end",
  "local ok, result = pcall(function()",
  "task.delay(self.stats.reloadTime, function()",
  "RunService.Heartbeat:Connect(function(dt)",
  "store:UpdateAsync(key, function(old)",
  "return setmetatable({}, Inventory)",
  "hum:TakeDamage(damageFor(distance))",
  "workspace:GetPartBoundsInBox(cf, size, params)",
  "path:ComputeAsync(root.Position, destination)",
  "player:SetAttribute(\"Stamina\", stamina)",
  "signal:Fire(player, itemId, price)",
  "TweenService:Create(frame, info, goal):Play()",
  "local trove = Trove.new()",
  "--!strict",
  "export type Stack = { id: string, count: number }",
  "for _, player in Players:GetPlayers() do",
  "Lighting.ClockTime = clock",
  "game:BindToClose(function()",
  "remote.OnServerEvent:Connect(handler)",
  "local rng = Random.new()",
  "self.humanoid.WalkSpeed = CONFIG.SprintSpeed",
  "table.insert(self.items, item)",
  "if hit.Instance:IsA(\"BasePart\") then",
  "local track = animator:LoadAnimation(anim)",
  "coins.Value -= PRICE",
  "OverlapParams.new()",
  "math.clamp(value, 0, 200)",
  "CFrame.new(position) * CFrame.Angles(0, y, 0)",
  "Vector3.new(x, 0, z).Unit",
];

/** Draws Luau into a texture atlas — 32 rows, one line each. */
function makeCodeTexture(gl) {
  const W = 1024, H = 1024, ROWS = 32, ROW_H = H / ROWS;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");

  ctx.clearRect(0, 0, W, H);
  ctx.font = "600 21px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";

  for (let r = 0; r < ROWS; r++) {
    const line = CODE_LINES[r % CODE_LINES.length];
    ctx.fillText(line, 8, r * ROW_H + ROW_H / 2);
  }

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function buildShards(quality) {
  const S = new ShardBuilder();
  const rng = makeRng(777001);
  const total = quality === "high" ? 2600 : quality === "medium" ? 1100 : 420;

  for (let i = 0; i < total; i++) {
    // Weighted toward the universe corridor, with a tail across the journey.
    let z;
    const roll = rng();
    if (roll < 0.55)      z = -76 - rng() * 120;   // universe
    else if (roll < 0.72) z = -190 - rng() * 96;   // archive
    else if (roll < 0.86) z = -286 - rng() * 146;  // vault
    else                  z = -430 - rng() * 400;  // everywhere after

    const a = rng() * Math.PI * 2;
    const r = 3 + rng() * 34;
    const near = rng() > 0.72;

    S.push({
      pos: [Math.cos(a) * r, Math.sin(a) * r * 0.62 + 3, z],
      size: [near ? 4.5 + rng() * 3 : 2.2 + rng() * 2.2, near ? 0.56 : 0.3],
      color: rng() > 0.7 ? C.cyan : rng() > 0.4 ? C.blue : C.ice,
      seed: rng() * 100,
      row: Math.floor(rng() * 32),
      spin: (rng() - 0.5) * 0.35,
      bright: near ? 1.0 : 0.45 + rng() * 0.4,
    });
  }

  return S;
}

/* ================================================================
   Shaders
   ================================================================ */

const BOX_VS = `#version 300 es
precision highp float;

layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_normal;
layout(location=2) in vec4 a_offsetSeed;   // xyz offset, w seed
layout(location=3) in vec4 a_scaleKind;    // xyz scale, w kind
layout(location=4) in vec4 a_colorEmis;    // rgb colour, a emissive
layout(location=5) in vec4 a_pivotSpin;    // xyz pivot, w spin
layout(location=6) in vec4 a_misc;         // x orbit, y wobble, z phase, w -

uniform mat4 u_viewProj;
uniform float u_time;
uniform float u_motion;      // 0 when reduced-motion
uniform float u_dissolve;    // finale: fades the world away
uniform float u_camZ;

out vec3 v_normal;
out vec3 v_color;
out float v_emissive;
out float v_depth;
out float v_fade;
out vec3 v_local;
out float v_kind;

mat3 axisAngle(vec3 axis, float angle) {
  float c = cos(angle), s = sin(angle), t = 1.0 - c;
  vec3 a = normalize(axis);
  return mat3(
    t*a.x*a.x + c,      t*a.x*a.y + s*a.z,  t*a.x*a.z - s*a.y,
    t*a.x*a.y - s*a.z,  t*a.y*a.y + c,      t*a.y*a.z + s*a.x,
    t*a.x*a.z + s*a.y,  t*a.y*a.z - s*a.x,  t*a.z*a.z + c
  );
}

void main() {
  vec3 offset = a_offsetSeed.xyz;
  float seed  = a_offsetSeed.w;
  vec3 scale  = a_scaleKind.xyz;
  float kind  = a_scaleKind.w;
  vec3 pivot  = a_pivotSpin.xyz;
  float spin  = a_pivotSpin.w;
  float orbit = a_misc.x;
  float wobble= a_misc.y;
  float phase = a_misc.z;

  float t = u_time * u_motion;

  // local tumble
  vec3 axis = normalize(vec3(sin(seed), cos(seed * 1.7) + 0.4, sin(seed * 2.3)));
  vec3 local = a_pos * scale;
  vec3 nrm = a_normal;

  if (abs(spin) > 0.0001) {
    mat3 R = axisAngle(axis, t * spin + phase);
    local = R * local;
    nrm = R * nrm;
  }

  vec3 world = offset;

  // vertical bob
  world.y += sin(t * 0.6 + phase) * wobble;

  // orbit about a pivot (Y for most, Z for gears)
  if (abs(orbit) > 0.0001) {
    vec3 rel = world - pivot;
    float o = t * orbit;
    float c = cos(o), s = sin(o);
    if (kind > 4.5 && kind < 5.5) {
      rel = vec3(rel.x * c - rel.y * s, rel.x * s + rel.y * c, rel.z);
    } else {
      rel = vec3(rel.x * c + rel.z * s, rel.y, -rel.x * s + rel.z * c);
    }
    world = pivot + rel;
  }

  vec3 pos = world + local;

  // Finale: everything that is not the final object drifts apart and fades.
  float isFinale = step(abs(offset.z + 946.0), 22.0);
  float away = u_dissolve * (1.0 - isFinale);
  pos += normalize(vec3(sin(seed * 3.1), cos(seed * 2.2), sin(seed))) * away * 150.0;

  v_fade = 1.0 - away;
  v_local = a_pos;
  v_kind = kind;
  v_normal = nrm;
  v_color = a_colorEmis.rgb;
  v_emissive = a_colorEmis.a;

  gl_Position = u_viewProj * vec4(pos, 1.0);
  v_depth = length(pos - vec3(0.0, 0.0, u_camZ));
}`;

const BOX_FS = `#version 300 es
precision highp float;

in vec3 v_normal;
in vec3 v_color;
in float v_emissive;
in float v_depth;
in float v_fade;
in vec3 v_local;
in float v_kind;

uniform vec3 u_fogColor;
uniform float u_fogNear;
uniform float u_fogFar;
uniform float u_focus;

out vec4 frag;

void main() {
  vec3 n = normalize(v_normal);

  // Two-light rig: cool key from above, warm-blue fill from below-front.
  vec3 keyDir = normalize(vec3(0.45, 0.9, 0.3));
  vec3 fillDir = normalize(vec3(-0.5, -0.2, 0.8));

  float key = max(dot(n, keyDir), 0.0);
  float fill = max(dot(n, fillDir), 0.0);

  vec3 lit = v_color * (0.10 + key * 0.80) + vec3(0.09, 0.17, 0.34) * fill * 0.32;

  // Script cards: dark face, glowing frame, header bar and text ribs.
  float cardEmis = v_emissive;
  if (v_kind > 3.5 && v_kind < 4.5) {
    vec2 q = v_local.xy * 2.0;              // -1 .. 1 across the face
    float frame = step(0.88, max(abs(q.x), abs(q.y)));
    float header = step(0.44, q.y) * step(q.y, 0.72) * step(abs(q.x), 0.80);
    float ribs = step(abs(q.x), 0.74)
               * step(0.30, fract(q.y * 3.4))
               * step(fract(q.y * 3.4), 0.52)
               * step(q.y, 0.30) * step(-0.80, q.y);
    float ink = clamp(frame + header * 0.85 + ribs * 0.38, 0.0, 1.0);
    lit = mix(vec3(0.012, 0.020, 0.042), v_color * 1.25, ink);
    cardEmis = ink * (0.35 + v_emissive * 0.75);
  }

  // Towers: dark shells with lit window grids. No windows on the roof.
  if (v_kind > 6.5 && v_kind < 7.5) {
    vec2 uv = abs(n.x) > 0.5 ? v_local.zy : v_local.xy;
    vec2 grid = vec2(7.0, 17.0);
    vec2 cell = fract(uv * grid);
    vec2 id = floor(uv * grid);
    float pane = step(0.20, cell.x) * step(cell.x, 0.74)
               * step(0.22, cell.y) * step(cell.y, 0.70);
    float on = step(0.52, fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453));
    float win = pane * on * (1.0 - step(0.55, abs(n.y)));
    vec3 glow = mix(v_color, vec3(1.0, 0.86, 0.62), 0.45) * 1.6;
    lit = mix(v_color * 0.10, glow, win);
    cardEmis = win * 0.9;
  }

  // Emissive core plus a rim that reads as volumetric edge light.
  float rim = pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 2.2);
  vec3 color = mix(lit, v_color * 1.5, cardEmis);
  color += v_color * rim * (0.25 + cardEmis * 0.9);

  float fog = clamp((v_depth - u_fogNear) / (u_fogFar - u_fogNear), 0.0, 1.0);
  fog = fog * fog;
  color = mix(color, u_fogColor, fog);

  color *= v_fade;

  // alpha carries normalised depth for the depth-of-field composite
  float coc = clamp(abs(v_depth - u_focus) / 90.0, 0.0, 1.0);
  frag = vec4(color, coc);
}`;

const SHARD_VS = `#version 300 es
precision highp float;

layout(location=0) in vec2 a_quad;
layout(location=1) in vec4 a_offsetSeed;
layout(location=2) in vec4 a_sizeRowSpin;  // x w, y h, z row, w spin
layout(location=3) in vec4 a_colorBright;

uniform mat4 u_viewProj;
uniform vec3 u_camPos;
uniform float u_time;
uniform float u_motion;
uniform float u_dissolve;

out vec2 v_uv;
out vec3 v_color;
out float v_bright;
out float v_depth;

void main() {
  vec3 offset = a_offsetSeed.xyz;
  float seed = a_offsetSeed.w;
  float w = a_sizeRowSpin.x;
  float h = a_sizeRowSpin.y;
  float row = a_sizeRowSpin.z;
  float spin = a_sizeRowSpin.w;

  float t = u_time * u_motion;

  // Billboard toward the camera, then roll slightly so they are not all flat.
  vec3 toCam = normalize(u_camPos - offset);
  vec3 up = vec3(0.0, 1.0, 0.0);
  vec3 right = normalize(cross(up, toCam));
  up = normalize(cross(toCam, right));

  float roll = sin(t * spin + seed) * 0.35;
  float c = cos(roll), s = sin(roll);
  vec3 r2 = right * c + up * s;
  vec3 u2 = up * c - right * s;

  vec3 pos = offset
    + r2 * (a_quad.x * w)
    + u2 * (a_quad.y * h);

  pos.y += sin(t * 0.4 + seed) * 0.6;
  pos += normalize(vec3(sin(seed * 3.1), cos(seed * 2.2), sin(seed))) * u_dissolve * 150.0;

  // v spans one row of the 32-row atlas; the atlas is top-down so v is inverted
  v_uv = vec2(a_quad.x * 0.5 + 0.5, (row + (0.5 - a_quad.y * 0.5)) / 32.0);
  v_color = a_colorBright.rgb;
  v_bright = a_colorBright.a * (1.0 - u_dissolve);
  v_depth = length(pos - u_camPos);

  gl_Position = u_viewProj * vec4(pos, 1.0);
}`;

const SHARD_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
in vec3 v_color;
in float v_bright;
in float v_depth;

uniform sampler2D u_code;
uniform float u_fogFar;

out vec4 frag;

void main() {
  float a = texture(u_code, v_uv).a;
  if (a < 0.02) discard;

  float fade = 1.0 - clamp(v_depth / u_fogFar, 0.0, 1.0);
  fade *= fade;

  frag = vec4(v_color * a * v_bright * fade * 1.4, 0.0);
}`;

const PARTICLE_VS = `#version 300 es
precision highp float;

layout(location=0) in vec4 a_seedPos;   // xyz base position, w seed

uniform mat4 u_viewProj;
uniform vec3 u_camPos;
uniform float u_time;
uniform float u_motion;
uniform float u_span;
uniform float u_pointScale;

out float v_alpha;
out vec3 v_color;

void main() {
  vec3 p = a_seedPos.xyz;
  float seed = a_seedPos.w;

  // Wrap along Z so the field always surrounds the camera.
  float rel = u_camPos.z - p.z;
  p.z = u_camPos.z - (rel - floor(rel / u_span) * u_span);

  float t = u_time * u_motion;
  p.x += sin(t * 0.25 + seed * 6.0) * 1.4;
  p.y += cos(t * 0.21 + seed * 4.0) * 1.1;

  vec4 clip = u_viewProj * vec4(p, 1.0);
  gl_Position = clip;

  float dist = length(p - u_camPos);
  gl_PointSize = clamp(u_pointScale * (34.0 / max(dist, 1.0)), 1.0, 9.0);

  float near = smoothstep(2.0, 16.0, dist);
  float far = 1.0 - smoothstep(70.0, 190.0, dist);
  v_alpha = near * far * (0.25 + fract(seed * 7.3) * 0.75);
  v_color = mix(vec3(0.28, 0.62, 1.0), vec3(0.55, 0.92, 1.0), fract(seed * 3.1));
}`;

const PARTICLE_FS = `#version 300 es
precision highp float;

in float v_alpha;
in vec3 v_color;
out vec4 frag;

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  if (r > 0.5) discard;
  float falloff = pow(1.0 - r * 2.0, 2.4);
  frag = vec4(v_color * falloff * v_alpha, 0.0);
}`;

// Full-screen triangle; no vertex buffer required.
const QUAD_VS = `#version 300 es
precision highp float;
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const DOWN_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
out vec4 frag;
void main() {
  vec4 s = texture(u_tex, v_uv + u_texel * vec2(-1.0, -1.0))
         + texture(u_tex, v_uv + u_texel * vec2( 1.0, -1.0))
         + texture(u_tex, v_uv + u_texel * vec2(-1.0,  1.0))
         + texture(u_tex, v_uv + u_texel * vec2( 1.0,  1.0));
  frag = s * 0.25;
}`;

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;
out vec4 frag;
void main() {
  // 9-tap gaussian
  vec4 sum = texture(u_tex, v_uv) * 0.227027;
  vec2 o1 = u_dir * 1.3846153846;
  vec2 o2 = u_dir * 3.2307692308;
  sum += (texture(u_tex, v_uv + o1) + texture(u_tex, v_uv - o1)) * 0.3162162162;
  sum += (texture(u_tex, v_uv + o2) + texture(u_tex, v_uv - o2)) * 0.0702702703;
  frag = sum;
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;

in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_blur;
uniform float u_time;
uniform float u_bloom;
uniform float u_dof;
uniform float u_grain;
uniform vec2  u_res;

out vec4 frag;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec2 uv = v_uv;
  vec2 centred = uv - 0.5;

  // Very light chromatic aberration toward the edges.
  float ca = dot(centred, centred) * 0.0035;
  vec4 sceneR = texture(u_scene, uv + centred * ca);
  vec4 scene  = texture(u_scene, uv);
  vec4 sceneB = texture(u_scene, uv - centred * ca);
  vec3 col = vec3(sceneR.r, scene.g, sceneB.b);

  vec3 blurred = texture(u_blur, uv).rgb;

  // Depth of field: alpha channel holds circle-of-confusion.
  float coc = scene.a;
  col = mix(col, blurred, clamp(coc * u_dof, 0.0, 0.92));

  // Bloom from the same blurred buffer, thresholded.
  vec3 bloom = max(blurred - 0.32, 0.0) * u_bloom;
  col += bloom;

  // Atmospheric lift so blacks are never dead flat.
  col += vec3(0.012, 0.017, 0.030);

  // Vignette.
  float vig = smoothstep(1.05, 0.28, length(centred * vec2(1.0, 1.15)));
  col *= mix(0.42, 1.0, vig);

  // Filmic-ish tone curve.
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);

  // Fine grain.
  float g = hash(uv * u_res + fract(u_time) * 137.0) - 0.5;
  col += g * u_grain;

  frag = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

/* ================================================================
   Cube geometry (36 verts, explicit normals)
   ================================================================ */

function cubeGeometry() {
  const p = [], n = [];
  const faces = [
    { nrm: [0, 0, 1],  a: [-1, -1, 1],  b: [1, -1, 1],  c: [1, 1, 1],  d: [-1, 1, 1] },
    { nrm: [0, 0, -1], a: [1, -1, -1],  b: [-1, -1, -1],c: [-1, 1, -1],d: [1, 1, -1] },
    { nrm: [1, 0, 0],  a: [1, -1, 1],   b: [1, -1, -1], c: [1, 1, -1], d: [1, 1, 1] },
    { nrm: [-1, 0, 0], a: [-1, -1, -1], b: [-1, -1, 1], c: [-1, 1, 1], d: [-1, 1, -1] },
    { nrm: [0, 1, 0],  a: [-1, 1, 1],   b: [1, 1, 1],   c: [1, 1, -1], d: [-1, 1, -1] },
    { nrm: [0, -1, 0], a: [-1, -1, -1], b: [1, -1, -1], c: [1, -1, 1], d: [-1, -1, 1] },
  ];
  for (const f of faces) {
    for (const v of [f.a, f.b, f.c, f.a, f.c, f.d]) {
      p.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5);
      n.push(f.nrm[0], f.nrm[1], f.nrm[2]);
    }
  }
  return { positions: new Float32Array(p), normals: new Float32Array(n) };
}

/* ================================================================
   Camera path — the whole journey, as a pure function of progress
   ================================================================ */

const bump = (p, a, b) => {
  const t = clamp((p - a) / (b - a), 0, 1);
  return Math.sin(t * Math.PI);
};

export function cameraAt(p, time, pointer, motion) {
  const z = zAt(p);

  // Height accumulates in deltas so each band hands off to the next.
  let y = 2.3
    + ease(p, 0.000, 0.087, 0, 0.35)
    + ease(p, 0.087, 0.196, 0, 1.5)
    + ease(p, 0.196, 0.293, 0, 2.1)
    + ease(p, 0.293, 0.457, 0, -3.4)
    + ease(p, 0.457, 0.520, 0, 9.5)
    + ease(p, 0.600, 0.652, 0, -4.0)
    + ease(p, 0.652, 0.761, 0, 1.4)
    + ease(p, 0.761, 0.870, 0, 2.6)
    + ease(p, 0.870, 0.935, 0, -3.4)
    + ease(p, 0.935, 1.000, 0, -0.3);

  // Lateral drift returns to centre at every band boundary.
  let x =
      bump(p, 0.000, 0.087) * 0.7
    + Math.sin(clamp((p - 0.087) / 0.109, 0, 1) * Math.PI * 1.0) * 2.4
    + bump(p, 0.196, 0.293) * -1.2
    + Math.sin(clamp((p - 0.293) / 0.164, 0, 1) * Math.PI * 2.0) * 3.1
    + Math.sin(clamp((p - 0.457) / 0.195, 0, 1) * Math.PI * 3.0) * 3.6
    + Math.sin(clamp((p - 0.652) / 0.109, 0, 1) * Math.PI * 2.0) * 5.2
    + bump(p, 0.761, 0.870) * 3.0
    + bump(p, 0.870, 0.935) * -1.4
    + bump(p, 0.935, 1.000) * 1.2;

  // Idle breathing before the user has scrolled anywhere.
  const idle = (1 - smootherstep(clamp(p / 0.05, 0, 1))) * motion;
  x += Math.sin(time * 0.31) * 0.55 * idle;
  y += Math.cos(time * 0.24) * 0.35 * idle;

  // Constant subtle life, even mid-journey.
  x += Math.sin(time * 0.17) * 0.22 * motion;
  y += Math.cos(time * 0.13) * 0.16 * motion;

  // Pointer parallax.
  x += pointer.x * 1.5 * motion;
  y += pointer.y * -0.9 * motion;

  // Bank into the turns.
  const roll =
    ( Math.cos(clamp((p - 0.457) / 0.195, 0, 1) * Math.PI * 3.0) * 0.055
    + Math.cos(clamp((p - 0.652) / 0.109, 0, 1) * Math.PI * 2.0) * 0.05
    + Math.sin(time * 0.19) * 0.012) * motion
    + pointer.x * 0.03 * motion;

  const fov = (
    52
    + ease(p, 0.000, 0.087, 4, 0)      // slight zoom-in off the hero
    + ease(p, 0.293, 0.457, 0, 6)      // wide through the vault
    + ease(p, 0.652, 0.761, 0, -4)     // tighter on the featured orbit
    + ease(p, 0.935, 1.000, 0, -7)     // compress for the finale
    + Math.sin(time * 0.23) * 0.9 * motion
  );

  // Look point sits ahead and slightly toward world centre.
  const look = [
    x * 0.35 + Math.sin(time * 0.11) * 0.3 * motion,
    y * 0.82 + ease(p, 0.196, 0.293, 0, -1.4) + ease(p, 0.761, 0.870, 0, -2.0),
    z - 16,
  ];

  return { pos: [x, y, z], look, roll, fov };
}

/* ================================================================
   World
   ================================================================ */

export class World {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.quality = opts.quality || "high";
    this.motion = opts.reducedMotion ? 0 : 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality === "high" ? 2 : 1.35);

    this.progress = 0;
    this.pointer = { x: 0, y: 0 };
    this.targetPointer = { x: 0, y: 0 };
    this.time = 0;
    this.ok = false;
  }

  init() {
    const gl = this.canvas.getContext("webgl2", {
      alpha: false, antialias: false, depth: true, stencil: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!gl) return false;
    this.gl = gl;

    try { this._build(); } catch (e) {
      console.error("[world] init failed", e);
      return false;
    }

    this.ok = true;
    return true;
  }

  _build() {
    const gl = this.gl;

    this.boxProg = makeProgram(gl, BOX_VS, BOX_FS);
    this.shardProg = makeProgram(gl, SHARD_VS, SHARD_FS);
    this.pointProg = makeProgram(gl, PARTICLE_VS, PARTICLE_FS);
    this.downProg = makeProgram(gl, QUAD_VS, DOWN_FS);
    this.blurProg = makeProgram(gl, QUAD_VS, BLUR_FS);
    this.compProg = makeProgram(gl, QUAD_VS, COMPOSITE_FS);

    /* ---- boxes ---- */
    const cube = cubeGeometry();
    const boxes = buildBoxes(this.quality);
    this.boxCount = boxes.count;

    this.boxVao = gl.createVertexArray();
    gl.bindVertexArray(this.boxVao);

    const vbPos = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbPos);
    gl.bufferData(gl.ARRAY_BUFFER, cube.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const vbNrm = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbNrm);
    gl.bufferData(gl.ARRAY_BUFFER, cube.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const vbInst = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbInst);
    gl.bufferData(gl.ARRAY_BUFFER, boxes.toArray(), gl.STATIC_DRAW);
    const stride = BOX_STRIDE * 4;
    for (let i = 0; i < 5; i++) {
      const loc = 2 + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }

    /* ---- shards ---- */
    const shards = buildShards(this.quality);
    this.shardCount = shards.count;
    this.codeTex = makeCodeTexture(gl);

    this.shardVao = gl.createVertexArray();
    gl.bindVertexArray(this.shardVao);

    const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const sb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, sb);
    gl.bufferData(gl.ARRAY_BUFFER, shards.toArray(), gl.STATIC_DRAW);
    const sStride = SHARD_STRIDE * 4;
    for (let i = 0; i < 3; i++) {
      const loc = 1 + i;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, sStride, i * 16);
      gl.vertexAttribDivisor(loc, 1);
    }

    /* ---- particles ---- */
    const pc = this.quality === "high" ? 1500 : this.quality === "medium" ? 600 : 220;
    this.pointCount = pc;
    this.pointSpan = 300;
    const pdata = new Float32Array(pc * 4);
    const prng = makeRng(4242);
    for (let i = 0; i < pc; i++) {
      const a = prng() * Math.PI * 2;
      const r = 2 + prng() * 40;
      pdata[i * 4]     = Math.cos(a) * r;
      pdata[i * 4 + 1] = (prng() - 0.35) * 46;
      pdata[i * 4 + 2] = -prng() * this.pointSpan;
      pdata[i * 4 + 3] = prng() * 100;
    }

    this.pointVao = gl.createVertexArray();
    gl.bindVertexArray(this.pointVao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, pdata, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    /* ---- post targets ---- */
    this.emptyVao = gl.createVertexArray();
    this.sceneRT = createTarget(gl, 2, 2);
    this.halfRT = createTarget(gl, 2, 2, "nodepth");
    this.blurRT = createTarget(gl, 2, 2, "nodepth");

    this.viewProj = mat4();
    this.proj = mat4();
    this.view = mat4();

    this.resize();
  }

  resize() {
    if (!this.ok && !this.gl) return;
    const gl = this.gl;
    const w = Math.max(2, Math.floor(this.canvas.clientWidth * this.dpr));
    const h = Math.max(2, Math.floor(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;

    this.canvas.width = w;
    this.canvas.height = h;

    resizeTarget(gl, this.sceneRT, w, h);
    const dw = Math.max(2, w >> 2), dh = Math.max(2, h >> 2);
    resizeTarget(gl, this.halfRT, dw, dh);
    resizeTarget(gl, this.blurRT, dw, dh);
  }

  setProgress(p) { this.progress = clamp(p, 0, 1); }

  setPointer(x, y) { this.targetPointer.x = x; this.targetPointer.y = y; }

  render(dt) {
    if (!this.ok) return;
    const gl = this.gl;

    this.time += dt;
    this.pointer.x += (this.targetPointer.x - this.pointer.x) * 0.06;
    this.pointer.y += (this.targetPointer.y - this.pointer.y) * 0.06;

    const p = this.progress;
    const cam = cameraAt(p, this.time, this.pointer, this.motion);
    const aspect = this.canvas.width / this.canvas.height;

    perspective(this.proj, (cam.fov * Math.PI) / 180, aspect, 0.1, 700);
    lookAt(this.view, cam.pos, cam.look, [0, 1, 0]);
    rollView(this.view, cam.roll);
    multiply(this.viewProj, this.proj, this.view);

    // The finale dissolves the rest of the world away.
    const dissolve = ease(p, 0.930, 0.985, 0, 1);
    const focus = 22 + ease(p, 0.29, 0.46, 0, 26);

    /* ---------- scene pass ---------- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneRT.fbo);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.016, 0.021, 0.036, 1.0);
    gl.clearDepth(1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // boxes
    this.boxProg.use();
    gl.uniformMatrix4fv(this.boxProg.loc("u_viewProj"), false, this.viewProj);
    gl.uniform1f(this.boxProg.loc("u_time"), this.time);
    gl.uniform1f(this.boxProg.loc("u_motion"), this.motion);
    gl.uniform1f(this.boxProg.loc("u_dissolve"), dissolve);
    gl.uniform1f(this.boxProg.loc("u_camZ"), cam.pos[2]);
    gl.uniform3f(this.boxProg.loc("u_fogColor"), 0.016, 0.021, 0.036);
    gl.uniform1f(this.boxProg.loc("u_fogNear"), 15);
    gl.uniform1f(this.boxProg.loc("u_fogFar"), 150);
    gl.uniform1f(this.boxProg.loc("u_focus"), focus);
    gl.bindVertexArray(this.boxVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, this.boxCount);

    // additive layers keep the depth channel (alpha) intact
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);

    // code shards
    this.shardProg.use();
    gl.uniformMatrix4fv(this.shardProg.loc("u_viewProj"), false, this.viewProj);
    gl.uniform3f(this.shardProg.loc("u_camPos"), cam.pos[0], cam.pos[1], cam.pos[2]);
    gl.uniform1f(this.shardProg.loc("u_time"), this.time);
    gl.uniform1f(this.shardProg.loc("u_motion"), this.motion);
    gl.uniform1f(this.shardProg.loc("u_dissolve"), dissolve);
    gl.uniform1f(this.shardProg.loc("u_fogFar"), 140);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.codeTex);
    gl.uniform1i(this.shardProg.loc("u_code"), 0);
    gl.bindVertexArray(this.shardVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.shardCount);

    // particles
    this.pointProg.use();
    gl.uniformMatrix4fv(this.pointProg.loc("u_viewProj"), false, this.viewProj);
    gl.uniform3f(this.pointProg.loc("u_camPos"), cam.pos[0], cam.pos[1], cam.pos[2]);
    gl.uniform1f(this.pointProg.loc("u_time"), this.time);
    gl.uniform1f(this.pointProg.loc("u_motion"), this.motion);
    gl.uniform1f(this.pointProg.loc("u_span"), this.pointSpan);
    gl.uniform1f(this.pointProg.loc("u_pointScale"), this.dpr * (1 - dissolve));
    gl.bindVertexArray(this.pointVao);
    gl.drawArrays(gl.POINTS, 0, this.pointCount);

    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.bindVertexArray(this.emptyVao);
    gl.disable(gl.DEPTH_TEST);

    /* ---------- downsample ---------- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.halfRT.fbo);
    gl.viewport(0, 0, this.halfRT.w, this.halfRT.h);
    this.downProg.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.tex);
    gl.uniform1i(this.downProg.loc("u_tex"), 0);
    gl.uniform2f(this.downProg.loc("u_texel"), 1 / this.canvas.width, 1 / this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    /* ---------- blur: H, V, H, V ---------- */
    const blurPass = (src, dst, dx, dy) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
      this.blurProg.use();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform1i(this.blurProg.loc("u_tex"), 0);
      gl.uniform2f(this.blurProg.loc("u_dir"), dx / dst.w, dy / dst.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    blurPass(this.halfRT, this.blurRT, 1, 0);
    blurPass(this.blurRT, this.halfRT, 0, 1);
    blurPass(this.halfRT, this.blurRT, 2, 0);
    blurPass(this.blurRT, this.halfRT, 0, 2);

    /* ---------- composite ---------- */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.compProg.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneRT.tex);
    gl.uniform1i(this.compProg.loc("u_scene"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.halfRT.tex);
    gl.uniform1i(this.compProg.loc("u_blur"), 1);
    gl.uniform1f(this.compProg.loc("u_time"), this.time);
    gl.uniform1f(this.compProg.loc("u_bloom"), this.quality === "low" ? 1.05 : 1.75);
    gl.uniform1f(this.compProg.loc("u_dof"), this.quality === "low" ? 0.4 : 0.82);
    gl.uniform1f(this.compProg.loc("u_grain"), 0.035);
    gl.uniform2f(this.compProg.loc("u_res"), this.canvas.width, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
