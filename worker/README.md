# Lucrit Script — AI backend (Cloudflare Worker)

`assistant.js` is the whole backend. It holds no keys and needs no build step.

## Why a Worker and not a Cloud Function

Firebase Cloud Functions require the Blaze plan, which requires a payment
method. Cloudflare Workers are free with no card: 100,000 requests/day, and
Workers AI gives 10,000 Neurons/day of free inference. Both fail closed when
the allocation runs out — they return an error, they do not start charging.

Accounts, profiles, usernames and security rules all stay on Firebase. This
Worker only answers "write me a script".

## Deploy from the dashboard

1. **Workers & Pages → Create → Start with Hello World → Deploy.**
   Name it `lucrit-assistant`.
2. **Edit code**, replace everything with `assistant.js`, **Deploy**.
3. **Settings → Bindings → Add → Workers AI**, variable name exactly `AI`.
4. **Settings → Variables and Secrets → Add**, plain text:
   `ALLOWED_ORIGINS` = `https://lucritscripts.github.io`
   Comma-separate more origins if you add a custom domain later.
5. Copy the `*.workers.dev` URL into `ASSISTANT_URL` in `assets/js/config.js`,
   and add the same origin to the `connect-src` list in `index.html`'s CSP.

## Deploy with wrangler instead

```bash
npx wrangler deploy worker/assistant.js --name lucrit-assistant --compatibility-date 2026-01-01
npx wrangler secret put ALLOWED_ORIGINS   # or set it as a plain var in the dashboard
```

Add to `wrangler.toml` for the AI binding and the optional rate limiter:

```toml
[ai]
binding = "AI"

[[ratelimits]]
name = "LIMITER"
namespace_id = "1001"
simple = { limit = 6, period = 60 }
```

The rate limiter is optional. Without it the Worker falls back to a
per-isolate counter, which is weaker but still blunts one machine hammering
the endpoint.

## Using a different model or provider

**Different Workers AI model** — set `AI_MODEL` to any text-generation id from
the Workers AI catalogue, e.g. `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.

**A different provider entirely** — set all three and it switches over:

| Variable      | Example                                  |
| ------------- | ---------------------------------------- |
| `AI_BASE_URL` | `https://integrate.api.nvidia.com/v1`    |
| `AI_API_KEY`  | *(secret — set it in the dashboard)*     |
| `AI_MODEL`    | `meta/llama-3.3-70b-instruct`            |

Anything speaking the OpenAI chat-completions shape works: NVIDIA, Groq,
OpenRouter, OpenAI, Together, DeepSeek. Set `AI_API_KEY` as a **secret**, never
a plain variable, and never commit it.

## What it does per request

- Rejects any origin not in `ALLOWED_ORIGINS`. A browser cannot forge Origin,
  so this keeps the endpoint to your site.
- Throttles to 6 requests per visitor per minute.
- Caps the question at 4,000 characters and the reply at 1,400 tokens.
- Carries at most 6 turns of history.
- Streams the reply back as plain text, so the browser can render it as it
  arrives. All SSE parsing happens here.
