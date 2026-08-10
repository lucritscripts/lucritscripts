/* ============================================================
 *  linkvertise.js — Full Script API loader + link helpers
 *  Docs: help.linkvertise.com → "How do I integrate the Full
 *  Script API on any Website?"
 * ============================================================ */
(function (global) {
  "use strict";

  var CFG = global.LINKVERTISE || {};
  var CDN = "https://publisher.linkvertise.com/cdn/linkvertise.js";

  /* ---------- Full Script API ----------
   * Converts every OUTBOUND link on the page into a Linkvertise link.
   * Must run on every page. Your own domain must be blacklisted or
   * internal navigation gets monetized too and the site becomes unusable.
   */
  function loadFullScript() {
    if (!CFG.fullScript || !CFG.userId) return;
    if (document.querySelector("script[data-linkvertise]")) return;

    var s = document.createElement("script");
    s.src = CDN;
    s.async = true;
    s.setAttribute("data-linkvertise", "1");

    s.onload = function () {
      if (typeof global.linkvertise !== "function") return;
      global.linkvertise(CFG.userId, {
        whitelist: CFG.whitelist || [],
        blacklist: CFG.blacklist || [],
      });
    };

    s.onerror = function () {
      // Adblockers kill this file often. Fail silently — the site must
      // still work, and the LootLabs path is unaffected.
      if (global.console && console.info) {
        console.info("[linkvertise] script blocked or unavailable");
      }
    };

    document.head.appendChild(s);
  }

  /* ---------- static links ---------- */
  function linkFor(lockId) {
    var url = (CFG.links || {})[lockId];
    return url && !/REPLACE/.test(url) ? url : null;
  }

  /* ---------- dynamic detour links (UNOFFICIAL) ----------
   * Format reverse-engineered by the community, not documented or
   * supported by Linkvertise. Links built this way do not show up in
   * your dashboard and the format can change without warning.
   * Gated behind config.useDynamicLinks for that reason.
   */
  function dynamicLink(destinationUrl) {
    if (!CFG.useDynamicLinks || !CFG.userId) return null;
    var b64 = btoa(destinationUrl).replace(/=+$/, "");
    var rand = Math.random().toString(36).slice(2, 10);
    return (
      "https://link-to.net/" + CFG.userId + "/" + rand +
      "/dynamic?r=" + encodeURIComponent(b64)
    );
  }

  /* ---------- resolve the best available link ---------- */
  function resolve(lockId, fallbackDestination) {
    return linkFor(lockId) || dynamicLink(fallbackDestination || location.href);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadFullScript);
  } else {
    loadFullScript();
  }

  global.Linkvertise = {
    load: loadFullScript,
    linkFor: linkFor,
    dynamicLink: dynamicLink,
    resolve: resolve,
    configured: !!CFG.userId,
  };
})(window);
