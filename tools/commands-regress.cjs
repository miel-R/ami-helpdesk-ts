/* Regression tests for src/server/commands.js ($help, $reset, $status, ...).
   Runs the real module and a real conversation manager against a temp data dir.
   Run:  node tools/commands-regress.cjs                              */
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the data dir at a scratch folder so $reset/$disable never touch real data.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ami-cmd-'));
process.env.CONVERSATIONS_DIR = path.join(TMP, 'conversations');
process.env.ATTACHMENTS_DIR = path.join(TMP, 'attachments');
process.env.UPLOADS_DIR = path.join(TMP, 'uploads');

const commands = require('../dist/server/features/agent/commands');
// Imported from the modules that own them. These used to come out of a single
// `utils` barrel, which held eight unrelated concerns at once.
const ticketIntake = require('../dist/server/features/agent/ticket-intake');
// conversation.ts exports the manager as an ES default export, which lands on
// .default under CommonJS interop - not on module.exports itself.
const conversationManager = require('../dist/server/services/session.service').default;
// Storage has to be up before any conversation is touched: getConversation()
// restores from storage on first access and throws if init() has not run yet.
//
// Required as `db/storage.service`, NOT `db`. `dist/server/db/index.js` is a stale
// artifact from an older layout that nothing imports any more, and Node resolves
// the directory to it in preference to `storage.service.js`. It keeps its own
// private `backend` variable, so `init()` here initialised THAT module while
// session.service kept calling the real one - which then reported
// "db.init() has not completed yet" for every restore and save in this suite.
// Those failures were swallowed by their own try/catch, so the suite stayed green
// while never actually persisting anything.
const dbStorageRef = require('../dist/server/db/storage.service');
const { init: initDb, db: dbBackend } = dbStorageRef;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};

const NAME = 'E2E Tester';
function ctx(sessionId, role = 'user', dept = 'QA') {
  const session = conversationManager.getConversation(sessionId);
  const user = { user_name: NAME, first_name: NAME, email: 'e2e@example.invalid', department: dept, role };
  session.user = { ...session.user, ...user };
  return { sessionId, session, user, userName: NAME };
}

