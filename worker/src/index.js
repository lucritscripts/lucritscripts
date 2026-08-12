/**
 * Lucrit Script — assistant proxy.
 *
 * The website is static files on GitHub Pages, so anything it ships is public.
 * This Worker exists so the NVIDIA API key never is: the browser talks to the
 * Worker, the Worker talks to NVIDIA with a key held as a Cloudflare secret.
 *
 * It also does the jobs a public endpoint spending your credits has to do:
 *   - only answers requests from your own site
 *   - rate limits per visitor, then per site, so one person cannot drain a day
 *   - caps how much it will read and write per request
 *   - streams the reply back so long scripts appear as they are written
 *
 * Deploy: see worker/README.md. Nothing here contains a key.
 */

const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

/** Reply cap. Long enough for a full module, short enough to bound spend. */
const MAX_TOKENS = 1400;

/** Longest question accepted, in characters. */
const MAX_QUESTION = 4000;

/** How much conversation history is carried. Older turns are dropped. */
const MAX_HISTORY = 6;

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

/* --------------------------------------------------------------- helpers */

function corsHeaders(origin, allowed) {
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Origins allowed to call this Worker, from the ALLOWED_ORIGINS secret. */
function isAllowed(origin, env) {
  if (!origin) return false;
  const list = String(env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.includes(origin);
}

/** Trims history to recent turns and drops anything malformed. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
}

/**
 * Turns NVIDIA's SSE stream into plain text chunks. The browser gets readable
 * text as it arrives instead of waiting for a whole script to finish.
 */
function toTextStream(upstream) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
        } catch {
          // A partial JSON frame — the next chunk completes it.
        }
      }
    },
  });
}

/* ----------------------------------------------------------------- entry */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const allowed = isAllowed(origin, env);
    const cors = corsHeaders(origin, allowed);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Use POST." }, 405, cors);

    // A browser cannot forge Origin, so this keeps the endpoint to your site.
    if (!allowed) return json({ error: "Not allowed from this origin." }, 403, cors);

    if (!env.NVIDIA_API_KEY) {
      return json({ error: "Assistant is not configured yet." }, 503, cors);
    }

    /* ------------------------------------------------------- rate limits */

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";

    if (env.PER_VISITOR) {
      const { success } = await env.PER_VISITOR.limit({ key: ip });
      if (!success) {
        return json({ error: "You're asking faster than I can answer — give it a few seconds." }, 429, cors);
      }
    }

    if (env.PER_SITE) {
      const { success } = await env.PER_SITE.limit({ key: "site" });
      if (!success) {
        return json({ error: "The assistant is busy right now. Try again in a minute." }, 429, cors);
      }
    }

    /* ------------------------------------------------------------ input */

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Expected JSON." }, 400, cors);
    }

    const question = String(body?.question || "").trim();
    if (!question) return json({ error: "Ask me something." }, 400, cors);
    if (question.length > MAX_QUESTION) {
      return json({ error: "That's too long — trim it to the part you need help with." }, 413, cors);
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...cleanHistory(body?.history),
      { role: "user", content: question },
    ];

    /* ---------------------------------------------------------- upstream */

    const upstream = await fetch(NVIDIA_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.NVIDIA_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        model: env.MODEL || "meta/llama-3.3-70b-instruct",
        messages,
        temperature: 0.3,     // code should be predictable, not creative
        top_p: 0.9,
        max_tokens: MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(60000),
    }).catch(() => null);

    if (!upstream) {
      return json({ error: "Couldn't reach the model. Try again in a moment." }, 502, cors);
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
      return json({ error: message }, 502, cors);
    }

    return new Response(upstream.body.pipeThrough(toTextStream(upstream)), {
      headers: {
        ...cors,
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  },
};
