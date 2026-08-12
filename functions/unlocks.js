/**
 * LootLabs proxy and postback receiver.
 *
 * Ported from the Cloudflare Worker so the whole backend lives in one place.
 * The only real change is storage: Workers KV became a Firestore collection
 * with a TTL field, and the API token became a Secret Manager secret.
 *
 * Routes (all under the one function URL):
 *   POST /create           create a content locker link
 *   POST /encrypt          Redirect API — encrypt a destination for &data=
 *   GET  /postback         LootLabs calls this when a task completes
 *   GET  /verify?puid=..   the site polls this to confirm completion
 *
 * The postback route is deliberately NOT origin-checked: LootLabs' servers
 * call it, and they send no Origin header. It is safe because it only records
 * a click id — reading that back still goes through /verify.
 */

import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";

import { checkOrigin, sendJson, clientIp } from "./lib/http.js";

const LOOTLABS = "https://creators.lootlabs.gg/api/public";

const LOOTLABS_TOKEN = defineSecret("LOOTLABS_TOKEN");
const ALLOWED_ORIGINS = defineSecret("ALLOWED_ORIGINS");

/** How long a completed unlock is remembered. */
const TTL_MS = 24 * 60 * 60 * 1000;

async function callLootLabs(path, payload, token) {
  const r = await fetch(LOOTLABS + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export const unlocks = onRequest(
  {
    secrets: [LOOTLABS_TOKEN, ALLOWED_ORIGINS],
    concurrency: 40,
    maxInstances: 3,
    memory: "256MiB",
    timeoutSeconds: 60,
    cors: false,
  },
  async (req, res) => {
    const db = getFirestore();
    const route = (req.path || "/").replace(/\/+$/, "") || "/";

    /* ---- postback: called by LootLabs, not by a browser ---- */

    if (route === "/postback") {
      const clickId = String(req.query.click_id || "");
      if (!clickId) return res.status(400).send("missing click_id");

      await db.collection("unlocks").doc(clickId).set({
        ip: String(req.query.ip || ""),
        uniqueId: String(req.query.unique_id || ""),
        at: Date.now(),
        expires: new Date(Date.now() + TTL_MS),
      });

      return res.status(200).send("ok");   // LootLabs expects a 200
    }

    /* ---- everything else is called by the site ---- */

    const allowed = checkOrigin(req, res, ALLOWED_ORIGINS.value());
    if (req.method === "OPTIONS") return res.status(204).send("");
    if (!allowed) return sendJson(res, 403, { error: "Not allowed from this origin." });

    try {
      if (route === "/create" && req.method === "POST") {
        const b = req.body || {};
        if (!b.url) return sendJson(res, 400, { error: "url is required" });

        const payload = {
          title: String(b.title || "Unlock").slice(0, 30),
          url: b.url,
          tier_id: Number(b.tier_id ?? 1),                  // 1-4
          number_of_tasks: Number(b.number_of_tasks ?? 1),  // 1-5
        };
        if (b.theme) payload.theme = Number(b.theme);       // 1-5
        if (b.thumbnail) payload.thumbnail = b.thumbnail;

        const { status, body } = await callLootLabs("/content_locker", payload, LOOTLABS_TOKEN.value());
        return sendJson(res, status, body);
      }

      if (route === "/encrypt" && req.method === "POST") {
        const destination = req.body?.destination_url;
        if (!destination) return sendJson(res, 400, { error: "destination_url is required" });

        const { status, body } = await callLootLabs(
          "/url_encryptor", { destination_url: destination }, LOOTLABS_TOKEN.value()
        );
        return sendJson(res, status, body);
      }

      if (route === "/verify") {
        const puid = String(req.query.puid || "");
        if (!puid) return sendJson(res, 400, { verified: false, error: "missing puid" });

        const snap = await db.collection("unlocks").doc(puid).get();
        if (!snap.exists) return sendJson(res, 200, { verified: false });

        const rec = snap.data();
        if (rec.at && Date.now() - rec.at > TTL_MS) {
          return sendJson(res, 200, { verified: false, error: "expired" });
        }

        // The address that completed the offer should be the one asking.
        const caller = clientIp(req);
        const ipOk = !rec.ip || !caller || rec.ip === caller;

        return sendJson(res, 200, { verified: ipOk, unique_id: rec.uniqueId, ip_match: ipOk });
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("unlocks error", err?.message);
      return sendJson(res, 500, { error: "Something went wrong." });
    }
  }
);