(async () => {
  await initDb();
  console.log('\n[1] Module exports (regression: exports came back empty)');
  for (const fn of ['handleCommand', 'helpText', 'isDisabled', 'setDisabled', 'isCommand']) {
    ok(`exports ${fn}`, typeof commands[fn] === 'function', typeof commands[fn]);
  }
  ok('isCommand($help)', commands.isCommand('$help') === true);
  ok('isCommand( plain text )', commands.isCommand('hello') === false);
  ok('isCommand( empty )', commands.isCommand('') === false);

  console.log('\n[2] Non-commands are ignored');
  ok('returns null for normal chat', await commands.handleCommand('hello there', ctx('t0')) === null);

  console.log('\n[3] $help');
  const help = await commands.handleCommand('$help', ctx('t1'));
  ok('replies', !!help && !!help.reply);
  ok('lists $reset', help.reply.includes('$reset'));
  ok('lists $status', help.reply.includes('$status'));
  ok('non-admin does NOT see admin commands', !help.reply.includes('$diagnose'));
  const adminHelp = await commands.handleCommand('$help', ctx('t2', 'admin'));
  ok('admin DOES see admin commands', adminHelp.reply.includes('$diagnose'));
  ok('provider is system, never the AI', help.provider === 'system');

  console.log('\n[4] $whoami');
  const who = await commands.handleCommand('$whoami', ctx('t3'));
  ok('names the user', who.reply.includes(NAME), who.reply);
  ok('shows the ROLE, not the department', who.reply.includes('(user)') && !who.reply.includes('QA'), who.reply);

  console.log('\n[5] $status');
  const c5 = ctx('t4');
  c5.session.mode = 'chat';
  c5.session.collected_fields = { location: 'Main Building', empty: '  ' };
  const st = await commands.handleCommand('$status', c5);
  ok('shows mode in plain language', st.reply.includes('just chatting'), st.reply);
  // Note: intake flow removed, so captured fields are no longer shown in status
  ok('ignores blank fields', !st.reply.includes('empty'), st.reply);

  console.log('\n[6] $reset actually clears the conversation');
  const c6 = ctx('t5');
  c6.session.messages.push({ role: 'user', content: 'secret thing' });
  c6.session.mode = 'chat';
  c6.session.collected_fields = { location: 'Warehouse' };
  ok('session had state before', c6.session.messages.length > 0);
  const rs = await commands.handleCommand('$reset', c6);
  ok('replies that it cleared', /cleared/i.test(rs.reply), rs.reply);
  ok('messages cleared to just the command pair', c6.session.messages.length === 2,
     'got ' + c6.session.messages.length);
  ok('mode back to chat', c6.session.mode === 'chat', c6.session.mode);
  ok('collected fields cleared', Object.keys(c6.session.collected_fields || {}).length === 0);

  console.log('\n[7] $end leaves a resumable session');
  const c7 = ctx('t6');
  c7.session.mode = 'chat';
  c7.session.pending_question = { id: 'x', question: 'Where?' };
  const en = await commands.handleCommand('$end', c7);
  ok('replies', /Thanks for chatting/i.test(en.reply), en.reply);
  ok('mode reset to chat', c7.session.mode === 'chat');
  ok('pending question cleared', c7.session.pending_question === null);

  console.log('\n[8] Admin gating');
  const denied = await commands.handleCommand('$disable', ctx('t7', 'user'));
  ok('non-admin is refused', /administrators only/i.test(denied.reply), denied.reply);
  ok('flag NOT written for non-admin', commands.isDisabled() === false);

  const allowed = await commands.handleCommand('$disable', ctx('t8', 'admin'));
  ok('admin may disable', /disabled for all users/i.test(allowed.reply), allowed.reply);
  ok('flag written', commands.isDisabled() === true);

  const enabled = await commands.handleCommand('$enable', ctx('t9', 'admin'));
  ok('admin may enable', /enabled for all users/i.test(enabled.reply), enabled.reply);
  ok('flag cleared', commands.isDisabled() === false);

  console.log('\n[9] Unknown commands');
  const unknown = await commands.handleCommand('$bogus', ctx('t10'));
  ok('explains itself', /don't know/i.test(unknown.reply), unknown.reply);
  ok('points at $help', unknown.reply.includes('$help'), unknown.reply);

  console.log('\n[10] Commands are recorded in history');
  const c11 = ctx('t11');
  await commands.handleCommand('$status', c11);
  ok('user turn recorded', c11.session.messages.some(m => m.role === 'user' && m.content === '$status'));
  ok('assistant turn recorded', c11.session.messages.some(m => m.role === 'assistant' && m.content.includes('Status')));

  console.log('\n[11] Ticket wording survives typos and Taglish');
  {
    // Real user typed "Create ticker" and got a chat reply instead of the form.
    // The trigger list is a plain substring match, so every misspelling of the
    // one word we need fell straight through.
    for (const msg of ['create ticker', 'Create Ticker', 'create tikets', 'create tiket',
      'gawa ng ticket', 'gawan ko ng ticket', 'kailangan ko ng ticket']) {
      ok(`"${msg}" opens a ticket`, ticketIntake.ami_userAskedForTicket(msg) === true);
    }
    // Normal words that merely look similar must NOT be rewritten into "ticket".
    for (const msg of ['the printer is ticking loudly', 'my keyboard sticks',
      'ticketing is not a word here']) {
      ok(`"${msg}" is left alone`, ticketIntake.normaliseTicketSpelling(msg) === msg,
        ticketIntake.normaliseTicketSpelling(msg));
    }
    // A misspelling must not leak into the filed description either.
    ok('typo is stripped from the description',
      !/ticker/i.test(ticketIntake.requestDescriptionFromMessage('my printer is jammed, create ticker')),
      ticketIntake.requestDescriptionFromMessage('my printer is jammed, create ticker'));
    ok('real description survives normalisation',
      /printer is jammed/i.test(ticketIntake.requestDescriptionFromMessage('my printer is jammed, create ticker')),
      ticketIntake.requestDescriptionFromMessage('my printer is jammed, create ticker'));
  }

  console.log('\n[12] AI blips are retried, real errors are not');
  {
    // A 429 is a rate limit. One of these used to end the user's turn with
    // "sorry, I had trouble reaching the AI service" when a second attempt
    // would have worked.
    const { isTransientAiError } = require('../dist/server/services/ai-retry.service');
    for (const msg of ['Request failed with status code 429', 'Request failed with status code 503',
      'socket hang up', 'ETIMEDOUT', 'network error', 'rate limit exceeded', 'model overloaded']) {
      ok(`"${msg}" is retried`, isTransientAiError(new Error(msg)) === true, msg);
    }
    // Retrying these just burns quota and delays the same error.
    for (const msg of ['Request failed with status code 400', 'Request failed with status code 401',
      'Request failed with status code 403', 'API key not valid']) {
      ok(`"${msg}" is NOT retried`, isTransientAiError(new Error(msg)) === false, msg);
    }
  }

  console.log('\n[12b] A slow reply still succeeds; the stall is diagnosable');
  {
    // A 48s reply was attempt 1 timing out and attempt 2 succeeding at 18s.
    // Cutting the budget would have turned that success into a failure, so the
    // timing was restored deliberately. What is asserted here is the DECISION:
    // do not shorten it again, and do make sure a stall cannot hang forever.
    const { callAIWithRetry, DEFAULT_RETRY_POLICY } = require('../dist/server/services/ai-retry.service');

    ok('a slow but successful turn is given room to finish',
       DEFAULT_RETRY_POLICY.attemptTimeoutMs >= 30000,
       String(DEFAULT_RETRY_POLICY.attemptTimeoutMs));
    ok('it is still retried more than once',
       DEFAULT_RETRY_POLICY.attempts >= 3, String(DEFAULT_RETRY_POLICY.attempts));
    ok('the total budget cannot truncate the retries it allows',
       DEFAULT_RETRY_POLICY.budgetMs >= DEFAULT_RETRY_POLICY.attemptTimeoutMs * DEFAULT_RETRY_POLICY.attempts,
       `${DEFAULT_RETRY_POLICY.budgetMs} vs ${DEFAULT_RETRY_POLICY.attemptTimeoutMs * DEFAULT_RETRY_POLICY.attempts}`);

    // A promise that never settles must still be abandoned, whatever the budget.
    // This is the backstop, not the policy: it proves an unbounded loop is not
    // possible even though the timeout itself was left generous.
    let attempts = 0;
    const started = Date.now();
    let failed = false;
    try {
      await callAIWithRetry(() => {
        attempts++;
        return new Promise(() => { /* never resolves: a real provider stall */ });
      }, { attempts: 2, budgetMs: 600, attemptTimeoutMs: 300 });
    } catch { failed = true; }
    const elapsed = Date.now() - started;
    ok('a stalled call is abandoned, not waited on forever', failed === true);
    ok('and it happens inside the budget', elapsed < 3000, elapsed + 'ms');
    ok('a stall does not burn the whole attempt list', attempts <= 2, String(attempts));

    // The case that actually happened: the first attempt times out, the second
    // succeeds. It must still return the answer.
    let n = 0;
    const value = await callAIWithRetry((t) => {
      n++;
      if (n === 1) return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout of ' + t + 'ms exceeded')), t));
      return Promise.resolve('second attempt worked');
    }, { attempts: 3, budgetMs: 30000, attemptTimeoutMs: 200 });
    ok('a timed-out first attempt is still retried', n === 2, String(n));
    ok('and the retry returns the real answer', value === 'second attempt worked', String(value));

    // A non-transient failure must still fail on the first attempt: retrying a bad
    // key only burns the user's time.
    let m = 0;
    let rejected = false;
    try {
      await callAIWithRetry(() => { m++; return Promise.reject(new Error('status code 401')); },
        { attempts: 3, budgetMs: 5000, attemptTimeoutMs: 2000 });
    } catch { rejected = true; }
    ok('a non-transient error is not retried', rejected === true && m === 1, String(m));

    // The quota message from the live provider. It must count as transient so the
    // retry gets a chance once the per-minute window rolls over, which is the
    // whole point of having spent the quota in the first place.
    const { isTransientAiError: transient } = require('../dist/server/services/ai-retry.service');
    ok('"You exceeded your current quota" is retried',
       transient(new Error('You exceeded your current quota')) === true);
  }

  console.log('\n[12c] The widget opens on a short page, not the whole thread');
  {
    // The paging was fully built server-side and client-side (the `before` cursor,
    // `has_more`, the scroll-to-top handler that pulls the previous page, and the
    // scroll-offset restore so nothing jumps). The one defect was the page size:
    // the widget asked for 50, so a long thread pulled fifty messages into the DOM
    // on open and the existing paging path was dead code.
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget', 'main.js'), 'utf8');
    const limits = src.split('\n')
      .filter(l => l.includes('api/history'))
      .flatMap(l => l.match(/limit=\d+/g) || []);

    ok('history is requested, in two places: the first page and the older page',
       limits.length === 2, JSON.stringify(limits));
    ok('the initial page is short, not the whole thread',
       limits.every(l => l === 'limit=10'), JSON.stringify(limits));
    ok('no widget history call asks for 50 any more',
       !/api\/history\/[^\n]*limit=50/.test(src));

    // The paging path has to still be reachable, or the short first page is just
    // a way to lose the user's scrollback.
    // The threshold is a named constant now, and deliberately generous: an 8px
    // window is only reached by a scrollbar drag that lands exactly on zero, so
    // momentum and touch scrolling settled a few pixels short and silently did
    // nothing. widget-regress.mjs drives the real handler at 20px to prove it.
    // The test now lives in `atTop()`, shared by the scroll, wheel and touchmove
    // handlers, so this asserts the predicate rather than one call site.
    ok('there is a single at-top predicate for every trigger',
       /var atTop = function \(\)\s*\{\s*return [^}]*scrollTop <= LOAD_MORE_THRESHOLD_PX/.test(src));
    // The scroll handler now also updates the jump-to-latest control, so it is
    // two statements rather than one.
    ok('the scroll handler defers to it',
       /addEventListener\('scroll', function \(\)\s*\{\s*(?:\/\/[^\n]*\n\s*)*if \(atTop\(\) && reportTop\('scroll'\)\) self\.loadOlder\(\);/.test(src));
    ok('scrolling to the top pulls the previous page',
       /reportTop\('scroll'\)\) self\.loadOlder\(\)/.test(src));
    ok('and the same scroll also updates the jump-to-latest control',
       /self\.loadOlder\(\);\s*\n\s*if \(!self\._autoScrolling\)/.test(src));
    ok('the trigger reads a named threshold, not a magic number',
       /var LOAD_MORE_THRESHOLD_PX = \d+;/.test(src));
    ok('and that threshold is forgiving enough for momentum scrolling',
       (src.match(/var LOAD_MORE_THRESHOLD_PX = (\d+);/) || [])[1] >= 32,
       (src.match(/var LOAD_MORE_THRESHOLD_PX = (\d+);/) || [])[1]);
    ok('the older page is prepended, not appended', /prependMessage/.test(src));
    ok('scroll position is restored after prepending',
       /scrollTop = prevTop \+ \(m\.scrollHeight - prevHeight\)/.test(src));
      // No visible paging control any more: scrolling up loads the previous page
      // and a jump-to-latest control handles the way back down. Both the button
      // and its "Loading earlier messages…" state were removed.
      // Comments are stripped first: this file explains at length why the control
      // was removed, and that explanation quotes its label. `widgetCss` is read
      // here rather than reusing the stripped copy declared further down, which is
      // a different block scope.
      const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      const widgetCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.css'), 'utf8');
      ok('no load-earlier button is rendered',
         !/Load earlier messages/.test(noComments) && !/Load earlier messages/.test(widgetCss));
      ok('the progress state for that button is gone with it',
         !/setLoadMoreState/.test(src));
      ok('and can be inspected from the console',
         /pagingState: function/.test(src));

    console.log('\n[12d] The transcript is a real scroll container');
    {
      // The one that actually broke it, and it was invisible to every JS-level
      // test: `#ami-messages` is a flex item with `flex: 1 1 auto` and no
      // `min-height: 0`, so its automatic minimum size was its content height.
      // It grew to fit the whole conversation, never became a scrollport,
      // `scrollHeight === clientHeight`, `scrollTop` stayed 0 and the browser
      // fired no `scroll` event at all. The overflow was clipped by
      // `#ami-chat-window { overflow: hidden }`.
      //
      // So the widget looked fine, the endpoint was fine, the handler was fine,
      // and scrolling "did nothing" - which is exactly how it was reported.
      const cssRaw = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget.css'), 'utf8');
      // Comments are stripped first: the explanation of this very bug contains
      // `#ami-chat-window { overflow: hidden }`, and naively cutting at the first
      // `}` truncates the rule inside that comment.
      const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '');
      const rule = (() => {
        const i = css.indexOf('#ami-messages {');
        return i === -1 ? '' : css.slice(i, css.indexOf('}', i) + 1);
      })();

      ok('there is a #ami-messages rule to inspect', rule !== '');
      ok('it is a flex item of the window', /flex:\s*1 1 auto/.test(rule));
      ok('it declares overflow-y: auto', /overflow-y:\s*auto/.test(rule));
      // The actual fix.
      ok('it sets min-height: 0 so it can shrink and become a scrollport',
         /min-height:\s*0/.test(rule),
         rule.replace(/\s+/g, ' ').slice(0, 120));
      ok('the window that hosts it is a fixed-height flex column',
         /#ami-chat-window \{[^}]*height:\s*640px[^}]*flex-direction:\s*column/.test(css));
      ok('and clips rather than scrolls, which is what hid the bug',
         /#ami-chat-window \{[^}]*overflow:\s*hidden/.test(css));

      // `scroll-behavior: smooth` on the container animated loadOlder()'s restore
      // of the reading position, so the viewport landed in the wrong place after
      // loading a page. It is now requested per call instead.
      //
      // Anchored on the property name: the rule legitimately contains
      // `overscroll-behavior`, which includes the substring "scroll-behavior".
      ok('the transcript no longer sets scroll-behavior globally',
         !/[\s{]\s*scroll-behavior\s*:/.test(rule),
         (rule.match(/[\s{]\s*scroll-behavior\s*:/) || [])[0]);
      ok('it does still stop scroll chaining to the host page',
         /overscroll-behavior:\s*contain/.test(rule));
      ok('jumping to the bottom still asks for smooth explicitly',
         /scrollTo\(\{\s*top: m\.scrollHeight, behavior: 'smooth'/.test(src));

      // The trigger must not depend on the layout being exactly right.
      ok('the trigger also listens for wheel, which ignores which box scrolls',
         /addEventListener\('wheel', function \(\) \{ tryLoadFrom\('wheel'\); \}/.test(src));
      ok('and for touchmove',
         /addEventListener\('touchmove', function \(\) \{ tryLoadFrom\('touchmove'\); \}/.test(src));
      ok('the gesture trigger still checks the scroll position',
         /var tryLoadFrom = function \(source\) \{\s*if \(atTop\(\) && reportTop\(source\)\) self\.loadOlder\(\);/.test(src));
      ok('the diagnostic can report a non-scrollport transcript',
         /isScrollPort:/.test(src));

      // Diagnostics: each trigger names itself and reports which guard blocked it,
      // because "nothing happened" was indistinguishable from every one of the real
      // causes. Routed through historyDebug() so it is off by default rather than
      // firing on every scroll event.
      ok('there is a single gated debug helper, not scattered console calls',
         !/console\.(log|warn)\('\[ami:history\]/.test(src));
      ok('the helper is silent unless switched on',
         /var HISTORY_DEBUG = false;/.test(src) &&
         /if \(HISTORY_DEBUG[\s\S]{0,120}console\.log/.test(src));
      ok('it can be switched on from the console',
         /setHistoryDebug: function/.test(src));
      ok('the top-reached report names the input that fired it',
         /historyDebug\('top reached via ' \+ source/.test(src));
      ok('and reports the guard that blocked it',
         /skipped: a page is already loading/.test(src) &&
         /skipped: hasMore is false/.test(src) &&
         /skipped: no cursor/.test(src));
      ok('the initial page reports what the server decided about more history',
         /historyDebug\('initial page:/.test(src) && /has_more=/.test(src));
      ok('a successful prepend is logged with the new totals',
         /historyDebug\('prepended ' \+ d\.messages\.length/.test(src));
      ok('a failed older-page fetch is not swallowed silently',
         /historyDebug\('older page fetch FAILED/.test(src));
      ok('the request URL and status are logged',
         /historyDebug\('GET ' \+ historyUrl \+ ' -> ' \+ r\.status/.test(src));
      ok('loadOlder names its trigger for the log line',
         /loadOlder: function \(trigger\)/.test(src));

      console.log('\n[12c] Jump-to-current control above the composer');
      ok('it is rendered in the markup',
         /id="ami-jump-latest"/.test(src));
      ok('it ships out of the tab order and hidden from AT',
         /id="ami-jump-latest"[\s\S]{0,120}aria-hidden="true" disabled/.test(src));
      ok('it is not inside the scrolling transcript',
         !/id="ami-jump-latest"[\s\S]{0,200}id="ami-messages"/.test(src));
      ok('and is referenced from the element cache',
         /jumpLatest: document\.getElementById\('ami-jump-latest'\)/.test(src));
      ok('visibility is driven by distance from the bottom, with slack',
         /var JUMP_TOLERANCE_PX = \d+;/.test(src) &&
         /scrollHeight - m\.scrollTop - m\.clientHeight <= JUMP_TOLERANCE_PX/.test(src));
      // Landing at the bottom clears the lock, which is what hides the control:
      // it is released by a timer rather than forced inside scrollDown, because an
      // instant assignment settles before it can be tested for position.
      ok('arriving at the bottom hides it',
         /releaseScrollLock\(self\)[\s\S]{0,400}self\.toggleJumpToLatest\(\)/.test(src));
      ok('it is wired to a click handler',
         /jumpLatest\.addEventListener\('click', function \(\) \{ self\.jumpToLatest\(\); \}\)/.test(src));
      ok('its CSS is hidden by default and shown with .show',
         /\.ami-jump-latest \{[^}]*display:\s*none/.test(widgetCss) &&
         /\.ami-jump-latest\.show \{[^}]*display:\s*block/.test(widgetCss));
      ok('and it has a visible focus ring',
         /\.ami-jump-latest:focus-visible/.test(widgetCss));

      // It is anchored by a ZERO-HEIGHT SIBLING, not by #ami-input-area.
      //
      // The input area has `overflow-y: auto` so a tall attachment tray cannot
      // starve the message list - and an absolutely positioned child at
      // `bottom: 100%` sits outside that scrollport, so the overflow clipped the
      // button away entirely. It rendered once, then vanished for good.
      ok('the input area does NOT anchor it - that box clips overflow',
         !/#ami-input-area \{[^}]*position:\s*relative/.test(widgetCss));
      ok('and the input area still scrolls its own overflow',
         /#ami-input-area \{[^}]*overflow-y:\s*auto/.test(widgetCss));
      ok('a zero-height anchor carries it instead',
         /\.ami-jump-anchor \{[^}]*position:\s*relative[^}]*height:\s*0/.test(widgetCss));
      ok('the anchor is not a scroll container, so nothing clips the button',
         !/\.ami-jump-anchor \{[^}]*overflow/.test(widgetCss));
      ok('the button floats above the anchor, not at bottom:100% of a clipped box',
         /\.ami-jump-latest \{[^}]*position:\s*absolute/.test(widgetCss) &&
         /\.ami-jump-latest \{[^}]*bottom:\s*var\(--space-2\)/.test(widgetCss) &&
         !/\.ami-jump-latest \{[^}]*bottom:\s*100%/.test(widgetCss));
      ok('the anchor wraps the button in the markup',
         /class="ami-jump-anchor"[\s\S]{0,200}id="ami-jump-latest"/.test(src));
      ok('and is a sibling of the input area, not a child',
         /class="ami-jump-anchor"[\s\S]{0,400}id="ami-input-area"/.test(src));

      console.log('\n[12d] The session-end divider is a real boundary, not a drawing');
      // Option B: the divider claims the conversation is over, so the model's
      // replayed context has to agree. It did not - of the twenty turns Ami would
      // see on a real session, EIGHTEEN were from before the end.
      const readSrc = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
      const reply = readSrc('src/server/services/chat/stage.reply.ts');
      ok('the replay window is anchored after the last marker',
         /lastIndexOfMarker\(session\.messages\)/.test(reply) &&
         /session\.messages\.slice\(markerAt \+ 1\)/.test(reply));
      ok('so turns from before the end cannot reach the model',
         reply.indexOf('lastIndexOfMarker(session.messages)') <
         reply.indexOf('.slice(-20)'));
      ok('the marker itself is still excluded from the context',
         /\.filter\(m => m\.role !== 'system'\)/.test(reply));

      const life = readSrc('src/server/services/session-lifecycle.service.ts');
      ok('a marker is only written when there is conversation since the last one',
         /sinceLastMarker/.test(life) && /if \(sinceLastMarker\)/.test(life));
      ok('a marker is not written when nothing was said after the last boundary',
         /lastIndexOfMarker\(conv\.messages\)/.test(life));
      ok('expiry RE-ARMS the greeting instead of suppressing it forever',
         /conv\.greeted = false;/.test(life) && !/conv\.greeted = true;/.test(life));
      ok('the helper that finds the last marker is exported for reuse',
         /export function lastIndexOfMarker/.test(life));

      console.log('\n[12e] Form presence actually stops the idle sweep');
      // `form_active` is the server's only defence for a user sitting in the
      // ticket form, which stays open for minutes with the composer untouched.
      // Each of these was wrong at least once, and every version failed the same
      // way: the flag did not reach the object the sweep actually reads.
      const sess = readSrc('src/server/services/session.service.ts');
      const markForm = sess.match(/markFormActive\(sessionId: string\): void \{[\s\S]*?\n  \}/);
      ok('markFormActive exists', !!markForm);
      if (markForm) {
         ok('and it does NOT peek - peeking would leave last_seen exactly where it was',
            /getConversation\(sessionId\)/.test(markForm[0]) &&
            !/peek/.test(markForm[0]));
         ok('so the clock moves with the form, not just the flag',
            !/if \(!conv\) return;/.test(markForm[0]));
         ok('and it sets the flag on the conversation it just resolved',
            /conv\.form_active = true;/.test(markForm[0]));
      }

      const sweep = readSrc('src/server/server.ts');
      ok('the idle sweep skips a conversation with the form open',
         /bag\.form_active\) continue;/.test(sweep));

      const hist = readSrc('src/server/controllers/history.controller.ts');
      ok('idle_remaining_ms is measured from the PERSISTED last_seen',
         /idle_remaining_ms:[\s\S]{0,400}storedSeen/.test(hist));
      ok('not from the live conversation, which reads "now" on a cold process',
         !/idle_remaining_ms:[^\n]*live\.last_seen/.test(hist) &&
         !/idle_remaining_ms: Math\.max\(0, config\.conversation\.sessionTimeout - \(Date\.now\(\) - \(live/.test(hist));
      ok('history reads do not touch the idle clock at all',
         /getConversation\(sessionId, \{ peek: true \}\)/.test(hist));

      const ticket = readSrc('src/server/services/ticket/ticket.controller.ts');
      ok('submitting a ticket clears the flag on the CONVERSATION',
         /if \(conversation\.form_active\) delete conversation\.form_active;/.test(ticket));
      ok('not on the per-request ResolvedSession, which is rebuilt every time',
         !/session\.form_active/.test(ticket));

      const auth = readSrc('src/server/services/ticket/session-auth.service.ts');
      ok('ResolvedSession carries no form_active field to mislead anyone',
         !/form_active/.test(auth));

      const chatStage = readSrc('src/server/services/chat/stage.session.ts');
      ok('and chatting again clears it too, before the expiry check',
         /delete session\.form_active;/.test(chatStage) &&
         chatStage.indexOf('delete session.form_active;') <
         chatStage.indexOf('expireIfIdle(sessionId, session)'));

      const cat = readSrc('src/server/services/catalog/catalog.controller.ts');
      ok('a catalog request - i.e. the form loading - marks the session active',
         /markFormActive\(\(req as AuthenticatedRequest\)\.amiSession\.sessionId\)/.test(cat));
      ok('every catalog route is behind it',
         (cat.match(/authWithFormActivity/g) || []).length >= 4);

      const modal = fs.readFileSync(path.join(__dirname, '..', 'public', 'widget', 'modal.js'), 'utf8');
      // Comments stripped: the fix explains the old `catalogCache = {}` line by
      // name, so a raw scan finds the very assignment it is forbidding.
      const modalCode = modal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      ok('the modal clears the catalog cache in place',
         /Object\.keys\(catalogCache\)\.forEach\(function \(key\) \{ delete catalogCache\[key\]; \}\)/.test(modalCode));
      ok('a `const` is never reassigned - that threw on EVERY form close',
         !/catalogCache\s*=\s*\{\}/.test(modalCode.replace('const catalogCache = {};', '')));
    }
  }

  console.log('\n[13] Session opening lines: greeting and farewell');
  {
    // The widget boots from /api/history and never calls /api/session, so these
    // two strings are the only thing the user sees when they open the widget.
    const { greetingFor } = require('../dist/server/features/agent/greeting');
    const { farewellFor } = require('../dist/server/services/session-lifecycle.service');

    const morning = new Date('2026-10-03T02:00:00Z');   // 10:00 in Manila
    const afternoon = new Date('2026-10-03T06:00:00Z'); // 14:00 in Manila
    const evening = new Date('2026-10-03T12:00:00Z');   // 20:00 in Manila
    ok('morning greeting', /Good morning/.test(greetingFor('Rems Baks', 'Asia/Manila', morning)),
      greetingFor('Rems Baks', 'Asia/Manila', morning));
    ok('afternoon greeting', /Good afternoon/.test(greetingFor('Rems Baks', 'Asia/Manila', afternoon)),
      greetingFor('Rems Baks', 'Asia/Manila', afternoon));
    ok('evening greeting', /Good evening/.test(greetingFor('Rems Baks', 'Asia/Manila', evening)),
      greetingFor('Rems Baks', 'Asia/Manila', evening));

    // The whole point of the timezone: the server's clock is UTC, so without
    // this a 10am Manila greeting says "evening".
    ok('greeting uses the configured zone, not UTC',
      !/Good evening/.test(greetingFor('Rems Baks', 'Asia/Manila', morning)));
    ok('first name only', greetingFor('Rems Baks', 'Asia/Manila', afternoon).startsWith('Good afternoon, Rems!'));
    ok('blank name still greets', /there/.test(greetingFor('', 'Asia/Manila', afternoon)));
    // A bad TIMEZONE must not stop someone being greeted at all.
    ok('invalid timezone degrades gracefully',
      greetingFor('Rems Baks', 'Not/AZone', afternoon).length > 20);

    // The farewell must say what happened AND that nothing was filed, because
    // the user may have been halfway through a ticket when it timed out.
    const bye = farewellFor(11 * 60 * 1000);
    ok('farewell names the gap', /11 minutes/.test(bye), bye);
    ok('farewell says the chat is closed', /closed that conversation/i.test(bye));
    ok('farewell says nothing was filed', /not been sent to MIS/i.test(bye));
    ok('singular minute', / 1 minute[^s]/.test(farewellFor(60 * 1000)), farewellFor(60 * 1000));
    ok('a very short gap still reads sensibly', /minute/.test(farewellFor(5000)));
  }

  console.log('\n[14] Messages survive the replay window (data loss)');
  {
    // The trim used to live inline in stage.escalate and left `persistedCount`
    // pointing past the end of the trimmed array. saveConversation writes
    // `messages.slice(persistedCount)`, so from the twentieth turn onward that
    // slice was EMPTY: every message after that existed in the widget and was
    // gone on reload, silently, with no error and no log line.
    const { config } = require('../dist/server/config/config.service');
    const cap = config.conversation.maxHistory * 2;
    const sid = 'trim-cursor-test';
    const conv = conversationManager.getConversation(sid);
    // 25 turns = 50 messages, so the window (40) is crossed twice over.
    for (let turn = 0; turn < 25; turn++) {
      conv.messages.push({ role: 'user', content: 'q' + turn });
      conv.messages.push({ role: 'assistant', content: 'a' + turn });
      conversationManager.trimInMemory(sid);
    }
    const bag = conv;
    ok('the in-memory window is capped', bag.messages.length === cap,
      'length=' + bag.messages.length + ' cap=' + cap);
    // The invariant that was broken: the cursor can never exceed the array, or
    // the slice it drives is empty and nothing is ever written again.
    ok('the cursor never outruns the array (this is what broke persistence)',
      bag.persistedCount <= bag.messages.length,
      'cursor=' + bag.persistedCount + ' length=' + bag.messages.length);
    ok('the newest turn is still inside the window',
      bag.messages.some(m => m.content === 'a24'));
    // Already at the cap, so this is a no-op and must report nothing dropped.
    ok('trimming at the cap drops nothing',
      conversationManager.trimInMemory(sid) === 0);
    // Asking for a smaller window DOES drop, and reports the count so the caller
    // can log it. This is where the cursor has to move with it.
    const keptBefore = bag.messages.length;
    const dropped = conversationManager.trimInMemory(sid, 10);
    ok('a tighter window drops the excess and reports it',
      dropped === keptBefore - 10 && bag.messages.length === 10,
      'dropped=' + dropped + ' length=' + bag.messages.length);
    ok('and the cursor moved with the array',
      bag.persistedCount <= bag.messages.length,
      'cursor=' + bag.persistedCount + ' length=' + bag.messages.length);
    // Put it back to the real cap for the persistence check below.
    for (let turn = 25; turn < 40; turn++) {
      bag.messages.push({ role: 'user', content: 'q' + turn });
      bag.messages.push({ role: 'assistant', content: 'a' + turn });
      conversationManager.trimInMemory(sid);
    }

    // And the real thing: after all that, a save must still write the tail.
    await conversationManager.saveConversation(sid);
    const page = await conversationManager.pageMessages(sid, { limit: 100 });
    ok('the last turn was actually persisted',
      page.messages.some(m => m.content === 'a24'),
      'rows=' + page.messages.length);
    ok('and the tail is not empty',
      page.messages.length > 0, 'rows=' + page.messages.length);
  }

  console.log('\n[15] Runtime-only flags never reach storage');
  {
    // `form_active` used to ride in the persisted state blob. A clean redeploy
    // (the SIGTERM flush saves every conversation) wrote it to disk, restore()
    // read it back, and the idle sweep - which skips flagged sessions - could
    // then never expire that session again. Stayed active, held its transcript
    // in memory, showed as permanently active on /api/health.
    const sid = 'runtime-flags-test';
    const conv = conversationManager.getConversation(sid);
    conv.form_active = true;
    conv.touched = true;
    await conversationManager.saveConversation(sid);

    const row = await dbBackend().getConversationState(sid);
    const state = (row && row.state) || {};
    ok('form_active is NOT persisted', state.form_active === undefined,
      JSON.stringify(state.form_active));
    ok('nor is the touched flag', state.touched === undefined,
      JSON.stringify(state.touched));
    ok('but ordinary state still is',
      state.user_name !== undefined || state.greeted !== undefined ||
      Object.keys(state).length > 0);

    // A stale row written by an older build must not resurrect the flag.
    conversationManager.markFormActive(sid);
    ok('the live flag is set for the sweep', conv.form_active === true);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'session.service.ts'), 'utf8');
    ok('and restore() strips it even if a row still has it',
      /delete saved\.form_active;/.test(src));
    ok('along with the cursor and the touched flag',
      /delete saved\.persistedCount;/.test(src) && /delete saved\.touched;/.test(src));
  }

  console.log('\n[16] A live clock is not rewound by restore (idle expiry)');
  {
    // restore() copied the stored `last_seen` over the top unconditionally,
    // rewinding a LIVE clock to the pre-restart timestamp. Come back after a
    // 6-minute deploy with a 5-minute timeout and the sweep expired a session
    // someone was actively using, wiping `collected_fields` mid-intake.
    //
    // The guard has to be one-sided: a pure history read also creates the
    // conversation, and it must NOT keep a stale session alive - without the
    // stored value winning there, an old session reloaded by the user would look
    // brand new and never expire.
    // Called on the MANAGER, not destructured: getConversation is a method that
    // uses `this`, and pulling it off the object loses the receiver.
    const store = conversationManager.conversations;

    const fresh = 'restore-untouched';
    store.delete(fresh);
    const peeked = conversationManager.getConversation(fresh, { peek: true });
    ok('a peeked conversation is NOT marked touched',
      peeked.touched === undefined, String(peeked.touched));

    const used = 'restore-touched';
    store.delete(used);
    const real = conversationManager.getConversation(used);
    ok('a real (non-peek) use IS marked touched', real.touched === true);
    const clockAtUse = real.last_seen;
    ok('and its clock is current', Date.now() - clockAtUse < 2000);

    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'services', 'session.service.ts'), 'utf8');
    ok('restore only applies the stored clock when nothing touched it',
      /if \(!bag\.touched && saved\.last_seen !== undefined\)/.test(src));
    ok('and it is dropped from the copy either way',
      /delete saved\.last_seen;/.test(src));
    ok('the sweep still skips a conversation with the form open',
      /bag\.form_active\) continue;/.test(
        fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'server.ts'), 'utf8')));
  }

  console.log('\n[17] The user turn is stored before the model is called');
  {
    // A provider timeout returned from callModel and ended the pipeline before the
    // last stage pushed the message, so the user was shown "Sorry, I had trouble
    // reaching the AI service" and their question was never stored. Reload, and
    // it had vanished. Given how often the provider times out, that ate turns.
    const readSrc = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const sess = readSrc('src/server/services/chat/stage.session.ts');
    const esc = readSrc('src/server/services/chat/stage.escalate.ts');
    const reply = readSrc('src/server/services/chat/stage.reply.ts');

    ok('startSession pushes the user message',
      /session\.messages\.push\(\{[\s\S]{0,120}role: 'user'/.test(sess));
    ok('and saves it immediately, before the model runs',
      /role: 'user'[\s\S]{0,400}await conversationManager\.saveConversation\(sessionId\)/.test(sess));
    ok('it flags the context so the model does not see it twice',
      /ctx\.userTurnPushed = true;/.test(sess));
    ok('buildContext drops the duplicate from the replay window',
      /ctx\.userTurnPushed[\s\S]{0,120}slice\(0, -1\)/.test(reply));
    ok('and still appends the message explicitly at the end',
      /\{ role: 'user', content: message \}/.test(reply));
    ok('decideAndStore no longer pushes it unconditionally',
      /if \(!ctx\.userTurnPushed && rawMessage\)/.test(esc));
  }

  console.log('\n[19] Rate limiting keys on the person, behind a proxy');
  {
    // Behind Apache every request appears to come from the proxy's own address,
    // and express-rate-limit keys on req.ip by default. The entire company then
    // shared ONE bucket: 30 messages a minute between everyone, and a 429 for
    // people who had sent nothing. Invisible in a single-user test.
    const readSrc = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
    const appSrc = readSrc('src/server/app.ts');
    const cfgSrc = readSrc('src/server/config/config.service.ts');

    ok('trust proxy is configured', /app\.set\('trust proxy', config\.security\.trustProxyHops\)/.test(appSrc));
    ok('and it is set BEFORE the limiter, which reads req.ip',
      appSrc.indexOf("app.set('trust proxy'") < appSrc.indexOf('chatLimiter'));
    ok('as a HOP COUNT, never `true` - that would let anyone spoof X-Forwarded-For',
      /trustProxyHops/.test(cfgSrc) &&
      !/app\.set\('trust proxy',\s*true\)/.test(appSrc));
    ok('defaulted to 1 for the Apache in front of it', /TRUST_PROXY_HOPS \?\? '1'/.test(cfgSrc));
    ok('a junk value falls back to 1 rather than trusting everything',
      /n >= 0 \? n : 1/.test(cfgSrc));

    ok('the limiter prefers a signed login over an address',
      /function rateLimitKey[\s\S]{0,400}login_user/.test(appSrc));
    ok('so two people behind one NAT do not share a bucket',
      /return `login:\$\{login\}`/.test(appSrc));
    ok('with the IP only as a fallback',
      /return `ip:\$\{req\.ip/.test(appSrc));

    // The read endpoints are unauthenticated and CREATE a conversation for any id,
    // so they need a ceiling too - generous, because one page load makes several
    // history calls (initial plus older pages).
    ok('the widget read endpoints are limited as well',
      /app\.use\('\/api\/history', widgetReadLimiter\)/.test(appSrc) &&
      /app\.use\('\/api\/session', widgetReadLimiter\)/.test(appSrc));
    ok('with a headroom limit, not the chat budget',
      /widgetReadLimiter[\s\S]{0,200}max: 120/.test(appSrc));
    ok('and the limits come from config, not literals',
      /max: config\.rateLimit\.perMinute/.test(appSrc) &&
      /windowMs: config\.rateLimit\.windowMs/.test(appSrc));
  }

  console.log('\n[20] A guessed id cannot grow the memory cache');
  {
    // /api/history/:id is unauthenticated, so a loop over random ids used to grow
    // the in-memory map without bound: nothing ever removed an entry.
    //
    // Refusing to adopt unknown ids was tried and REVERTED, and this section
    // records why, because the reasoning looks sound and is not. A brand-new
    // session is an id storage has never seen, and the greeting claim has to be
    // made synchronously on the live object - two concurrent history loads in the
    // same tick would otherwise both see "not greeted" and both greet. Skip the
    // object and there is nothing to claim: three concurrent loads greeted three
    // times. Memory is therefore bounded by `evictIdle` (section 21) and by the
    // read limiter, not by refusing a legitimate first load.
    const hist = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'controllers', 'history.controller.ts'), 'utf8');
    ok('history still adopts the conversation, including a brand-new one',
      /const live = conversationManager\.getConversation\(sessionId, \{ peek: true \}\);/.test(hist));
    ok('the refusal is documented so it is not "simplified" back in',
      /Always adopt the conversation, INCLUDING for an id storage has never seen/.test(hist));
    ok('and it explains the greeting-claim reason',
      /synchronously on this object/.test(hist));
    // Whatever else it touches, nothing may assume `live` is non-null now that the
    // type allows null elsewhere in the file.
    ok('the response tolerates a null conversation throughout',
      /live\?\.last_seen/.test(hist) &&
      /\| null\)\?\.pending_goodbye/.test(hist) &&
      /\{ last_control_number\?: string \} \| null\)\?\.last_control_number/.test(hist));

    ok('the manager can answer "is it cached" without creating one',
      typeof conversationManager.has === 'function');
    const before = conversationManager.conversations.size;
    ok('and it does not add an entry for an unknown id',
      conversationManager.has('definitely-not-a-session') === false &&
      conversationManager.conversations.size === before);
  }

  console.log('\n[21] Finished conversations leave memory');
  {
    // Nothing removed an entry except $reset, so a long-running container
    // accumulated every session it had ever seen and the sweep - which walks the
    // whole map each tick - got slower with lifetime traffic, not live load.
    ok('there is an eviction pass', typeof conversationManager.evictIdle === 'function');
    const keep = 5 * 60 * 1000;
    const old = 'evict-old-' + Date.now();
    const fresh = 'evict-fresh-' + Date.now();
    const open = 'evict-form-' + Date.now();

    const a = conversationManager.getConversation(old);
    a.lastActivity = Date.now() - (keep * 4);
    a.messages = [{ role: 'user', content: 'hi' }];
    const b = conversationManager.getConversation(fresh);
    b.lastActivity = Date.now();
    b.messages = [{ role: 'user', content: 'hi' }];
    const c = conversationManager.getConversation(open);
    c.lastActivity = Date.now() - (keep * 4);
    c.messages = [{ role: 'user', content: 'hi' }];
    c.form_active = true;             // the ticket form is open right now

    const dropped = conversationManager.evictIdle(keep);
    ok('a long-finished conversation is dropped', dropped === 1, 'dropped=' + dropped);
    ok('a session in use is kept', conversationManager.has(fresh));
    ok('and one with the form open is kept, whatever its age',
        conversationManager.has(open));

    // A queued write must never be dropped: that is the last turns of the
    // conversation going missing.
    const writing = 'evict-writing-' + Date.now();
    const w = conversationManager.getConversation(writing);
    w.lastActivity = Date.now() - (keep * 4);
    w.messages = [{ role: 'user', content: 'hi' }];
    const pending = conversationManager.saveConversation(writing);
    conversationManager.evictIdle(keep);
    ok('a conversation with a write still queued is NOT dropped',
        conversationManager.has(writing));
    await pending;

    const sweep = fs.readFileSync(path.join(__dirname, '..', 'src', 'server', 'server.ts'), 'utf8');
    ok('the sweep runs it', /conversationManager\.evictIdle\(\)/.test(sweep));
    ok('after the expiry pass, so it judges post-expiry state',
      sweep.indexOf('evictIdle()') > sweep.indexOf('expireIfIdle'));
  }

  console.log('\n[18] The suite is actually talking to the real storage module');
  {
    // Not a test of the app so much as of this file. It required
    // `../dist/server/db`, which Node resolves to a STALE index.js from an older
    // layout that nothing imports any more. That file holds its own private
    // `backend`, so init() initialised it while the app kept using
    // storage.service - and every restore and save in this suite failed
    // "db.init() has not completed yet". Each failure was swallowed by its own
    // try/catch, so the suite reported green while never persisting a single
    // message. A green suite that cannot see the database is worse than a red one.
    ok('the storage module this suite inits is the one the app uses',
      require('../dist/server/db/storage.service') === dbStorageRef);
    ok('and it is initialised', dbStorageRef.kind() !== 'uninitialised', dbStorageRef.kind());
    // The stale duplicate is still on disk and will be resolved by the directory
    // again if anyone imports `../dist/server/db`.
    const stale = path.join(__dirname, '..', 'dist', 'server', 'db', 'index.js');
    ok('no stale duplicate shadows the real module', !fs.existsSync(stale),
      'delete ' + stale);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();