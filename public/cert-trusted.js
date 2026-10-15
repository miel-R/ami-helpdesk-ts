// The one moving part of cert-trusted.html: find the Helpdesk address and put a
// real link in the page.
//
// It lives in a FILE rather than an inline <script> block, and that is not a style
// choice. Every page this app serves carries helmet's default Content-Security-
// Policy, whose script-src is 'self' with no 'unsafe-inline'. An inline script is
// therefore refused by the browser, silently, and the page renders its static
// markup looking perfectly normal while nothing in it works. That is not
// hypothetical: the page spent its whole life broken exactly that way, showing a
// permanent "Checking..." and two dead buttons, because the script that was meant
// to replace that text never ran.
//
// 'self' permits a script loaded from the same origin, so a file next to the HTML
// is the shape the policy actually allows. tools/cert-page-regress.cjs asserts
// that no inline <script> ever comes back, so this cannot regress quietly.

(function () {
  'use strict';

  // Hardcoded to match AmiChatConfig.baseUrl. Deliberately absolute: this file is
  // also reachable under the MIS-mounted path, where a relative URL would resolve
  // to a path the API never serves from there.
  var ORIGIN = 'https://192.1.5.21:3000';
  var CONFIG_URL = ORIGIN + '/api/public/cert-config';
  // Only this fetch can hang, so only this needs a deadline. The page's verdict is
  // already written into the markup; a stalled lookup must not blank it out or
  // leave a half-drawn link behind.
  var TIMEOUT_MS = 5000;

  // Only ever http(s). Anything else (javascript:, data:) is refused rather than
  // followed, so a crafted ?back= cannot turn the link into an injection.
  function safeUrl(value) {
    if (!value) return null;
    try {
      var u = new URL(String(value));
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    } catch (e) { /* not a URL */ }
    return null;
  }

  var slot = document.getElementById('backslot');

  function showLink(url) {
    if (!slot) return;
    if (!url) {
      slot.textContent = 'Go back to your Helpdesk tab and the chat button will be ' +
        'in the bottom-right corner.';
      return;
    }
    var a = document.createElement('a');
    a.className = 'btn';
    a.href = url;
    a.textContent = 'Back to the Helpdesk';
    slot.appendChild(a);
  }

  // The Helpdesk address is a dashboard setting, so the live value is fetched
  // rather than baked into either file. The ?back= param the help page passes and
  // the referrer are fallbacks for when that endpoint cannot be reached.
  function resolveBackUrl() {
    var fallback = safeUrl(new URLSearchParams(window.location.search).get('back')) ||
      safeUrl(document.referrer);
    if (typeof window.fetch !== 'function') return Promise.resolve(fallback);
    // Guarded rather than assumed. An older browser without AbortController would
    // otherwise throw on the line below, and since that throw escapes before the
    // promise is ever built, showLink would never be called and the page would sit
    // empty again. The fallback keeps the page useful either way.
    if (typeof window.AbortController !== 'function') return Promise.resolve(fallback);

    var ctrl = new window.AbortController();
    var timer = window.setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);
    return window.fetch(CONFIG_URL, { mode: 'cors', cache: 'no-store', signal: ctrl.signal })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (body) { return safeUrl(body && body.helpdesk_url) || fallback; })
      .catch(function () { return fallback; })
      .then(function (url) {
        window.clearTimeout(timer);
        return url;
      });
  }

  // One fetch, one outcome. showLink is called exactly once either way, so the
  // page cannot end up half-rendered no matter how the lookup resolves.
  resolveBackUrl().then(showLink, showLink);
})();