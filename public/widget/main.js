/* Ami Helpdesk Chat Widget - Main */

// Only modules that are actually used.
//
// `api.js` and `events.js` were imported here and never referenced - main.js has
// its own `candidateBases`/`probe`/`discover` and its own `bindEvents`, which are
// the real implementations the widget runs on. Importing them did nothing but
// ship two more files to the browser and, worse, invite the next reader to patch
// the copy that is not running.
//
// `ui.js` survives for exactly one call, `setIcons`, which only assigns a module
// variable so `getIcon` can look names up. Its other exports - escapeHtml,
// renderContent, the message builders and a second lightbox - are duplicates of
// what main.js does inline, and it is the second lightbox that carried the same
// innerHTML-with-filename hole fixed in main.js. It is imported for that one call
// rather than deleted, because unwiring the icon lookup is a larger change than
// this cleanup should make.
import { AmiIcons } from './icons.js';
import { AmiConfig } from './config.js';
import { AmiState } from './state.js';
import { AmiUI } from './ui.js';
import { AmiModal } from './modal.js';

const AmiWidgetModule = (function() {
  'use strict';

  // Initialize UI with icons
  AmiUI.setIcons(AmiIcons);

  /**
 * How close to the top of the transcript counts as "at the top" and should pull
 * in the previous page. See the scroll handler in bindEvents for why this is not
 * a hairline trigger.
 */
var LOAD_MORE_THRESHOLD_PX = 48;

/**
 * How far from the bottom the transcript may sit and still count as "reading the
 * latest messages", which is what hides the jump-to-latest control.
 *
 * Deliberately looser than a strict 0px: a rounded pixel or two of slack from
 * sub-pixel layout stops the control flickering on and off as the last message
 * settles.
 */
var JUMP_TOLERANCE_PX = 24;

/**
 * The wire value the server writes into `messages` when it closes a conversation.
 * Must match `SESSION_END_MARKER` in session-lifecycle.service.ts.
 */
var SESSION_END_MARKER = '[ended session]';

/**
 * What the divider reads in the transcript.
 *
 * The surrounding rules are drawn by CSS (`.ami-session-end::before/::after`), so
 * this is the LABEL ONLY. It used to carry its own `—————` on each side, which
 * doubled up with those rules and rendered as a row of dashes either side of a
 * row of dashes.
 */
var SESSION_END_LABEL = 'Session ended';

/**
 * Prefix on stage directives the widget posts to the chat ("the user closed the
 * form, acknowledge briefly").
 *
 * They are instructions to the model, not conversation, and they are stored with
 * role `user` because that is how the model reads them. But that made every one of
 * them render in the transcript as a user bubble showing the literal instruction
 * text - so a user who cancelled the form came back to a thread reading
 * "[SYSTEM] The user closed the ticket form without submitting. Nothing was
 * filed. Acknowledge briefly and offer to pick it up later." in their own bubble.
 *
 * They stay persisted: the model needs them for continuity within the session, and
 * the assistant's acknowledgement is a real turn that should survive a reload. Only
 * the raw directive is hidden.
 */
var SESSION_STAGE_PREFIX = '[SYSTEM]';

/**
 * Key under which the ticket form suspends the idle clocks.
 *
 * One constant for BOTH suspend and resume. They used to read
 * `'ticket form open'` and `'ticket form closed'`, which do not match - so the
 * resume found nothing to release and the clocks stayed paused for the rest of
 * the session. The form would then suppress the nudge and the close permanently,
 * which is a worse bug than the one it was meant to prevent.
 */
var SESSION_SUSPEND_LABEL = 'ticket-form';

function isStageDirective(msg) {
  return !!msg && String(msg.content || '').trim().indexOf(SESSION_STAGE_PREFIX) === 0;
}

function isSessionEndMarker(msg) {
  return !!msg && msg.role === 'system' && String(msg.content || '').trim() === SESSION_END_MARKER;
}

/**
 * Releases the programmatic-scroll lock once the position has settled.
 *
 * While `_autoScrolling` is set, scroll events are ours, not the user's, so the
 * jump-to-latest check ignores them. The timer has to outlive a smooth animation,
 * hence 420ms for that case and nothing at all for an instant assignment.
 */
function releaseScrollLock(self) {
  self._autoScrolling = false;
  self._autoScrollTimer = null;
  // Re-evaluate now that the position is final: if the user was reading back
  // through history when a page was prepended, the control should be visible; if
  // we just landed at the bottom, it should not.
  self.toggleJumpToLatest();
}

/**
 * Paging diagnostics, off by default.
 *
 * These lines existed to diagnose a bug that took several rounds to find, and
 * they earned their keep: `ReferenceError: lastTime is not defined` is what ended
 * it. They then became noise on every scroll, so they are now opt-in from the
 * console rather than permanent:
 *
 *   AmiWidget.setHistoryDebug(true)   // turn them back on
 *   AmiWidget.pagingState()           // inspect the paging fields at any time
 *
 * `pagingState()` is unaffected by this flag - it is a manual call, so it always
 * reports the truth.
 */
var HISTORY_DEBUG = false;
function historyDebug() {
  if (HISTORY_DEBUG && typeof console !== 'undefined' && console.log) {
    console.log.apply(console, ['[ami:history]'].concat([].slice.call(arguments)));
  }
}

/**
 * The id of the oldest message in a newest-first page - i.e. the `before` cursor
 * for the next (older) page.
 *
 * Ids arrive as strings from Postgres, so a numeric-looking string is used as-is
 * and never coerced: turning "139" into 139 is harmless, but turning a
 * non-numeric id into NaN would silently produce a cursor that matches nothing.
 */
function oldestIdIn(messages) {
  if (!messages || !messages.length) return null;
  var last = messages[messages.length - 1];
  var id = last && last.id;
  return (id === undefined || id === null || id === '') ? null : String(id);
}

var Widget = {
    // State
    ...AmiState.createInitialState(),
    el: {},

    // Icons reference
    icons: AmiIcons,

    /* -------------------------- API Discovery -------------------------- */

    candidateBases: function () {
      var cfg = window.AmiChatConfig || {};
      var list = [];
      function push(u) {
        if (!u) return;
        u = String(u).replace(/\/+$/, '');
        if (list.indexOf(u) === -1) list.push(u);
      }

      push(cfg.baseUrl);
      push(cfg.apiUrl);
      (cfg.fallbackUrls || []).forEach(push);

      try {
        var scripts = document.getElementsByTagName('script');
        for (var i = 0; i < scripts.length; i++) {
          var src = scripts[i].src || '';
          if (/(^|\/)widget\.js/i.test(src)) push(src.replace(/widget\.js[^/]*$/i, ''));
        }
      } catch (e) { /* ignore */ }

      push(window.location.origin);
      ['192.1.5.65:3000', 'localhost:3000', '127.0.0.1:3000'].forEach(function (h) {
        push(window.location.protocol + '//' + h);
      });
      if (window.location.protocol === 'https:') push('https://' + window.location.hostname + ':3000');

      try {
        var cached = localStorage.getItem('ami_api_base');
        if (cached) list.unshift(cached);
      } catch (e) { /* ignore */ }

      return list;
    },

    probe: function (base) {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 2500);
      return fetch(base + '/api/health', { method: 'GET', signal: ctrl.signal, mode: 'cors', cache: 'no-store' })
        .then(function (r) { clearTimeout(timer); return r.ok ? base : null; })
        .catch(function () { clearTimeout(timer); return null; });
    },

    discover: function () {
      var self = this;
      var list = this.candidateBases();
      if (!list.length) return Promise.resolve('');

      var cfgBase = (window.AmiChatConfig || {}).baseUrl;
      if (cfgBase && list[0] === String(cfgBase).replace(/\/+$/, '')) {
        return fetch(cfgBase.replace(/\/+$/, '') + '/api/health', { mode: 'cors', cache: 'no-store' })
          .then(function (r) { return r.ok ? cfgBase.replace(/\/+$/, '') : self.probeChain(list.slice(1)); })
          .catch(function () { return self.probeChain(list.slice(1)); });
      }
      return this.probeChain(list);
    },

    probeChain: function (list) {
      var self = this, i = 0;
      function next() {
        if (i >= list.length) return Promise.resolve('');
        return self.probe(list[i++]).then(function (ok) {
          if (ok) {
            try { localStorage.setItem('ami_api_base', ok); } catch (e) { /* ignore */ }
            return ok;
          }
          return next();
        });
      }
      return next();
    },

    apiBase: function () { return this._apiBase || ''; },
    apiUrl: function (p) { return this.apiBase() + p; },

    /* -------------------------- Init -------------------------- */

    /**
     * The live widget instance, for host pages and the console.
     *
     * `window.AmiWidget` is the Widget OBJECT - a bag of methods on the prototype
     * literal, not the booted widget. Calling `AmiWidget.showSessionEnded()` on it
     * therefore ran against no DOM at all and silently did nothing, which is a
     * bad trap to leave for the external trigger this function exists to serve.
     * This is the instance the user actually means.
     */
    instance: function () { return this._instance || null; },

    init: function () {
      var cfg = window.AmiChatConfig || {};
      // Trim everything: the MIS page sends first_name . ' ' . last_name, which
      // collapses to a single space when the PHP session is empty or partial.
      // A blank-ish name must never pass the "is this person logged in" test.
      this.userName = String(cfg.userName || this.textOf('.user-name') || '').trim();
      this.userEmail = String(cfg.userEmail || this.textOf('.user-email') || '').trim();
      this.userDepartment = String(cfg.userDepartment || this.textOf('.user-dept, .user-department') || '').trim();
      this.userRole = String(cfg.userRole || this.textOf('.user-role') || '').trim();
      this.loginUser = String(cfg.loginUser || window.userId || '').trim();
      // Signed by the MIS PHP page with IDENTITY_SECRET. This is what lets the
      // server take the role from MIS instead of maintaining a second admin
      // list. It is an opaque string; the widget never inspects or creates it,
      // and no secret is ever exposed here.
      this.identityToken = String(cfg.identityToken || '').trim();
      this.userAvatar = cfg.userAvatar || '';

      // loginUser is the only trustworthy identity here: the MIS helpdesk set it
      // from an authenticated PHP session. Without it we cannot key limits or
      // history to a person, so refuse rather than invent an id from the name.
      if (!this.loginUser) { this.renderLoginRequired(); return; }

      // Key the conversation on the LOGIN ID, always.
      //
      // The page may offer cfg.sessionId, but that belongs to the browser/PHP
      // session, so opening the widget in incognito - or a second device, or after
      // a session timeout - produced a different conversation and the user's
      // history appeared empty even though it was stored under their login.
      // History belongs to the person, not the browser, so loginUser wins.
      // loginUser is guaranteed non-empty here: the check above refuses to boot
      // without it rather than inventing an identity.
      this.sessionId = this.loginUser;

      this.injectStyles();
      this.render();
      this.bindEvents();
      this.modal = AmiModal;

      // No greeting here. The server builds it (correct timezone) and loadHistory
      // renders it once the thread is known to be empty. Calling greet() locally
      // as well produced the welcome twice on every open.
      var self = this;
      this.discover().then(function (base) {
        self._apiBase = base;
        self.setStatus(base ? 'MIS Help Desk \u2022 Online' : 'MIS Help Desk \u2022 Offline');
        if (!base) {
          self.addMessage('assistant', 'I can\u2019t reach the Ami server. Please check your connection and reload.', { error: true });
          return;
        }
        // Reopen automatically if they left the panel open when the page reloaded.
        //
        // Without this the panel always booted closed, so reloading the MIS page
        // while reading a thread threw away where they were - and because the
        // transcript then loaded hidden, the history they had scrolled back
        // through was already gone before they could look at it again.
        var wasOpen = self.readViewState().open;
        if (wasOpen) { self.open(); } else { self.loadHistory(); }
      });
    },

    /* ---------------------- View state across reloads ---------------------- */

    /**
     * Per-login `sessionStorage` holding whether the panel was open and how far
     * down the transcript the user was.
     *
     * Keyed on the login, not globally: two people sharing a machine would
     * otherwise inherit each other's panel state. `sessionStorage` rather than
     * `localStorage` so it dies with the tab - a preference that outlives the
     * session would reopen a chat nobody asked for tomorrow morning.
     *
     * Every access is wrapped: storage throws in private browsing in some
     * browsers, and a widget that cannot remember where you were must still work.
     */
    viewStateKey: function () {
      return 'ami_view_' + (this.loginUser || 'anon');
    },

    readViewState: function () {
      try {
        var raw = sessionStorage.getItem(this.viewStateKey());
        var parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return {};
        return parsed;
      } catch (e) {
        return {};
      }
    },

    writeViewState: function (patch) {
      try {
        var next = this.readViewState();
        Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
        sessionStorage.setItem(this.viewStateKey(), JSON.stringify(next));
      } catch (e) {
        /* storage unavailable; remembering the position is a nicety, not a need */
      }
    },

    /** Record where in the transcript the user is, so a reload can put them back. */
    rememberScroll: function () {
      if (!this.el || !this.el.msgs) return;
      var m = this.el.msgs;
      var atBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 24;
      // Only worth restoring if they were actually reading something. At the
      // bottom there is nothing to restore - that is where loadHistory puts them
      // anyway - and remembering a stale offset would fight the newest message.
      if (atBottom) { this.writeViewState({ scroll: null }); return; }
      this.writeViewState({ scroll: m.scrollTop });
    },

    /**
     * Put the transcript back where the user left it.
     *
     * Runs after the transcript is rendered, and only when they were NOT at the
     * bottom last time: someone who had scrolled back to read earlier turns
     * should not be yanked to the newest message by a reload.
     */
    restoreScroll: function () {
      var saved = this.readViewState().scroll;
      if (saved === null || saved === undefined || !this.el || !this.el.msgs) return;
      var m = this.el.msgs;
      var max = Math.max(0, m.scrollHeight - m.clientHeight);
      m.scrollTop = Math.min(Number(saved) || 0, max);
      // Reading history means NOT pinned to the bottom, so a new reply does not
      // drag them away from what they were reading.
      this._pinnedToBottom = false;
    },

    textOf: function (sel) {
      var el = document.querySelector(sel);
      return el ? (el.textContent || '').trim() : '';
    },

    /* -------------------------- Avatars -------------------------- */

    // Ami's own logo, used in the chat header. Resolved from the module URL so it
    // loads from the chatbot server, not from the embedding page.
    botLogo: function () {
      try {
        if (typeof import.meta !== 'undefined' && import.meta.url) {
          return new URL('../ami-icon-box.png', import.meta.url).href;
        }
      } catch (e) { /* ignore */ }
      return 'ami-icon-box.png';
    },

    // The signed-in user's photo, for their own message bubbles. The path comes
    // from the page (AmiChatConfig.userAvatar) so it is intentionally left relative.
    userAvatarHtml: function () {
      var src = this.userAvatar || '';
      if (!src) return this.icons.user;
      return '<img src="' + src + '" alt="" onerror="this.onerror=null;this.style.display=\'none\';" />';
    },

    /* -------------------------- Styles -------------------------- */

    injectStyles: function () {
      if (document.getElementById('ami-widget-styles')) return;
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      // Resolve from this module's own URL so the CSS loads from the chatbot
      // server regardless of which page embeds the widget.
      var assetBase = (function () {
        try {
          if (typeof import.meta !== 'undefined' && import.meta.url) {
            return new URL('../', import.meta.url).href;
          }
        } catch (e) { /* fall through */ }
        var cfg = window.AmiChatConfig || {};
        if (cfg.assetBase) return String(cfg.assetBase).replace(/\/*$/, '/');
        return '';
      })();
      link.href = assetBase + 'widget.css?v=' + Date.now();
      document.head.appendChild(link);
    },

    /* -------------------------- Render -------------------------- */

    renderLoginRequired: function () {
      document.body.insertAdjacentHTML('beforeend',
        '<div id="ami-widget">' +
        '<button id="ami-chat-button" title="Chat with Ami">' + this.icons.bot + '</button>' +
        '<div id="ami-chat-window" style="display:none;">' +
        '<div id="ami-header"><div class="ami-header-left">' +
        '<div class="ami-avatar">' + this.icons.bot + '</div>' +
        '<div class="ami-header-info"><span class="ami-name">Ami</span>' +
        '<span class="ami-status">Help Desk Assistant</span></div></div>' +
        '<div class="ami-header-right"><button id="ami-close">' + this.icons.close + '</button></div></div>' +
        '<div id="ami-messages"><div class="ami-message assistant">Please log in to the MIS Helpdesk to chat with Ami.</div></div></div></div>');

      document.getElementById('ami-chat-button').addEventListener('click', function () {
        document.getElementById('ami-chat-window').style.display = 'flex';
      });
      document.getElementById('ami-close').addEventListener('click', function () {
        document.getElementById('ami-chat-window').style.display = 'none';
      });
    },

    render: function () {
      var avatarSrc = this.userAvatar || 'ami-icon-box.png';
      document.body.insertAdjacentHTML('beforeend',
        '<div id="ami-widget">' +
          '<button id="ami-chat-button" title="Chat with Ami" aria-label="Open chat">' +
            this.icons.bot +
            '<span id="ami-badge" class="ami-badge" style="display:none;">1</span>' +
          '</button>' +
          '<div id="ami-chat-window">' +
            '<div id="ami-header">' +
              '<div class="ami-header-left">' +
                '<div class="ami-avatar">' +
                '<img src="' + this.botLogo() + '" alt="Ami" onerror="this.onerror=null;this.style.display=\'none\';this.nextElementSibling.style.display=\'inline-flex\';"/>' +
                '<span class="ami-avatar-fallback" style="display:none;">' + this.icons.bot + '</span>' +
                '</div>' +
                '<div class="ami-header-info">' +
                  '<span class="ami-name">Ami</span>' +
                  '<span class="ami-status">MIS Help Desk \u2022 Typically replies instantly</span>' +
                '</div>' +
              '</div>' +
              '<div class="ami-header-right">' +
                // No "create ticket" button here on purpose. Ticket capture is
                // driven by the assistant: it troubleshoots with the user first
                // and opens the modal itself once it cannot resolve the issue.
                '<button id="ami-minimize" title="Minimize" aria-label="Minimize">' + this.icons.minus + '</button>' +
                '<button id="ami-close" title="Close" aria-label="Close">' + this.icons.close + '</button>' +
              '</div>' +
            '</div>' +
            '<div id="ami-messages" role="log" aria-live="polite"></div>' +
            '<div id="ami-typing"><div class="ami-typing-bubble"><span></span><span></span><span></span></div></div>' +
            '<div class="ami-quick-replies" id="ami-quick" style="display:none;"></div>' +
            // Zero-height anchor for the floating jump-to-latest control.
            //
            // It is NOT a child of #ami-input-area. That box has `overflow-y: auto`
            // so a tall attachment tray scrolls instead of starving the transcript -
            // and an absolutely positioned child sitting at `bottom: 100%` lies
            // OUTSIDE that scrollport, so the overflow clipped the button away and
            // it silently stopped appearing at all. A zero-height sibling is not
            // clipped, and costs no layout.
            '<div class="ami-jump-anchor">' +
              '<button id="ami-jump-latest" class="ami-jump-latest" type="button"' +
                ' aria-hidden="true" disabled>View current messages</button>' +
            '</div>' +
            '<div id="ami-input-area">' +
              '<div id="ami-pending"></div>' +
              // Summary line sits ABOVE the composer. It used to live inside
              // .ami-input-row, where it competed with the textarea for width.
              '<span id="ami-file-label" class="ami-file-label"></span>' +
              '<div class="ami-input-row">' +
                '<button id="ami-attach-btn" title="Attach file" aria-label="Attach file">' + this.icons.clip + '</button>' +
                '<textarea id="ami-input" rows="1" placeholder="Type your message..." autocomplete="off"></textarea>' +
                '<button id="ami-send" title="Send" aria-label="Send">' + this.icons.send + '</button>' +
              '</div>' +
            '</div>' +
            '<input type="file" id="ami-file-input" accept="image/*,.csv,.txt,.xlsx,.xls,.pdf" multiple ' +
              'style="position:absolute;opacity:0;pointer-events:none;width:1px;height:1px;">' +
          '</div>' +
        '</div>');

      this.el = {
        win: document.getElementById('ami-chat-window'),
        msgs: document.getElementById('ami-messages'),
        typing: document.getElementById('ami-typing'),
        quick: document.getElementById('ami-quick'),
        jumpLatest: document.getElementById('ami-jump-latest'),
        input: document.getElementById('ami-input'),
        pending: document.getElementById('ami-pending'),
        fileLabel: document.getElementById('ami-file-label'),
        fileInput: document.getElementById('ami-file-input'),
        attachBtn: document.getElementById('ami-attach-btn'),
        badge: document.getElementById('ami-badge'),
        lightbox: null
      };

      // NOTE: greet() is NOT called here. init() greets once after render(), and
      // calling it from both places showed the greeting twice on every open.
    },

    /* -------------------------- Events -------------------------- */

    bindEvents: function () {
      var self = this;

      document.getElementById('ami-chat-button').addEventListener('click', function () { self.toggle(); });
      document.getElementById('ami-close').addEventListener('click', function () { self.close(); });
      document.getElementById('ami-minimize').addEventListener('click', function () { self.close(); });
      document.getElementById('ami-send').addEventListener('click', function () { self.send(); });

      var input = this.el.input;
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
        if (self._composing || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        self.send();
      });

      input.addEventListener('compositionstart', function () { this._composing = true; });
      input.addEventListener('compositionend', function () { this._composing = false; });

      input.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      });

      this.el.attachBtn.addEventListener('click', function () { self.el.fileInput.click(); });

      this.el.fileInput.addEventListener('change', function (e) {
        var files = Array.prototype.slice.call(e.target.files || []);
        if (files.length) self.stageFiles(files);
        e.target.value = '';
      });

      // Auto-load when the user reaches the top of the transcript.
      //
      // The threshold is deliberately generous. An 8px window is only ever hit
      // by a scrollbar drag that lands exactly on zero: momentum scrolling on a
      // trackpad, a touch screen, or a scroll driven by the keyboard routinely
      // settles a few pixels short and never fires, so the page silently refused
      // to load. 48px is roughly a finger-width of slack and still nowhere near
      // the point where loading would be surprising.
      //
      // `loadOlder()` is guarded by `loadingOlder`, so a stream of scroll events
      // while the page is in flight collapses into one request.
      var atTop = function () {
        return self.el.msgs.scrollTop <= LOAD_MORE_THRESHOLD_PX;
      };
      var atBottom = function () {
        var m = self.el.msgs;
        return (m.scrollHeight - m.scrollTop - m.clientHeight) <= JUMP_TOLERANCE_PX;
      };

      // Reports the moment the top of the transcript is reached, and why the load
      // did or did not follow.
      //
      // This feature failed silently twice for reasons invisible from the outside
      // - once because the endpoint always answered `has_more: false`, and once
      // because the transcript was not a scrollport at all so no `scroll` event
      // ever fired. Both looked identical to the user ("nothing happens"), so each
      // trigger now says which one it was and what the guard decided.
      var reportTop = function (source) {
        var why;
        if (self.loadingOlder) why = 'skipped: a page is already loading';
        else if (!self.hasMore) why = 'skipped: hasMore is false (nothing older to fetch)';
        else if (!self.nextBefore) why = 'skipped: no cursor (nextBefore is null)';
        else why = 'loading page';
        historyDebug('top reached via ' + source +
          ' (scrollTop=' + Math.round(self.el.msgs.scrollTop) +
          ', threshold=' + LOAD_MORE_THRESHOLD_PX + 'px) -> ' + why, self.pagingState());
        return why === 'loading page';
      };

      this.el.msgs.addEventListener('scroll', function () {
        // Paging upward when the top is reached, and the jump-to-latest control
        // whenever the reading position leaves the bottom.
        //
        // The at-top test is real either way - our own scroll to the bottom can
        // never reach the top - but the jump check must not run while we are the
        // ones scrolling, or it sees a transcript in transit.
        if (atTop() && reportTop('scroll')) self.loadOlder();
        if (!self._autoScrolling) {
          // A user-driven scroll decides whether we are following the conversation
          // or letting them read back. That single flag is what keeps a reply from
          // yanking someone out of history they are reading, and what stops the
          // jump control appearing when they are not.
          //
          // `self`, not `this`: inside a DOM listener `this` is the ELEMENT, so
          // writing to `this._pinnedToBottom` filed the flag on the transcript and
          // left the widget reading `undefined` - which is neither true nor false,
          // so every reply treated itself as allowed to yank the viewport and the
          // re-pin observer never stood down.
          self._pinnedToBottom = atBottom() ? true : false;
          self.toggleJumpToLatest();
        }
      }, { passive: true });

      // Second net, and the reason this now works.
      //
      // The `scroll` event only fires on the element that actually scrolls. If
      // the transcript is not the scrollport - which is what happened when
      // `#ami-messages` lacked `min-height: 0` and so grew to its full content
      // height - the listener above is bound to a box that can never scroll, and
      // no amount of threshold tuning produces an event.
      //
      // `wheel` and `touchmove` do not care which element is the scrollport, so
      // they still fire while the user is clearly reading upwards. Combined with
      // the scroll-position test this makes the trigger independent of the CSS
      // layout being exactly as intended.
      //
      // Separate handlers rather than one shared callback, so the log always names
      // the input that actually fired it.
      var tryLoadFrom = function (source) {
        if (atTop() && reportTop(source)) self.loadOlder();
      };
      this.el.msgs.addEventListener('wheel', function () { tryLoadFrom('wheel'); }, { passive: true });
      this.el.msgs.addEventListener('touchmove', function () { tryLoadFrom('touchmove'); }, { passive: true });

      // The jump-to-latest control, and the drag-to-move handle below it.
      if (this.el.jumpLatest) {
        this.el.jumpLatest.addEventListener('click', function () { self.jumpToLatest(); });
      }

      // Keep the transcript pinned to the newest turn while it is meant to be.
      //
      // Scrolling on insert is not enough on its own: an attachment preview or a
      // pasted image has no height until it loads, and a webfont arriving late
      // reflows every message above it. Both grow the content AFTER the scroll that
      // was meant to follow it, which is why a reply could stop visibly short of
      // the bottom. Observing the box and re-pinning catches every such case
      // without guessing which elements are late.
      if (typeof ResizeObserver !== 'undefined' && this.el.msgs) {
        var self_ = this;
        this._ro = new ResizeObserver(function () {
          if (self_._pinnedToBottom === false) return;
          var m = self_.el.msgs;
          if (!m) return;
          // Only correct a shortfall. A genuine upward scroll must not be undone.
          var gap = m.scrollHeight - m.scrollTop - m.clientHeight;
          if (gap > 0 && gap <= JUMP_TOLERANCE_PX) m.scrollTop = m.scrollHeight;
        });
        try { this._ro.observe(this.el.msgs); } catch { /* not fatal */ }
      }

      // Some browsers coalesce scroll events during a fast fling and the last
      // one can land past the threshold, so the top of the range is also checked
      // on a short timer while the transcript sits near the top.
      this.el.msgs.addEventListener('scroll', function () {
        if (!atTop()) return;
        if (self._topProbe) clearTimeout(self._topProbe);
        self._topProbe = setTimeout(function () {
          if (atTop() && reportTop('scroll-settle')) self.loadOlder();
        }, 120);
      }, { passive: true });

      // Drag to move window
      var win = this.el.win;
      var handle = document.getElementById('ami-header');
      var dragging = false, offX = 0, offY = 0;
      handle.addEventListener('mousedown', function (e) {
        if (e.target.closest('button')) return;
        var r = win.getBoundingClientRect();
        dragging = true;
        offX = e.clientX - r.left;
        offY = e.clientY - r.top;
        win.style.position = 'fixed';
        win.classList.add('dragging');
        e.preventDefault();
      });
      document.addEventListener('mousemove', function (e) {
        if (!dragging) return;
        var w = win.offsetWidth, h = win.offsetHeight;
        var x = Math.min(Math.max(0, e.clientX - offX), window.innerWidth - w);
        var y = Math.min(Math.max(0, e.clientY - offY), window.innerHeight - h);
        win.style.left = x + 'px';
        win.style.top = y + 'px';
        win.style.right = 'auto';
        win.style.bottom = 'auto';
      });
      document.addEventListener('mouseup', function () {
        dragging = false;
        win.classList.remove('dragging');
      });

      // Paste image
      this.el.input.addEventListener('paste', function (e) {
        var items = (e.clipboardData || {}).items || [];
        var files = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === 'file') {
            var f = items[i].getAsFile();
            if (f) files.push(f);
          }
        }
        if (files.length) { e.preventDefault(); self.stageFiles(files); }
      });

      // Drag & drop on panel
      var win = this.el.win;
      ['dragenter', 'dragover'].forEach(function (evt) {
        win.addEventListener(evt, function (e) { e.preventDefault(); win.style.outline = '2px dashed var(--ami-primary)'; });
      });
      ['dragleave', 'drop'].forEach(function (evt) {
        win.addEventListener(evt, function (e) { e.preventDefault(); win.style.outline = 'none'; });
      });
      win.addEventListener('drop', function (e) {
        var files = Array.prototype.slice.call((e.dataTransfer || {}).files || []);
        if (files.length) self.stageFiles(files);
      });

      // Lightbox
      var lb = document.getElementById('ami-lightbox');
      if (!lb) {
        lb = document.createElement('div');
        lb.id = 'ami-lightbox';
        lb.addEventListener('click', function () { lb.classList.remove('open'); });
        document.body.appendChild(lb);
      }
      this.el.lightbox = lb;
    },

    /* -------------------------- Open/Close -------------------------- */

    toggle: function () { this.isOpen ? this.close() : this.open(); },

    open: function () {
      var self = this;
      this.isOpen = true;
      this.el.win.style.display = 'flex';
      document.getElementById('ami-chat-button').classList.add('active');
      this.el.badge.style.display = 'none';
      this.unread = 0;
      // Remember the panel being open, so a reload comes back to it.
      this.writeViewState({ open: true });
      // The user is looking at the panel again, so the title goes back to normal.
      this.restoreTitle();
      // Coming back to the panel is activity, but run the idle check first so an
      // over-old marker is retired rather than refreshed by this very open().
      this.startIdleWatch();
      this.markActivity();
      this.loadHistory();
      setTimeout(function () { if (!self.isMobile()) self.el.input.focus(); }, 60);
    },

    close: function () {
      this.isOpen = false;
      this.el.win.style.display = 'none';
      document.getElementById('ami-chat-button').classList.remove('active');
      // Do NOT stop the idle watch - the session-end timer must survive minimise.
      // Only the nudge timer is stopped; the session-end poller keeps running.
      //
      // It used to do the exact opposite of this comment: the body cleared
      // `_idleTimer` and called `cancelSessionEnd()`, which killed the divider
      // timer AND the visibilitychange handler together. Minimising the panel
      // therefore disarmed every path that could draw the divider, so a user who
      // closed the panel and walked away never saw "Session ended" live - it
      // only appeared after a refresh replayed the marker the server persisted.
      //
      // And it then called `markActivity()` to "keep the clocks alive", which is
      // what made the timer useless the moment it was fixed: hiding the panel is
      // not the user doing anything, so `_lastActivity` was pushed to now and
      // armSessionEnd() re-armed the FULL idle period. Every minimise bought
      // another five minutes, so a user who closed the panel and walked away was
      // guaranteed never to see the boundary while they were away - which is the
      // one case the timer exists for. The nudge is cancelled instead, because
      // nobody can answer a "still there?" question about a panel they just
      // closed.
      this.cancelNudge();
      this._nudgeFired = false;
      // Remember the panel being closed AND where in the transcript they were, so
      // a reload can restore both.
      this.rememberScroll();
      this.writeViewState({ open: false });
      // Deliberately NOT clearing _markerRetired here: closing and reopening the
      // panel is exactly the case where the retired marker must stay retired.
    },

    isMobile: function () { return window.innerWidth <= 480; },

    scrollDown: function (opts) {
      var m = this.el.msgs;
      if (!m) return;
      opts = opts || {};
      // Instant by default, and that is a deliberate change from the smooth
      // scroll this used to do on every call.
      //
      // A smooth scroll animates over a few hundred milliseconds and fires a
      // `scroll` event on every frame. Those events ran the jump-to-latest check,
      // which saw a transcript that was still on its way down and reported "not at
      // the bottom" - so the control flickered into view every time Ami replied,
      // including while the typing indicator was up. It also meant the final
      // position depended on an animation finishing, which it sometimes did not.
      //
      // Assigning scrollTop lands immediately and fires no intermediate events, so
      // the check sees the real resting position. Only the explicit
      // jump-to-latest click animates, where the motion is the point.
      this._autoScrolling = true;
      if (opts.smooth) {
        try {
          m.scrollTo({ top: m.scrollHeight, behavior: 'smooth' });
        } catch {
          m.scrollTop = m.scrollHeight;
        }
      } else {
        m.scrollTop = m.scrollHeight;
      }
      this._pinnedToBottom = true;
      if (this._autoScrollTimer) clearTimeout(this._autoScrollTimer);
      var widget = this;
      this._autoScrollTimer = setTimeout(function () {
        releaseScrollLock(widget);
      }, opts.smooth ? 420 : 0);
    },

    setStatus: function (text) {
      var el = document.querySelector('#ami-widget .ami-status');
      if (el) el.textContent = text;
    },

    /* -------------------------- History -------------------------- */

    /**
     * The ticket confirmation, in one place.
     *
     * It used to be inline at the point of submission, which meant the wording
     * existed in two places once reload also needed to show it, and they drifted.
     */
    loadHistory: function () {
      var self = this;
      // One history load at a time.
      //
      // Two callers could overlap: `discover()` fires this once the API base is
      // known, and `open()` fires it again on every panel open. Click the launcher
      // while base discovery is still probing - up to seven candidates, 2.5s each -
      // and `open()` issues its request against an EMPTY `apiBase()`, which
      // resolves to the embedding page's own origin and fails; the `.catch` then
      // only writes to the history debug log, so from the outside it looks like a
      // silently broken load. Discovery finishes a moment later and fires a second
      // one, and both responses rebuild the transcript, so the slower one wipes
      // and re-renders what the user was already reading.
      //
      // Returning the in-flight promise makes the second call a no-op rather than a
      // duplicate, and `_historyPending` is cleared in both outcomes so a genuine
      // reload later still works.
      if (this._historyPending) return this._historyPending;
      // Ten at a time. The endpoint was already paged (server default is 10, with
      // a `before` cursor and `has_more`), and the scroll handler at the top of the
      // transcript already pulls the previous page - but this line asked for 50, so
      // a long thread pulled fifty messages into the DOM on open while the button
      // that fetched older messages was never needed.
      var historyUrl = this.apiUrl('/api/history/' + encodeURIComponent(this.sessionId) + '?limit=10');
      this._historyPending = fetch(historyUrl)
        .then(function (r) {
          // Status and the raw payload are logged because this request has failed
          // in three different ways - a 404 when the conversation is unknown, a
          // JSON parse failure when the base resolved to something that is not the
          // chatbot, and a genuine empty thread - and all three look identical
          // from the widget: the transcript simply does not fill.
          var ct = r.headers && r.headers.get ? r.headers.get('content-type') : null;
          historyDebug('GET ' + historyUrl + ' -> ' + r.status +
            ' ' + (r.statusText || '') + '  content-type=' + ct);
          return r.json();
        })
        .then(function (d) {
          if (!d) {
            historyDebug('history response was not an object');
            return;
          }
          if (!d.messages) {
            historyDebug('history response has NO messages array; keys=' +
              Object.keys(d).join(',') + '  payload=' + JSON.stringify(d).slice(0, 300));
          }
          // A farewell is shown even when the thread is empty: the user may be
          // reopening the widget long after the session closed, and "nothing
          // here" is exactly the wrong thing to show them then.
          if (d.goodbye) {
            self.addMessage('assistant', d.goodbye, { system: true });
          }
          if (!d.messages || !d.messages.length) {
            // New session. The server owns the greeting: it sends one only on the
            // very first history load for a session, then records that it did.
            // The widget must NOT invent its own - it has no way to know whether
            // this is the first load, so any local fallback re-renders the
            // opening line every time history is reloaded.
            //
            // The browser clock is deliberately not used for the period: that is
            // wrong for anyone outside Manila.
            var line = d.greeting;
            if (line && !self._greetedShown) {
              self._greetedShown = true;
              self.addMessage('assistant', line);
            }
            self.setIdleMs(d.session_idle_ms);
            self.setNudgeMs(d.nudge_ms);
            // The SERVER's remaining time, not a local reset. See
            // setIdleRemaining(): calling markActivity() here used to hand out a
            // fresh idle period on every history read.
            self.setIdleRemaining(d.idle_remaining_ms);
            self.scrollDown();
            // Paging state is reset HERE rather than left at whatever the instance
            // was constructed with. It used to fall out of this branch untouched,
            // which meant a failed or empty load left `hasMore` on its `true`
            // default and `nextBefore` null: the widget then advertised history it
            // did not have and every scroll logged "skipped: no cursor", which is
            // indistinguishable from a broken trigger.
            self.loadedCount = 0;
            self.nextBefore = null;
            self.hasMore = false;
            self.toggleLoadMore();
            historyDebug('thread is empty; paging disabled', self.pagingState());
            return;
          }
          var m = self.el.msgs;
          while (m.firstChild) m.removeChild(m.firstChild);
          // The wipe above detaches any divider from a previous visit, so drop
          // the cached reference before deciding whether to re-add one.
          self.resetSessionEnd();
          // The history endpoint returns NEWEST FIRST (`ORDER BY id DESC`), because the
          // paging cursor is "the oldest id we just returned". Appending that
          // order directly renders the thread backwards, so normalise to
          // chronological before appending.
          //
          // A `[ended session]` row is not a bubble: it is the boundary the server
          // persisted when it closed a conversation, and it renders as the divider
          // in the position it was written. That is what makes the end of a
          // conversation survive a reload instead of being re-inferred from live
          // state that has since been consumed.
          var replayedEnd = false;
          self.chronological(d.messages).forEach(function (msg) {
            if (isSessionEndMarker(msg)) {
              replayedEnd = true;
              self.addSessionEnd({ time: msg.created_at || msg.timestamp, replay: true });
              return;
            }
            // A stage directive is an instruction to the model, stored as a user
            // turn. Rendering it would print the instruction verbatim in the
            // transcript.
            if (isStageDirective(msg)) return;
            self.addMessage(msg.role, msg.content, { time: msg.timestamp, quiet: true });
          });
          if (d.uploads && d.uploads.length) self.updateUploadPreviews(d.uploads);
          self.setIdleMs(d.session_idle_ms);
          self.setNudgeMs(d.nudge_ms);
          // The SERVER's remaining time, not a local reset. See
          // setIdleRemaining(): calling markActivity() here used to hand out a
          // fresh idle period on every history read.
          self.setIdleRemaining(d.idle_remaining_ms);
          // Only a session that actually ENDED gets a divider, and only when the
          // replayed transcript did not already carry one. An escalated thread is
          // still an open conversation - MIS simply has the request - so marking
          // it ended on reload is what made a live chat look like it had been
          // closed the moment the page was refreshed.
          //
          // The `replayedEnd` guard is what stops two dividers in one place: the
          // marker above is the durable record, and this flag only covers the
          // window before the server has written it.
          if (!replayedEnd && !self._markerRetired && d.session_ended) {
            // `self.lastTime`, not a bare `lastTime`.
            //
            // lastTime is a method on the Widget object, so calling it unqualified
            // throws ReferenceError. Because that happened here - above the code
            // that sets loadedCount, nextBefore and hasMore - a session that ended
            // never completed its history load at all: the transcript kept whatever
            // was already on screen, the paging fields kept their constructor
            // defaults, and every scroll at the top reported "nothing older to
            // fetch". The visible symptom was "scroll up does nothing", reported
            // three times while the CSS, the endpoint and the trigger were all
            // correct.
            //
            // `final: true` marks this as the real boundary, not a leftover for the
            // 60s idle poller to sweep away. Without it the divider drew on reload
            // and then vanished again on the next poll - "I can't see it live but I
            // can after refreshing" - because no live timer re-armed it once
            // `_sessionEnded` had been set true by the very first draw.
            self.addSessionEnd({ time: self.lastTime(d.messages), final: true });
          }
          // The confirmation is now a real persisted assistant turn, written by
          // the server when the ticket is filed, so replaying the page above
          // already brings it back and it no longer needs re-adding here. This is
          // only a fallback for conversations filed before that change, or where
          // the ticket was numbered on a later page.
          //
          // It checks the replayed turns first: adding the notice unconditionally
          // would print it twice on every reload, once from history and once from
          // here.
          var lastNo = d.last_control_number || self._lastControlNumber || null;
          if (lastNo) {
            self._lastControlNumber = String(lastNo);
            var alreadyReplayed = (d.messages || []).some(function (m) {
              return m.role === 'assistant'
                && String(m.content || '').indexOf('Ticket submitted') !== -1
                && String(m.content || '').indexOf(String(lastNo)) !== -1;
            });
            if (!alreadyReplayed && !self._ticketNoticeShown) {
              self._ticketNoticeShown = true;
              self.addMessage('assistant', self.ticketNotice(lastNo),
                { notice: true, quiet: true });
            }
          }
          self.loadedCount = d.messages.length;
          // The server's cursor is authoritative, but the same value can be read
          // straight off the page: the endpoint returns NEWEST FIRST, so the LAST
          // element is the oldest message shown and its id is exactly what
          // `before` means. Deriving it means paging survives a response that
          // omits `next_before`, and gives a non-null cursor whenever there is in
          // fact something older to fetch.
          var derivedCursor = oldestIdIn(d.messages);
          self.nextBefore = d.next_before || derivedCursor || null;
          if (!d.next_before && derivedCursor) {
            historyDebug('response had no next_before; derived it from the ' +
              'oldest loaded message id=' + derivedCursor);
          }
          self.hasMore = !!d.has_more;
          self.toggleLoadMore();
          // Put them back where they were reading, and only then decide the rest.
          //
          // This ran `scrollDown()` unconditionally, so reloading the page while
          // scrolled back through earlier turns threw away their position and
          // dropped them on the newest message. Someone reviewing a long thread
          // had to find their place again after every refresh - and on the MIS
          // page, where the widget is embedded and a refresh is easy to trigger by
          // accident, that is most of the session.
          self.restoreScroll();
          // The single most useful line when this feature misbehaves: it says
          // what the SERVER decided about there being more history. `has_more:
          // false` here means the endpoint is the problem, not the widget - which
          // is exactly how it looked from the outside when `LIMIT take` made
          // paging impossible.
          historyDebug('initial page: ' + (d.messages ? d.messages.length : 0) +
            ' message(s), has_more=' + JSON.stringify(d.has_more) +
            ', next_before=' + JSON.stringify(d.next_before), self.pagingState());
        })
        .catch(function (e) { historyDebug('initial load FAILED', e); })
        // Cleared last, in both outcomes: a failed load must not leave the widget
        // permanently unable to retry, which is what a guard that only clears on
        // success would do.
        .then(function () { self._historyPending = null; },
              function () { self._historyPending = null; });
      return this._historyPending;
    },

    loadOlder: function (trigger) {
      var self = this;
      if (!self.hasMore || self.loadingOlder || !self.nextBefore) {
        historyDebug('loadOlder called but nothing to do' +
          ' (trigger=' + (trigger || 'button') + ')', self.pagingState());
        return;
      }
      self.loadingOlder = true;
      var m = self.el.msgs;
      var prevHeight = m.scrollHeight;
      var prevTop = m.scrollTop;
      var url = self.apiUrl('/api/history/' + encodeURIComponent(self.sessionId) + '?limit=10&before=' + encodeURIComponent(self.nextBefore));
      historyDebug('fetching older page' +
        ' (trigger=' + (trigger || 'button') + ', before=' + self.nextBefore + ')', url);
      fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.messages || !d.messages.length) {
            historyDebug('older page came back empty; marking the thread complete');
            self.hasMore = false;
            self.toggleLoadMore();
            return;
          }
          // The page arrives NEWEST FIRST, same as the initial load. Prepending
          // it as-is put the newest older message at the very top, so the thread
          // read backwards and the cursor no longer lined up with what was on
          // screen. Reverse it, then walk it so the oldest lands first.
          //
          // Stage directives and session-end markers are filtered exactly as they
          // are on the first load. This path was a second render site: the first
          // page hid them and an older page printed them, so a directive filed
          // before the current window would surface as raw instruction text the
          // moment the user scrolled far enough back.
          //
          // `anchor` is the first node that was ALREADY on screen. Every row in
          // this page is inserted before it, so the page lands as one ordered
          // block. Prepending each row against `firstChild` instead reversed the
          // page, because it is walked oldest-first.
          var anchor = m.firstChild;
          self.chronological(d.messages).forEach(function (msg) {
            if (isSessionEndMarker(msg)) {
              self.addSessionEnd({
                time: msg.created_at || msg.timestamp, replay: true, prepend: true, before: anchor
              });
              return;
            }
            if (isStageDirective(msg)) return;
            self.prependMessage(msg.role, msg.content, msg.timestamp, msg.timestamp, anchor);
          });
          self.nextBefore = d.next_before || null;
          self.hasMore = !!d.has_more;
          self.toggleLoadMore();
          m.scrollTop = prevTop + (m.scrollHeight - prevHeight);
          historyDebug('prepended ' + d.messages.length + ' message(s); ' +
            'now showing ' + self.el.msgs.children.length +
            ', hasMore=' + self.hasMore + ', nextBefore=' + self.nextBefore);
        })
        .catch(function (e) {
          // Previously swallowed silently, so a failed page fetch looked exactly
          // like a trigger that never fired - the third way this feature could
          // fail without any visible sign.
          historyDebug('older page fetch FAILED', e, self.pagingState());
        })
        .then(function () {
          self.loadingOlder = false;
          // Cleared even on failure: the cursor is untouched, so the next scroll
          // to the top simply tries again rather than being wedged shut.
          self.toggleJumpToLatest();
        });
    },

    /**
     * Previously the "Load earlier messages" control.
     *
     * It lived INSIDE the scrolling transcript, which put a foreign element at
     * the top of the message list: prepending a page then inserted messages
     * above the button rather than under it, and hitting the very top of the
     * scroll area often scrolled past the control entirely. It is now a fixed
     * strip above the transcript, outside the scroll container, so the scroll
     * handler owns the top edge and the order of messages is only ever decided
     * by prependMessage.
     *
     * NO LONGER RENDERS ANYTHING. The visible control was removed on request: it
     * duplicated what scrolling up already does, and a button pinned above the
     * transcript competes with the messages for the eye. Paging is entirely
     * automatic - `scroll`, `wheel` and `touchmove` at the top of the transcript
     * all trigger it - so there is nothing for the user to click.
     *
     * The method is kept because the state it maintained is still referenced, and
     * because removing the call sites would mean every caller has to know paging
     * is automatic. It is now a no-op that simply clears any control left over
     * from an older build.
     */
    toggleLoadMore: function () {
      var strip = this.el.loadMoreStrip;
      if (strip) {
        strip.remove();
        this.el.loadMoreStrip = null;
        this.el.loadMore = null;
      }
    },

    /**
     * "View current messages" - jump back to the newest turn.
     *
     * The counterpart to automatic paging: scrolling up pulls in older messages,
     * so there has to be a way back down that does not require dragging the
     * scrollbar to the bottom and guessing whether you have arrived.
     *
     * It sits directly above the input area rather than inside the transcript,
     * for the same reason the load-more control was moved out: anything inside
     * the scrolling list gets prepended around, moves when older pages arrive, and
     * scrolls out of reach exactly when it is needed.
     *
     * Shown only while the transcript is away from the bottom, so it is invisible
     * during normal reading.
     */
    toggleJumpToLatest: function (force) {
      var btn = this.el.jumpLatest;
      var m = this.el.msgs;
      if (!btn || !m) return;
      // Scroll events caused by our own scroll are not evidence that the user has
      // moved away from the bottom. Without this the control appears every time a
      // message arrives, because the transcript is briefly mid-scroll.
      if (this._autoScrolling && force === undefined) return;
      var atBottom = m.scrollHeight - m.scrollTop - m.clientHeight <= JUMP_TOLERANCE_PX;
      var show = force === true ? true : (force === false ? false : !atBottom);
      btn.classList.toggle('show', show);
      btn.setAttribute('aria-hidden', show ? 'false' : 'true');
      // Kept out of the tab order while hidden, so keyboard users do not tab into
      // an invisible control.
      btn.disabled = !show;
    },

    jumpToLatest: function () {
      // The one place smooth motion is wanted: the user asked to travel, and the
      // animation makes the jump legible when a long thread has to be crossed.
      this.scrollDown({ smooth: true });
      var input = this.el.input;
      if (input) input.focus();
    },

    /**
     * Console diagnostic: `AmiWidget.pagingState()`.
     *
     * Exists because this whole feature failed invisibly once already - the
     * server answered `has_more: false` for every session, so the control was
     * correctly absent and nothing looked broken. Being able to read the four
     * values that decide it, without a rebuild, is what turns that class of
     * report into a five-second check.
     */
    /**
     * Turn the paging diagnostics on or off.
     *
     * Left on the widget so it can be flipped from the console without a rebuild:
     * `AmiWidget.setHistoryDebug(true)`.
     */
    setHistoryDebug: function (on) {
      HISTORY_DEBUG = !!on;
      return HISTORY_DEBUG;
    },

    pagingState: function () {
      var m = this.el && this.el.msgs;
      return {
        session: this.sessionId,
        hasMore: !!this.hasMore,
        nextBefore: this.nextBefore === undefined ? null : this.nextBefore,
        loadingOlder: !!this.loadingOlder,
        loadedCount: this.loadedCount || 0,
        thresholdPx: LOAD_MORE_THRESHOLD_PX,
        scrollTop: m ? Math.round(m.scrollTop) : null,
        scrollHeight: m ? m.scrollHeight : null,
        clientHeight: m ? m.clientHeight : null,
        // False when the thread is shorter than the window, which is why no
        // scroll event can ever fire and only the button can load more.
        canScroll: !!(m && m.scrollHeight > m.clientHeight),
        // False means the transcript is not a scrollport at all - it is sized to
        // its content rather than the space available to it. That is the CSS
        // `min-height` bug, and it is why the scroll trigger can look dead.
        isScrollPort: !!(m && m.scrollHeight > m.clientHeight + 1),
      };
    },

    /* -------------------------- File Staging -------------------------- */

    stageFiles: function (files) {
      var self = this;
      var enriched = (files || []).map(function (f) {
        var isImg = /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name || '');
        return {
          file: f,
          name: f.name,
          size: f.size,
          type: f.type,
          previewUrl: isImg ? URL.createObjectURL(f) : null,
          downloadUrl: null
        };
      });
      this.pendingFiles = (this.pendingFiles || []).concat(enriched);
      this.renderPending();
      if (this.awaitingAttachment) {
        this.awaitingAttachment = false;
        this.sendFiles(this.pendingFiles.map(function (e) { return e.file; }));
      }
    },

    renderPending: function () {
      var self = this;
      var box = this.el.pending;
      var files = this.pendingFiles || [];

      box.innerHTML = '';
      files.forEach(function (f, i) {
        var chip = document.createElement('div');
        chip.className = 'ami-chip';

        var label = document.createElement('span');
        label.textContent = f.name;
        label.title = f.name;

        var x = document.createElement('button');
        x.type = 'button';
        x.title = 'Remove ' + f.name;
        x.setAttribute('aria-label', 'Remove ' + f.name);
        x.textContent = '\u00D7';
        x.addEventListener('click', function () {
          // Release the object URL we minted for the preview, otherwise every
          // stage/remove cycle leaks the blob for the life of the page.
          if (f.previewUrl) { try { URL.revokeObjectURL(f.previewUrl); } catch (e) { /* ignore */ } }
          self.pendingFiles.splice(i, 1);
          self.renderPending();
        });

        chip.appendChild(label);
        chip.appendChild(x);
        box.appendChild(chip);
      });

      // Reveal the tray, and give a short summary rather than a comma-joined
      // filename dump — the old raw join was what overflowed the composer.
      var count = files.length;
      box.classList.toggle('on', count > 0);

      if (this.el.fileLabel) {
        if (count) {
          var total = files.reduce(function (a, f) { return a + (Number(f.size) || 0); }, 0);
          this.el.fileLabel.textContent = count + ' file' + (count > 1 ? 's' : '') +
            ' ready to send \u00B7 ' + this.formatSize(total);
        } else {
          this.el.fileLabel.textContent = '';
        }
        this.el.fileLabel.classList.toggle('on', count > 0);
      }

      this.el.attachBtn.classList.toggle('has-file', count > 0);
      this.el.attachBtn.title = count ? count + ' file(s) ready to send' : 'Attach file';
    },

    /* -------------------------- Session end -------------------------- */

    /**
     * The supported way to draw the end of a conversation.
     *
     * Public on purpose: it is reachable as `AmiWidget.instance().showSessionEnded()`
     * from the console and from a host page that knows something the widget does
     * not (an admin escalating a session, a script reading the server's own
     * expiry). The live timer and the idle poller route through it too, so there
     * is exactly one place that decides what ending a session looks like.
     *
     * Deduplication is on the EXACT boundary, never on "is there a divider
     * somewhere". A conversation that ended and restarted twice legitimately holds
     * two dividers, and a check for "any divider exists" would refuse to draw the
     * second one - the boundary would then only ever appear after a reload, which
     * is the whole problem this function exists to solve. Identity comes from
     * `markerKey` when the caller has one (a server timestamp or row id), and
     * otherwise from the one-shot `_sessionEnded` guard.
     */
    showSessionEnded: function (opts) {
      opts = opts || {};
      // A caller-supplied identity is the ONLY thing that can authorise a second
      // boundary. Without one, `_sessionEnded` is a hard stop.
      var isNewBoundary = false;
      if (opts.markerKey) {
        if (!this._seenEndKeys) this._seenEndKeys = {};
        if (this._seenEndKeys[opts.markerKey]) return this._sessionEndedNode;
        this._seenEndKeys[opts.markerKey] = true;
        isNewBoundary = true;
      }
      // `_sessionEnded` blocks a repeat of the SAME boundary. A different, known
      // key is a genuinely different boundary - a conversation that ended and was
      // restarted has two real ones - so it has to be allowed through, or the
      // second would only ever appear after a reload.
      if (this._sessionEnded && !isNewBoundary && !opts.force) return this._sessionEndedNode;

      var el = this.addSessionEnd({
        now: !opts.time,
        time: opts.time,
        markerKey: opts.markerKey,
        final: opts.final !== false,
        replay: !!opts.replay
      });
      if (this.el.msgs) this.scrollDown();
      // Only a genuinely new, local boundary notifies. A replay is history the
      // user already saw, and the caller can suppress it explicitly.
      if (!opts.replay && opts.notify !== false) this.notifyUnread(opts);
      return el;
    },

    // Marks the close of a conversation in the transcript.
    //
    // Normally only one divider may exist - a second would be noise. A REPLAYED
    // marker is the exception: those come from persisted `[ended session]` rows,
    // and a conversation that has ended and been restarted twice has two real
    // boundaries that must both be drawn, in their own positions.
    //
    // Draws only. Notification lives in showSessionEnded so a replay can never
    // badge the launcher - see notifyUnread.
    addSessionEnd: function (opts) {
      opts = opts || {};
      // A replay is history, and a markerKey names one specific boundary, so
      // either may draw again. Everything else is one boundary, once.
      if (this._sessionEnded && !opts.replay && !opts.markerKey) return this._sessionEndedNode;
      this._sessionEnded = true;
      this._markerRetired = false;
      // `final` marks a boundary the session actually reached, so the idle poller
      // leaves it alone. Replayed markers are final for the same reason: they are
      // durable history, not a leftover to be swept up.
      if (opts.final || opts.replay) this._sessionEndFinal = true;

      var el = document.createElement('div');
      el.className = 'ami-session-end';
      el.setAttribute('role', 'separator');
      // Carries the boundary's identity, so a caller that knows the server's
      // marker key can tell "this exact divider" from "a divider somewhere".
      if (opts.markerKey) el.setAttribute('data-marker-key', String(opts.markerKey));

      var text = document.createElement('span');
      text.className = 'ami-session-end-text';
      text.textContent = opts.text || SESSION_END_LABEL;
      el.appendChild(text);

      // Resolve the stamp BEFORE rendering. Previously the guard tested
      // `opts.time || opts.now` but then formatted only `opts.time`, so the live
      // call (`{ now: true }`) appended an empty time span.
      var stamp = opts.time || (opts.now ? new Date().toISOString() : null);
      if (stamp) {
        var t = document.createElement('span');
        t.className = 'ami-session-end-time';
        t.textContent = this.formatTime(stamp);
        el.appendChild(t);
      }

          this._sessionEndedNode = el;
          // A marker replayed as part of an OLDER page belongs above the messages
          // already on screen, not below them - it marks a boundary the user is
          // scrolling back towards. Appending it would draw a session that ended
          // hours ago as though it had just happened. `before` anchors it within a
          // batch so the page stays in order.
          if (opts.prepend) this.el.msgs.insertBefore(el, opts.before || this.el.msgs.firstChild);
          else this.el.msgs.appendChild(el);
          return el;
        },

    /**
     * Tell the user something happened while they were not looking.
     *
     * Both cues live here rather than in `addSessionEnd`. Badging from inside the
     * divider drawer looked reasonable and was wrong: `addSessionEnd` is also the
     * function that REPLAYS historical `[ended session]` rows during loadHistory,
     * while the panel is closed. Every page load of a session that had ever ended
     * therefore incremented the counter and left a permanent "1" on the launcher
     * - and it climbed with the number of boundaries in the transcript. The
     * condition was `!this.isOpen`, which a replay satisfies and a real event
     * barely distinguishes.
     *
     * Only genuinely live paths call this now: the idle poller, the close timer,
     * and a reply arriving.
     */
    notifyUnread: function (opts) {
      opts = opts || {};
      // Never badge while the panel is open - the user is looking at it.
      if (this.isOpen) return;
      this.unread = (this.unread || 0) + 1;
      if (this.el.badge) {
        this.el.badge.textContent = this.unread > 1 ? String(this.unread) : '1';
        this.el.badge.style.display = 'block';
      }
      // The launcher badge is only visible if they can see the launcher, which
      // is often not the case - the panel is minimised, and the tab is
      // foregrounded. The title is the cue that always works.
      this.flashTitle();
    },

    /**
     * Prefix the tab title while there is unread activity, and restore it once
     * the panel is opened or the tab is focused.
     *
     * Desktop Notification API is not used on purpose: the widget is served from
     * a self-signed https origin on an internal IP, and a notification there
     * either prompts for permission and then fails, or is blocked outright.
     */
    flashTitle: function () {
      var self = this;
      if (this._titleFlashing) return;
      // Captured once, and tracked with its own flag rather than by truthiness: a
      // page whose title is legitimately empty must still be restored to empty,
      // and `if (this._baseTitle)` would silently skip that.
      if (!this._titleCaptured) {
        this._baseTitle = document.title || '';
        this._titleCaptured = true;
      }
      this._titleFlashing = true;
      var paint = function () {
        if (!self._titleFlashing) return;
        document.title = '(' + (self.unread || 1) + ') ' + (self._baseTitle || 'Ami Helpdesk');
      };
      paint();
      // Re-paint so the count stays right as more turns land.
      this._titleTimer = setInterval(paint, 1000);
    },

    /** Stop flashing and put the real title back. */
    restoreTitle: function () {
      if (this._titleTimer) { clearInterval(this._titleTimer); this._titleTimer = null; }
      this._titleFlashing = false;
      // Same reason as above: the flag decides, not whether the title was empty.
      if (this._titleCaptured) {
        document.title = this._baseTitle;
        this._baseTitle = null;
        this._titleCaptured = false;
      }
    },

    // Clears the divider so a genuinely new thread starts clean.
    resetSessionEnd: function () {
      this._sessionEnded = false;
      this._sessionEndFinal = false;
      if (this._sessionEndedNode && this._sessionEndedNode.parentNode) {
        this._sessionEndedNode.parentNode.removeChild(this._sessionEndedNode);
      }
      this._sessionEndedNode = null;
    },

    /* -------------------------- Idle handling -------------------------- */

    // Records that the user is actually here, so an open-but-abandoned tab
    // eventually retires its stale "Session ended" marker.
    markActivity: function () {
      this._lastActivity = Date.now();
      // The close timer's deadline has to MOVE with the activity it measures.
      // It used to be armed once and left alone while `_lastActivity` kept being
      // pushed forward - the async history load inside open(), sendMessage, the
      // ticket-filed branch - so when the old timer landed it saw "not idle long
      // enough yet" and returned, and NOTHING re-armed it. The divider then never
      // drew live; it only reappeared after a refresh replayed the server's
      // persisted marker. Re-arming here keeps the deadline at exactly
      // lastActivity + idleMs, which is also what the server expires against.
      //
      // Skipped while suspended: the ticket form pauses the clocks on purpose,
      // and re-arming from activity inside the form would undo that.
      if (!this._idleSuspended) this.armSessionEnd();
    },

    idleMs: function () {
      return this._idleMs || AmiConfig.defaults.idleSessionMs;
    },

    // The server is the source of truth for the idle threshold; fall back to
    // the bundled default if an older build does not send it.
    setIdleMs: function (ms) {
      var n = Number(ms);
      if (Number.isFinite(n) && n > 0) this._idleMs = n;
    },
    setNudgeMs: function (ms) {
      var n = Number(ms);
      if (Number.isFinite(n) && n > 0) this._nudgeMs = n;
    },

    /**
     * Adopt the SERVER's idea of how much idle time is left.
     *
     * Both idle branches used to call `markActivity()` after a history load,
     * which set `_lastActivity` to now. The server never expires on that: it
     * expires on the persisted `last_seen`, and it deliberately does not touch it
     * on a history read. So a user who had been away four minutes and then
     * reloaded - or simply opened the panel without typing - handed themselves a
     * fresh full five minutes client-side while the server was still counting
     * down from four. The boundary then fired five minutes late, or not at all if
     * the panel was closed in the meantime.
     *
     * Rather than introduce a second clock, the remaining time is folded back
     * into `_lastActivity` by BACK-DATING it: if the server says 60s of a 300s
     * period remain, `_lastActivity` is set to now - 240s, which is exactly the
     * same arithmetic every existing check already does. A remaining time of 0
     * back-dates by the full period, so the boundary fires on the next tick -
     * and the marker the server already persisted replays at the same time.
     *
     * Falls back to `markActivity()` when the server sends nothing (an older
     * build), so behaviour is no worse than before.
     */
    setIdleRemaining: function (ms) {
      var remaining = Number(ms);
      if (!Number.isFinite(remaining) || remaining < 0) { this.markActivity(); return; }
      var period = this.idleMs();
      var elapsed = Math.max(0, period - remaining);
      this._lastActivity = Date.now() - elapsed;
      this.armSessionEnd();
    },


    nudgeMs: function () {
      return this._nudgeMs || AmiConfig.defaults.nudgeMs || 60000;
    },

    /**
     * Start (or restart) the "are you still there?" countdown.
     *
     * Runs on a timer here rather than on the server because there is no push
     * channel: the only way a user finds out anything is by having the page
     * open. Armed after every turn, fires once at the nudge threshold, and is
     * disarmed the moment they actually reply.
     *
     * It is deliberately a question rather than a warning. At this point the
     * session has NOT ended yet, and nagging someone who is simply reading a
     * long answer is worse than staying quiet.
     */
    /**
     * Pause the idle clocks while the user is busy somewhere other than the chat.
     *
     * The ticket form is the case that matters: it is open for minutes at a time
     * while the composer is untouched, so without this the nudge fires mid-form and
     * the session closes underneath someone who was demonstrably present.
     *
     * Pauses rather than extends, and is reference-counted by label so nested
     * suspensions cannot resume each other's timers early.
     */
    _suspendIdle: function (label) {
      this._idleSuspends = this._idleSuspends || {};
      if (this._idleSuspends[label]) return;
      this._idleSuspends[label] = true;
      this.cancelNudge();
      this.cancelSessionEnd();
      this._idleSuspended = true;
    },

    _resumeIdle: function (label) {
      this._idleSuspends = this._idleSuspends || {};
      if (!this._idleSuspends[label]) return;
      delete this._idleSuspends[label];
      if (Object.keys(this._idleSuspends).length) return;
      this._idleSuspended = false;
      // Present and well: treat the interaction as activity and restart the clocks.
      this.markActivity();
      this._nudgeFired = false;
      this.armNudge();
    },

    armNudge: function () {
      var self = this;
      this.cancelNudge();
      // Re-armed on every reply, so the divider fires one full idle period after
      // the LAST thing the user did rather than on a timer set when the panel
      // opened.
      this.armSessionEnd();
      if (this._nudgeFired) return;
      this._nudgeTimer = setTimeout(function () {
        self._nudgeFired = true;
        self.addMessage('assistant',
          'Still there? 🙂 No rush - I\u2019ll close this chat in a few minutes if I don\u2019t hear from you.');
      }, this.nudgeMs());
    },

    cancelNudge: function () {
      if (this._nudgeTimer) { clearTimeout(this._nudgeTimer); this._nudgeTimer = null; }
    },

    /** The user replied: reset the nudge so it can fire again after the next reply. */
    noteUserReply: function () {
      this.markActivity();
      this._nudgeFired = false;
      this.armNudge();
    },

    // Retires the divider once the conversation has been idle long enough.
    // The transcript itself is deliberately kept: the old messages stay
    // readable, only the "this is where we stopped" marker goes away.
    //
    // Also serves as a safety net: if the one-shot close timer in
    // armSessionEnd was killed by background-tab throttling or an early fire
    // that satisfied its own guard and returned without re-arming, the 60s
    // idle poller draws the divider here instead, so the boundary shows up
    // without a refresh.
    checkIdle: function (opts) {
      if (!this._lastActivity) { this.markActivity(); return false; }
      if (this._idleSuspended) return false;

      var idleFor = Date.now() - this._lastActivity;
      if (idleFor < this.idleMs()) return false;

      // Safety-net draw: no divider exists yet, the session is genuinely idle,
      // and there is conversation to bound. This only fires when the one-shot
      // timer in armSessionEnd never landed - otherwise the live draw is
      // already flagged final and the branch above never reaches here.
      if (!this._sessionEnded && !this._sessionEndFinal && !this._markerRetired &&
          this.hasSpokenSinceLastEnd()) {
        this.showSessionEnded({ fromServer: false });
        return false;
      }

      if (!this._sessionEnded) return false;
      // A divider drawn at the moment the conversation closed is the real boundary,
      // not a stale marker to clear away.
      if (this._sessionEndFinal) return false;

      this.resetSessionEnd();
      // Remember that the user already saw (and dismissed) this marker, so a
      // later history reload does not silently put it back. Reopening the panel
      // after an idle spell replays history, and the server still reports
      // "escalated" from the original ticket - which would resurrect the very
      // marker the idle check just retired.
      this._markerRetired = true;
      if (!opts || !opts.silent) this.setStatus('New conversation');
      this.markActivity();
      return true;
    },

    // Polls while the panel is open so the marker clears on its own without
    // needing a reload. Deliberately NOT torn down on close: the panel being
    // shut is exactly when the user walks away, so the session-end timer and
    // this poller have to outlive it (see close()).
    startIdleWatch: function () {
      var self = this;
      this.stopIdleWatch();
      this.checkIdle();
      this._idleTimer = setInterval(function () { self.checkIdle(); },
        AmiConfig.defaults.idlePollMs);
      // Draw the divider at the moment the session closes, not on the next reload.
      //
      // The server only learns a session has expired when the user next interacts
      // or reloads history - it has no push channel - so before this, a user
      // watching an open panel saw the conversation simply stop: the 2-minute
      // nudge appeared, then nothing at all for the remaining three minutes, and
      // the divider appeared only after they refreshed.
      this.armSessionEnd();
    },
