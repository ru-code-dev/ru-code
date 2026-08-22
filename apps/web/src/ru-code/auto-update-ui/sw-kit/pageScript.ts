// ru-code: SW page kit — the vanilla runtime script embedded into SW-served
// documents (updating / down). Plain browser JS in a template string: the
// pages must work with the server dead and no app bundle available. The EMITTED
// script has no imports and no app APIs — everything environment-specific arrives
// through `window.__RCU__`; the only exception is a build-time branding tunable
// interpolated into the source below (a literal by the time the page is served).
//
// Contract with the emitted documents (all filled by swPages.ts):
//   · `window.__RCU__` (inline JSON) carries:
//       {page, command, strings, startedAt?, targetVersion?}
//     — `command` is the branded CLI name for clipboard writes (#34);
//     — `strings` is the {probing,probeAgain,copy,copied,elapsedPre,elapsedSuf}
//       map picked by the mirrored locale at emission (#35).
//   · sections carry data-rcu-section="live|success|manual|failed" ([hidden])
//   · dynamic slots: [data-rcu="elapsed"], [data-rcu="countdown"],
//     [data-rcu="new-version"], [data-rcu="fail-reason"],
//     [data-rcu="probe-label"], [data-rcu="copy-label"]
//   · actions (event delegation): data-action="back|copy-cmd|probe|stay|return-now"
//     (`probe` = an immediate /healthz poll: the down page's and the manual screen's «check again»)
//
// Behavior:
//   · down page: heartbeat /healthz every 2.5s → the moment it answers,
//     location.replace("/"). Manual «Проверить» is guarded so it can never race
//     the interval probe (#37).
//   · updating page (item 7): poll /healthz. SUCCESS = response ok AND
//     healthz.version === targetVersion → clear the SW marker, reveal success,
//     countdown 5…0 then auto-return. A healthz answer with a DIFFERENT version
//     keeps waiting (old server dying) UNLESS lastApply.outcome==="failed" — then
//     reveal the failure section with the raw reasonCode. 2 minutes without
//     success → reveal the manual screen but keep polling quietly (a late server
//     still auto-returns). That window is UPDATE_MANUAL_WINDOW_MS, the same
//     constant the in-app /updating page uses, so both surfaces flip together.

// ru-code: build-time constants, interpolated into the emitted script below.
import { UPDATE_MANUAL_WINDOW_MS } from "@ru-code/branding";

import { APP_UPDATE_SETTINGS_ROUTE } from "./runtime";

