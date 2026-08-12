# Backend

The site is static files on GitHub Pages, so everything it ships is readable by
anyone. These functions exist so your keys are not: the browser calls a
function, the function calls NVIDIA or LootLabs using a secret that lives in
Google Secret Manager.

**No key is in this folder, in git, or in anything sent to a browser.**

| Function | Does |
| --- | --- |
| `assistant` | Proxies the site assistant to NVIDIA and streams the reply back |
| `unlocks` | Creates LootLabs locker links and verifies that an unlock really happened |

## Before you start

Cloud Functions **require the Blaze (pay-as-you-go) plan** — the free Spark
plan cannot deploy them at all. Blaze still includes a monthly free allowance
that a site this size sits well inside; you are putting a card on file as a
ceiling, not paying from request one. Upgrade at
[console.firebase.google.com](https://console.firebase.google.com) → your
project → ⚙️ → Usage and billing.

While you are in the console, create a **Firestore** database (production
mode). Both functions use it — the assistant for rate-limit counters, unlocks
for completed offers.

## Deploy

```bash
npm install -g firebase-tools     # once
firebase login
firebase use --add                # pick your project, alias it "default"

cd functions && npm install && cd ..
```

Set the secrets. The CLI prompts for the value and hides it — paste at the
prompt rather than putting the key on the command line, which shell history
would keep.

```bash
firebase functions:secrets:set NVIDIA_API_KEY
# paste the nvapi-... key from build.nvidia.com

firebase functions:secrets:set ALLOWED_ORIGINS
# paste exactly: https://lucritscripts.github.io

firebase functions:secrets:set LOOTLABS_TOKEN
# paste your LootLabs API token (skip if you are not wiring unlocks yet)
```

Then deploy:

```bash
firebase deploy --only functions
```

It prints a URL per function, like
`https://us-central1-<project>.cloudfunctions.net/assistant`. Put the assistant
one in `assets/js/config.js` as `ASSISTANT_URL` and commit — that URL is public
and safe to publish; the key behind it is not.

### Firestore cleanup

The rate-limit counters and unlock records both carry an `expires` field.
Add a TTL policy so they delete themselves instead of piling up:

```bash
gcloud firestore fields ttls update expires \
  --collection-group=ratelimits --enable-ttl
gcloud firestore fields ttls update expires \
  --collection-group=unlocks --enable-ttl
```

You can also add these under Firestore → TTL in the console.

## Rotating a key

Revoke the old one at its source, then:

```bash
firebase functions:secrets:set NVIDIA_API_KEY
firebase deploy --only functions:assistant
```

No code change. The redeploy is what picks up the new version.

## What it protects

| Risk | Handling |
| --- | --- |
| Key theft | Keys live in Secret Manager, never leave the function |
| Someone else using your endpoint | Origin allowlist — only your site's requests are answered |
| One person draining credits | 6 questions per minute per visitor |
| A bad day draining credits | 120 requests per minute across the whole site |
| A runaway bill | `maxInstances: 3` on both functions |
| Huge prompts | Question capped at 4,000 characters, history at 6 turns |
| Runaway replies | `max_tokens` 1,400 per answer |
| Faked unlocks | Only LootLabs' postback can write one, and Firestore rules deny all direct browser access |

The origin check stops browsers, not scripts — anyone can forge an `Origin`
header with curl. The rate limits are what actually bound your spend, so keep
them tight and raise them only when real traffic needs it. For a stronger
guarantee, turn on [App Check](https://firebase.google.com/docs/app-check) with
reCAPTCHA Enterprise and require a valid token in `assistant`.

## Cost

Firestore does two small writes per assistant question, which is a rounding
error next to the model call. NVIDIA's credits are the real cost — watch the
balance at build.nvidia.com for the first week and adjust `PER_SITE` in
`assistant.js` from there.

## Changing the model

Set `ASSISTANT_MODEL` as an environment variable in `functions/.env` and
redeploy. Any model id from build.nvidia.com works, for example
`deepseek-ai/deepseek-r1` or `qwen/qwen2.5-coder-32b-instruct`.

## A note on the emulator

`firebase emulators:start` historically buffers chunked responses, so the
assistant's reply may arrive all at once locally and stream properly only once
deployed. That is the emulator, not the function.
