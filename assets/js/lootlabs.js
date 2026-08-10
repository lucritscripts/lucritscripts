/* ============================================================
 *  lootlabs.js — LootLabs primitives
 *  Link locker URLs, Content Locker API, Redirect API, task-wall
 *  SDK, and postback verification. No DOM ownership: monetize.js
 *  drives the UI and decides which network handles each unlock.
 * ============================================================ */
(function (global) {
  "use strict";

  var CFG = global.LOOTLABS || {};

  function api(path, body) {
    if (!CFG.workerUrl) return Promise.reject(new Error("no-worker"));
    return fetch(CFG.workerUrl.replace(/\/$/, "") + path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error("http-" + r.status);
      return r.json();
    });
  }

  /* ---------- static link locker ---------- */
  function lockerUrl(lockId, puid) {
    var base = (CFG.links || {})[lockId];
    if (!base || /REPLACE_ME/.test(base)) return null;
    if (!puid) return base;
    return base + (base.indexOf("?") === -1 ? "?" : "&") + "puid=" + encodeURIComponent(puid);
  }

  /* ---------- Content Locker API (via Worker) ---------- */
  function createLink(opts) {
    return api("/create", opts).then(function (res) {
      var m = res && res.message;
      if (!m || !m.loot_url) throw new Error("bad-response");
      return m.loot_url;
    });
  }

  /* ---------- Redirect API (anti-bypass) ---------- */
  function encryptDestination(destinationUrl) {
    return api("/encrypt", { destination_url: destinationUrl }).then(function (res) {
      if (!res || !res.message) throw new Error("bad-response");
      return res.message;
    });
  }

  /* ---------- postback verification ---------- */
  function verifyOnce(puid) {
    return api("/verify?puid=" + encodeURIComponent(puid));
  }

  function pollVerify(puid) {
    var deadline = Date.now() + (CFG.verifyTimeoutMs || 300000);
    return new Promise(function (resolve, reject) {
      (function tick() {
        if (Date.now() > deadline) return reject(new Error("timeout"));
        verifyOnce(puid)
          .then(function (res) {
            if (res && res.verified) return resolve(res);
            setTimeout(tick, CFG.verifyIntervalMs || 3000);
          })
          .catch(function () {
            setTimeout(tick, CFG.verifyIntervalMs || 3000);
          });
      })();
    });
  }

  /* ---------- task-wall SDK ---------- */
  var wall = { containerId: null, onAllDone: null, total: 0, done: 0 };

  function defineManualTasks() {
    if (Object.getOwnPropertyDescriptor(global, "manualTasks")) return;
    Object.defineProperty(global, "manualTasks", {
      configurable: true,
      set: function (value) {
        this._manualTasks = value;
        renderTaskButtons(value || []);
      },
      get: function () {
        return this._manualTasks;
      },
    });
  }

  function renderTaskButtons(adsArray) {
    var container = document.getElementById(wall.containerId || "taskwall");
    if (!container) return;
    container.innerHTML = "";
    wall.total = adsArray.length;
    wall.done = 0;

    adsArray.forEach(function (item, index) {
      var button = document.createElement("button");
      button.type = "button";
      button.id = "ad-btn-" + index;
      button.className = "ll-task";
      button.textContent = item.title || "Sponsored step " + (index + 1);
      button.addEventListener("click", function () {
        global.runTask(index);
        button.textContent = "Loading…";
        button.classList.add("is-loading");
      });
      container.appendChild(button);
    });
  }

  global.taskCompleted = function (index) {
    var btn = document.getElementById("ad-btn-" + index);
    if (btn) {
      btn.disabled = true;
      btn.classList.remove("is-loading");
      btn.classList.add("is-done");
      btn.textContent = "Completed";
    }
    wall.done++;
    if (wall.onAllDone && wall.done >= wall.total) wall.onAllDone();
  };

  function mountTaskWall(containerId, onAllDone) {
    wall.containerId = containerId;
    wall.onAllDone = onAllDone || null;
    global.postbackValue = global.postbackValue || (global.Monetize && global.Monetize.uuid());
    defineManualTasks();

    if (!CFG.sdkScriptUrl) {
      var c = document.getElementById(containerId);
      if (c) c.innerHTML = '<p class="ll-muted">Task wall disabled — no SDK script configured.</p>';
      return;
    }
    if (document.querySelector("script[data-lootlabs-sdk]")) return;
    var s = document.createElement("script");
    s.src = CFG.sdkScriptUrl;
    s.async = true;
    s.setAttribute("data-lootlabs-sdk", "1");
    document.head.appendChild(s);
  }

  global.LootLabs = {
    lockerUrl: lockerUrl,
    createLink: createLink,
    encryptDestination: encryptDestination,
    pollVerify: pollVerify,
    mountTaskWall: mountTaskWall,
    hasWorker: function () { return !!CFG.workerUrl; },
    configured: function (lockId) { return !!lockerUrl(lockId); },
  };
})(window);
