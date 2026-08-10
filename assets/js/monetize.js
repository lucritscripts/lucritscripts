/* ============================================================
 *  monetize.js — the gate stack
 *  Owns all unlock UI and decides which network handles each
 *  unlock (LootLabs / Linkvertise / rotate). Surfaces:
 *    · inline section gates   [data-gate="id"]
 *    · full-page interstitial [body data-gate-page="id"]
 *    · sticky bottom bar
 *    · exit-intent modal
 * ============================================================ */
(function (global) {
  "use strict";

  var G = global.GATES || {};
  var LL = global.LOOTLABS || {};
  var STORE = "gate_unlocks_v1";
  var SESSION = "gate_session_v1";
  var pageLoadedAt = Date.now();

  /* ---------------- storage ---------------- */

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)) || {}; }
    catch (e) { return {}; }
  }
  function write(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  }
  function isUnlocked(lockId) {
    var rec = read(STORE)[lockId];
    return !!rec && rec.exp > Date.now();
  }
  function markUnlocked(lockId) {
    var s = read(STORE);
    s[lockId] = { exp: Date.now() + (LL.unlockTtlHours || 24) * 3600e3 };
    write(STORE, s);
    document.dispatchEvent(new CustomEvent("gate:unlocked", { detail: { lockId: lockId } }));
  }
  function seenThisSession(key) {
    try { return sessionStorage.getItem(SESSION + ":" + key) === "1"; }
    catch (e) { return false; }
  }
  function markSeen(key) {
    try { sessionStorage.setItem(SESSION + ":" + key, "1"); } catch (e) {}
  }

  function uuid() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return "xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /* ---------------- network routing ----------------
   * "rotate" alternates so one network's fill rate or payout dip
   * doesn't take the whole site down with it. Falls back to
   * whichever network is actually configured for that lockId.
   */
  var rotateFlag = 0;

  function pickNetwork(lockId) {
    var hasLL = global.LootLabs && global.LootLabs.configured(lockId);
    var hasLV = global.Linkvertise && !!global.Linkvertise.resolve(lockId);

    if (G.network === "lootlabs") return hasLL ? "lootlabs" : (hasLV ? "linkvertise" : null);
    if (G.network === "linkvertise") return hasLV ? "linkvertise" : (hasLL ? "lootlabs" : null);

    if (hasLL && hasLV) return (rotateFlag++ % 2 === 0) ? "lootlabs" : "linkvertise";
    if (hasLL) return "lootlabs";
    if (hasLV) return "linkvertise";
    return null;
  }

  /* ---------------- the unlock flow ----------------
   * Opens the gate in a new tab on a real user click. Browsers block
   * popups that aren't click-initiated, so every caller here must be
   * inside a click handler — never a timer or page-load.
   */
  function openGate(lockId, callbacks) {
    callbacks = callbacks || {};
    var net = pickNetwork(lockId);

    if (!net) {
      if (callbacks.onError) callbacks.onError("No locker configured for \"" + lockId + "\". Add one in assets/js/config.js.");
      return;
    }

    var puid = uuid();
    var url = net === "lootlabs"
      ? global.LootLabs.lockerUrl(lockId, puid)
      : global.Linkvertise.resolve(lockId);

    if (!url) {
      if (callbacks.onError) callbacks.onError("Locker link missing for \"" + lockId + "\".");
      return;
    }

    global.open(url, "_blank", "noopener");
    if (callbacks.onOpen) callbacks.onOpen(net);

    // LootLabs + Worker = real server-side verification.
    if (net === "lootlabs" && global.LootLabs.hasWorker()) {
      if (callbacks.onWaiting) callbacks.onWaiting();
      global.LootLabs.pollVerify(puid)
        .then(function () { markUnlocked(lockId); if (callbacks.onDone) callbacks.onDone(); })
        .catch(function () { if (callbacks.onFail) callbacks.onFail(); });
      return;
    }

    // Linkvertise has no publisher-side postback, and LootLabs without a
    // Worker can't be verified either. Unlock when the reader comes back.
    if (LL.allowUnverifiedUnlock !== false) {
      var onReturn = function () {
        if (document.visibilityState !== "visible") return;
        document.removeEventListener("visibilitychange", onReturn);
        markUnlocked(lockId);
        if (callbacks.onDone) callbacks.onDone();
      };
      document.addEventListener("visibilitychange", onReturn);
    } else if (callbacks.onFail) {
      callbacks.onFail();
    }
  }

  /* ---------------- inline section gates ---------------- */

  function attachSectionGate(el) {
    var lockId = el.getAttribute("data-gate") || el.getAttribute("data-lootlabs-lock");
    if (!lockId) return;

    if (isUnlocked(lockId)) { el.classList.add("is-unlocked"); return; }

    var original = el.innerHTML;
    el.classList.add("is-locked");
    el.innerHTML =
      '<div class="ll-lock">' +
        '<div class="ll-lock__icon" aria-hidden="true">&#128274;</div>' +
        '<h3 class="ll-lock__title">' + (el.getAttribute("data-lock-title") || "Unlock this section") + "</h3>" +
        '<p class="ll-lock__desc">' + (el.getAttribute("data-lock-desc") || "Complete one quick sponsor step to reveal this. It funds the site and keeps everything free.") + "</p>" +
        '<button class="ll-lock__btn" type="button">' + (el.getAttribute("data-lock-cta") || "Unlock free") + "</button>" +
        '<p class="ll-lock__status" role="status" aria-live="polite"></p>' +
      "</div>";

    var btn = el.querySelector(".ll-lock__btn");
    var status = el.querySelector(".ll-lock__status");

    function reveal() {
      el.innerHTML = original;
      el.classList.remove("is-locked");
      el.classList.add("is-unlocked");
    }

    btn.addEventListener("click", function () {
      openGate(lockId, {
        onOpen: function () {
          btn.disabled = true;
          btn.textContent = "Opening…";
          status.textContent = "Finish the step in the new tab, then come back.";
        },
        onWaiting: function () { status.textContent = "Waiting for confirmation…"; },
        onDone: reveal,
        onFail: function () {
          btn.disabled = false;
          btn.textContent = "Try again";
          status.textContent = "Couldn't confirm that. Finish the step, then retry.";
        },
        onError: function (msg) { status.textContent = msg; },
      });
    });
  }

  /* ---------------- full-page interstitial ---------------- */

  function mountInterstitial(lockId) {
    var cfg = G.interstitial || {};
    if (isUnlocked(lockId)) return;

    document.documentElement.classList.add("gate-locked");
    var overlay = document.createElement("div");
    overlay.className = "gate-overlay";
    overlay.innerHTML =
      '<div class="gate-modal" role="dialog" aria-modal="true" aria-labelledby="gate-t">' +
        '<div class="ll-lock__icon" aria-hidden="true">&#128274;</div>' +
        '<h2 id="gate-t">' + (cfg.title || "One step to continue") + "</h2>" +
        "<p>" + (cfg.body || "This page is reader-supported.") + "</p>" +
        '<button class="ll-lock__btn" type="button">' + (cfg.cta || "Continue") + "</button>" +
        '<p class="ll-lock__status" role="status" aria-live="polite"></p>' +
      "</div>";
    document.body.appendChild(overlay);

    var btn = overlay.querySelector(".ll-lock__btn");
    var status = overlay.querySelector(".ll-lock__status");

    btn.addEventListener("click", function () {
      openGate(lockId, {
        onOpen: function () { btn.disabled = true; btn.textContent = "Opening…"; },
        onWaiting: function () { status.textContent = "Waiting for confirmation…"; },
        onDone: function () {
          overlay.remove();
          document.documentElement.classList.remove("gate-locked");
        },
        onFail: function () {
          btn.disabled = false;
          btn.textContent = "Try again";
          status.textContent = "Couldn't confirm that.";
        },
        onError: function (m) { status.textContent = m; },
      });
    });
  }

  /* ---------------- sticky bar ---------------- */

  function mountStickyBar() {
    var cfg = G.stickyBar || {};
    if (!cfg.enabled) return;
    if (isUnlocked(cfg.lockId)) return;

    var dismissed = read(STORE)["_bar_dismissed"];
    if (dismissed && dismissed.exp > Date.now()) return;

    setTimeout(function () {
      var bar = document.createElement("div");
      bar.className = "gate-bar";
      bar.innerHTML =
        "<span>" + (cfg.text || "Support the site") + "</span>" +
        '<button class="gate-bar__cta" type="button">' + (cfg.cta || "Support") + "</button>" +
        '<button class="gate-bar__x" type="button" aria-label="Dismiss">&times;</button>';
      document.body.appendChild(bar);
      requestAnimationFrame(function () { bar.classList.add("is-in"); });

      bar.querySelector(".gate-bar__cta").addEventListener("click", function () {
        openGate(cfg.lockId, {
          onDone: function () { bar.remove(); },
          onError: function (m) { bar.querySelector("span").textContent = m; },
        });
      });

      bar.querySelector(".gate-bar__x").addEventListener("click", function () {
        var s = read(STORE);
        s["_bar_dismissed"] = { exp: Date.now() + (cfg.dismissHours || 12) * 3600e3 };
        write(STORE, s);
        bar.remove();
      });
    }, cfg.delayMs || 8000);
  }

  /* ---------------- exit intent ---------------- */

  function mountExitIntent() {
    var cfg = G.exitIntent || {};
    if (!cfg.enabled) return;
    if (seenThisSession("exit")) return;
    if (isUnlocked(cfg.lockId)) return;

    function onLeave(e) {
      if (e.clientY > 0) return;
      if ((Date.now() - pageLoadedAt) / 1000 < (cfg.minSecondsOnPage || 20)) return;
      document.removeEventListener("mouseout", onLeave);
      markSeen("exit");
      show();
    }

    function show() {
      var overlay = document.createElement("div");
      overlay.className = "gate-overlay";
      overlay.innerHTML =
        '<div class="gate-modal" role="dialog" aria-modal="true">' +
          "<h2>" + (cfg.title || "Before you go") + "</h2>" +
          "<p>" + (cfg.body || "") + "</p>" +
          '<button class="ll-lock__btn" type="button">' + (cfg.cta || "Unlock") + "</button>" +
          '<button class="gate-modal__x" type="button">No thanks</button>' +
        "</div>";
      document.body.appendChild(overlay);

      overlay.querySelector(".ll-lock__btn").addEventListener("click", function () {
        openGate(cfg.lockId, { onDone: function () { overlay.remove(); } });
      });
      overlay.querySelector(".gate-modal__x").addEventListener("click", function () {
        overlay.remove();
      });
    }

    document.addEventListener("mouseout", onLeave);
  }

  /* ---------------- init ---------------- */

  function init() {
    Array.prototype.forEach.call(
      document.querySelectorAll("[data-gate], [data-lootlabs-lock]"),
      attachSectionGate
    );

    var pageLock = document.body.getAttribute("data-gate-page");
    if (pageLock) mountInterstitial(pageLock);

    mountStickyBar();
    mountExitIntent();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  global.Monetize = {
    openGate: openGate,
    isUnlocked: isUnlocked,
    markUnlocked: markUnlocked,
    pickNetwork: pickNetwork,
    uuid: uuid,
  };
})(window);