/**
     * Fires once, at the idle threshold, to close the conversation on screen.
     *
     * The server has no push channel: it only learns a session expired when the
     * user next interacts or reloads history. Without this, a user watching an
     * open panel saw the conversation simply stop - the two-minute nudge
     * appeared, then nothing for the remaining minutes, and the divider showed
     * up only after a refresh.
     *
     * So the widget draws the boundary itself the moment the threshold is
     * reached. The server still owns the authoritative boundary
     * (`[ended session]` row); this is only about drawing it promptly on screen.
     *
     * The timer re-checks idleness when it lands, because a reply may have
     * slipped in while it waited - and every turn re-arms it via armNudge().
     */
    armSessionEnd: function () {
      var self = this;
      this.cancelSessionEnd();
      var ms = this.idleMs();
      if (!Number.isFinite(ms) || ms <= 0) return;

      // Every live path that draws the boundary notifies here, so the badge and
      // the title flash stay tied to something that actually just happened.
      // Drawn from addSessionEnd's replay path instead, they fired on every page
      // load of any session that had ever ended.
      self._sessionEndTimer = setTimeout(function () {
        // Only if they really have gone quiet, and only once. Left in, an
        // abandoned tab stacked a divider every idle cycle, and once the newest
        // row was a divider the transcript opened scrolled to the bottom onto
        // nothing but "Session ended".
        if (Date.now() - (self._lastActivity || 0) < ms) return;
        if (self._sessionEnded) return;
        if (!self.hasSpokenSinceLastEnd()) return;
        self.showSessionEnded({ fromServer: false });
      }, ms);

      // Also catch the moment the tab becomes visible again - the timer may have
      // been throttled in the background, so we re-evaluate immediately on focus.
      self._visibilityHandler = function () {
        if (!document.hidden && !self._sessionEnded) {
          // Re-evaluate immediately when the tab becomes visible.
          if (Date.now() - (self._lastActivity || 0) >= self.idleMs() &&
              self.hasSpokenSinceLastEnd() && !self._sessionEnded) {
            self.showSessionEnded({ fromServer: false });
          }
        }
      };
      document.addEventListener('visibilitychange', self._visibilityHandler);
    },

    /**
     * True when there is a real message below the most recent divider.
     *
     * Mirrors the rule the server applies before persisting its marker, so the
     * live divider and the persisted one cannot disagree.
     */
    hasSpokenSinceLastEnd: function () {
      var m = this.el.msgs;
      if (!m) return false;
      var kids = m.children || [];
      for (var i = kids.length - 1; i >= 0; i--) {
        var cls = String(kids[i].className || '');
        if (cls.indexOf('ami-session-end') !== -1) return false;
        if (cls.indexOf('ami-msg-row') !== -1) return true;
      }
      return false;
    },

    cancelSessionEnd: function () {
      if (this._sessionEndTimer) { clearTimeout(this._sessionEndTimer); this._sessionEndTimer = null; }
      if (this._visibilityHandler) { document.removeEventListener('visibilitychange', this._visibilityHandler); this._visibilityHandler = null; }
    },

    stopIdleWatch: function () {
      if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
      this.cancelSessionEnd();
    },

    /* -------------------------- Sending -------------------------- */

    buildFormData: function (text) {
      var fd = new FormData();
      fd.append('session_id', this.sessionId);
      if (text !== undefined && text !== null) fd.append('message', text);
      fd.append('provider', 'gemini');
      fd.append('user_name', this.userName);
      fd.append('user_email', this.userEmail);
      fd.append('user_department', this.userDepartment);
      fd.append('user_role', this.userRole);
      fd.append('login_user', this.loginUser);
      if (this.identityToken) fd.append('identity_token', this.identityToken);
      return fd;
    },

    /**
     * Tell Ami something that happened in the UI, without pretending the user
     * typed it.
     *
     * Used when the ticket form is dismissed. The conversation would otherwise
     * just stop: Ami had handed over, the user closed the form, and the next
     * message either side of it would give no sign anything happened. Ami gets to
     * acknowledge it so the thread still reads as a conversation.
     *
     * No user bubble is added, because the user did not say this. The reply is
     * rendered as normal.
     */
    notifyServer: function (text) {
      var self = this;
      if (!text || !this.apiBase()) return;
      this.showTyping();
      var fd = this.buildFormData(text);
      fetch(this.apiUrl('/api/chat'), { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) { self.handleResponse(d, { suppressModal: true }); })
        .catch(function () {
          // A failed courtesy message must not leave the typing indicator up.
          self.hideTyping();
        });
    },

    send: function (presetText) {
      var self = this;
      var input = this.el.input;
      var text = presetText !== undefined && presetText !== null ? presetText : input.value.trim();
      var pending = (this.pendingFiles || []).slice();

      if (!text && !pending.length) return;

      if (!this.apiBase()) {
        this.addMessage('assistant', 'I\u2019m still connecting to the Ami server. Give me a second and try again.', { error: true });
        return;
      }

      this.markActivity();
      // The user spoke again, so any pending "still there?" is no longer true
      // and the next one has to be re-armed from scratch.
      this._nudgeFired = false;
      this.cancelNudge();
      // Actively chatting again, so a later history reload is welcome to show
      // the end-of-conversation marker once more.
      this._markerRetired = false;
      // ...and the LIVE end machinery has to be allowed to fire for this new
      // conversation. loadHistory leaves `_sessionEnded` true whenever the
      // thread replays any old `[ended session]` row, and replayed markers are
      // flagged final so the idle poller never retires them - which meant
      // armSessionEnd's `if (self._sessionEnded) return;` blocked every future
      // live divider after the first ever end. Only the flags clear here: the
      // old divider node stays in the transcript as history.
      this._sessionEnded = false;
      this._sessionEndFinal = false;

      input.value = '';
      input.style.height = 'auto';
      this.pendingFiles = [];
      this.renderPending();
      this.clearQuickReplies();

      var uploads = pending.map(function (e) { return e.file; });
      this.addUserUploadMessage(text, pending);
      // Kept so the ticket form can be opened with the conversation's subject
      // already in hand instead of asking the user to retype it.
      this.lastUserMessage = text || this.lastUserMessage || '';

      this.showTyping();

      var fd = this.buildFormData(text || ('I uploaded ' + uploads.length + ' file' + (uploads.length > 1 ? 's' : '')));
      uploads.forEach(function (f) { fd.append('files', f, f.name); });

      fetch(this.apiUrl('/api/chat'), { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) { self.handleResponse(d); })
        .catch(function (e) {
          self.hideTyping();
          self.addMessage('assistant', 'Connection problem: ' + (e.message || e) + '. Please try again.', { error: true });
        });
    },

    sendFiles: function (files) {
      var self = this;
      if (!files || !files.length) return;
      this.pendingFiles = [];
      this.renderPending();
      this.clearQuickReplies();

      var enriched = (files || []).map(function (f) {
        var isImg = /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name || '');
        return {
          file: f,
          name: f.name,
          size: f.size,
          type: f.type,
          previewUrl: isImg ? URL.createObjectURL(f) : null,
          downloadUrl: null
        };
      });
      this.addUserUploadMessage('', enriched);
      this.showTyping();

      var fd = this.buildFormData('I uploaded ' + files.length + ' file' + (files.length > 1 ? 's' : ''));
      files.forEach(function (f) { fd.append('files', f, f.name); });

      fetch(this.apiUrl('/api/chat'), { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) { self.handleResponse(d); })
        .catch(function (e) {
          self.hideTyping();
          self.addMessage('assistant', 'Upload failed: ' + (e.message || e), { error: true });
        });
    },

    /* -------------------------- Response -------------------------- */

