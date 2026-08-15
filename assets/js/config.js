// Public configuration. Everything here ships to the browser, so it holds
// URLs and switches only — never a key, a token, or a secret of any kind.
//
// The AI backend is a Cloudflare Worker (see worker/README.md). It reaches
// the model through Cloudflare's own Workers AI binding, so there is no API
// key anywhere — not here, not there.

/**
 * The assistant endpoint.
 *
 * Starts out pointing at the standalone Worker, which is what the GitHub Pages
 * build has to use because it is on a different origin. Once account.js finds
 * an API on our own origin — that is, once we are running on Cloudflare Pages
 * — it calls useSameOriginApi() and this switches to /api/ai: no CORS, no
 * second deploy, one place to change the model.
 *
 * ES module exports are live bindings, so importers see the new value without
 * having to re-import anything.
 */
const STANDALONE = "https://lucrit-assistant.lucritscripts.workers.dev/";

export let ASSISTANT_URL = STANDALONE;

export function useSameOriginApi() { ASSISTANT_URL = "/api/ai"; }

/**
 * The unlock verifier. Empty keeps the paywall client-side, which is fine for
 * looking at but not for trusting — the script body still reaches the browser,
 * so anyone with devtools can skip the sponsor step. Closing that needs the
 * script bodies held server-side.
 */
export const UNLOCKS_URL = "";

/** Where the assistant sends people when it cannot help. */
export const DISCORD_INVITE = "https://discord.gg/JUSmn4ZYe";
