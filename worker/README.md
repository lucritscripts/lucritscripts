# Assistant proxy

The site is static files on GitHub Pages, so everything it ships is readable by
anyone. This Worker exists so the NVIDIA API key is not: the browser calls the
Worker, the Worker calls NVIDIA using a key stored as a Cloudflare secret.

**The key is never in this folder, never in git, and never sent to a browser.**

## Deploy

You need a free Cloudflare account and Node installed.

```bash
cd worker
npx wrangler login          # opens a browser, authorises this machine
npx wrangler deploy         # first deploy, prints your Worker URL
```

Then set the two secrets. Wrangler prompts for the value and hides it — paste
at the prompt, don't put it on the command line (shell history keeps that).

```bash
npx wrangler secret put NVIDIA_API_KEY
# paste the nvapi-... key from build.nvidia.com

npx wrangler secret put ALLOWED_ORIGINS
# paste exactly: https://lucritscripts.github.io
```

`ALLOWED_ORIGINS` is a comma-separated list. Add `http://localhost:8000` while
developing locally, and remove it when you're done.

Deploy prints something like `https://lucrit-assistant.<you>.workers.dev`. Put
that URL in `assets/js/config.js` as `ASSISTANT_URL` and commit — the URL is
public and safe to publish; the key it holds is not.

## Rotating the key

If a key is ever exposed, revoke it at build.nvidia.com, generate a new one,
and run `wrangler secret put NVIDIA_API_KEY` again. No code change, no redeploy.

## What it protects

| Risk | Handling |
| --- | --- |
| Key theft | Key lives in Cloudflare, never leaves the Worker |
| Someone else using your endpoint | Origin allowlist — only your site's requests are answered |
| One person draining credits | 6 questions per minute per visitor |
| A bad day draining credits | 120 requests per minute across the whole site |
| Huge prompts | Question capped at 4,000 characters, history at 6 turns |
| Runaway replies | `max_tokens` 1,400 per answer |

The origin check stops browsers, not scripts — anyone can forge an `Origin`
header with curl. The rate limits are what actually bound your spend, so keep
them tight and raise them only if real traffic needs it.

## Cost

Cloudflare Workers' free tier covers 100,000 requests a day, far more than the
rate limits above allow. NVIDIA's credits are the real cost — watch the balance
at build.nvidia.com for the first week and adjust `PER_SITE` from there.

## Changing the model

Edit `MODEL` in `wrangler.toml` and redeploy. Any model id from
build.nvidia.com works, for example `deepseek-ai/deepseek-r1` or
`qwen/qwen2.5-coder-32b-instruct`.
