/**
 * Lucrit Script — AI backend (Cloudflare Worker).
 *
 * The website is static files on GitHub Pages, so anything it ships is public.
 * This Worker exists so the model call never happens in the browser: the page
 * posts a question here, and this decides what to do with it.
 *
 * Two ways to answer, picked automatically:
 *
 *   1. Workers AI (default). Cloudflare runs the model itself, reached through
 *      the `AI` binding. There is no API key to leak because there is no API
 *      key at all — and the free allocation fails closed rather than billing,
 *      so it cannot run up a surprise.
 *
 *   2. Any OpenAI-compatible provider. Set AI_BASE_URL + AI_API_KEY (+ AI_MODEL)
 *      as secrets and this switches over — NVIDIA, Groq, OpenRouter, OpenAI,
 *      Together, whoever. Nothing else changes.
 *
 * Whichever answers, the reply is streamed back as plain text so long scripts
 * appear as they are written. The browser reads it with a plain text decoder,
 * so this file owns all the SSE parsing.
 *
 * Nothing here contains a key. See worker/README.md to deploy.
 */

/* ------------------------------------------------------------------ config */

/** Workers AI model. Code-specialised, and strong for its size. */
const CF_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

/** Reply cap. Long enough for a full module, short enough to bound spend. */
const MAX_TOKENS = 1400;

/** Longest question accepted, in characters. */
const MAX_QUESTION = 4000;

/** How much conversation history is carried. Older turns are dropped. */
const MAX_HISTORY = 6;

/** One visitor, per minute. Enough for a real conversation, not a script. */
const PER_VISITOR = 6;

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

/* -------------------------------------------------------------------- CORS */

/**
 * A browser cannot forge Origin, so an allowlist keeps this endpoint to your
 * own site. ALLOWED_ORIGINS is a comma-separated list; if it is unset we fall
 * back to the production site rather than opening up to everyone.
 */
const DEFAULT_ORIGINS = "https://lucritscripts.github.io";

function originAllowed(request, env) {
  const origin = request.headers.get("Origin") || "";
  const list = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
    .split(",").map((s) => s.trim()).filter(Boolean);
  return { origin, ok: Boolean(origin) && list.includes(origin) };
}

function corsHeaders(origin, ok) {
  return {
    "Access-Control-Allow-Origin": ok ? origin : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(status, body, origin, ok) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin, ok) },
  });
}

/* ------------------------------------------------------------ rate limiting */

/**
 * Per-visitor throttle.
 *
 * Uses the native Rate Limiting binding when one is configured. Without it we
 * fall back to a per-isolate counter — weaker, because Cloudflare runs many
 * isolates, but it still blunts a single machine hammering the endpoint. The
 * real spend ceiling is the Workers AI daily allocation, which fails closed.
 */
const recent = new Map();

async function underLimit(env, key) {
  if (env.LIMITER?.limit) {
    try {
      const { success } = await env.LIMITER.limit({ key });
      return success;
    } catch {
      return true;   // a limiter outage must not take the assistant down
    }
  }

  const now = Date.now();
  const bucket = Math.floor(now / 60000);
  const id = `${key}_${bucket}`;
  const count = (recent.get(id) || 0) + 1;
  recent.set(id, count);

  // Drop buckets from previous minutes so this cannot grow without bound.
  if (recent.size > 5000) {
    for (const k of recent.keys()) {
      if (!k.endsWith(`_${bucket}`)) recent.delete(k);
    }
  }
  return count <= PER_VISITOR;
}

/* -------------------------------------------------------------- messages */

/** Trims history to recent turns and drops anything malformed. */
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-MAX_HISTORY)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_QUESTION) }));
}

/* --------------------------------------------------------------- streaming */

/**
 * Both Workers AI and every OpenAI-compatible provider stream Server-Sent
 * Events, but they disagree about where the text sits in each frame. This
 * unwraps either shape and emits plain text, which is all the browser wants.
 */
