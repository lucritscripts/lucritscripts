// "More scripts like this one", for the script page.
//
// Two rules, in this order:
//   1. Same game first. Somebody unlocking a Pet Simulator X script wants
//      Pet Simulator X scripts, however well a Blox Fruits one happens to match.
//   2. Within that, closest description first. "Closest" is TF-IDF cosine
//      similarity over the description, the title and the tags — so two
//      auto-farm scripts rank together, and words every script uses
//      ("script", "roblox", "the") count for almost nothing.
//
// Pure functions over the library the page already holds: no request, no
// server CPU, and it works the moment the listing has loaded.

const STOP = new Set(`a an and are as at be but by can do for from get gets has have
  how i if in into is it its just me my no not of on or our out so than that the
  their them then there these they this to too up us use uses using very was we
  what when which while who will with you your yours script scripts roblox game
  games best new free op working works work`.split(/\s+/));

/** Lowercase words worth comparing, with plurals folded ("pets" → "pet"). */
export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** "Pet Simulator X!" and "pet simulator x" are the same game. */
export function sameGame(a, b) {
  const norm = (g) => String(g || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return Boolean(norm(a)) && norm(a) === norm(b);
}

/** Term counts for one script. Title and tags say more per word than the body. */
function termsOf(s) {
  const tf = new Map();
  const add = (words, weight) => { for (const w of words) tf.set(w, (tf.get(w) || 0) + weight); };
  add(tokens(s.desc), 1);
  add(tokens(s.title), 3);
  add(tokens((s.tags || []).join(" ")), 3);
  if (s.category) add(["cat_" + s.category], 2);
  return tf;
}

/**
 * Scripts similar to `target`, best first.
 *
 * Returns `{ sameGame, otherGames }`, each a list of `{ script, score }`
 * (score 0–1). Same-game scripts are all returned, ranked; other games only
 * when they share something real with the target (score ≥ `minOther`).
 */
export function rankSimilar(target, pool, { minOther = 0.12 } = {}) {
  const others = (pool || []).filter((s) => s && s.id !== target.id);
  if (!others.length) return { sameGame: [], otherGames: [] };

  // Document frequency over everything in view, target included.
  const docs = [target, ...others].map(termsOf);
  const df = new Map();
  for (const d of docs) for (const w of d.keys()) df.set(w, (df.get(w) || 0) + 1);
  const n = docs.length;
  const idf = (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1;

  const vec = (d) => {
    const v = new Map();
    let norm = 0;
    for (const [w, c] of d) { const x = (1 + Math.log(c)) * idf(w); v.set(w, x); norm += x * x; }
    return { v, norm: Math.sqrt(norm) || 1 };
  };
  const t = vec(docs[0]);
  const cosine = (d) => {
    const o = vec(d);
    let dot = 0;
    for (const [w, x] of t.v) { const y = o.v.get(w); if (y) dot += x * y; }
    return dot / (t.norm * o.norm);
  };

  // Ties (often 0 between unrelated descriptions) go to the more-used script.
  const popularity = (s) => (s.copies || 0) * 3 + (s.views || 0) + (s.likes || 0) * 5;
  const ranked = others
    .map((script, i) => ({ script, score: cosine(docs[i + 1]) }))
    .sort((a, b) => b.score - a.score || popularity(b.script) - popularity(a.script));

  return {
    sameGame: ranked.filter((r) => sameGame(r.script.game, target.game)),
    otherGames: ranked.filter((r) => !sameGame(r.script.game, target.game) && r.score >= minOther),
  };
}

/**
 * What the script page shows: up to `limit` suggestions, same game first,
 * topped up from other games only when the game has too few of its own.
 */
export function suggestionsFor(target, pool, limit = 4) {
  const { sameGame: same, otherGames } = rankSimilar(target, pool);
  const picks = same.slice(0, limit).map((r) => ({ ...r, sameGame: true }));
  for (const r of otherGames) {
    if (picks.length >= limit) break;
    picks.push({ ...r, sameGame: false });
  }
  return picks;
}
