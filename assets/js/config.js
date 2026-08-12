// Public configuration. Everything here ships to the browser, so it holds
// URLs and switches only — never a key, a token, or a secret of any kind.
//
// Those live in Firebase Cloud Functions (see functions/README.md).

/**
 * The assistant proxy. Empty means "not deployed yet": the assistant quietly
 * falls back to its built-in answers, so the site works either way.
 *
 * Set this to the URL `firebase deploy` prints for the `assistant` function:
 *   "https://us-central1-<project-id>.cloudfunctions.net/assistant"
 */
export const ASSISTANT_URL = "";

/**
 * The unlock verifier — same deploy, the `unlocks` function. Empty keeps the
 * paywall client-side, which is fine for looking at but not for trusting.
 *   "https://us-central1-<project-id>.cloudfunctions.net/unlocks"
 */
export const UNLOCKS_URL = "";

/** Where the assistant sends people when it cannot help. */
export const DISCORD_INVITE = "https://discord.gg/JUSmn4ZYe";
