/**
 * LootLabs API proxy + postback receiver (Cloudflare Worker)
 * ----------------------------------------------------------
 * Why this exists: GitHub Pages is static, so your LootLabs API token
 * cannot live in the site. This Worker holds it and exposes four safe routes.
 *
 * Routes
 *   POST /create          -> creates a content locker link
 *   POST /encrypt         -> Redirect API: encrypt a destination for &data=
 *   GET  /postback        -> LootLabs calls this when a task completes
 *   GET  /verify?puid=..  -> your site polls this to confirm completion
 *
 * Secrets / bindings (see wrangler.toml)
 *   LOOTLABS_TOKEN  (secret)  your API token
 *   ALLOWED_ORIGIN  (var)     your Pages origin, e.g. https://user.github.io
 *   UNLOCKS         (KV)      stores completions
 */

const LL = "https://creators.lootlabs.gg/api/public";
const TTL = 60 * 60 * 24; // remember a completion for 24h

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    try {
      /* ---------- create a locker link ---------- */
      if (url.pathname === "/create" && request.method === "POST") {
        const body = await request.json();
        const payload = {
          title: String(body.title || "Unlock").slice(0, 30),
          url: body.url,
          tier_id: Number(body.tier_id ?? 1),          // 1-4
          number_of_tasks: Number(body.number_of_tasks ?? 1), // 1-5
        };
        if (body.theme) payload.theme = Number(body.theme);         // 1-5
        if (body.thumbnail) payload.thumbnail = body.thumbnail;

        if (!payload.url) return json({ error: "url is required" }, 400);

        const r = await fetch(LL + "/content_locker", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.LOOTLABS_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        return json(await r.json(), r.status);
      }

      /* ---------- Redirect API: encrypt destination ---------- */
      if (url.pathname === "/encrypt" && request.method === "POST") {
        const body = await request.json();
        if (!body.destination_url) return json({ error: "destination_url is required" }, 400);

        const r = await fetch(LL + "/url_encryptor", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + env.LOOTLABS_TOKEN,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ destination_url: body.destination_url }),
        });
        return json(await r.json(), r.status);
      }

      /* ---------- postback from LootLabs ---------- */
      // Configure this URL in Panel -> Advanced -> Postback:
      //   https://<worker>/postback?click_id={CLICK_ID}&ip={IP}&unique_id={UNIQUE_ID}
      if (url.pathname === "/postback") {
        const clickId = url.searchParams.get("click_id");
        if (!clickId) return new Response("missing click_id", { status: 400 });

        await env.UNLOCKS.put(
          "unlock:" + clickId,
          JSON.stringify({
            ip: url.searchParams.get("ip") || "",
            unique_id: url.searchParams.get("unique_id") || "",
            ts: Date.now(),
          }),
          { expirationTtl: TTL }
        );
        return new Response("ok"); // LootLabs expects a 200
      }

      /* ---------- verification poll from the site ---------- */
      if (url.pathname === "/verify") {
        const puid = url.searchParams.get("puid");
        if (!puid) return json({ verified: false, error: "missing puid" }, 400);

        const raw = await env.UNLOCKS.get("unlock:" + puid);
        if (!raw) return json({ verified: false });

        const rec = JSON.parse(raw);
        // Optional hardening: require the completing IP to match the poller.
        const callerIp = request.headers.get("CF-Connecting-IP") || "";
        const ipOk = !rec.ip || !callerIp || rec.ip === callerIp;

        return json({ verified: ipOk, unique_id: rec.unique_id, ip_match: ipOk });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
/**
 * LootLabs API proxy + postback receiver (Cloudflare Worker)
 * ----------------------------------------------------------
 * Why this exists: GitHub Pages is static, so your LootLabs API token
 * cannot live in the site. This Worker holds it and exposes four safe routes.
 *
 * Routes
 *   POST /create          -> creates a content locker link
 *   POST /encrypt         -> Redirect API: encrypt a destination for &data=
 *   GET  /postback        -> LootLabs calls this when a task completes
 *   GET  /verify?puid=..  -> your site polls this to confirm completion
 *
 * Secrets / bindings (see wrangler.toml)
 *   LOOTLABS_TOKEN  (secret)  your API token
 *   ALLOWED_ORIGIN  (var)     your Pages origin, e.g. https://user.github.io
 *   UNLOCKS         (KV)      stores completions
 */

const LL = "https://creators.lootlabs.gg/api/public";
const TTL = 60 * 60 * 24; // remember a completion for 24h

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = env.ALLOWED_ORIGIN || "*";

    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { ...cors, "Content-Type": "application/json" },
      });

    try {
      /* ---------- create a locker link ---------- */
      if (url.pathname === "/create" && request.method === "POST") {
        const body = await request.json();
        const payload = {
          title: String(body.title || "Unlock").slice(0, 30),
          url: body.url,
          tier_id: Number(body.tier_id ?? 1),          // 1-4
          number_of_tasks: Number(body.number_of_tasks ?? 1), // 1-5
        };
        if (body.theme) payload.theme = Number(body.theme);         // 1-5
        if (body.thumbnail) payload.thumbnail = body.thumbnail;

        if (!payload.url) return json({ error: "url is required" }, 400);

        const r = await fetch(\`\${LL}/content_locker\`, {
          method: "POST",
          headers: {
            Authorization: \`Bearer \${env.LOOTLABS_TOKEN}\`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        return json(await r.json(), r.status);
      }

      /* ---------- Redirect API: encrypt destination ---------- */
      if (url.pathname === "/encrypt" && request.method === "POST") {
        const body = await request.json();
        if (!body.destination_url) return json({ error: "destination_url is required" }, 400);

        const r = await fetch(\`\${LL}/url_encryptor\`, {
          method: "POST",
          headers: {
            Authorization: \`Bearer \${env.LOOTLABS_TOKEN}\`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ destination_url: body.destination_url }),
        });
        return json(await r.json(), r.status);
      }

      /* ---------- postback from LootLabs ---------- */
      // Configure this URL in Panel -> Advanced -> Postback:
      //   https://<worker>/postback?click_id={CLICK_ID}&ip={IP}&unique_id={UNIQUE_ID}
      if (url.pathname === "/postback") {
        const clickId = url.searchParams.get("click_id");
        if (!clickId) return new Response("missing click_id", { status: 400 });

        await env.UNLOCKS.put(
          \`unlock:\${clickId}\`,
          JSON.stringify({
            ip: url.searchParams.get("ip") || "",
            unique_id: url.searchParams.get("unique_id") || "",
            ts: Date.now(),
          }),
          { expirationTtl: TTL }
        );
        return new Response("ok"); // LootLabs expects a 200
      }

      /* ---------- verification poll from the site ---------- */
      if (url.pathname === "/verify") {
        const puid = url.searchParams.get("puid");
        if (!puid) return json({ verified: false, error: "missing puid" }, 400);

        const raw = await env.UNLOCKS.get(\`unlock:\${puid}\`);
        if (!raw) return json({ verified: false });

        const rec = JSON.parse(raw);
        // Optional hardening: require the completing IP to match the poller.
        const callerIp = request.headers.get("CF-Connecting-IP") || "";
        const ipOk = !rec.ip || !callerIp || rec.ip === callerIp;

        return json({ verified: ipOk, unique_id: rec.unique_id, ip_match: ipOk });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err && err.message ? err.message : err) }, 500);
    }
  },
};