function sseToText(upstream) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      // Keep reading until there is actually something to emit, or the
      // upstream ends. Plenty of frames carry no text — keep-alives, the
      // trailing [DONE], the half of a frame that arrived early — and
      // returning from `pull` without enqueueing anything can leave the
      // consumer waiting on a pull that never comes. That reads as the reply
      // freezing after the first token.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let emitted = false;
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;

          try {
            const frame = JSON.parse(data);
            // Workers AI: { response: "..." }
            // OpenAI-compatible: { choices: [{ delta: { content: "..." } }] }
            const text = frame.response ?? frame.choices?.[0]?.delta?.content;
            if (text) { controller.enqueue(encoder.encode(text)); emitted = true; }
          } catch {
            // A partial JSON frame — the next chunk completes it.
          }
        }

        if (emitted) return;
      }
    },
    cancel() { reader.cancel().catch(() => {}); },
  });
}

/* ---------------------------------------------------------------- providers */

/** An OpenAI-compatible endpoint, when one is configured. */
async function askUpstream(env, messages) {
  const base = String(env.AI_BASE_URL).replace(/\/+$/, "");
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.AI_API_KEY}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      model: env.AI_MODEL || "meta/llama-3.3-70b-instruct",
      messages,
      temperature: 0.3,   // code should be predictable, not creative
      top_p: 0.9,
      max_tokens: MAX_TOKENS,
      stream: true,
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    // The upstream body can contain account detail — log it, never return it.
    const detail = await response.text().catch(() => "");
    console.error("upstream error", response.status, detail.slice(0, 400));
    const message = response.status === 401 || response.status === 403
      ? "The assistant's API key was rejected."
      : response.status === 429
        ? "The model is rate limited right now. Try again shortly."
        : "The model had a problem answering that.";
    throw new Error(message);
  }

  return response.body;
}

/** Cloudflare's own inference, through the AI binding. */
async function askWorkersAI(env, messages) {
  const stream = await env.AI.run(env.AI_MODEL || CF_MODEL, {
    messages,
    stream: true,
    max_tokens: MAX_TOKENS,
    temperature: 0.3,
  });
  return stream;
}

/* -------------------------------------------------------------------- main */

export default {
  async fetch(request, env) {
    const { origin, ok } = originAllowed(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin, ok) });
    }
    if (request.method !== "POST") {
      return json(405, { error: "Use POST." }, origin, ok);
    }
    if (!ok) {
      return json(403, { error: "Not allowed from this origin." }, origin, ok);
    }

    /* ---------------------------------------------------------- throttle */

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (!(await underLimit(env, `ip:${ip}`))) {
      return json(429, {
        error: "You're asking faster than I can answer — give it a few seconds.",
      }, origin, ok);
    }

    /* ------------------------------------------------------------- input */

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Send JSON." }, origin, ok); }

    const question = String(body?.question || "").trim();
    if (!question) return json(400, { error: "Ask me something." }, origin, ok);
    if (question.length > MAX_QUESTION) {
      return json(413, {
        error: "That's too long — trim it to the part you need help with.",
      }, origin, ok);
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...cleanHistory(body?.history),
      { role: "user", content: question },
    ];

    /* ---------------------------------------------------------- generate */

    const useUpstream = Boolean(env.AI_BASE_URL && env.AI_API_KEY);

    let upstream;
    try {
      upstream = useUpstream
        ? await askUpstream(env, messages)
        : await askWorkersAI(env, messages);
    } catch (err) {
      console.error("generation failed", err?.message);
      // Workers AI returns a plain error once the daily allocation is spent;
      // say so in words rather than leaking the provider's phrasing.
      const message = /neuron|quota|limit|capacity/i.test(String(err?.message))
        ? "The AI has hit today's free limit. It resets tomorrow."
        : err?.message || "Couldn't reach the model. Try again in a moment.";
      return json(502, { error: message }, origin, ok);
    }

    if (!upstream) {
      return json(502, { error: "The model returned nothing. Try again." }, origin, ok);
    }

    return new Response(sseToText(upstream), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...corsHeaders(origin, ok),
      },
    });
  },
};
