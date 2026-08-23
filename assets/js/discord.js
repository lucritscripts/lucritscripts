// The Discord server, as seen from the site.
//
// Two small jobs that both amount to "tell the truth about the server":
//
//   1. Live counts on the Join buttons. "Join Discord" is a request; "Join
//      Discord · 1,240 members · 87 online" is a reason.
//   2. One invite link, from the server. The invite used to be a constant
//      compiled into two modules, which meant changing it was a deploy — and
//      an expired invite is a button that goes nowhere.
//
// Everything here degrades to exactly what the site did before. No guild
// configured, the API down, the widget switched off: the buttons keep their
// built-in link and no counts appear. Nothing on this page is load-bearing.

import { account } from "./account.js";

const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k"
                              : String(n));

let asked = null;

/** One request per page load, shared by every button that wants it. */
function load() {
  if (asked) return asked;
  asked = fetch("/api/discord", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.ok ? j.data : null))
    .catch(() => null);
  return asked;
}

/**
 * Fills every `[data-discord-stats]` on the page and points every
 * `.btn--discord` at the configured invite.
 *
 * Safe to call repeatedly — chapters and overlays are rebuilt as the site is
 * used, and a newly drawn button should get the numbers the last one had
 * without a second request.
 */
export async function paintDiscord(root = document) {
  const data = await load();
  if (!data) return;

  if (data.invite) {
    for (const a of root.querySelectorAll("a.btn--discord")) a.href = data.invite;
  }

  const bits = [];
  // The public widget knows how many are online but not how many exist, so a
  // zero here means "not available", not "nobody is in the server". Showing it
  // would be worse than showing nothing.
  if (data.members) bits.push(`${fmt(data.members)} members`);
  if (data.online) bits.push(`${fmt(data.online)} online`);
  if (!bits.length) return;

  for (const node of root.querySelectorAll("[data-discord-stats]")) {
    node.textContent = " · " + bits.join(" · ");
    node.hidden = false;
  }
}

/**
 * The message after a Discord sign-in round trip.
 *
 * The callback is a redirect, so the only channel back to the page is the URL.
 * The parameter is read once and then stripped, so a refresh does not replay
 * the message and the address bar does not keep carrying it around.
 */
export function readDiscordReturn() {
  const params = new URLSearchParams(location.search);
  const status = params.get("discord");
  if (!status) return null;

  params.delete("discord");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);

  const SAID = {
    ok: ["Signed in with Discord", "ok"],
    cancelled: ["Discord sign-in cancelled", "warn"],
    banned: ["This account has been suspended.", "warn"],
    emailtaken: [
      // Deliberately specific. The generic version of this message sent people
      // round the loop again expecting a different answer.
      "An account already uses that email. Sign in with your password first, then link Discord.",
      "warn",
    ],
    state: ["That sign-in link expired — try again", "warn"],
    slowdown: ["Too many sign-in attempts. Wait a few minutes.", "warn"],
    failed: ["Discord sign-in didn't work — try again", "warn"],
  };
  return SAID[status] || SAID.failed;
}

/** Repaint whenever the session changes, since the buttons live everywhere. */
export function watchDiscord() {
  account.onChange(() => { paintDiscord(); });
}