export const SW_PAGE_SCRIPT = /* js */ `
(function () {
  "use strict";
  var cfg = window.__RCU__ || { page: "down" };
  var S = cfg.strings || {};
  var CMD = typeof cfg.command === "string" ? cfg.command : "";
  var returned = false;
  var countdownTimer = null;
  var pollTimer = null;

  function q(sel) { return document.querySelector(sel); }
  function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  // Two destinations, no computation and nothing stored.
  //   · UPDATING — a fixed route. This page can be up for minutes and the user can navigate while
  //     it is (every navigation fails and is answered by this same document), so the current URL is
  //     not trustworthy. After an update there is one page worth landing on: the one that states
  //     which version is now running.
  //   · DOWN — reload the path this page is already at. A service worker answering a navigation
  //     does not change the URL, so that IS the page the user asked for; it was never anything
  //     the app needed to remember.
  // The old behaviour was location.replace("/") for both, which silently dropped the user at the
  // app root after every update.
  function goHome() {
    if (returned) return;
    returned = true;
    if (cfg.page === "updating") location.replace(${JSON.stringify(APP_UPDATE_SETTINGS_ROUTE)});
    else location.reload();
  }

  function showSection(name) {
    qa("[data-rcu-section]").forEach(function (el) {
      if (el.getAttribute("data-rcu-section") === name) el.removeAttribute("hidden");
      else el.setAttribute("hidden", "");
    });
  }

  function sectionHidden(name) {
    var el = q('[data-rcu-section="' + name + '"]');
    return !el || el.hasAttribute("hidden");
  }

  function setText(slot, text) {
    var el = q('[data-rcu="' + slot + '"]');
    if (el) el.textContent = text;
  }

  function copyCommand(target) {
    try {
      navigator.clipboard.writeText(CMD);
      target.textContent = S.copied || "";
      setTimeout(function () { target.textContent = S.copy || CMD; }, 1500);
    } catch (e) { /* clipboard blocked — leave the label as is */ }
  }

  function health(cb) {
    var done = false;
    var timeout = setTimeout(function () { if (!done) { done = true; cb(null); } }, 4000);
    fetch("/healthz", { cache: "no-store" }).then(function (res) {
      if (done) return;
      if (!res.ok) { done = true; clearTimeout(timeout); cb(null); return; }
      res.json().then(function (body) {
        if (done) return;
        done = true; clearTimeout(timeout);
        cb(body && body.ok ? body : null);
      }, function () { if (!done) { done = true; clearTimeout(timeout); cb(null); } });
    }, function () {
      if (!done) { done = true; clearTimeout(timeout); cb(null); }
    });
  }

  function clearUpdateMarker() {
    try {
      if (cfg.clearMsg && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: cfg.clearMsg });
      }
    } catch (e) { /* the marker also self-expires */ }
  }

  // ── down page ──────────────────────────────────────────────────────────────
  function runDown() {
    var probing = false;
    // \`manual\` decides whether the button says anything. The heartbeat runs every 2.5 s on a page
    // the user may leave open indefinitely, and writing the label from it flipped the only control
    // on screen between «Проверяю…» and «Проверить снова» twice every five seconds, forever, while
    // nothing else changed. A press is a different thing: the user asked, so the button answers.
    function probeOnce(manual) {
      if (probing) return; // in-flight guard — a manual press can't race the interval (#37)
      probing = true;
      if (manual) setText("probe-label", S.probing || "");
      health(function (body) {
        probing = false;
        if (body) { goHome(); return; }
        if (manual) setText("probe-label", S.probeAgain || "");
      });
    }
    pollTimer = setInterval(function () { probeOnce(false); }, 2500);
    probeOnce(false);
    document.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
      if (!target) return;
      var action = target.getAttribute("data-action");
      if (action === "probe") { event.preventDefault(); probeOnce(true); }
      if (action === "copy-cmd") { event.preventDefault(); copyCommand(target); }
    });
  }

  // ── updating page (item 7) ───────────────────────────────────────────────────
  function runUpdating() {
    var startedAt = typeof cfg.startedAt === "number" ? cfg.startedAt : Date.now();
    var target = typeof cfg.targetVersion === "string" ? cfg.targetVersion : "";
    var manualAfterMs = ${UPDATE_MANUAL_WINDOW_MS};
    var terminal = false; // succeeded OR failed — stop touching the live view

    var elapsedTimer = setInterval(function () {
      if (terminal || sectionHidden("live")) return; // stop writing into a hidden node (#37)
      var seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      setText("elapsed", (S.elapsedPre || "") + seconds + (S.elapsedSuf || ""));
    }, 1000);

    function stopTimers() {
      clearInterval(elapsedTimer);
      if (pollTimer) clearInterval(pollTimer);
    }

    function succeed(body) {
      if (terminal) return;
      terminal = true;
      stopTimers();
      clearUpdateMarker();
      if (body && body.version) setText("new-version", "v" + body.version);
      showSection("success");
      var left = 5;
      setText("countdown", String(left));
      countdownTimer = setInterval(function () {
        left -= 1;
        if (left <= 0) { clearInterval(countdownTimer); goHome(); return; }
        setText("countdown", String(left));
      }, 1000);
    }

    function fail(reasonCode) {
      if (terminal) return;
      terminal = true;
      stopTimers();
      setText("fail-reason", reasonCode || "—");
      showSection("failed");
    }

    function pollTick() {
      health(function (body) {
        if (body) {
          if (body.version === target) { succeed(body); return; }
          // A different version answered: the old server came back.
          var la = body.lastApply;
          if (la && la.outcome === "failed") { fail(la.reasonCode); return; }
          // else: the old server is still dying — keep waiting.
        }
        if (!terminal && Date.now() - startedAt > manualAfterMs) {
          // Manual mode: reveal the how-to, slow the poll down, keep listening.
          if (sectionHidden("manual")) {
            showSection("manual");
            if (pollTimer) clearInterval(pollTimer);
            pollTimer = setInterval(pollTick, 4000);
          }
        }
      });
    }
    pollTimer = setInterval(pollTick, 1500);
    pollTick();

    document.addEventListener("click", function (event) {
      var target2 = event.target && event.target.closest ? event.target.closest("[data-action]") : null;
      if (!target2) return;
      var action = target2.getAttribute("data-action");
      if (action === "back" || action === "return-now") { event.preventDefault(); goHome(); }
      // The manual screen's «Проверить снова»: poll immediately instead of waiting out the tick.
      if (action === "probe") { event.preventDefault(); pollTick(); }
      if (action === "stay") {
        event.preventDefault();
        if (countdownTimer) clearInterval(countdownTimer);
        setText("countdown", "—");
      }
      if (action === "copy-cmd") { event.preventDefault(); copyCommand(target2); }
    });
  }

  if (cfg.page === "updating") runUpdating();
  else runDown();
})();
`;
