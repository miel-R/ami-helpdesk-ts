/* Regression checks for the AI-driven ticket handover and the greeting fix.
 *
 * Three real bugs motivated this file:
 *
 *   1. The greeting rendered three times on open. Two causes: the server saved
 *      the "greeted" flag without awaiting the write, and its own shouldGreet
 *      test ignored the live conversation, so concurrent history loads each
 *      decided they were first. The widget also had its own copy of the greeting
 *      that fired on every empty history load.
 *   2. The chat header had a "Create Ticket" button. Ticket capture is now
 *      driven by the assistant, so there must be no button to click.
 *   3. The modal called AmiConfig.getApiUrl / AmiConfig.getUserName and
 *      AmiApi.addSystemMessage. None of those exist, so the form could not load a
 *      single dropdown or record a submission.
 *
 * Runs against a SCRATCH data directory, no database, no AI key and no webhook,
 * so it cannot touch production, spend tokens, or file a real ticket.

   Run:  node tools/modal-regress.cjs                              */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
// Imported from the modules that own them. These used to come out of a single
// `utils` barrel, which held eight unrelated concerns at once.
const escalation = require('../dist/server/features/agent/escalation');
const greeting = require('../dist/server/features/agent/greeting');
const utils = {
  ...escalation,
  greetingFor: greeting.greetingFor,
  greetingPeriod: greeting.greetingPeriod
};
// Required for the exported filename sanitiser, exercised in section 11c. Safe
// to import: the module only builds routes when called, and db() is not touched
// at load time.
// The upload middleware is wired in app.ts now; the name sanitiser lives with the
// staging code it belongs to.
const ticketModule = require('../dist/server/services/ticket/staging.service');

const PORT = process.env.MODAL_E2E_PORT || '3997';
const BASE = `http://127.0.0.1:${PORT}`;
const LOGIN = 'modal.test.user';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'ami-modal-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const section = (n) => console.log('\n[' + n + ']');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

/**
 * Runs buildCheckboxGroup() out of modal.js against a tiny fake DOM.
 *
 * Needed because the failure it guards against is invisible to a source scan:
 * `boxes.push({box, row, group, label})` recorded no `value`, so a ticked box
 * serialised to null while every string in the file looked correct. Driving the
 * real function and reading back fieldValues is the only check that catches it.
 */
async function exerciseCheckboxGroup(modalSrc, options) {
  const start = modalSrc.indexOf('function buildCheckboxGroup(');
  if (start === -1) throw new Error('buildCheckboxGroup not found');
  // Take the function plus the two helpers it calls, which sit inside the same
  // IIFE scope.
  // The normaliser lives outside buildCheckboxGroup but in the same IIFE scope, so
  // it has to be extracted and supplied alongside the loader stub.
  const normalise = modalSrc.slice(
    modalSrc.indexOf('function normaliseOption('),
    modalSrc.indexOf('/** Add one normalised option to a <select>. */')
  );
  // The real loader normalises every catalog entry through normaliseOption
  // before handing it to a renderer, so the stub has to do the same or opt.value
  // would be undefined for reasons that have nothing to do with the code under
  // test.
  const loadCatalog = 'function loadCatalogOptions(u){return Promise.resolve(' +
    JSON.stringify(options) + '.map(normaliseOption).filter(Boolean));}';
  const validateForm = () => {};
  const body = modalSrc.slice(start, modalSrc.indexOf('\n  function ', start + 10));

  // The extracted function writes fieldValues['system']; a plain object captures
  // that directly, and values() reads it back the way handleSubmit would.
  const holder = {};
  const fn = new Function(
    'document', 'fieldValues', 'loadCatalogOptions', 'validateForm',
    normalise + '\n' + loadCatalog + '\n' + body +
    '\nreturn buildCheckboxGroup;'
  )(fakeDocument(), holder, (u) => Promise.resolve(options.map(x => x)), validateForm);

  const root = fn({ id: 'system', type: 'checkboxgroup', grouped: true, filter: true });
  // The options load in a promise, so nothing is rendered until it settles.
  await new Promise(r => setTimeout(r, 0));
  return { root, boxes: () => holder.system };
}

/**
 * Render a static `options:` list through the real appendOption().
 *
 * Inspecting the source cannot catch this class of bug: the definition looked
 * plausible and every string was spelled correctly. What was wrong was the SHAPE
 * - a bare string where the renderer expected {value,label} - and only executing
 * the renderer reveals that the option ends up with value "undefined" and an
 * empty label.
 */
function exerciseStaticSelect(modalSrc, fieldDef) {
  const start = modalSrc.indexOf('function appendOption(');
  if (start === -1) throw new Error('appendOption not found');
  // Close on the function's OWN indent level. This file is CRLF, so searching for
  // a bare '\n}' skips every 2-space `  }` and lands on the end of the enclosing
  // IIFE - which then drags `return { open, close };` into the snippet and fails
  // to parse.
  const body = modalSrc.slice(start, modalSrc.indexOf('\n  }', start) + 4);
  const fn = new Function('document', body + '\nreturn appendOption;')(fakeDocument());

  const select = fakeDocument().createElement('select');
  fieldDef.options.forEach(o => fn(select, o));
  // What the form reads back on submit: `fieldValues[id] = input.value`.
  return {
    options: select.children,
    values: select.children.map(o => o.value),
    labels: select.children.map(o => o.textContent)
  };
}

/** The slice of the DOM buildCheckboxGroup actually touches. */
function fakeDocument() {  const node = (tag = 'DIV') => {
    const n = {
      tagName: String(tag).toUpperCase(), children: [], style: {}, dataset: {}, attrs: {},
      listeners: {}, value: '', checked: false, disabled: false, _text: '',
      className: '',
      classList: {
        _s: new Set(),
        add(...c) { c.forEach(x => this._s.add(x)); },
        remove(...c) { c.forEach(x => this._s.delete(x)); },
        toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); }
      },
      appendChild(c) { this.children.push(c); return c; },
      insertBefore(c) { this.children.unshift(c); return c; },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      // box.type = 'checkbox' must be visible to the test the same way it is to
      // the browser, so it reads back off attrs like a real input element.
      get type() { return this.attrs.type || ''; },
      set type(v) { this.attrs.type = String(v); },
      addEventListener(e, f) { (this.listeners[e] = this.listeners[e] || []).push(f); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      get textContent() { return this._text; },
      set textContent(v) { this._text = String(v); }
    };
    Object.defineProperty(n, 'className', {
      get() { return [...n.classList._s].join(' '); },
      set(v) { n.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)); }
    });
    return n;
  };
  return {
    createElement: (tag) => node(tag),
    querySelector: () => null,
    querySelectorAll: () => []
  };
}

