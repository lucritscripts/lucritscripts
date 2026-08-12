/**
 * Lucrit Script — assistant proxy.
 *
 * The website is static files on GitHub Pages, so anything it ships is public.
 * This function exists so the NVIDIA API key never is: the browser talks to
 * the function, the function talks to NVIDIA using a key held in Secret
 * Manager and bound at deploy time.
 *
 * It also does the jobs a public endpoint spending your credits has to do:
 *   - only answers requests from your own site
 *   - rate limits per visitor, then per site, so one person cannot drain a day
 *   - caps how much it will read and write per request
 *   - streams the reply back so long scripts appear as they are written
 *
 * Deploy: see functions/README.md. Nothing here contains a key.
 */

import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";

import { checkOrigin, sendJson, clientIp, underLimit } from "./lib/http.js";

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

const NVIDIA_API_KEY = defineSecret("NVIDIA_API_KEY");
const ALLOWED_ORIGINS = defineSecret("ALLOWED_ORIGINS");

/** Which model answers. Any id from build.nvidia.com works. */
const MODEL = process.env.ASSISTANT_MODEL || "meta/llama-3.3-70b-instruct";

/** Reply cap. Long enough for a full module, short enough to bound spend. */
const MAX_TOKENS = 1400;

/** Longest question accepted, in characters. */
const MAX_QUESTION = 4000;

/** How much conversation history is carried. Older turns are dropped. */
const MAX_HISTORY = 6;

/** One visitor, per minute. Enough for a real conversation, not a script. */
const PER_VISITOR = 6;

/** The whole site, per minute — a ceiling on how fast credits can go. */
const PER_SITE = 120;

const SYSTEM_PROMPT = `You are the Lucrit Script assistant, built into a Roblox
script library. You help people write Luau for their own Roblox games.

How to answer:
- Lead with working code. A short sentence of context, then the script.
- Write modern Luau: type annotations where they help, task.wait over wait,
  :Connect stored so it can be disconnected, no deprecated API.
- Say where the code goes — ServerScriptService, StarterPlayerScripts, a
  ModuleScript — because that is the part people get wrong.
- Keep the server authoritative. Never trust a value the client sent; validate
  it on the server. Call this out when it matters rather than silently doing it.
- If the request is vague, write the most useful version you can and note the
  one assumption you made. Do not interrogate the person first.
- Be brief between code blocks. No filler, no restating the question.

Scope: you help people build their own games. You do not write exploits,
cheats, executor scripts, or anything meant to bypass another game's
protections or gain an unfair advantage in a game the person does not own.
If asked for that, say so plainly in one line and offer the legitimate version
of what they are after — an anti-cheat, a proper admin command, a test harness.

Never claim to know a specific script, author, or statistic on this site; you
cannot see the library. Point people at the search box for that.`;

/** Trims history to recent turns and drops anything malformed. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
}

export const assistant = onRequest(
  {
    secrets: [NVIDIA_API_KEY, ALLOWED_ORIGINS],
    // Concurrency matters here: these requests are almost entirely spent
    // waiting on NVIDIA, so one instance can hold many of them at once.
    concurrency: 40,
    // A hard ceiling on instances is a hard ceiling on a runaway bill.
    maxInstances: 3,
    memory: "256MiB",
    timeoutSeconds: 120,
    cors: false,   // handled here, so the allowlist is the single source
  },
  async (req, res) => {
    const allowed = checkOrigin(req, res, ALLOWED_ORIGINS.value());

    if (req.method === "OPTIONS") return res.status(204).send("");
    if (req.method !== "POST") return sendJson(res, 405, { error: "Use POST." });

    // A browser cannot forge Origin, so this keeps the endpoint to your site.
    if (!allowed) return sendJson(res, 403, { error: "Not allowed from this origin." });

    /* ------------------------------------------------------- rate limits */

    const db = getFirestore();
    const ip = clientIp(req);

    if (!(await underLimit(db, `ip:${ip}`, PER_VISITOR))) {
      return sendJson(res, 429, {
        error: "You're asking faster than I can answer — give it a few seconds.",
      });
    }

    if (!(await underLimit(db, "site", PER_SITE))) {
      return sendJson(res, 429, {
        error: "The assistant is busy right now. Try again in a minute.",
      });
    }

    /* ------------------------------------------------------------ input */

    // Cloud Functions parses JSON bodies for us, but a string body can still
    // arrive if the Content-Type was wrong.
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const question = String(body?.question || "").trim();
    if (!question) return sendJson(res, 400, { error: "Ask me something." });
    if (question.length > MAX_QUESTION) {
      return sendJson(res, 413, { error: "That's too long — trim it to the part you need help with." });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...cleanHistory(body?.history),
      { role: "user", content: question },
    ];

    /* ---------------------------------------------------------- upstream */

    let upstream;
    try {
      upstream = await fetch(NVIDIA_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NVIDIA_API_KEY.value()}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          temperature: 0.3,   // code should be predictable, not creative
          top_p: 0.9,
          max_tokens: MAX_TOKENS,
          stream: true,
        }),
        signal: AbortSignal.timeout(60000),
      });
    } catch (err) {
      console.error("nvidia unreachable", err?.message);
      return sendJson(res, 502, { error: "Couldn't reach the model. Try again in a moment." });
    }

    if (!upstream.ok) {
      // The upstream body can contain account detail — log it, never return it.
      const detail = await upstream.text().catch(() => "");
      console.error("nvidia error", upstream.status, detail.slice(0, 400));
      const message = upstream.status === 401 || upstream.status === 403
        ? "The assistant's API key was rejected."
        : upstream.status === 429
          ? "The model is rate limited right now. Try again shortly."
          : "The model had a problem answering that.";
      return sendJson(res, 502, { error: message });
    }

    /* ----------------------------------------------------------- stream */

    res.set("Content-Type", "text/plain; charset=utf-8");
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.flushHeaders();

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data).choices?.[0]?.delta?.content;
            if (delta) res.write(delta);
          } catch {
            // A partial JSON frame — the next chunk completes it.
          }
        }
      }
    } catch (err) {
      console.error("stream broke", err?.message);
    }

    res.end();
  }
);
