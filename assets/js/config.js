// Public configuration. Everything here ships to the browser, so it holds
// URLs and switches only — never a key, a token, or a secret of any kind.
//
// The AI backend is a Cloudflare Worker (see worker/README.md). It reaches
// the model through Cloudflare's own Workers AI binding, so there is no API
// key anywhere — not here, not there.

/**
 * The assistant proxy. Empty means "not deployed": the assistant quietly
 * falls back to its built-in answers, so the site works either way.
 */
export const ASSISTANT_URL = "https://lucrit-assistant.lucritscripts.workers.dev/";

/**
 * The unlock verifier. Empty keeps the paywall client-side, which is fine for
 * looking at but not for trusting — the script body still reaches the browser,
 * so anyone with devtools can skip the sponsor step. Closing that needs the
 * script bodies held server-side.
 */
export const UNLOCKS_URL = "";

/** Where the assistant sends people when it cannot help. */
export const DISCORD_INVITE = "https://discord.gg/JUSmn4ZYe";