(async () => {
  console.log(`identity : ${LOGIN}`);
  console.log(`scratch  : ${SCRATCH}`);
  console.log('isolated : no database, no AI provider key, no webhook\n');

  section('1. The escalation marker is a pure contract');
  const M = utils.ESCALATION_MARKER;
  ok('marker is stripped from the text', (() => {
    const r = utils.extractEscalation('Let me pass you to MIS.\n' + M);
    return r.text === 'Let me pass you to MIS.' && r.escalate === true;
  })());
  ok('marker mid-reply is stripped too', (() => {
    const r = utils.extractEscalation(M + ' here you go ' + M);
    return r.escalate === true && r.text.indexOf(M) === -1 && r.text === 'here you go';
  })());
  ok('repeated markers produce one handover', (() => {
    const r = utils.extractEscalation('ok ' + M + ' and again ' + M);
    return r.escalate === true && r.text === 'ok  and again';
  })());
  ok('a bare marker is noise, not a handover', utils.extractEscalation(M).escalate === false);
  ok('whitespace around a bare marker is still noise', utils.extractEscalation('  \n ' + M + ' \n ').escalate === false);
  ok('an ordinary reply does not escalate', (() => {
    const r = utils.extractEscalation('Try restarting the router.');
    return r.escalate === false && r.text === 'Try restarting the router.';
  })());
  ok('an empty reply does not escalate', utils.extractEscalation('').escalate === false);
  ok('the marker never appears in the stripped text', (() => {
    const r = utils.extractEscalation('done ' + M);
    return r.text.indexOf(M) === -1;
  })());

  section('2. shouldGreet needs empty thread AND no prior greeting');
  ok('new session greets', utils.shouldGreet({ messageCount: 0 }) === true);
  ok('a thread with messages does not greet', utils.shouldGreet({ messageCount: 3 }) === false);
  ok('stored flag suppresses the greeting', utils.shouldGreet({ messageCount: 0, storedGreeted: true }) === false);
  ok('live flag suppresses the greeting', utils.shouldGreet({ messageCount: 0, liveGreeted: true }) === false);
  ok('either flag alone is enough', utils.shouldGreet({ messageCount: 0, liveGreeted: true, storedGreeted: true }) === false);

  section('2b. Only an admin can order the form open');
  const R = utils.resolveEscalation;
  ok('an admin who asks for a ticket gets it at once',
     R({ isAdmin: true, askedForTicket: true, aiEscalates: false, userDescribedProblem: false }).open === true);
  ok('an admin is not made to describe the problem first',
     R({ isAdmin: true, askedForTicket: true, aiEscalates: false, userDescribedProblem: false }).forceAssessment === false);
  ok('an admin asking with nothing described still opens',
     R({ isAdmin: true, askedForTicket: true, aiEscalates: false, userDescribedProblem: false }).open === true);
  ok('an admin is handed over when Ami asks too',
     R({ isAdmin: true, askedForTicket: false, aiEscalates: true, userDescribedProblem: true }).open === true);

  ok('a normal user asking for a ticket does NOT get it',
     R({ isAdmin: false, askedForTicket: true, aiEscalates: false, userDescribedProblem: true }).open === false);
  ok('a normal user asking is pushed to describe the problem',
     R({ isAdmin: false, askedForTicket: true, aiEscalates: false, userDescribedProblem: false }).forceAssessment === true);
  ok('asking cannot become a shortcut past diagnosis',
     R({ isAdmin: false, askedForTicket: true, aiEscalates: false, userDescribedProblem: true }).open === false);

  ok('Ami CAN hand over once a normal user described a problem',
     R({ isAdmin: false, askedForTicket: false, aiEscalates: true, userDescribedProblem: true }).open === true);
  ok('Ami CANNOT hand over about a problem nobody described',
     R({ isAdmin: false, askedForTicket: false, aiEscalates: true, userDescribedProblem: false }).open === false);
  ok('an ordinary turn hands over nothing',
     R({ isAdmin: false, askedForTicket: false, aiEscalates: false, userDescribedProblem: true }).open === false);
  ok('a normal user never gets both flags at once',
     R({ isAdmin: false, askedForTicket: true, aiEscalates: true, userDescribedProblem: true }).open === false &&
     R({ isAdmin: false, askedForTicket: true, aiEscalates: true, userDescribedProblem: true }).forceAssessment === true);

  section('2c. "Create a ticket" is not a description of a problem');
  const P = utils.hasDescribedProblem;
  ok('a bare demand is not a description', P(['create a ticket']) === false);
  ok('a polite demand is not a description',
     P(['please create a ticket now']) === false);
  ok('a demand with a ticket noun is not a description',
     P(['can you raise me a job ticket please']) === false);
  ok('greetings are not descriptions', P(['hi', 'hello there']) === false);
  ok('thanks and acknowledgements are not descriptions',
     P(['thanks', 'ok', 'noted']) === false);
  ok('an admin command is not a description', P(['$list']) === false);
  ok('a one-word answer is not a description', P(['broken']) === false);
  ok('a real symptom is a description',
     P(['my laptop will not connect to the wifi in the office']) === true);
  ok('a description earlier in the thread counts',
     P(['create a ticket', 'the printer on floor 2 jams every time we print']) === true);
  ok('an empty thread has described nothing', P([]) === false);
  ok('undefined entries do not crash it', P([undefined, null, '']) === false);

  section('2d. The form opens already filled from the conversation');
  const F = utils.buildTicketPrefill;
  const told = ['create a ticket', 'my laptop will not connect to the wifi in the office'];
  ok('the description comes from what they actually said',
     F(told).description.indexOf('wifi in the office') !== -1);
  ok('a demand is not carried into the description',
     F(told).description.toLowerCase().indexOf('create a ticket') === -1);
  ok('justification is left for the user to judge',
     F(told).justification === '');
  ok('several described turns are joined together',
     F(['the printer jams', 'it happens on every print job']).description.length >
     F(['the printer jams']).description.length);
  ok('nothing described means nothing prefilled',
     F(['create a ticket', 'thanks']).description === '');
  ok('a long story is truncated rather than dropped',
     F(['x '.repeat(2000)]).description.length <= 1000);
  ok('truncation is visible to the reader',
     F(['x '.repeat(2000)]).description.slice(-3) === '...');

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'dist', 'server', 'server.js')], {
    env: {
      ...process.env,
      PORT,
      DATABASE_URL: '',
      GEMINI_API_KEY: '',
      OPENAI_API_KEY: '',
      CONVERSATIONS_DIR: path.join(SCRATCH, 'conversations'),
      DATA_DIR: path.join(SCRATCH, 'data'),
      ATTACHMENTS_DIR: path.join(SCRATCH, 'attachments'),
      UPLOADS_DIR: path.join(SCRATCH, 'uploads'),
      N8N_WEBHOOK_URL: '',
      // config.ts loads .env, so without these the suite silently connects to
      // the live MIS directory. That made catalog behaviour depend on production
      // data: the suite broke whenever MIS was unreachable or a category was
      // renamed, and validation silently loosened instead of tightening.
      MIS_DB_HOST: '',
      MIS_DB_PORT: '',
      MIS_DB_USER: '',
      MIS_DB_PASSWORD: '',
      MIS_DB_NAME: '',
      ADMIN_USERS: LOGIN
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  server.stderr.on('data', d => { stderr += d.toString(); });

  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await sleep(400);
    try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { /* not yet */ }
  }
  if (!up) {
    console.log('  FAIL  server did not start\n' + stderr.slice(0, 800));
    server.kill();
    process.exit(1);
  }

  try {
    const modal = read('public/widget/modal.js');
// Read once here: several sections below assert against the same two files, and
// re-reading per section risks the assertions drifting apart.
// The ticket controller owns the route; the rules it enforces moved next to it.
// The upload middleware is wired in app.ts now, so the staging assertions
// about it read the wiring rather than the controller.
const appWiringSrc = read('src/server/app.ts');
const ticketRoute = read('src/server/services/ticket/ticket.controller.ts')
  + read('src/server/services/ticket/validation.service.ts')
  + read('src/server/services/ticket/staging.service.ts');
const hook = read('src/server/services/ticket/webhook.service.ts');
// The catalogue was split by table over a shared client; assertions about the
  // queries live with the queries.
  const catalog = read('src/server/services/catalog/system-request.service.ts') + read('src/server/services/catalog/support.service.ts') + read('src/server/services/catalog/directory.service.ts');
const widgetMain = read('public/widget/main.js');
    const history = (session, limit = 50) =>
      fetch(`${BASE}/api/history/${encodeURIComponent(session)}?limit=${limit}`).then(r => r.json());

    section('3. One greeting per session, even under concurrent loads');
    const concurrent = await Promise.all([history(LOGIN), history(LOGIN), history(LOGIN)]);
    const greeted = concurrent.filter(d => typeof d.greeting === 'string' && d.greeting.length);
    ok('three concurrent loads yield exactly one greeting', greeted.length === 1,
       'got ' + greeted.length);
    ok('the greeting carries no marker text', greeted.length === 1 &&
       greeted[0].greeting.indexOf(M) === -1);

    const later = await history(LOGIN);
    ok('a later reload sends no greeting', later.greeting === null, JSON.stringify(later.greeting));

    ok('the greeted flag is on disk, not just in memory', (() => {
      const f = path.join(SCRATCH, 'conversations', LOGIN + '.json');
      if (!fs.existsSync(f)) return false;
      return JSON.parse(fs.readFileSync(f, 'utf8')).greeted === true;
    })());
    ok('no .tmp files were left behind', (() => {
      const dir = path.join(SCRATCH, 'conversations');
      return !fs.existsSync(dir) || fs.readdirSync(dir).every(n => !n.endsWith('.tmp'));
    })());

    section('4. History page size is 50, as agreed');
    // Seeded straight into the conversation file rather than driven through
    // /api/chat: with no AI key the chat endpoint answers locally without
    // storing a message, and 60 turns would also blow the 30/min chat limit.
    const big = 'paging.test.user';
    const seeded = {
      mode: 'chat',
      status: 'active',
      user: { user_name: big },
      messages: Array.from({ length: 60 }, (_, i) => ({
        id: i + 1,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'message ' + (i + 1),
        created_at: new Date(1700000000000 + i * 1000).toISOString()
      }))
    };
    fs.mkdirSync(path.join(SCRATCH, 'conversations'), { recursive: true });
    fs.writeFileSync(
      path.join(SCRATCH, 'conversations', big + '.json'),
      JSON.stringify(seeded, null, 2)
    );

    // The widget opens on 10 messages, not the whole thread. The endpoint has
    // always paged; these assertions ask for the page the widget actually uses,
    // so a test that passes no longer says anything about the widget if someone
    // changes the size back.
      // `limit=` also appears inside the explanatory comment above each call, so
      // take the value from the fetch line itself rather than every mention.
      //
      // The older page is assigned to a `url` variable before fetching, so that
      // line can be logged; both call sites are therefore matched by the path and
      // the limit rather than by `fetch(` being on the same line.
      const widgetSize = read('public/widget/main.js')
        .split('\n')
        .filter(l => l.includes('api/history') && l.includes('limit='))
        .flatMap(l => [...l.matchAll(/limit=(\d+)/g)].map(m => Number(m[1])));
      ok('the widget asks for 10 on the initial load and 10 per older page',
         widgetSize.length === 2 && widgetSize.every(n => n === 10),
         JSON.stringify(widgetSize));

    const firstPage = await history(big, 10);
    ok('a fresh page holds 10 messages', firstPage.messages.length === 10,
       'got ' + firstPage.messages.length);
    ok('the page reports there is more', firstPage.has_more === true);
    ok('the newest message is first (DESC by id)', firstPage.messages[0].content === 'message 60',
       firstPage.messages[0].content);
    ok('the cursor points at the oldest message on this page',
       firstPage.messages[9].content === 'message 51', firstPage.messages[9].content);

    // Walk to the end the way the scroll handler does, and confirm nothing is
    // lost or repeated on the way. This is the path that was dead while the
    // widget asked for 50.
    let cursor = firstPage.next_before;
    let seen = firstPage.messages.map(m => m.content);
    let pages = 1;
    let second = null;
    while (cursor && pages < 20) {
      const p = await fetch(
        `${BASE}/api/history/${encodeURIComponent(big)}?limit=10&before=${encodeURIComponent(cursor)}`
      ).then(r => r.json());
      if (!p.messages.length) break;
      if (!second) second = p;
      seen = seen.concat(p.messages.map(m => m.content));
      cursor = p.next_before;
      pages++;
    }
    ok('paging reaches the very first message', seen.length === 60, 'got ' + seen.length);
    ok('paging repeats nothing',
       new Set(seen).size === seen.length, seen.length + ' messages, ' + new Set(seen).size + ' unique');
    ok('paging walks backwards from newest to oldest',
       seen[0] === 'message 60' && seen[seen.length - 1] === 'message 1',
       seen[0] + ' ... ' + seen[seen.length - 1]);

    // The control number has to survive a reload. The confirmation bubble used to
    // be added only at submission time with no `quiet`, so it was never persisted
    // and simply did not exist after a refresh - the server had kept
    // `last_control_number` the whole time and the widget never read it.
    ok('the server returns the control number on a history load',
       'last_control_number' in firstPage, JSON.stringify(firstPage.last_control_number));
    // The confirmation is a persisted assistant turn now, not a bubble the widget
    // draws when the POST returns. Before that it existed only in the DOM: reload
    // and the handover reply survived while the ticket confirmation under it did
    // not. Which meant history replay and the fallback both printing it.
    const ctrlForNotice = read('src/server/services/ticket/ticket.controller.ts');
    ok('the server writes the confirmation onto the conversation',
       /conversation\.messages\.push\(\{[\s\S]{0,220}Ticket submitted/.test(ctrlForNotice));
    // Ordering by position, against the AWAITED save specifically. Comparing
    // against the first `saveConversation` in the file hits the import statement,
    // which is always earlier and would make this pass no matter what the body did.
    const pushAt = ctrlForNotice.indexOf('Ticket submitted');
    const saveAt = ctrlForNotice.indexOf('await conversationManager.saveConversation');
    ok('the confirmation is written before it is saved',
       pushAt !== -1 && saveAt !== -1 && pushAt < saveAt,
       `push at ${pushAt}, save at ${saveAt}`);
    ok('and the save is awaited before success is reported',
       saveAt !== -1
       && ctrlForNotice.indexOf('res.json({', saveAt) > saveAt);
    ok('a duplicate submit cannot stack two confirmations',
       /alreadySaid/.test(ctrlForNotice));
    ok('the widget does not re-add a confirmation history already replayed',
       /alreadyReplayed/.test(widgetMain));
    ok('the widget still reads last_control_number as a fallback',
       /d\.last_control_number/.test(widgetMain));
    ok('and re-shows the confirmation from it', /_ticketNoticeShown/.test(widgetMain));
    ok('the confirmation text is shared by both paths, not written twice',
       widgetMain.split('Ticket submitted. Control number:').length - 1 === 1,
       'found ' + (widgetMain.split('Ticket submitted. Control number:').length - 1) + ' copies');
    ok('the restored confirmation does not yank the viewport',
       /notice: true, quiet: true/.test(widgetMain));

    ok('the second page is the ten messages just before the cursor',
       second.messages[0].content === 'message 50' && second.messages[9].content === 'message 41',
       second.messages[0].content + ' ... ' + second.messages[9].content);
    ok('a `before` cursor never overlaps the page that produced it',
       !second.messages.some(m => firstPage.messages.some(f => f.content === m.content)));

    section('5. Ticket endpoints refuse an unauthenticated caller');
    const noSession = await fetch(`${BASE}/api/catalog/departments`);
    ok('catalog without a session is refused', noSession.status === 401,
       'status ' + noSession.status);

    const unknownSession = await fetch(`${BASE}/api/catalog/departments`, {
      headers: { 'X-Session-ID': 'nobody.here' }
    });
    ok('catalog for an unknown session is refused', unknownSession.status === 401,
       'status ' + unknownSession.status);

    const forged = await fetch(`${BASE}/api/ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: LOGIN,
        // A body-supplied identity must not be able to stand in for the session.
        user: { user_name: 'someone.else', role: 'admin' },
        userName: 'someone.else',
        ticket_type: 'tech_support',
        fields: { department: 'MIS', location: 'CK1', category: 'Hardware', system: ['ERP'], description: 'x', justification: 'y' }
      })
    });
    ok('a forged body identity does not authenticate', forged.status === 401,
       'status ' + forged.status);

    section('5b. A ticket MIS accepted is never reported as a failure');
    {
      // Live incident: n8n inserted AIP26100046 at 03:23:30Z and answered
      // `{success:true, message:'Ticket created', ticket_type}` - which carries no
      // control_number - and the app replied 502 "n8n accepted the request but
      // returned no control number". The ticket existed; the user was told it did
      // not, and re-submitting would have filed a duplicate.
      //
      // The rule: only an EXPLICIT failure fails. The control number is minted by
      // MIS on approval (scrf_num is NULL until then), so its absence at
      // submission time says nothing about whether the row was saved.
      const ctrl = read('src/server/services/ticket/ticket.controller.ts');

      // Matched against code only: the phrase survives in a comment explaining the
      // bug, and a test that fails on prose is a test that punishes the fix.
      const ctrlCode = ctrl.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      ok('a missing control number is no longer a rejection reason',
         ctrlCode.indexOf('n8n accepted the request but returned no control number') === -1);
      ok('no rejection branch is conditioned on a control number',
         !/if \(rejectionReason\)[\s\S]{0,400}!controlNumber/.test(ctrlCode));
      ok('rejection is gated on an explicit failure flag',
         /if \(reportedFailure\) \{/.test(ctrl));
      ok('the old fallback ternary that rejected on a missing number is gone',
         !/!controlNumber \? 'n8n accepted/.test(ctrlCode));
      ok('an accepted-but-unnumbered ticket is logged as a warning, not a rejection',
         /ticket_api_no_control_number/.test(ctrl));
      ok('and a real n8n failure is still refused',
         /ticket_api_rejected/.test(ctrl) && /n8n reported the ticket could not be saved/.test(ctrl));
      ok('the response says when the number is still pending',
         /control_number_pending: !controlNumber/.test(ctrl));
      ok('a number already on the session is not cleared by an unnumbered submit',
         /if \(controlNumber\) \{[\s\S]{0,120}last_control_number = controlNumber/.test(ctrl));

      // The widget has to cope with success-with-no-number too, or it shows an
      // error toast for a ticket that was actually filed.
      ok('the widget confirms a submission that has no number yet',
         /'\\u2705 Ticket submitted' \+ \(control \? '\. Control number: '/.test(widgetMain));
      ok('the modal only errors when the response is genuinely not ok',
         /if \(!response\.ok \|\| !result\.ok\)/.test(read('public/widget/modal.js')));
    }

    section('6. The widget no longer offers a ticket button');
    ok('no create-ticket element is rendered', widgetMain.indexOf('id="ami-create-ticket"') === -1);
    ok('no create-ticket listener is bound', widgetMain.indexOf("getElementById('ami-create-ticket')") === -1);
    ok('no local greet() remains', /greet\s*:\s*function/.test(widgetMain) === false);
    ok('no local greeting is synthesised from greeting_period',
       widgetMain.indexOf("'Good ' + period") === -1);
    ok('the widget acts on the server flag', widgetMain.indexOf('data.open_ticket_modal') !== -1);
    ok('the widget opens the modal itself', /openTicketModal:\s*function/.test(widgetMain));
    ok('the widget carries the prefill into the modal',
       /openTicketModal\(data\.ticket_prefill/.test(widgetMain));

    section('6b. The chat route uses the role gate, not the old OR');
    // The escalation decision lives in the last stage of the chat pipeline, not in
  // the controller that sends whatever it returns.
  const serverMain = read('src/server/services/chat/stage.escalate.ts');
  // The prompt moved out of main.ts when the server was split by concern.
  const systemPrompt = read('src/server/features/agent/system-prompt.ts');
  // The no-store rule is app wiring, so it is asserted against app.ts.
  const appWiring = read('src/server/app.ts');
  ok('the no-cache rule matches the whole widget module graph',
       /\/widget\\\/\[\\w-\]\+\\\.\(js\|css\)\$/.test(appWiring));
    ok('modal.js is covered by a pattern, not an omission',
       !/\['\/widget\.js', '\/widget\/main\.js', '\/ami-session\.js'\]/.test(appWiring));
    ok('the MIS-mounted copy is covered too',
       /mis_helpdesk\/ami-helpdesk/.test(appWiring));
    ok('widget.css is no-store as well',
       /p === '\/widget\.css'/.test(appWiring));
    ok('resolveEscalation is called', /resolveEscalation\(\{/.test(serverMain));
    // Matched loosely on purpose. The role reaches this stage as ctx.isAdminUser
       // rather than a bare local, and a source scan should assert the INTENT -
       // the decision reads the resolved role - not one variable's spelling.
       ok('the decision is driven by the server-resolved role',
          /isAdmin:\s*ctx\.isAdminUser/.test(serverMain));
       ok('the old "marker OR asked" shortcut is gone',
          !/openTicketModal\s*=\s*aiWantsEscalation\s*\|\|/.test(serverMain));
       ok('problem detection runs over the whole session',
          /hasDescribedProblem\(userUtterances\)/.test(serverMain));
       ok('the prefill is built from the session and returned',
          /ticket_prefill:\s*escalation\.open\s*\?\s*buildTicketPrefill\(userUtterances\)/.test(serverMain));
       ok('no prefill leaks when the form stays closed',
          /ticket_prefill:\s*escalation\.open\s*\?/.test(serverMain));
       ok('the marker is still stripped before the reply is stored',
          /extractEscalation\(ctx\.aiReply/.test(serverMain));
    ok('the prompt tells the model to check the role first',
       /Escalation is role-dependent/.test(systemPrompt));
    ok('the prompt no longer promises a handover for any direct request',
       /REGULAR USER: do not hand over yet and do not lecture them/.test(systemPrompt));
    ok('a blank reply during assessment asks what is wrong',
       /Tell me what's happening and I'll take a look before we raise anything\./.test(serverMain));

    section('6c. Prefill is applied by the modal');
    ok('the modal accepts a prefill option', /opts\.prefill/.test(modal));
    ok('the modal clears it on close', /ctx\.prefill = null/.test(modal));
    ok('prefilled fields are marked so they can be styled',
       /wrapper\.dataset\.prefilled = 'true'/.test(modal));
    ok('description and justification are the prefilled fields',
       /prefillable: true/.test(modal) &&
       (modal.match(/prefillable: true/g) || []).length === 6,
       'count ' + ((modal.match(/prefillable: true/g) || []).length));
    ok('only declared fields are prefilled', /field\.prefillable/.test(modal));
    ok('an empty prefill does not overwrite anything',
       /typeof ctx\.prefill\[field\.id\] === 'string' && ctx\.prefill\[field\.id\]\.trim\(\)/.test(modal));

    section('7. The modal only uses APIs that exist');
    const widgetModal = modal;
    ok('no AmiConfig.getApiUrl call', modal.indexOf('AmiConfig.getApiUrl') === -1);
    ok('no AmiConfig.getUserName call', modal.indexOf('AmiConfig.getUserName') === -1);
    ok('no AmiApi.addSystemMessage call', modal.indexOf('AmiApi.addSystemMessage') === -1);
    ok('it authenticates with the session header', modal.indexOf("'X-Session-ID'") !== -1);
    ok('filenames are not interpolated as HTML', !/innerHTML\s*=\s*`[^`]*\$\{file\.name/.test(modal));
    ok('it takes apiUrl from the caller', /apiUrl:\s*function/.test(modal) || modal.indexOf('opts.apiUrl') !== -1);

    section('8. The three forms match the legacy PHP forms');
    // Field ids in definition order. `items` is the repeatable group, so its
    // nested `item`/`quantity` ids follow it in the source.
    const tech = ['department', 'location', 'category', 'system', 'description', 'justification'];
    const sysreq = ['department', 'category', 'system', 'description', 'justification',
      'from_process', 'to_process', 'risk'];
    const asset = ['department', 'request_category', 'items', 'item', 'quantity', 'description', 'justification'];
    const orderOf = (type) => {
      const start = modal.indexOf('  ' + type + ': {');
      if (start === -1) return [];
      // Stop at the next top-level form so the slice cannot bleed into it.
      const rest = modal.slice(start + 1);
      const nextIdx = rest.indexOf('\n  },');
      const block = nextIdx === -1 ? rest : rest.slice(0, nextIdx);
      return (block.match(/id:\s*'([a-z_]+)'/g) || [])
        .map(s => s.replace(/id:\s*'/, '').replace(/'/, ''));
    };
    ok('tech support field order', JSON.stringify(orderOf('tech_support')) === JSON.stringify(tech),
       JSON.stringify(orderOf('tech_support')));
    ok('system request field order', JSON.stringify(orderOf('system_request')) === JSON.stringify(sysreq),
       JSON.stringify(orderOf('system_request')));
    ok('it asset field order', JSON.stringify(orderOf('it_asset')) === JSON.stringify(asset),
       JSON.stringify(orderOf('it_asset')));
    ok('system request uses its own category catalog',
       /system_request:[\s\S]{0,900}request-categories/.test(modal));

    // The impact checkboxes and measurable-impact box came out of the System Request
    // form on request: MIS writes a measurable_impact row either way, so a ticket
    // with nothing ticked is a valid state and asking for it only added friction.
    ok('the impact checkboxes are no longer asked of the user',
       modal.indexOf("id: 'impact'") === -1);
    ok('measurable impact is no longer asked of the user',
       modal.indexOf("id: 'measurable_impact'") === -1);
    ok('the five impact values are gone from the form',
       ['productivity', 'quality', 'yield', 'cost_saving', 'customer_requirement']
         .every(k => modal.indexOf(`value: '${k}'`) === -1));
    ok('it asset rows are repeatable', /type:\s*'repeater'/.test(modal));
    // Fields the legacy forms leave to MIS must never be asked of the user.
    ok('mis_assessment is not asked of the user', modal.indexOf("id: 'mis_assessment'") === -1);
    ok('the repeatable rows can be added and removed',
       modal.indexOf('+ Add another item') !== -1 && modal.indexOf("remove.textContent = 'Remove'") !== -1);
    ok('a repeater row cannot be removed to nothing',
       /querySelectorAll\('\.ami-repeater-row'\)\.length\s*<=\s*1/.test(modal));

    section('8a. Each field reads the catalog the legacy form reads');
    // Tech Support's System Type came from scrf_request_category, which is the
    // System Request list: MIS's company systems, not the things that break.
    ok('tech support systems come from support_category',
       /FROM support_category/.test(catalog) && /supportSystemOptions/.test(catalog));
    ok('tech support does NOT borrow the System Request list',
       /export function supportSystemOptions[\s\S]{0,400}scrf_request_category/.test(catalog) === false);
    ok('tech support asks its own endpoint for systems',
       /id: 'system'[\s\S]{0,120}support-systems/.test(modal));
    ok('tech support systems are a tick list, not a single select',
       /id: 'system', label: 'System Type', type: 'checkboxgroup'/.test(modal));
    ok('system request systems are a tick list too',
       /id: 'system', label: 'System Name', type: 'checkboxgroup'/.test(modal));
    ok('only system request is grouped',
       /id: 'system', label: 'System Name', type: 'checkboxgroup'[^}]*grouped: true/.test(modal) &&
       /id: 'system', label: 'System Type', type: 'checkboxgroup'[^}]*grouped/.test(modal) === false);
    // Locations used to be mined out of past tickets: 365 spellings including
    // "(ifv mold) at dtfs area". MIS curates a real list of 72.
    ok('locations come from it_asset.locations',
       /FROM it_asset\.locations WHERE active = \\?'Y\\'? ORDER BY name/.test(catalog));
    ok('locations are no longer mined from support_master',
       /FROM support_master WHERE location/.test(catalog) === false);
    ok('location is a dropdown, not the old typeahead',
       /id: 'location', label: 'Location', type: 'select'/.test(modal));
    ok('the dead typeahead renderer is gone', /doSearch/.test(modal) === false);
    ok('the dead search field type is gone', /type: 'search'/.test(modal) === false);

    section('8a2. Options carry the id MIS stores');
    ok('asset items keep their on-hand count',
       /onhand:\s*Number\.isFinite\(onhand\)/.test(modal));
    ok('an item renders as "NAME - n", like the legacy option',
       /labelWithCount:\s*Number\.isFinite\(onhand\)\s*\?\s*`\$\{name\} - \$\{onhand\}`/.test(modal));
    ok('only the name is submitted, not the count',
       /value:\s*id \|\| name/.test(modal));
    ok('the catalog endpoints no longer flatten items to names',
       /res\.json\(items\.map\(i => i\.value\)\)/.test(ticketRoute) === false);
    ok('a new repeater row is inserted before the Add button',
       /className = 'ami-repeater-rows'/.test(modal) && /rows\.appendChild\(row\)/.test(modal));
    ok('the Add button is a sibling after the rows, not a parent',
       /container\.appendChild\(rows\)[\s\S]{0,20000}container\.appendChild\(addMore\)/.test(modal)
       && modal.indexOf('container.appendChild(rows)') < modal.indexOf('container.appendChild(addMore)'));
    ok('measurable impact no longer repeats itself',
       /id: 'measurable_impact'[^}]*hint:/.test(modal) === false);

    section('8a4. The grouped picker actually renders');
    // The first version built each section without its options array, so
    // section.options.push threw and every grouped list showed "Could not load
    // the list" instead of the systems. Asserting the initialiser exists is the
    // cheap guard against that coming back.
    ok('each group section initialises its own options list',
       /section = \{ name: g, options: \[\], wrap/.test(modal));
    ok('the section is not built without one',
       /section = \{ name: g, wrap: document/.test(modal) === false);
    ok('a render failure names the cause instead of blaming the network',
       /console\.error\('ami-modal: could not render'/.test(modal) &&
       /Could not display the options/.test(modal));
    ok('the misleading generic load error is gone',
       /Could not load the list\. Please try again\./.test(modal) === false);

    section('8a5. Dismissing the form tells Ami');
    ok('close reports why it was called',
       /function close\(reason\)/.test(modal));
    ok('X, Cancel, Escape and the backdrop all count as a cancellation',
       ["'cancelled'"].length === 1 &&
       (modal.match(/close\('cancelled'\)/g) || []).length === 4);
    ok('closing after a successful submit is not a cancellation',
       /close\('submitted'\)/.test(modal));
    ok('the chat is notified when the form is cancelled',
       /reason === 'cancelled'/.test(widgetMain) &&
       /notifyServer\(/.test(widgetMain));
    ok('the notification does not fake a message from the user',
       /without pretending the user/.test(widgetMain) &&
       /addUserUploadMessage|addUserMessage/.test(widgetMain) &&
       /notifyServer: function[\s\S]{0,900}buildFormData/.test(widgetMain) &&
       !/notifyServer: function[\s\S]{0,900}addUser/.test(widgetMain));
    ok('the escalation marker cannot reopen the dismissed form',
       /!suppressModal/.test(widgetMain));
    ok('a failed courtesy message still clears the typing indicator',
       /self\.hideTyping\(\);/.test(widgetMain));

    section('8a3. Category and system submit ids, not labels');
    ok('exactly one payload builder remains',
       /function buildPayload/.test(ticketRoute) === false);
    ok('the route uses the shared id-resolving builder',
       /buildResolvedPayload\(\{/.test(ticketRoute));
ok('system request ids resolve from the request-category table',
       /systemRequestCategoryOptions\(\)[\s\S]{0,120}systemRequestSystemOptions\(\)/.test(hook));
    ok('tech support ids resolve from the support tables',
       /supportCategoryOptions\(\)[\s\S]{0,120}supportSystemOptions\(\)/.test(hook));
    ok('a label is accepted as well as an id, so $test-webhook still works',
       /String\(o\.id\) === v \|\| o\.name === v/.test(hook));
    ok('several system ids are comma-joined for the MIS column',
       /ids\.join\(','\)/.test(hook));
ok('IT asset pairs become inventory_items / request_quantity',
       /delete ticketData\.items/.test(hook));
    ok('a missing employee number is no longer filed as zero',
       /user\.mis_user_id \?\? 0/.test(ticketRoute) === false);
ok('validation is per-ticket-type, not one shared list',
       /catalogOptionsFor\(ticketType\)/.test(ticketRoute));

    section('8a6. A category_id must validate against the category list');
    // Regression: category was compared against the SYSTEM options with a
    // name-only fallback, so the posted id "15" matched neither and every System
    // Request came back "Invalid category" even with a valid choice ticked.
    ok('category is checked against the category options',
       /matchesOption\(opts\.category, fields\.category\)/.test(ticketRoute));
    ok('category is never checked against the system options',
       /matchesOption\(opts\.system, fields\.category\)/.test(ticketRoute) === false);
    ok('both option lists keep their ids, not just names',
       /return \{ category, system \}/.test(ticketRoute) &&
       /category: Array<\{ id: number; name: string \}>/.test(ticketRoute));
    ok('category validation is still skipped when MIS is unreachable',
       /opts\.category\.length && !matchesOption/.test(ticketRoute));

    section('8a6b. A ticked checkbox carries its value to the server');
    // Regression: the grouped picker recorded {box,row,group,label} but no
    // `value`, while syncValues read `b.value`. Every selection became
    // [undefined], JSON-serialised to [null], and MIS rejected it as
    // "Invalid system: null" while the user had plainly ticked a real system.
    ok('the box record stores the option value',
       /boxes\.push\(\{ box, row, value: opt\.value,/.test(modal));
    ok('no push site drops the value',
       /boxes\.push\(\{ box, row, group:/.test(modal) === false);

    // Behavioural half: drive the real function and read back what it stores.
    const grouped = await (async () => {
      try {
        return await exerciseCheckboxGroup(modal, [
          { id: 1, name: 'Oracle ERP', group: 'ERP' },
          { id: 3, name: 'MYSQL DB', group: 'ERP' },
          { id: 5, name: 'MES', group: '' },
          // No id: must fall back to sending the label rather than nothing.
          { name: 'No Id Here', group: 'ERP' }
        ]);
      } catch (e) { return { error: e.message, boxes: () => null }; }
    })();
    ok('the real picker function can be driven', grouped.error === undefined, grouped.error);
    if (grouped.error === undefined) {
      ok('an untouched picker submits nothing', (() => {
        const vals = grouped.boxes();
        return Array.isArray(vals) && vals.length === 0;
      })());
      const tick = value => {
        const find = n => {
          for (const c of n.children) {
            if (c.tagName === 'INPUT' && c.type === 'checkbox' && c.value === value) return c;
            const hit = find(c);
            if (hit) return hit;
          }
          return null;
        };
        const box = find(grouped.root);
        if (!box) return false;
        box.checked = true;
        box.listeners.change.forEach(fn => fn({ target: box }));
        return true;
      };

      ok('ticking a real system posts its id, not null', (() => {
        if (!tick('1')) return false;
        const vals = grouped.boxes();
        return Array.isArray(vals) && vals.length === 1 &&
               vals[0] === '1' && vals[0] !== null;
      })());

      ok('two systems in the same group are both kept', (() => {
        if (!tick('3')) return false;
        const vals = grouped.boxes();
        return Array.isArray(vals) && vals.length === 2 &&
               vals.indexOf('1') !== -1 && vals.indexOf('3') !== -1;
      })());

      ok('an option with no id degrades to its label', (() => {
        if (!tick('No Id Here')) return false;
        const vals = grouped.boxes();
        return Array.isArray(vals) && vals.indexOf('No Id Here') !== -1;
      })());
    }

    section('8a7. Every widget module is served no-store');
    // Regression: the allowlist named only widget.js, main.js and ami-session.js,
    // so modal.js fell through to express.static's default and a browser could
    // pair new code with a cached module - which is how the grouped system
    // picker kept rendering the pre-fix version after it was deployed.
    

    section('8b. Server validation and payload match those forms');
ok('impact and measurable_impact are not required on a system request',
       !/system_request:\s*\[[^\]]*'impact'/.test(ticketRoute) &&
       !/system_request:\s*\[[^\]]*'measurable_impact'/.test(ticketRoute));
    ok('it asset requires items rather than a single quantity',
       /it_asset:\s*\[[^\]]*'items'/.test(ticketRoute) &&
       !/it_asset:\s*\[[^\]]*'quantity'/.test(ticketRoute));
// Absent from the form, so absent from the payload too. The expansion
    // columns stay in the builder for a caller that does supply them, but nothing
    // in the modal path sets them now.
    ok('a form submission carries no impact columns',
       /delete ticketData\.impact/.test(hook) && /IMPACT_COLUMNS/.test(hook));
    ok('items are emitted as inventory_items',
       hook.indexOf('ticketData.inventory_items') !== -1);
    ok('quantities are emitted as request_quantity',
       hook.indexOf('ticketData.request_quantity') !== -1);
    // Asset_tag is assigned by MIS after approval, so it must not come from here.
    ok('Asset_tag is not sent by the widget',
       ticketRoute.indexOf('asset_tag') === -1 && hook.indexOf('asset_tag') === -1);
    ok('a row with a blank item or bad quantity is rejected',
       /Each item needs a name and a quantity/.test(ticketRoute));
ok('an empty catalog is not treated as an invalid answer',
       /locs\.length && !locs\.includes/.test(ticketRoute) &&
       /opts\.category\.length && !matchesOption/.test(ticketRoute) &&
       /opts\.system\.length\)/.test(ticketRoute));
    ok('a MIS outage therefore cannot reject every ticket',
       /depts\.length && !depts\.includes/.test(ticketRoute));

    section('9. The modal is styled');
    const css = read('public/widget.css');
    ['.ami-modal-overlay', '.ami-modal-body', '.ami-type-card', '.ami-form-field', '.ami-search-results', '.ami-toast']
      .forEach(sel => ok('styled: ' + sel, css.indexOf(sel) !== -1));
    ['.ami-checkbox-group', '.ami-checkbox-item', '.ami-field-hint', '.ami-repeater', '.ami-repeater-row']
      .forEach(sel => ok('styled: ' + sel, css.indexOf(sel) !== -1));
    ['.ami-checkgroup', '.ami-checkgroup-filter', '.ami-checkgroup-heading', '.ami-checkgroup-status']
      .forEach(sel => ok('styled: ' + sel, css.indexOf(sel) !== -1));
    ok('a box disabled by its group is visibly dimmed',
       /\.ami-checkbox-item\.is-disabled[\s\S]*?opacity:\s*0\.45/.test(css));
    ok('the checkbox group reflows on narrow screens',
       /\.ami-repeater-row\s*\{[\s\S]*?max-width: 480px/.test(css));
    ok('no unprefixed class can collide with the host page',
       !/^\s*\.(btn|card|form-control|form-select|modal|row|col-md)\b/m.test(css));

    section('10. Removed intake code is really gone');
    ok('public/widget/intake.js deleted', !fs.existsSync(path.join(__dirname, '..', 'public', 'widget', 'intake.js')));
    ok('src/server/intake.ts deleted', !fs.existsSync(path.join(__dirname, '..', 'src', 'server', 'intake.ts')));
    ok('flows/ deleted', !fs.existsSync(path.join(__dirname, '..', 'flows')));
    ok('the old flows regression is gone', !fs.existsSync(path.join(__dirname, 'flows-regress.cjs')));

    section('11. Attachments are staged for n8n, not dumped in /tmp');
    ok('multer no longer targets /tmp', ticketRoute.indexOf("'/tmp'") === -1);
    ok('uploads land in the configured staging root',
       /stagingDestination/.test(appWiringSrc) && /stagingRoot\(\)/.test(ticketRoute));
    ok('multer does not mkdir at construction time',
       /dest:\s*stagingDestination/.test(appWiringSrc) === false);
    ok('the destination is created lazily instead',
       /fs\.mkdirSync\(root, \{ recursive: true \}\)[\s\S]{0,900}cb\(null, root\)/.test(ticketRoute));
    ok('staging sits under the file_master mount',
       /path\.join\(config\.paths\.attachmentsDir,\s*INCOMING_DIR\)/.test(ticketRoute));
ok('the payload sends staged_path, not file_directory',
       /staged_path:\s*String\(a\.staged_path/.test(hook) &&
       /file_directory:\s*String\(a\./.test(hook) === false);
    ok('the webhook builder uses the same attachment keys',
       /staged_path:\s*String\(a\.staged_path\s*\?\?\s*a\.stored_path/.test(hook));
    ok('the original filename survives staging',
       /fs\.renameSync\(file\.path,\s*stagedPath\)/.test(ticketRoute) &&
       ticketRoute.indexOf('sanitizeUploadName') !== -1);
    ok('# is replaced with - as the legacy form does', /\.replace\(\/#\/g, '-'\)/.test(ticketRoute));
    ok('an unreadable share does not stop the server booting',
       /attachment_staging_unavailable/.test(ticketRoute) &&
       /stagingWritable = false/.test(ticketRoute));
    ok('an unmounted share produces a clear upload error',
       /file share is not mounted/.test(ticketRoute));

    section('11a. Every static select option is a {value,label} object');
    {
      // The IT Asset Request Category dropdown rendered as four blank rows and
      // submitted the literal string "undefined".
      //
      // appendOption() does `optEl.value = opt.value; optEl.textContent =
      // opt.labelWithCount || opt.label`. A bare string has neither property, so
      // both became `undefined`: nothing to display, and a "required" select that
      // looked empty while the user had genuinely picked something.
      //
      // It is the only dropdown with no catalog behind it - the legacy form
      // hardcodes it (it_asset_form.php:13) - which is exactly why it was missed:
      // every other select is populated by loadCatalogOptions() and normalised on
      // the way in, so nothing else could hit this.
      const defs = modal.slice(modal.indexOf('const FORM_DEFINITIONS'), modal.indexOf('const MAX_ATTACHMENTS'));

      // Every `options:` array in the definitions, wherever it appears.
      const optionArrays = [...defs.matchAll(/options:\s*(\[[\s\S]*?\])(?=\s*[,}])/g)].map(m => m[1]);
      ok('the definitions contain static option lists to check', optionArrays.length > 0,
         optionArrays.length + ' found');

      const bareStrings = optionArrays.filter(arr =>
        /^\[\s*'[^']*'\s*(,|\])/.test(arr.trim()));
      ok('no option list is a bare array of strings',
         bareStrings.length === 0,
         bareStrings.length ? bareStrings[0].slice(0, 70) : '');

      // Spot-check the one that broke, by value rather than by formatting.
      for (const label of ['New', 'Borrow', 'Replacement', 'Transfer']) {
        ok(`"${label}" is defined as a value/label pair`,
           new RegExp(`\\{\\s*value:\\s*'${label}',\\s*label:\\s*'${label}'\\s*\\}`).test(defs));
      }
      ok('the four legacy categories are all present',
         ['New', 'Borrow', 'Replacement', 'Transfer'].every(l =>
           defs.includes(`value: '${l}'`)));

      // The submitted value must be the LABEL, which is what it_asset_form.php
      // posts (`$reqCategory = [1 => "New", ...]`, value="<?php echo $row; ?>").
      ok('it posts the label, matching the legacy form',
         /value:\s*'New',\s*label:\s*'New'/.test(defs));

      ok('appendOption reads the properties the definitions actually supply',
         /optEl\.value = opt\.value/.test(modal) &&
         /optEl\.textContent = opt\.labelWithCount \|\| opt\.label/.test(modal));

      // Drive the real renderer over the real definition. This is the check that
      // would have caught the original blank dropdown.
      const itDefSrc = defs.slice(defs.indexOf('it_asset:'));
      const reqCatSrc = itDefSrc.slice(
        itDefSrc.indexOf("id: 'request_category'"),
        itDefSrc.indexOf('placeholder:', itDefSrc.indexOf("id: 'request_category'"))
      );
      const reqCatDef = new Function(
        'return {' + reqCatSrc.replace(/,\s*$/, '') + '};'
      )();
      const rendered = exerciseStaticSelect(modal, reqCatDef);

      ok('all four categories render', rendered.labels.length === 4,
         JSON.stringify(rendered.labels));
      ok('no category renders blank',
         rendered.labels.every(l => l && l.trim() !== ''), JSON.stringify(rendered.labels));
      ok('no category submits the string "undefined"',
         rendered.values.every(v => v !== 'undefined' && v !== ''),
         JSON.stringify(rendered.values));
      ok('the labels read New/Borrow/Replacement/Transfer',
         JSON.stringify(rendered.labels) ===
         JSON.stringify(['New', 'Borrow', 'Replacement', 'Transfer']),
         JSON.stringify(rendered.labels));
    }

    section('11b. IT Asset cannot carry attachments');
    ok('it_asset declares no attachments',
       /it_asset:[\s\S]{0,400}allowAttachments: false/.test(modal));
    ok('the picker is hidden for that type',
       /applyAttachmentVisibility/.test(modal) &&
       /allowsAttachments\(selectedType\)\s*\?\s*''\s*:\s*'none'/.test(modal));
    ok('changing type clears staged files',
       /attachmentFiles = \[\];[\s\S]{0,120}applyAttachmentVisibility/.test(modal));
    ok('submit skips files for a type that forbids them',
       /if \(allowsAttachments\(selectedType\)\)[\s\S]{0,120}formData\.append\('attachments'/.test(modal));
    ok('the server rejects IT Asset attachments rather than orphaning them',
       /IT Asset requests cannot carry attachments/.test(ticketRoute));
    ok('a rejected upload is deleted, not left behind',
       /discardUploads\(req\.files\)/.test(ticketRoute));

    section('11c. An uploaded file really lands in the staging tree');
    // Driven through the real endpoint rather than by inspecting the source,
    // because the bug being guarded against was a container-local path that no
    // other process could read - only an actual write proves that is fixed.
    const STAGE_SESSION = 'attach.stage.user';
    const stagingDir = path.join(SCRATCH, 'attachments');

    fs.mkdirSync(path.join(SCRATCH, 'conversations'), { recursive: true });
    fs.writeFileSync(
      path.join(SCRATCH, 'conversations', STAGE_SESSION + '.json'),
      JSON.stringify({
        mode: 'chat', status: 'active',
        user: { user_name: STAGE_SESSION },
        messages: []
      }, null, 2)
    );
    fs.mkdirSync(path.join(SCRATCH, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(SCRATCH, 'data', 'users.json'),
      JSON.stringify({ users: {
        [STAGE_SESSION]: {
          username: STAGE_SESSION, display_name: 'Stage Tester',
          email: 'stage@test', department: 'MIS', role: 'user', enabled: true,
          requests_per_day: null, max_upload_bytes: null, note: '',
          created_at: new Date().toISOString(), last_seen: new Date().toISOString()
        }
      } }, null, 2)
    );

    const postTicket = (type, fields, files) => {
      const fd = new FormData();
      fd.append('ticket_type', type);
      fd.append('fields', JSON.stringify(fields));
      fd.append('session_id', STAGE_SESSION);
      (files || []).forEach(f => fd.append('attachments', new Blob([f.body], { type: f.type }), f.name));
      return fetch(`${BASE}/api/ticket`, {
        method: 'POST', body: fd, headers: { 'X-Session-ID': STAGE_SESSION }
      });
    };

    // MIS is unreachable in this suite (blanked on purpose), so validation is
    // skipped and the request stops at the missing webhook: after staging.
    const twoFiles = [
      { name: 'Q4 Report.docx', body: 'first document', type: 'application/msword' },
      { name: 'Photo #2.png', body: 'second image', type: 'image/png' }
    ];
    await postTicket('tech_support', {
      department: 'MIS', location: 'CK1 MIS', category: 'Hardware',
      system: ['Printer'], description: 'printer is jammed', justification: 'blocked'
    }, twoFiles);

    ok('the staging root was created under the mount',
       fs.existsSync(path.join(stagingDir, '_incoming')));

    const incoming = path.join(stagingDir, '_incoming');
    const keys = fs.existsSync(incoming) ? fs.readdirSync(incoming) : [];
    ok('a staging folder was created for the submission', keys.length === 1,
       'keys=' + JSON.stringify(keys));
    const stagedFiles = keys.length ? fs.readdirSync(path.join(incoming, keys[0])) : [];
    ok('both files were staged', stagedFiles.length === 2, JSON.stringify(stagedFiles));
    ok('the original filename is kept for the requester',
       stagedFiles.includes('Q4 Report.docx'));
    ok('# is replaced with -', stagedFiles.includes('Photo -2.png'));
    ok('the staged bytes are the ones uploaded', (() => {
      if (!keys.length) return false;
      const p = path.join(incoming, keys[0], 'Q4 Report.docx');
      return fs.existsSync(p) && fs.readFileSync(p, 'utf8') === 'first document';
    })());

    const rejected = await postTicket('it_asset', {
      department: 'MIS', request_category: 'New',
      items: [{ item: 'Computer CPU', quantity: 1 }],
      description: 'need a cpu', justification: 'mine is broken'
    }, [{ name: 'should-not-appear.txt', body: 'nope', type: 'text/plain' }]);

    ok('IT Asset with an attachment is refused', rejected.status === 400,
       'status ' + rejected.status);
    const afterReject = fs.existsSync(incoming) ? fs.readdirSync(incoming) : [];
    ok('the refused file was not left behind in staging',
       afterReject.every(k => {
         const f = path.join(incoming, k);
         return !fs.readdirSync(f).includes('should-not-appear.txt');
       }), JSON.stringify(afterReject));

    section('11d. Sanitising an uploaded filename');
    const clean = ticketModule.sanitizeUploadName;
    ok('sanitizeUploadName is exported', typeof clean === 'function');
    ok('a normal name is untouched', clean('Security Report 29-Jun-2026.docx') === 'Security Report 29-Jun-2026.docx');
    ok('spaces are kept, because requesters see the name', clean('my report v2.docx') === 'my report v2.docx');
    ok('# becomes -', clean('Q4#report.xlsx') === 'Q4-report.xlsx');
    ok('a path is reduced to its basename',
       clean('../../etc/passwd') === 'passwd' && clean('C:\\temp\\x.doc') === 'x.doc');
    ok('a traversal attempt cannot escape', !clean('..').startsWith('.') && clean('..') === 'attachment');
    ok('an empty name still yields something usable', clean('') === 'attachment');
    ok('an over-long name is truncated', clean('a'.repeat(400)).length <= 180);
    ok('non-ascii is replaced rather than dropped', clean('réunion.docx').length > 0);
    // These two exist verbatim in scrf_attachment, so they must round-trip
    // unchanged or requesters see a different name than they uploaded.
    ok('apostrophes survive, as in the legacy rows',
       clean("Q4 24' PO for IFPD - Copy.xlsx") === "Q4 24' PO for IFPD - Copy.xlsx");
    ok('commas survive, as in the legacy rows',
       clean('Batch 7 NEVA X RMA SN, PROD, BAG ID.xlsx') === 'Batch 7 NEVA X RMA SN, PROD, BAG ID.xlsx');
    ok('path separators never survive', !clean('a/b/c.txt').includes('/'));
  } catch (e) {
    fail++;
    console.log('  FAIL  unexpected error -> ' + (e && e.stack ? e.stack : e));
  } finally {
    server.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();