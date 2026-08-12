// Event store behind the dashboard.
//
// Every view, copy and like is recorded with a timestamp, so the 24h / 7d /
// 1m / 3m windows are real numbers rather than placeholders. Locally this is
// one array in storage; against Supabase it becomes an `events` table and
// `summary()` becomes a single grouped query. The shape stays identical.

const KEY = "lucrit:events";
const MAX_EVENTS = 5000;

const KINDS = ["view", "copy", "like"];

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}

function save(events) {
  try {
    localStorage.setItem(KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch { /* storage full or blocked — stats are best-effort */ }
}

let events = load();
const listeners = new Set();

export function onStatsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Records one event. `who` lets us keep likes to one per person per script. */
export function record(scriptId, kind, who = null) {
  if (!scriptId || !KINDS.includes(kind)) return false;

  if (kind === "like" && who) {
    const already = events.some((e) => e.s === scriptId && e.k === "like" && e.w === who);
    if (already) return false;
  }

  events.push({ t: Date.now(), s: scriptId, k: kind, ...(who ? { w: who } : {}) });
  save(events);
  for (const fn of listeners) fn();
  return true;
}

export function hasLiked(scriptId, who) {
  return Boolean(who) && events.some((e) => e.s === scriptId && e.k === "like" && e.w === who);
}

export function unlike(scriptId, who) {
  const before = events.length;
  events = events.filter((e) => !(e.s === scriptId && e.k === "like" && e.w === who));
  if (events.length !== before) {
    save(events);
    for (const fn of listeners) fn();
  }
}

/** Totals for one script, all time. */
export function totals(scriptId) {
  const out = { views: 0, copies: 0, likes: 0 };
  for (const e of events) {
    if (e.s !== scriptId) continue;
    if (e.k === "view") out.views++;
    else if (e.k === "copy") out.copies++;
    else if (e.k === "like") out.likes++;
  }
  return out;
}

/**
 * Windowed summary across a set of scripts.
 * Returns totals plus a bucketed series ready to plot.
 */
export function summary(scriptIds, days) {
  const ids = new Set(scriptIds || []);
  const now = Date.now();
  const span = days * 86400000;
  const from = now - span;

  // 24h reads better hour-by-hour; longer windows bucket per day.
  const buckets = days <= 1 ? 24 : Math.min(days, 90);
  const step = span / buckets;

  const series = Array.from({ length: buckets }, (_, i) => ({
    at: from + step * (i + 1), views: 0, copies: 0, likes: 0,
  }));

  const out = { views: 0, copies: 0, likes: 0, series, buckets, days };

  for (const e of events) {
    if (!ids.has(e.s) || e.t < from) continue;

    const key = e.k === "view" ? "views" : e.k === "copy" ? "copies" : "likes";
    out[key]++;

    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((e.t - from) / step)));
    series[idx][key]++;
  }

  return out;
}

/** Percentage change against the previous window of the same length. */
export function trend(scriptIds, days, metric = "views") {
  const ids = new Set(scriptIds || []);
  const now = Date.now();
  const span = days * 86400000;
  const kind = metric === "views" ? "view" : metric === "copies" ? "copy" : "like";

  let current = 0, previous = 0;
  for (const e of events) {
    if (!ids.has(e.s) || e.k !== kind) continue;
    const age = now - e.t;
    if (age <= span) current++;
    else if (age <= span * 2) previous++;
  }

  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

/** Removes every event for a script — used when a publish is deleted. */
export function forget(scriptId) {
  events = events.filter((e) => e.s !== scriptId);
  save(events);
  for (const fn of listeners) fn();
}

/* ------------------------------------------------------------- chart */

/**
 * Area + line chart as inline SVG. No dependency, scales to its container,
 * and degrades to a flat baseline when there is nothing to plot.
 */
export function sparkline(series, { key = "views", w = 720, h = 170 } = {}) {
  const pad = { t: 14, r: 14, b: 22, l: 34 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;

  const values = series.map((p) => p[key] || 0);
  const max = Math.max(1, ...values);
  const n = values.length;

  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;

  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;

  const gridY = [0, 0.5, 1].map((f) => {
    const yy = pad.t + ih - f * ih;
    return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" class="ch__grid"/>
            <text x="${pad.l - 8}" y="${(yy + 4).toFixed(1)}" class="ch__ytick">${Math.round(max * f)}</text>`;
  }).join("");

  const last = values[n - 1] || 0;

  return `
    <svg class="ch" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
         aria-label="${key} over time, peak ${max}">
      <defs>
        <linearGradient id="chfill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="#3d9bff" stop-opacity="0.42"/>
          <stop offset="100%" stop-color="#3d9bff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${gridY}
      <path d="${area}" fill="url(#chfill)"/>
      <path d="${line}" class="ch__line"/>
      <circle cx="${x(n - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3.5" class="ch__dot"/>
    </svg>`;
}