handleResponse: function (data, opts) {
   // opts.suppressModal: set when this turn was triggered by the UI rather than
   // by the user (closing the ticket form, for example). Without it, a reply that
   // happens to carry the escalation marker would reopen the form the user just
   // dismissed - the modal would refuse to close and look stuck.
   var suppressModal = !!(opts && opts.suppressModal);
   this.hideTyping();
   if (!data) { this.addMessage('assistant', 'I got an empty response. Please try again.', { error: true }); return; }
   if (data.error) { this.addMessage('assistant', 'Sorry - ' + data.error, { error: true }); return; }

      // Ami has finished its turn, so the ball is in the user's court. Arm the
      // "still there?" nudge now rather than on send, so a long answer does not
      // get a "you sent that ages ago" prompt underneath it.
      this.markActivity();
      this.armNudge();

      this.lastMode = data.mode || 'chat';
      this.awaitingAttachment = !!(data.options && data.options.length === 1 && /^done$/i.test(String(data.options[0]).trim()));

      if (data.uploads && data.uploads.length) {
        this.updateUploadPreviews(data.uploads);
      }

      if (data.reply) {
        var opts = { notice: data.ticket_created };
        this.addMessage('assistant', data.reply, opts);
      }

      if (data.ticket_created && data.control_number) {
        this.addMessage('assistant', this.ticketNotice(data.control_number), { notice: true });
        // Remembered locally so a refresh inside the same page view can put the
        // control number back. This is a cache, not the record: the server holds
        // `last_control_number`, and loadHistory() restores from that. Without
        // either, the number existed only in this one render and vanished on
        // reload - which is what the user reported.
        this._lastControlNumber = data.control_number;
      }

// A submitted ticket does NOT end the conversation. The user usually has
      // more to ask once MIS has the request, and closing the thread here showed
      // "Session ended" seconds after the confirmation they had just read.
      // The ticket notice above is the confirmation; nothing else is needed.
      // A genuine idle expiry still marks the end, because that one really is
      // the end of the thread.
      if (data.session_ended && !data.ticket_created) {
        this.addSessionEnd({ now: true });
      }

      if (data.options && data.options.length) {
        this.showQuickReplies(data.options);
      } else {
        this.clearQuickReplies();
      }

      // The assistant decided the chat has gone as far as it can, so it hands
      // over to the ticket form itself. There is no header button for this.
      // Opened after the reply lands so the user reads why the form appeared.
      if (data.open_ticket_modal && !this.ticketModalOpen && !suppressModal) {
        this.openTicketModal(data.ticket_prefill || null);
      }
    },

    openTicketModal: function (prefill) {
      if (this.ticketModalOpen) return;
      if (!this.modal || !this.modal.open) return;
      this.ticketModalOpen = true;
      var self = this;
      // Filling in the ticket form is active use, not idleness.
      //
      // The form is the longest interaction in the product - choosing a category,
      // systems, location, typing a description and justification - and it happens
      // with the chat composer untouched. Left alone, the two-minute nudge fired
      // while they were mid-form and the five-minute timer closed the session
      // underneath them, so a ticket written carefully could be lost.
      this._suspendIdle(SESSION_SUSPEND_LABEL);
      this.modal.open({
        // The modal resolves its own URLs and authenticates from these, rather
        // than re-running base discovery for every catalog dropdown.
        apiUrl: function (p) { return self.apiUrl(p); },
        sessionId: this.sessionId,
        // What the user asked about most recently, plus anything the server
        // carried over from earlier turns, so the form opens already filled
        // where the session knows the answer.
        context: this.lastUserMessage || '',
        prefill: prefill || null,
        onClose: function (reason) {
          self.ticketModalOpen = false;
          // Whatever closed it - submitted, cancelled or dismissed - they were
          // here, so the idle clocks start again from now rather than from
          // whenever the form opened.
          self._resumeIdle(SESSION_SUSPEND_LABEL);
          // Only a dismissal is worth reporting. Closing after a successful
          // submit is already covered by the confirmation message.
          if (reason === 'cancelled') {
            self.notifyServer(
              '[SYSTEM] The user closed the ticket form without submitting. ' +
              'Nothing was filed. Acknowledge briefly and offer to pick it up later.'
            );
          }
        },
        onCreated: function (result) { self.onTicketCreated(result); }
      });
    },

    onTicketCreated: function (result) {
      this.ticketModalOpen = false;
      var control = (result && result.control_number) || '';
      // A submission MIS has accepted but not yet numbered is still a success.
      // Saying "Ticket submitted" with no number is honest; the old code
      // reported these as failures and invited a resubmit that would create a
      // duplicate ticket.
      this.lastControlNumber = control || this.lastControlNumber;
      this.addMessage('assistant',
        '\u2705 Ticket submitted' + (control ? '. Control number: ' + control : '') +
        '\n\nThe MIS team has been notified and will assist you shortly.',
        { notice: true });
      // The conversation is deliberately left open. Filing a ticket is a step,
      // not the end of the chat, so this asks whether anything else is needed
      // instead of closing the thread the user is still sitting in.
      this.addMessage('assistant',
        'Anything else I can help you with? If not, just leave this open \u2014 I\u2019ll close it '
        + 'after a few minutes of quiet.', { system: true });
      this.showQuickReplies(['No, that\u2019s all', 'Yes, one more thing']);
      // Restart the idle clock so the new thread is given the full window
      // rather than whatever was left of the one that raised the ticket.
      this.markActivity();
    },

    updateUploadPreviews: function (uploads) {
      var self = this;
      var grids = this.el.msgs.querySelectorAll('.ami-upload-grid');
      if (!grids.length) return;
      var lastGrid = grids[grids.length - 1];
      var anchors = lastGrid.querySelectorAll('.ami-thumb img, .ami-file');
      uploads.forEach(function (up, i) {
        if (anchors[i]) {
          var a = anchors[i];
          if (a.tagName === 'IMG') {
            a.src = up.url || a.src;
            a.dataset.permanent = 'true';
          } else if (a.classList.contains('ami-file')) {
            a.href = up.url || a.href;
            a.download = up.name || a.download;
            a.dataset.permanent = 'true';
          }
        }
      });
    },

    showQuickReplies: function (options) {
      var self = this;
      var box = this.el.quick;
      box.innerHTML = '';
      box.style.display = 'flex';
      // Must clear the server's own cap, or a list the server deliberately sent
      // as buttons (29 departments) arrives with only the first 8 showing and
      // the user cannot reach the rest. The container wraps, so a long list
      // stacks instead of overflowing.
      var limit = self.OPTION_BUTTON_LIMIT || 40;
      options.slice(0, limit).forEach(function (opt) {
        var b = document.createElement('button');
        b.className = 'ami-quick-reply-btn';
        b.type = 'button';
        b.textContent = opt;
        b.addEventListener('click', function () {
          self.clearQuickReplies();
          self.send(opt);
        });
        box.appendChild(b);
      });
    },

    clearQuickReplies: function () {
      if (this.el.quick) { this.el.quick.innerHTML = ''; this.el.quick.style.display = 'none'; }
    },

    /* -------------------------- Messages -------------------------- */

    addMessage: function (role, content, opts) {
      opts = opts || {};
      var row = document.createElement('div');
      row.className = 'ami-msg-row ' + (role === 'user' ? 'user' : 'assistant');
      row.style.width = '100%';
      if (opts.quiet) row.style.animation = 'none';

      var avatar = document.createElement('div');
      avatar.className = 'ami-avatar-sm';
      avatar.innerHTML = role === 'user' ? this.userAvatarHtml() : this.icons.bot;

      var wrap = document.createElement('div');
      wrap.className = 'ami-msg-body';
      var bubble = document.createElement('div');
      bubble.className = 'ami-message ' + role;
      if (opts.notice) bubble.classList.add('ami-ticket-notice');
      if (opts.error) bubble.classList.add('ami-error');

      if (role === 'assistant') {
        bubble.innerHTML = this.renderContent(content || '');
      } else {
        bubble.textContent = content || '';
      }
      wrap.appendChild(bubble);

      if (opts.time) {
        var t = document.createElement('div');
        t.className = 'ami-time';
        t.textContent = this.formatTime(opts.time);
        wrap.appendChild(t);
      }

      row.appendChild(avatar);
      row.appendChild(wrap);

      // opts.prepend is now explicit. Previously `quiet` doubled as "prepend",
      // which reversed loadHistory: every replayed message went to the FRONT, so
      // a reloaded thread rendered newest-first and read backwards.
      //
      // `opts.before` is the anchor a batch insert needs. Prepending against
      // `firstChild` reverses a whole page, because the page is walked
      // oldest-first and every insert lands above the previous one - so a page of
      // ten scrolled-back messages rendered newest-first and read upside down.
      // Inserting every row against a fixed anchor taken before the batch keeps
      // the page in order.
      var ref = opts.prepend ? (opts.before || this.el.msgs.firstChild) : null;
      if (opts.prepend) this.el.msgs.insertBefore(row, ref);
      else this.el.msgs.appendChild(row);

      // Don't yank the viewport while a history page is being spliced in;
      // loadOlder restores the scroll offset itself once the loop finishes.
      //
      // A live message follows the conversation only when the user is already at
      // the bottom. `_pinnedToBottom` is false while they are reading back, and
      // scrolling a reply into view for someone who deliberately scrolled away is
      // the single most annoying thing a chat widget does.
      if (!opts.quiet && this._pinnedToBottom !== false) this.scrollDown();
      return row;
    },

    prependMessage: function (role, content, key, time, before) {
      // addMessage already places the row at the front when prepend is set, so
      // there is no second insertBefore here. `before` is passed straight
      // through so a batch of older messages can be anchored as a block.
      var row = this.addMessage(role, content, {
        time: time, quiet: true, prepend: true, before: before
      });
      row.setAttribute('data-mid', key);
    },

    addUserUploadMessage: function (text, items) {
      var self = this;
      var row = document.createElement('div');
      row.className = 'ami-msg-row user';
      row.style.width = '100%';

      var avatar = document.createElement('div');
      avatar.className = 'ami-avatar-sm';
      avatar.innerHTML = this.userAvatarHtml();

      var wrap = document.createElement('div');
      wrap.className = 'ami-msg-body';
      var bubble = document.createElement('div');
      bubble.className = 'ami-message user';
      if (text) bubble.textContent = text;

      var grid = document.createElement('div');
      grid.className = 'ami-upload-grid';
      (items || []).forEach(function (item) {
        var enriched = item.file ? item : {
          file: item,
          name: item.name,
          size: item.size,
          type: item.type,
          previewUrl: /^image\//.test(item.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(item.name || '')
            ? URL.createObjectURL(item)
            : null,
          downloadUrl: null
        };
        grid.appendChild(self.buildUploadNode(enriched));
      });
      bubble.appendChild(grid);
      wrap.appendChild(bubble);

      var t = document.createElement('div');
      t.className = 'ami-time';
      t.textContent = this.formatTime(new Date().toISOString());
      wrap.appendChild(t);

      row.appendChild(avatar);
      row.appendChild(wrap);
      this.el.msgs.appendChild(row);
      this.scrollDown();
    },

    buildUploadNode: function (f) {
      var isImg = /^image\//.test(f.type) || /\.(jpe?g|png|gif|webp|bmp)$/i.test(f.name || '');
      var node = document.createElement('div');
      node.className = 'ami-thumb';

      if (isImg && f.previewUrl) {
        var img = document.createElement('img');
        img.src = f.previewUrl;
        img.alt = f.name;
        img.addEventListener('click', function () { self_open(this.src, f.name); });
        var overlay = document.createElement('div');
        overlay.className = 'ami-thumb-overlay';
        var expand = document.createElement('button');
        expand.className = 'ami-thumb-expand';
        expand.type = 'button';
        expand.innerHTML = this.icons.expand;
        expand.addEventListener('click', function (e) { e.stopPropagation(); self_open(img.src, f.name); });
        overlay.appendChild(expand);
        node.appendChild(img);
        node.appendChild(overlay);
        return node;
      }

      var a = document.createElement('a');
      a.className = 'ami-file';
      a.href = f.downloadUrl || '#';
      a.download = f.name || 'download';
      a.target = '_blank';
      a.rel = 'noopener';

      var ico = document.createElement('div');
      ico.className = 'ami-file-ico';
      ico.textContent = (this.extOf(f.name) || 'FILE').slice(0, 4).toUpperCase();

      var meta = document.createElement('div');
      meta.className = 'ami-file-meta';
      var nm = document.createElement('div');
      nm.className = 'ami-file-name';
      nm.textContent = f.name || 'file';
      var sz = document.createElement('div');
      sz.className = 'ami-file-size';
      sz.textContent = this.formatSize(f.size);
      meta.appendChild(nm);
      meta.appendChild(sz);

      a.appendChild(ico);
      a.appendChild(meta);
      node.appendChild(a);
      return node;
    },

    extOf: function (name) {
      var m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
      return m ? m[1] : '';
    },

    formatSize: function (bytes) {
      bytes = Number(bytes) || 0;
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    formatTime: function (iso) {
      var d = new Date(iso);
      if (isNaN(d)) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    },

    // Normalise a history page to oldest-first.
    //
    // The Postgres backend orders by `id DESC` (newest first, because the paging
    // cursor is the oldest id returned), while the JSON fallback returns natural
    // array order. Those two disagree, so relying on the server's order renders
    // the transcript backwards on one backend and correctly on the other.
    // Sorting by id when available handles both; otherwise the page is assumed to
    // be newest-first and is reversed.
    chronological: function (messages) {
      var list = (messages || []).slice();
      if (list.length < 2) return list;

      var allHaveIds = list.every(function (m) { return m && m.id !== undefined && m.id !== null; });
      if (allHaveIds) {
        return list.sort(function (a, b) { return Number(a.id) - Number(b.id); });
      }
      return list.reverse();
    },

  /**
   * The ticket confirmation text.
   *
   * Shared by the live submission path and by history restore, so the two can
   * never disagree about what the user is told after filing.
   */
  ticketNotice: function (controlNumber) {
    return '\u2705 Ticket submitted. Control number: ' + controlNumber +
      '\n\nThe MIS team has been notified and will assist you shortly.';
  },

  // Timestamp of the newest message, used to stamp the session-end divider
  // when rebuilding a thread from history.
  lastTime: function (messages) {
      if (!messages || !messages.length) return null;
      for (var i = messages.length - 1; i >= 0; i--) {
        var t = messages[i] && messages[i].timestamp;
        if (t) return t;
      }
      return null;
    },

    renderContent: function (text) {
      var escaped = String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
      escaped = escaped.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
      return escaped;
    },

    showTyping: function () {
      this.el.typing.style.display = 'block';
      // Only follow the conversation down if the user was already there. Someone
      // reading back through history should not be yanked to the newest message
      // just because Ami started typing - that is what the jump control is for.
      if (this._pinnedToBottom !== false) this.scrollDown();
    },

    hideTyping: function () {
      this.el.typing.style.display = 'none';
      // The indicator is a sibling of the transcript, so hiding it does not change
      // the transcript's height - but the reply that follows does, and it is
      // added after this runs. Following the position here keeps the sequence from
      // being left a message short of the bottom.
      if (this._pinnedToBottom !== false) this.scrollDown();
    }
  };

  /* Lightbox for images */
  function self_open(src, caption) {
    var l = document.getElementById('ami-lightbox');
    if (!l) {
      l = document.createElement('div');
      l.id = 'ami-lightbox';
      l.addEventListener('click', function () { l.classList.remove('open'); });
      document.body.appendChild(l);
    }
    // Built with DOM calls, never innerHTML.
    //
    // `caption` is the user's own FILENAME, and it used to be concatenated raw into
    // an HTML string. A file named `"><img src=x onerror=alert(1)>` closed the tag
    // and ran script in the host page's origin the moment its thumbnail was clicked
    // - the widget is embedded in the MIS page, so that is the MIS origin, and it
    // was reachable by anyone who can attach a file.
    //
    // `textContent` on the caption and a property assignment on `src` remove the
    // HTML parsing entirely, so there is nothing left to escape. Same fix as
    // modal.js already uses for upload names.
    while (l.firstChild) l.removeChild(l.firstChild);
    var img = document.createElement('img');
    img.src = String(src || '');
    img.alt = '';
    l.appendChild(img);
    if (caption) {
      var cap = document.createElement('div');
      cap.className = 'ami-lb-caption';
      cap.textContent = String(caption);
      l.appendChild(cap);
    }
    l.classList.add('open');
  }

  function boot() {
    if (document.getElementById('ami-widget')) return;
    Widget.init();
  }

  // Export for CommonJS
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Widget;
  }

  return { AmiWidget: Widget, boot: boot };
})();

// Boot only after the IIFE has finished assigning AmiWidget (avoids TDZ ReferenceError)
var AmiWidget = AmiWidgetModule.AmiWidget;
var amiBoot = AmiWidgetModule.boot;
window.AmiWidget = AmiWidget;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', amiBoot);
} else {
  amiBoot();
}

export { AmiWidget };
export default AmiWidget;
