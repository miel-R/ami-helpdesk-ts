/* =====================================================================
 * Ami chat - session bootstrap (plain JavaScript, no build step).
 *
 * One POST to /api/session on page load that identifies the user first, then
 * hands back their chat. Paste this into the MIS page ABOVE the widget script:
 *
 *     <script>
 *       window.AmiChatConfig = {
 *         baseUrl: 'https://192.1.5.65:3000',
 *         loginUser: '...',        // required - the MIS login id
 *         userName: '...',         // optional
 *         userDepartment: '...',   // optional
 *         identityToken: '...'     // optional - see note below
 *       };
 *     </script>
 *     <script src="this-file.js"></script>
 *
 * What it does, in order:
 *   1. finds the chatbot host (probes /api/health)
 *   2. POSTs the person's details to /api/session  <- identify FIRST
 *   3. gets their name, role and recent chat back in that same response
 *   4. exposes the result as window.AmiSession for the widget or your own code
 *
 * It does NOT send a message, so it cannot spend any of the user's quota.
 * Refresh the page as often as you like.
 *
 * About identityToken: optional. If your MIS page can sign a role with the
 * chatbot's IDENTITY_SECRET, send it here and the chatbot will trust MIS as the
 * source of truth. Without it the chatbot falls back to its own database, which
 * is why an MIS admin may still be shown as "user".
 * ===================================================================== */
(function () {
  'use strict';

  var cfg = window.AmiChatConfig || {};
  var BASE = String(cfg.baseUrl || cfg.apiUrl || 'https://192.1.5.65:3000').replace(/\/+$/, '');
  var FALLBACKS = [BASE].concat(cfg.fallbackUrls || []);

  // Nothing downstream can attribute a person without this, so bail loudly
  // rather than lumping everyone into one shared account.
  var login = String(cfg.loginUser || window.userId || '').trim();
  if (!login) {
    console.warn('[ami] no loginUser - the chatbot cannot identify this user.');
    window.AmiSession = { ready: false, error: 'no_identity' };
    return;
  }

  var sessionId = String(cfg.sessionId || '').trim() || login;

  /** POST the person's details so the server can resolve their role + quota. */
  function identify(base) {
    // JSON, not FormData: there are no files here, and the server's JSON body
    // parser is always active. FormData would need multipart, which only the
    // /api/chat route parses.
    var payload = {
      session_id: sessionId,
      login_user: login,
      user_name: String(cfg.userName || ''),
      user_email: String(cfg.userEmail || ''),
      user_department: String(cfg.userDepartment || '')
    };
    if (cfg.identityToken) payload.identity_token = String(cfg.identityToken);

    return fetch(base + '/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store'
    })
      .then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
      });
  }

  /** Find a reachable host, then identify. Order matters: identify, then chat. */
  function probe(i) {
    if (i >= FALLBACKS.length) {
      console.warn('[ami] no reachable chatbot host tried:', FALLBACKS);
      window.AmiSession = { ready: false, error: 'unreachable' };
      return Promise.resolve(null);
    }
    var base = FALLBACKS[i];

    return fetch(base + '/api/health', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('unhealthy')); })
      .catch(function () { return probe(i + 1); })
      .then(function () { return identify(base); })
      .catch(function () { return probe(i + 1); })
      .then(function (s) {
        if (!s) return null;

        window.AmiSession = {
          ready: true,
          base: base,
          session: s,
          user: s.user,
          messages: s.messages || []
        };

        // The widget renders the same object, so it does not need a second
        // round trip for history or role.
        if (window.AmiWidget && typeof window.AmiWidget.applySession === 'function') {
          window.AmiWidget.applySession(s);
        }

        console.log('[ami] signed in as ' + s.user.name + ' (' + s.user.role
          + ', from ' + s.user.role_source + '), '
          + (s.messages || []).length + ' prior messages');
        return s;
      });
  }

  // Fired for other scripts that want to wait until the user is identified.
  // Deliberately run exactly once: this POST registers the user, and calling it
  // again on DOMContentLoaded would fire a duplicate request on every load.
  window.AmiSessionReady = probe(0);
})();