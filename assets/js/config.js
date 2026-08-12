// Public configuration. Everything here ships to the browser, so it holds
// URLs and switches only — never a key, a token, or a secret of any kind.
//
// Those live in the Cloudflare Worker (see worker/README.md).

/**
 * The assistant proxy. Empty means "not deployed yet": the assistant quietly
 * falls back to its built-in answers, so the site works either way.
 *
 * Set this to the URL `wrangler deploy` prints, e.g.
 *   "https://lucrit-assistant.yourname.workers.dev"
 */
export const ASSISTANT_URL = "";

/** Where the assistant sends people when it cannot help. */
export const DISCORD_INVITE = "https://discord.gg/JUSmn4ZYe";
