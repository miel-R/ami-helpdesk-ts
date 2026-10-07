/* Widget regression test - runs against the REAL public/widget/main.js.
   Covers: file label beside the clip, invisible attachment tray, missing
   "Session ended" notice.   Run:  node tools/widget-regress.mjs */
import { JSDOMLite } from './domshim.mjs';
import fsSync from 'node:fs';

// readyState 'loading' => main.js only registers a DOMContentLoaded listener we
// never fire, so boot() stays put and we drive the methods by hand.
const dom = new JSDOMLite();
globalThis.document = dom.document;
globalThis.window = dom.window;
globalThis.localStorage = dom.window.localStorage;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.URL = dom.URL;
globalThis.AbortController = dom.AbortController;
globalThis.setInterval = () => 0;
globalThis.clearInterval = () => { };
globalThis.fetch = async () => { throw new Error('network disabled'); };

const { AmiWidget: W } = await import('../public/widget/main.js');

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
   if (c) { pass++; console.log('  PASS  ' + n); }
   else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};
const mk = (name, size) => ({ name, size, type: 'image/png', previewUrl: null, downloadUrl: null });

console.log('\n[1] Input-area structure');
W.icons = { bot: '<svg/>', clip: 'C', send: 'S', close: 'X', minus: 'M', expand: 'E' };
W.userAvatar = '';
W.render();
const html = dom.document.body.inserted.join('');
const labelAt = html.indexOf('id="ami-file-label"');
const rowAt = html.indexOf('class="ami-input-row"');
const rowEnd = html.indexOf('</div>', rowAt);
ok('widget HTML rendered', html.includes('id="ami-widget"'));
ok('label is a sibling ABOVE the input row', labelAt > -1 && labelAt < rowAt, `label@${labelAt} row@${rowAt}`);
ok('label is NOT nested in the input row', labelAt < rowAt || labelAt > rowEnd, `row=${rowAt}..${rowEnd} label=${labelAt}`);
ok('tray also above the row', html.indexOf('id="ami-pending"') < rowAt);

console.log('\n[2] Attachment tray becomes visible');
const ctx = Object.create(W);
ctx.pendingFiles = [];
ctx.formatSize = W.formatSize;
ctx.el = {
   pending: document.createElement('div'),
   fileLabel: document.createElement('span'),
   attachBtn: document.createElement('button'),
   msgs: document.createElement('div'),
   input: document.createElement('textarea')
};
ctx.renderPending();
ok('empty tray hidden', ctx.el.pending.classList.contains('on') === false);
ok('empty label hidden', ctx.el.fileLabel.classList.contains('on') === false);
ctx.pendingFiles = [mk('invoice-scan.pdf', 120000), mk('photo.png', 340000)];
ctx.renderPending();
ok('tray visible with 2 files', ctx.el.pending.classList.contains('on') === true);
ok('2 chips rendered', ctx.el.pending.children.length === 2, 'got ' + ctx.el.pending.children.length);
ok('label summary shown', ctx.el.fileLabel.textContent === '2 files ready to send \u00B7 449.2 KB', JSON.stringify(ctx.el.fileLabel.textContent));
ok('label omits raw filenames', !ctx.el.fileLabel.textContent.includes('invoice-scan.pdf'));
ok('attach button flagged', ctx.el.attachBtn.classList.contains('has-file') === true);

console.log('\n[3] Label stays bounded with many files');
ctx.pendingFiles = Array.from({ length: 8 }, (_, i) => mk('a-really-long-company-attachment-name-' + i + '.pdf', 1048576));
ctx.renderPending();
ok('8 chips rendered', ctx.el.pending.children.length === 8);
ok('label still a short summary', ctx.el.fileLabel.textContent === '8 files ready to send \u00B7 8.0 MB', JSON.stringify(ctx.el.fileLabel.textContent));
ok('label under 60 chars', ctx.el.fileLabel.textContent.length < 60, String(ctx.el.fileLabel.textContent.length));
ctx.el.pending.children[0].children[1].listeners.click[0]();
ok('chip removal works', ctx.pendingFiles.length === 7, 'got ' + ctx.pendingFiles.length);
ok('label updates after removal', ctx.el.fileLabel.textContent === '7 files ready to send \u00B7 7.0 MB', JSON.stringify(ctx.el.fileLabel.textContent));

console.log('\n[4] Session-ended divider');
function base() {
   const c = Object.create(W);
   c._sessionEnded = false; c._sessionEndedNode = null;
   c.el = { msgs: document.createElement('div') };
   c.scrollDown = () => { }; c.formatTime = W.formatTime;
   return c;
}
const s = base();
const div = s.addSessionEnd({ now: true });
ok('divider created', div && div.className === 'ami-session-end');
ok('divider appended', s.el.msgs.children.length === 1);
   ok('the divider label is text only, with no dashes of its own',
      div.children[0].textContent === 'Session ended',
      JSON.stringify(div.children[0].textContent));
ok('marked role=separator', div.attrs.role === 'separator');
ok('live divider ({now:true}) shows a time', !!div.children[1] && div.children[1].textContent.length > 0,
   'time=' + JSON.stringify(div.children[1] && div.children[1].textContent));
ok('time uses the .ami-session-end-time class',
   div.children[1] && div.children[1].className === 'ami-session-end-time',
   div.children[1] && div.children[1].className);

// Reopening an escalated thread must also carry a stamp, taken from the last
// stored message rather than "now".
const h = base();
const hd = h.addSessionEnd({ time: '2026-01-01T09:07:00Z' });
ok('history divider shows the stored timestamp',
   !!hd.children[1] && hd.children[1].textContent === h.formatTime('2026-01-01T09:07:00Z'),
   'got=' + JSON.stringify(hd.children[1] && hd.children[1].textContent));

const n = base();
const nd = n.addSessionEnd({});
ok('no stamp requested -> no time span', nd.children.length === 1, 'children=' + nd.children.length);
ok('idempotent, no duplicate', s.addSessionEnd({ now: true }) === div && s.el.msgs.children.length === 1);
s.resetSessionEnd();
ok('reset clears flag + node', s._sessionEnded === false && s.el.msgs.children.length === 0);
s.addSessionEnd({ now: true });
ok('re-addable after reset', s.el.msgs.children.length === 1);

console.log('\n[5] handleResponse triggers the divider');
function rctx() {
   const c = base();
   c.hideTyping = () => { }; c.updateUploadPreviews = () => { };
   c.addMessage = () => document.createElement('div');
   c.showQuickReplies = () => { }; c.clearQuickReplies = () => { };
   return c;
}
// A submitted ticket is NOT the end of the conversation. The user was shown
// "Session ended" seconds after the confirmation they had just read.
const a = rctx();
a.handleResponse({ reply: 'Ticket created', ticket_created: true, control_number: 'INC-1' });
ok('ticket_created does NOT add a divider', a._sessionEnded === false);
const b = rctx();
b.handleResponse({ reply: 'hello', mode: 'chat' });
ok('plain reply does NOT add it', b._sessionEnded === false);
const c2 = rctx();
c2.handleResponse({ reply: 'bye', session_ended: true });
ok('a real idle expiry still marks the end', c2._sessionEnded === true);
const d2 = rctx();
d2.handleResponse({ reply: 'bye', session_ended: true, ticket_created: true });
ok('a ticket in the same turn wins over the stale flag', d2._sessionEnded === false);

console.log('\n[4b] Idle retirement of a stale Session-ended marker');
function idleCtx(idleMs) {
   const c = base();
   c.el.status = document.createElement('span');
   c.setStatus = function (t) { c.el.status.textContent = t; };
   c.setIdleMs(idleMs);
   c.addSessionEnd({ now: true });
   return c;
}
const i1 = idleCtx(60000);
i1.markActivity();
ok('marker present while fresh', i1._sessionEnded === true);
ok('checkIdle is a no-op before the threshold', i1.checkIdle() === false);
ok('marker survives a fresh check', i1.el.msgs.children.length === 1);

// Pretend the user walked away: push lastActivity well past the threshold.
const i2 = idleCtx(60000);
i2.addSessionEnd({ now: true });
i2._lastActivity = Date.now() - 120000;
const retired = i2.checkIdle();
ok('marker retires once idle', retired === true);
ok('divider removed from the transcript', i2.el.msgs.children.length === 0,
   'children=' + i2.el.msgs.children.length);
ok('status reflects a new conversation', i2.el.status.textContent === 'New conversation',
   JSON.stringify(i2.el.status.textContent));

console.log('\n[4c] Idle never touches the messages');
const i3 = idleCtx(60000);
i3.addSessionEnd({ now: true });
i3.addMessage('user', 'earlier question', { quiet: true });
const before = i3.el.msgs.children.length;
i3._lastActivity = Date.now() - 120000;
i3.checkIdle();
ok('only the divider goes, transcript is kept', i3.el.msgs.children.length === before - 1,
   `${before} -> ${i3.el.msgs.children.length}`);
ok('the messages themselves remain', i3.el.msgs.children.length === 1);

console.log('\n[4d] A retired marker is not resurrected by a history reload');
// Reopening the panel after an idle spell replays history, and the server still
// reports "escalated" from the original ticket. That must not put the marker back.
const r1 = idleCtx(60000);
r1._lastActivity = Date.now() - 120000;
r1.checkIdle();
ok('marker retired by idle', r1._sessionEnded === false);
ok('retirement is remembered', r1._markerRetired === true);

globalThis.fetch = async () => ({
   ok: true,
   json: async () => ({
      messages: [{ role: 'user', content: 'old question', timestamp: '2026-01-01T10:00:00Z' }],
      has_more: false, next_before: null, status: 'escalated'
   })
});
r1.apiUrl = () => '/api/history/x';
await r1.loadHistory();
await new Promise(res => setTimeout(res, 20));
ok('history reload does NOT resurrect the marker', r1._sessionEnded === false,
   'sessionEnded=' + r1._sessionEnded);
ok('transcript still rendered', r1.el.msgs.children.length === 1,
   'children=' + r1.el.msgs.children.length);

// A genuinely new session-end (user keeps chatting, then submits again) clears it.
r1._markerRetired = false;
r1.addSessionEnd({ now: true });
ok('a fresh end still draws a marker', r1._sessionEnded === true && r1._markerRetired === false);

console.log('\n[4e] Idle threshold plumbing');
const i4 = base();
i4.setIdleMs(900000);
ok('setIdleMs stores a valid value', i4.idleMs() === 900000, String(i4.idleMs()));
i4.setIdleMs(0);
ok('setIdleMs rejects 0', i4.idleMs() === 900000, String(i4.idleMs()));
i4.setIdleMs('nonsense');
ok('setIdleMs rejects junk', i4.idleMs() === 900000, String(i4.idleMs()));
const i5 = base();
i5._idleMs = null;
// The bundled default is only a fallback for an older server that sends no
// value. It matches SESSION_TIMEOUT in .env, which ends a session at 5 minutes.
ok('falls back to the bundled default (5 min)', i5.idleMs() === 300000, String(i5.idleMs()));

console.log('\n[5b] the "still there?" nudge');
{
  // The nudge is the last chance to get an answer before the 5 minute end, so
  // it must fire once, must not fire while the user is replying, and must be
  // re-armable afterwards.
  const n1 = base();
  ok('nudge default is four minutes', n1.nudgeMs() === 240000, String(n1.nudgeMs()));
  n1.setNudgeMs('junk');
  ok('setNudgeMs rejects junk', n1.nudgeMs() === 240000, String(n1.nudgeMs()));
  n1.setNudgeMs(5000);
  ok('setNudgeMs stores a valid value', n1.nudgeMs() === 5000, String(n1.nudgeMs()));

  ok('nudge starts disarmed', typeof n1._nudgeTimer === 'undefined' || n1._nudgeTimer === null);
  n1.armNudge();
  ok('arming creates a timer', !!n1._nudgeTimer);
  n1.cancelNudge();
  ok('cancelling clears the timer', !n1._nudgeTimer);
  n1._nudgeFired = true;
  n1.armNudge();
  ok('a nudge that already fired does not re-arm', !n1._nudgeTimer);
  n1._nudgeFired = false;
  n1.armNudge();
  n1.noteUserReply();
  ok('the user replying re-arms the nudge', !!n1._nudgeTimer && n1._nudgeFired === false);
  n1.cancelNudge();
}

console.log('\n[6] lastTime helper');
ok('returns newest timestamp', W.lastTime([{ timestamp: '2026-01-01T00:00:00Z' }, { timestamp: '2026-01-02T00:00:00Z' }]) === '2026-01-02T00:00:00Z');
ok('handles empty list', W.lastTime([]) === null);

console.log('\n[7] Message ordering (regression: thread rendered backwards)');
// Fixture mirrors the REAL /api/history payload: NEWEST FIRST (`ORDER BY id
// DESC`), because the paging cursor is the oldest id returned. An oldest-first
// fixture here once let the widget pass while the live transcript rendered
// backwards.
function orderCtx() {
   const c = Object.create(W);
   c._sessionEnded = false; c._sessionEndedNode = null;
   c.el = { msgs: document.createElement('div') };
   c.scrollDown = () => { };
   c.formatTime = W.formatTime;
   c.userAvatar = '';
   c.icons = W.icons;
   c.renderContent = W.renderContent;
   c.hasMore = false; c.loadingOlder = false; c.nextBefore = null;
   c.updateUploadPreviews = () => { };
   return c;
}
const o = orderCtx();
const page = [
  { id: 4, role: 'assistant', content: 'second answer', timestamp: '2026-01-01T10:00:03Z' },
  { id: 3, role: 'user', content: 'second question', timestamp: '2026-01-01T10:00:02Z' },
  { id: 2, role: 'assistant', content: 'first answer', timestamp: '2026-01-01T10:00:01Z' },
  { id: 1, role: 'user', content: 'first question', timestamp: '2026-01-01T10:00:00Z' }
];
globalThis.fetch = async () => ({ ok: true, json: async () => ({ messages: page, has_more: false, next_before: null }) });
o.apiUrl = () => '/api/history/x';
// loadHistory() does not return its promise, so await it and then let the
// fetch microtask queue drain before inspecting the DOM.
await o.loadHistory();
await new Promise(r => setTimeout(r, 20));
const texts = o.el.msgs.children.map(r => r.children[1].children[0].textContent);
ok('newest-first payload renders oldest-first in the DOM',
   JSON.stringify(texts) === JSON.stringify(['first question', 'first answer', 'second question', 'second answer']),
   JSON.stringify(texts));
ok('no row is duplicated', new Set(texts).size === texts.length, JSON.stringify(texts));

console.log('\n[7b] chronological() handles both backend orderings');
const asc = [{ id: 1, c: 'a' }, { id: 2, c: 'b' }, { id: 3, c: 'c' }];
const desc = [{ id: 3, c: 'c' }, { id: 2, c: 'b' }, { id: 1, c: 'a' }];
ok('ascending input -> ascending', W.chronological(asc).map(m => m.c).join('') === 'abc');
ok('descending input -> ascending', W.chronological(desc).map(m => m.c).join('') === 'abc');
ok('input array is not mutated', desc.map(m => m.c).join('') === 'cba', desc.map(m => m.c).join(''));
const noIds = [{ c: 'newest' }, { c: 'middle' }, { c: 'oldest' }];
ok('no ids -> reverses (assumes newest-first)',
   W.chronological(noIds).map(m => m.c).join(',') === 'oldest,middle,newest',
   W.chronological(noIds).map(m => m.c).join(','));
ok('empty and single are safe',
   W.chronological([]).length === 0 && W.chronological(asc.slice(0, 1)).length === 1);

console.log('\n[8] prependMessage still goes to the front');
const p = orderCtx();
p.addMessage('assistant', 'newest', { quiet: true });
p.prependMessage('user', 'older', 'id-1', '2026-01-01T09:00:00Z');
const ptxt = p.el.msgs.children.map(r => r.children[1].children[0].textContent);
ok('older message lands at the front', ptxt[0] === 'older', JSON.stringify(ptxt));
ok('newest message follows it', ptxt[1] === 'newest', JSON.stringify(ptxt));
ok('prependMessage does not double-insert', ptxt.length === 2, JSON.stringify(ptxt));

console.log('\n[9] Server: user message pushed exactly once per turn');
// Regression guard: the chat handler used to push the user turn a second time,
// which duplicated every user bubble in the transcript and fed the AI a doubled
// message. node --check cannot see this, so assert it structurally.
const fs = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const pathMod = await import('node:path');
const here = pathMod.dirname(fileURLToPath(import.meta.url));
// Read the TypeScript source, not the compiled output: this asserts on source
// shape, and reading dist/ would also match the sourcemap comments.
//
// This checks the chat HANDLER, not the wiring. The message push lives in
// This checks the escalate STAGE, not the wiring. The user's message is stored
// once, by the last stage of the pipeline; the controller only sends what that
// stage returns.
const serverSrc = fs.readFileSync(pathMod.join(here, '..', 'src', 'server', 'services', 'chat', 'stage.escalate.ts'), 'utf8');
const userPushes = (serverSrc.match(/session\.messages\.push\(\{\s*role:\s*'user'/g) || []).length;
ok('exactly one user push in the chat handler', userPushes === 1, 'found ' + userPushes);

console.log('\n[10] Scrolling to the top loads the previous page');
// The trigger, stated plainly: the transcript element fires `scroll`, and when
// its scrollTop is 8px or less loadOlder() runs. There is also a visible
// "Load earlier messages" button as an explicit fallback, which is what most
// people actually reach for.
//
// This drives the REAL loadHistory and the REAL bindEvents handler against the
// server's real response shape, because the wiring here was already correct and
// the failure was one layer down (the endpoint always reported has_more=false),
// which no amount of reading the widget would have revealed.
{
   const page = (msgs, hasMore, nextBefore) => ({
      messages: msgs.map((c, i) => ({ role: i % 2 ? 'assistant' : 'user', content: c, timestamp: '2026-01-01T09:0' + (i % 10) + ':00Z' })),
      has_more: hasMore,
      next_before: nextBefore,
      session_ended: false, uploads: [], goodbye: null, greeting: null
   });
   const firstTen = Array.from({ length: 10 }, (_, i) => 'message ' + (50 - i));

   const calls = [];
   globalThis.fetch = async (url) => {
      calls.push(String(url));
      // Page 1: newest ten, more to come. Page 2: another ten, still more.
      // Page 3: the final seven, nothing left.
      if (calls.length === 1) return { json: async () => page(firstTen, true, 41) };
      if (calls.length === 2) return { json: async () => page(Array.from({ length: 10 }, (_, i) => 'message ' + (40 - i)), true, 31) };
      return { json: async () => page(Array.from({ length: 7 }, (_, i) => 'message ' + (30 - i)), false, null) };
   };

   // A window element that owns the transcript, so toggleLoadMore has a
   // parentNode to insert its strip into.
   const win = document.createElement('div');
   const c = Object.create(W);
   c.el = { msgs: document.createElement('div'), win };
   win.appendChild(c.el.msgs);
   c.el.loadMoreStrip = null;
   c.el.loadMore = null;
   c.sessionId = 'remiel.baking';
   c.apiUrl = p => 'https://host' + p;
   c.scrollDown = () => { };
   c.setIdleMs = () => { }; c.setNudgeMs = () => { }; c.markActivity = () => { };
   c.formatTime = W.formatTime;
   c.userAvatarHtml = () => '';

   c.loadHistory();
   await new Promise(r => setTimeout(r, 0));

   ok('the first page asked for 10 messages', /limit=10/.test(calls[0] || ''), calls[0]);
   ok('the widget knows there is more to load', c.hasMore === true, String(c.hasMore));
   ok('the cursor was stored', c.nextBefore === 41, String(c.nextBefore));

   // The visible "Load earlier messages" control was removed on request. Paging is
   // entirely automatic now, so nothing may be inserted into the window: a control
   // above the transcript competed with the messages for the eye and duplicated
   // what scrolling up already does.
   ok('no strip or button is rendered for loading older messages',
      !c.el.loadMoreStrip && !c.el.loadMore, 'strip=' + !!c.el.loadMoreStrip);
   ok('the window holds nothing but the transcript',
      win.children.length === 1 && win.children[0] === c.el.msgs,
      'window children=' + win.children.length);

   // The automatic trigger: bindEvents' real scroll handler. bindEvents wires up
   // a dozen elements by id, so they are registered in the shim's id registry
   // first - otherwise it throws on the first missing one and the scroll listener,
   // which is registered late, is never attached. That is exactly the kind of
   // silent skip this test exists to catch.
   const stub = t => { const e = document.createElement(t); return e; };
   for (const id of ['ami-chat-button', 'ami-close', 'ami-minimize', 'ami-send', 'ami-header', 'ami-badge']) {
      dom.registry[id] = stub('div');
   }
   c.el.input = stub('textarea');
   c.el.attachBtn = stub('button');
   c.el.fileInput = stub('input');
   c.el.badge = stub('div');
   c.stageFiles = () => { }; c.isMobile = () => false;
   c.bindEvents();

   let loaded = 0;
   c.loadOlder = function () { loaded++; return W.loadOlder.call(this); };
   const handlers = c.el.msgs.listeners.scroll || [];
   ok('a scroll listener is bound to the transcript', handlers.length >= 1, 'found ' + handlers.length);

   c.el.msgs.scrollTop = 400;
   handlers[0].call(c.el.msgs);
   ok('scrolling in the middle does NOT load', loaded === 0, 'loaded=' + loaded);

   // 8px was the old threshold. Momentum and touch scrolling routinely settle a
   // few pixels short of zero and never fire a load, which is how "scroll up and
   // nothing happens" happened with a perfectly correct handler underneath.
   c.el.msgs.scrollTop = 20;
   handlers[0].call(c.el.msgs);
   ok('stopping 20px short of the top DOES load', loaded === 1, 'loaded=' + loaded);

   c.el.msgs.scrollTop = 0;
   handlers[0].call(c.el.msgs);
   await new Promise(r => setTimeout(r, 0));
   ok('the older page is requested with the cursor',
      /limit=10&before=41/.test(calls[1] || ''), calls[1]);
   ok('older messages are prepended above the first ten',
      c.el.msgs.children.length === 20, 'children=' + c.el.msgs.children.length);
   ok('a middle page advances the cursor', c.nextBefore === 31, String(c.nextBefore));
   ok('nothing is rendered above the transcript while more remains',
      !c.el.loadMoreStrip);

   // The last page clears the cursor, so no further scroll can loop against it.
   c.el.msgs.scrollTop = 0;
   handlers[0].call(c.el.msgs);
   await new Promise(r => setTimeout(r, 0));
   ok('the last page is requested with the advanced cursor',
      /limit=10&before=31/.test(calls[2] || ''), calls[2]);
   ok('all 27 messages are on screen', c.el.msgs.children.length === 27,
      'children=' + c.el.msgs.children.length);
   ok('the cursor is cleared once nothing is left', c.nextBefore === null, String(c.nextBefore));
   ok('and the window still holds only the transcript',
      !c.el.loadMoreStrip && win.children.length === 1,
      'window children=' + win.children.length);

   // And a further scroll must not loop forever against a null cursor.
   loaded = 0;
   c.el.msgs.scrollTop = 0;
   handlers[0].call(c.el.msgs);
   await new Promise(r => setTimeout(r, 0));
   ok('scrolling again at the end fetches nothing', calls.length === 3, 'calls=' + calls.length);

   console.log('\n[11] The jump-to-latest control appears only when reading back');
   // Paging up is automatic now, so this is the only way back down to the newest
   // turn. It must be invisible while the user is at the bottom and present once
   // they scroll away - otherwise it is clutter, and without it there is no way
   // back except dragging the scrollbar blind.
   const c2 = Object.create(W);
   c2.el = {
      msgs: document.createElement('div'), win: document.createElement('div'),
      loadMoreStrip: null, loadMore: null,
      jumpLatest: document.createElement('button'), input: document.createElement('textarea')
   };
   c2.el.win.appendChild(c2.el.msgs);
   // Stand in for the real geometry the control tests.
   const GEOM = { scrollHeight: 2000, clientHeight: 500 };
   Object.defineProperty(c2.el.msgs, 'scrollHeight', { get: () => GEOM.scrollHeight, configurable: true });
   Object.defineProperty(c2.el.msgs, 'clientHeight', { get: () => GEOM.clientHeight, configurable: true });

   ok('the control is created and starts hidden',
      c2.el.jumpLatest.classList.contains('show') === false);
   // The starting `disabled` comes from the rendered markup, so assert that
   // rather than a hand-built element, which never went through render().
   ok('the markup ships it out of the tab order',
      /id="ami-jump-latest"[^>]*disabled/.test(
         fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8')) ||
      /ami-jump-latest[\s\S]{0,120}disabled/.test(
         fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8')));

   c2.el.msgs.scrollTop = GEOM.scrollHeight - GEOM.clientHeight; // exactly at the bottom
   c2.toggleJumpToLatest();
   ok('at the bottom it stays hidden',
      c2.el.jumpLatest.classList.contains('show') === false,
      JSON.stringify(c2.el.jumpLatest.className));

   c2.el.msgs.scrollTop = 400; // scrolled up into history
   c2.toggleJumpToLatest();
   ok('scrolled up it is shown', c2.el.jumpLatest.classList.contains('show') === true,
      JSON.stringify(c2.el.jumpLatest.className));
   ok('and becomes reachable by keyboard',
      c2.el.jumpLatest.disabled === false &&
      c2.el.jumpLatest.getAttribute('aria-hidden') === 'false');

   // A few pixels of slack must not make it flicker in and out.
   c2.el.msgs.scrollTop = GEOM.scrollHeight - GEOM.clientHeight - 12;
   c2.toggleJumpToLatest();
   ok('a few pixels short of the bottom still counts as the bottom',
      c2.el.jumpLatest.classList.contains('show') === false,
      'scrollTop=' + c2.el.msgs.scrollTop);

   // Clicking it returns to the bottom and hides it again.
   let scrolled = null;
   c2.scrollDown = () => { scrolled = 'bottom'; c2.el.msgs.scrollTop = GEOM.scrollHeight; };
   c2.jumpToLatest();
   ok('clicking it jumps to the newest turn', scrolled === 'bottom', String(scrolled));
   ok('and hides itself on arrival',
      c2.el.jumpLatest.classList.contains('show') === false);

   // The diagnostic has to report the fields that decide whether paging works, so
   // the next report is a console paste rather than a rebuild.
   calls.length = 0;
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => page(firstTen, true, 41)
   });
   const c3 = Object.create(W);
   c3.el = { msgs: document.createElement('div'), win: document.createElement('div'), loadMoreStrip: null, loadMore: null, jumpLatest: document.createElement('button') };
   c3.el.win.appendChild(c3.el.msgs);
   c3.sessionId = 'remiel.baking'; c3.apiUrl = p => 'https://host' + p;
   c3.scrollDown = () => { }; c3.setIdleMs = () => { }; c3.setNudgeMs = () => { };
   c3.markActivity = () => { }; c3.formatTime = W.formatTime; c3.userAvatarHtml = () => '';
   c3.loadHistory();
   await new Promise(r => setTimeout(r, 0));

   const st = c3.pagingState();
   ok('pagingState reports hasMore', st.hasMore === true, JSON.stringify(st));
   ok('pagingState reports the cursor', typeof st.nextBefore === 'number', JSON.stringify(st));
   ok('pagingState reports the threshold it uses',
      st.thresholdPx === 48, String(st.thresholdPx));
   ok('pagingState says whether the thread can scroll at all',
      typeof st.canScroll === 'boolean', JSON.stringify(st));
   ok('pagingState reports the loaded count', st.loadedCount === 10, String(st.loadedCount));
}

console.log('\n[12] Reaching the top is logged, and the log says why not');
// The failure this exists for: a trigger that does nothing and a trigger that is
// blocked by a guard look identical from the outside, and this feature reported
// "nothing happens" three separate times for three different reasons. Each of
// those needed a different fix, so the reason now has to be in the console.
//
// `capture` swaps console.log only while the widget runs, and puts it back before
// `ok()` reports - otherwise the assertions print into the capture buffer and the
// section silently reports nothing, which is exactly how a vacuous test hides.
const capture = async (fn) => {
   // Paging diagnostics are off by default in the widget, so the harness turns
   // them on to assert on them. That is the supported way to see them: the same
   // call a user would make from the console.
   W.setHistoryDebug && W.setHistoryDebug(true);
   const real = console.log, realWarn = console.warn;
   const lines = [];
   console.log = (...a) => lines.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
   console.warn = (...a) => lines.push('WARN ' + a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
   try { await fn(); } finally { console.log = real; console.warn = realWarn; }
   return lines;
};
{
   const stubIds = () => {
      for (const id of ['ami-chat-button', 'ami-close', 'ami-minimize', 'ami-send', 'ami-header', 'ami-badge']) {
         dom.registry[id] = document.createElement('div');
      }
   };
   const mkCtx = () => {
      const c = Object.create(W);
      c.el = { msgs: document.createElement('div'), win: document.createElement('div'), loadMoreStrip: null, loadMore: null };
      c.el.win.appendChild(c.el.msgs);
      c.sessionId = 'remiel.baking'; c.apiUrl = p => 'https://host' + p;
      c.scrollDown = () => { }; c.setIdleMs = () => { }; c.setNudgeMs = () => { };
      c.markActivity = () => { }; c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
      return c;
   };
   const jsonRes = body => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => body
   });

   // An empty thread first: hasMore ends up false, so the trigger must report that
   // it is blocked rather than pretending to load.
   globalThis.fetch = async () => jsonRes({
      messages: [], has_more: false, next_before: null, session_ended: false, uploads: []
   });
   const c = mkCtx();
   let lines = await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });

   ok('the request URL, status and content-type are logged',
      lines.some(l => l.includes('GET https://host/api/history/remiel.baking?limit=10') &&
         l.includes('200') && l.includes('content-type=application/json')),
      lines.join(' | ').slice(0, 200));
   ok('an empty thread is reported as empty, with paging switched off',
      lines.some(l => l.includes('thread is empty') && l.includes('paging disabled')),
      lines.join(' | ').slice(0, 200));

   stubIds();
   c.el.input = document.createElement('textarea');
   c.el.attachBtn = document.createElement('button');
   c.el.fileInput = document.createElement('input');
   c.el.badge = document.createElement('div');
   c.stageFiles = () => { }; c.isMobile = () => false;
   c.bindEvents();

   lines = await capture(async () => {
      c.el.msgs.scrollTop = 0;
      (c.el.msgs.listeners.scroll || [])[0].call(c.el.msgs);
   });
   ok('reaching the top is logged', lines.some(l => l.includes('top reached via scroll')),
      lines.join(' | ').slice(0, 200));
   ok('the log names the scroll position and the threshold',
      lines.some(l => /scrollTop=0/.test(l) && /threshold=48px/.test(l)),
      lines.join(' | ').slice(0, 200));
   ok('and says the load was BLOCKED, not silently skipped',
      lines.some(l => l.includes('skipped: hasMore is false')),
      lines.join(' | ').slice(0, 200));

   lines = await capture(async () => {
      c.el.msgs.scrollTop = 0;
      (c.el.msgs.listeners.wheel || [])[0].call(c.el.msgs);
   });
   ok('a wheel gesture names itself', lines.some(l => l.includes('top reached via wheel')),
      lines.join(' | ').slice(0, 200));
   lines = await capture(async () => {
      c.el.msgs.scrollTop = 0;
      (c.el.msgs.listeners.touchmove || [])[0].call(c.el.msgs);
   });
   ok('a touch gesture names itself', lines.some(l => l.includes('top reached via touchmove')),
      lines.join(' | ').slice(0, 200));

   // Now with something to load.
   c.hasMore = true; c.nextBefore = 42;
   globalThis.fetch = async () => jsonRes({
      messages: Array.from({ length: 10 }, (_, i) => ({
         role: 'user', content: 'older' + i, timestamp: '2026-01-01T09:00:00Z'
      })),
      has_more: false, next_before: null
   });
   lines = await capture(async () => {
      c.el.msgs.scrollTop = 0;
      (c.el.msgs.listeners.scroll || [])[0].call(c.el.msgs);
      await new Promise(r => setTimeout(r, 0));
   });
   ok('an allowed load logs "loading page", not "skipped"',
      lines.some(l => l.includes('loading page')), lines.join(' | ').slice(0, 200));
   ok('the request URL is logged with the cursor',
      lines.some(l => l.includes('fetching older page') && l.includes('before=42')),
      lines.join(' | ').slice(0, 200));
   ok('and the prepend reports the new totals',
      lines.some(l => l.includes('prepended 10 message(s)')),
      lines.join(' | ').slice(0, 200));
}

console.log('\n[13] A failed or empty history load cannot fake a paging state');
// The observed symptom, exactly: hasMore true, nextBefore null, loadedCount 0,
// while scrolling produced endless "skipped: no cursor" lines.
//
// `hasMore` defaulted to true in state.js and the empty-thread branch returned
// before touching the paging fields, so a request that came back with no
// messages looked identical to a healthy one. Paging is now opt-in from the
// response, and the cursor can be recovered from the oldest loaded message id.
{
   const stateSrc = fsSync.readFileSync(process.cwd() + '/public/widget/state.js', 'utf8');
   ok('hasMore defaults to false, not true',
      /hasMore:\s*false/.test(stateSrc) && !/hasMore:\s*true/.test(stateSrc));
   ok('nextBefore has an explicit null default', /nextBefore:\s*null/.test(stateSrc));

   const mkCtx = () => {
      const c = Object.create(W);
      c.el = { msgs: document.createElement('div'), win: document.createElement('div'), loadMoreStrip: null, loadMore: null };
      c.el.win.appendChild(c.el.msgs);
      c.sessionId = 'remiel.baking'; c.apiUrl = p => 'https://host' + p;
      c.scrollDown = () => { }; c.setIdleMs = () => { }; c.setNudgeMs = () => { };
      c.markActivity = () => { }; c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
      return c;
   };

   // Case 1: 200 but with no messages array - the shape a 404 body produces.
   globalThis.fetch = async () => ({
      status: 404, statusText: 'Not Found',
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Conversation not found' })
   });
   const c1 = mkCtx();
   const l1 = await capture(async () => { c1.loadHistory(); await new Promise(r => setTimeout(r, 0)); });
   ok('a missing messages array is warned about',
      l1.some(l => l.includes('NO messages array')), l1.join(' | ').slice(0, 200));
   ok('the 404 status is visible in the log',
      l1.some(l => l.includes('404')), l1.join(' | ').slice(0, 200));
   ok('the empty path disables paging rather than leaving defaults',
      c1.hasMore === false && c1.nextBefore === null && c1.loadedCount === 0,
      JSON.stringify(c1.pagingState()));

   // Case 2: a healthy page that omits next_before.
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [
            { id: '150', role: 'assistant', content: 'newest', timestamp: '2026-01-01T09:03:00Z' },
            { id: '149', role: 'user', content: 'older', timestamp: '2026-01-01T09:02:00Z' }
         ],
         has_more: true, next_before: undefined, session_ended: false, uploads: []
      })
   });
   const c2 = mkCtx();
   const l2 = await capture(async () => { c2.loadHistory(); await new Promise(r => setTimeout(r, 0)); });
   ok('a missing next_before is derived from the oldest loaded message',
      c2.nextBefore === '149', String(c2.nextBefore));
   ok('and the derivation is logged',
      l2.some(l => l.includes('derived it from the oldest loaded message id=149')),
      l2.join(' | ').slice(0, 200));
   ok('paging stays enabled when the server said there is more',
      c2.hasMore === true, String(c2.hasMore));

   // Case 3: a non-numeric id must not become NaN, which would match nothing.
   ok('a non-numeric oldest id is kept verbatim, not coerced to NaN',
      oldestIdInProbe([{ id: 'abc' }, { id: 'xyz' }]) === 'xyz');
   ok('an empty page yields no cursor', oldestIdInProbe([]) === null);
   ok('a message with no id yields no cursor', oldestIdInProbe([{ content: 'x' }]) === null);
}

/** Reads the module-level helper the way the widget does. */
function oldestIdInProbe(messages) {
   const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   const start = src.indexOf('function oldestIdIn(');
   const body = src.slice(start, src.indexOf('\n}', start) + 2);
   return new Function(body + '\nreturn oldestIdIn;')()(messages);
}

console.log('\n[14] An ended session still completes its history load');
// The real cause of "scroll up does nothing", found from the browser console:
//
//   ReferenceError: lastTime is not defined  (main.js)
//
// `lastTime` is a method on the Widget object, called bare. It threw inside the
// success handler ABOVE the lines that assign loadedCount / nextBefore / hasMore,
// so a session whose history ended never finished loading: the paging fields kept
// their constructor defaults and every scroll reported "nothing older to fetch".
//
// The DOM shim does not enforce scope, so nothing but executing that exact branch
// catches it - which is why it survived the CSS fix, the endpoint fix and the
// threshold fix.
{
   const mkCtx = () => {
      const c = Object.create(W);
      c.el = { msgs: document.createElement('div'), win: document.createElement('div'), loadMoreStrip: null, loadMore: null };
      c.el.win.appendChild(c.el.msgs);
      c.sessionId = 'remiel.baking'; c.apiUrl = p => 'https://host' + p;
      c.scrollDown = () => { }; c.setIdleMs = () => { }; c.setNudgeMs = () => { };
      c.markActivity = () => { }; c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
      c.resetSessionEnd = () => { }; c.addSessionEnd = () => document.createElement('div');
      c.addMessage = function (role, content, opts) {
         const n = document.createElement('div');
         if (!opts || !opts.quiet) this.el.msgs.appendChild(n);
         return n;
      };
      c.prependMessage = () => document.createElement('div');
      c.chronological = W.chronological;
      return c;
   };
   const ten = Array.from({ length: 10 }, (_, i) => ({
      id: String(140 - i), role: i % 2 ? 'assistant' : 'user',
      content: 'm' + i, timestamp: '2026-01-01T09:0' + (9 - i) + ':00Z'
   }));

   // session_ended: true is the branch that threw.
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: ten, has_more: true, next_before: '131',
         session_ended: true, uploads: [], goodbye: null, last_control_number: null
      })
   });

   // The widget logs as it goes; `capture` collects that without swallowing the
   // assertions, which a bare console.log override in here would do.
   const c = mkCtx();
   const lines = await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });

   // The widget's own catch handler records the failure, so a throw inside the
   // success branch is observable instead of only skipping the paging fields.
   const failure = lines.find(l => l.startsWith('WARN') || l.includes('FAILED'));
   ok('the ended-session branch completes without a logged failure',
      !failure, failure ? failure.slice(0, 160) : '');
   ok('paging state is populated even when the session ended',
      c.hasMore === true && c.nextBefore === '131' && c.loadedCount === 10,
      JSON.stringify(c.pagingState()));
   ok('so the top-of-scroll trigger is armed rather than blocked',
      c.hasMore === true && !!c.nextBefore, JSON.stringify(c.pagingState()));

   // Source-level guard, so the exact mistake cannot be reintroduced quietly.
   const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('lastTime is called as a Widget method, never bare',
      !/(?<![\w.$])lastTime\s*\(/.test(src),
      'bare lastTime( call found');
   ok('and it is reached via self.lastTime', /self\.lastTime\(d\.messages\)/.test(src));

   // Belt and braces: no Widget method may be invoked unqualified anywhere in the
   // file. `lastTime` was one of six matches; the other five were comments.
   const defs = new Set([...src.matchAll(/^\s{4}([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?function/gm)].map(m => m[1]));
   const offenders = [];
   const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
   for (const m of noComments.matchAll(/(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (defs.has(m[1])) {
         offenders.push(m[1] + '() at line ' + noComments.slice(0, m.index).split('\n').length);
      }
   }
   ok('no Widget method is called unqualified outside a comment',
      offenders.length === 0, offenders.join(', '));
}

console.log('\n[15] Paging diagnostics are silent unless asked for');
// The logging is what found the ReferenceError, so it stays available - but it
// must not spam the console on every scroll event, which is what it was doing.
{
   const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('there is a single debug helper, not scattered console calls',
      !/console\.(log|warn)\('\[ami:history\]/.test(src));
   ok('and it is gated behind a flag that defaults to off',
      /var HISTORY_DEBUG = false;/.test(src) &&
      /if \(HISTORY_DEBUG[\s\S]{0,120}console\.log/.test(src));
   ok('the flag is reachable from the console',
      /setHistoryDebug: function/.test(src));
   ok('pagingState stays unconditional - a manual call must always tell the truth',
      /pagingState: function \(\) \{[\s\S]{0,80}return \{/.test(src) &&
      !/if \(HISTORY_DEBUG\)[\s\S]{0,60}pagingState/.test(src));

   // Behaviour, not just shape: with the flag off nothing is emitted.
   const c = Object.create(W);
   c.el = { msgs: document.createElement('div'), win: document.createElement('div') };
   c.el.win.appendChild(c.el.msgs);
   c.sessionId = 'x'; c.apiUrl = p => 'https://host' + p;
   c.scrollDown = () => { }; c.setIdleMs = () => { }; c.setNudgeMs = () => { };
   c.markActivity = () => { }; c.formatTime = W.formatTime; c.userAvatarHtml = () => '';

   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: Array.from({ length: 10 }, (_, i) => ({
            id: String(150 - i), role: 'user', content: 'm' + i, timestamp: '2026-01-01T09:00:00Z'
         })),
         has_more: true, next_before: '140', session_ended: false, uploads: []
      })
   });

   // Captures console output WITHOUT touching the debug flag, so the "silent by
   // default" case can actually be observed. `capture` deliberately turns the
   // flag on, which would defeat the point here.
   const captureRaw = async (fn) => {
      const real = console.log, realWarn = console.warn;
      const lines = [];
      console.log = (...a) => lines.push(a.map(String).join(' '));
      console.warn = (...a) => lines.push('WARN ' + a.map(String).join(' '));
      try { await fn(); } finally { console.log = real; console.warn = realWarn; }
      return lines;
   };

   W.setHistoryDebug(false);
   const quiet = await captureRaw(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });
   const widgetLines = quiet.filter(l => l.includes('[ami:history]'));
   ok('a history load is silent by default', widgetLines.length === 0,
      widgetLines.join(' | ').slice(0, 160));

   W.setHistoryDebug(true);
   const loud = await captureRaw(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });
   ok('and audible once switched on',
      loud.some(l => l.includes('[ami:history]')),
      loud.join(' | ').slice(0, 160));
   W.setHistoryDebug(false);
}

console.log('\n[16] A persisted [ended session] row renders as the divider');
// The end of a conversation has to survive a reload. It used to be inferred from
// live state, which meant the marker existed for one page view and a reload after
// a quiet spell showed a thread that just stopped. It is now a row in `messages`.
{
   const c = Object.create(W);
   c.el = {
      msgs: document.createElement('div'), win: document.createElement('div'),
      loadMoreStrip: null, loadMore: null,
      jumpLatest: document.createElement('button'), input: document.createElement('textarea')
   };
   c.el.win.appendChild(c.el.msgs);
   c.sessionId = 'remiel.baking'; c.apiUrl = p => 'https://host' + p;
   c.scrollDown = () => { }; c.setIdleMs = () => { }; c.setNudgeMs = () => { };
   c.markActivity = () => { }; c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
   c.chronological = W.chronological;
   c.resetSessionEnd = W.resetSessionEnd;

   const at = n => ({ role: 'user', content: 'turn ' + n, created_at: '2026-01-01T09:0' + n + ':00Z', timestamp: '2026-01-01T09:0' + n + ':00Z' });
   const marker = {
      role: 'system', content: '[ended session]',
      created_at: '2026-01-01T09:05:00Z', timestamp: '2026-01-01T09:05:00Z'
   };
   const asst = n => ({ role: 'assistant', content: 'reply ' + n, created_at: '2026-01-01T09:0' + n + ':00Z', timestamp: '2026-01-01T09:0' + n + ':00Z' });

   // A thread that ended and was restarted: one marker, in the middle.
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         // Newest first, as the endpoint really returns them.
         messages: [at(8), at(7), marker, asst(4), at(3)],
         has_more: false, next_before: null, session_ended: false, uploads: []
      })
   });
   await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });

   const dividers = c.el.msgs.children.filter(n => n.className === 'ami-session-end');
   ok('the marker becomes a divider', dividers.length === 1,
      'dividers=' + dividers.length + ' children=' + c.el.msgs.children.length);
   ok('the marker is not also rendered as a bubble',
      !c.el.msgs.children.some(n => n.textContent === '[ended session]'));
   ok('the divider carries the end time', !!dividers[0].children[1],
      dividers[0].children.length + ' children');
   ok('and it sits between the two halves of the conversation, not at an end', (() => {
      const texts = c.el.msgs.children.map(n => n.textContent);
      const d = texts.findIndex(t => /^Session ended/.test(t));
      return d > 0 && d < texts.length - 1;
   })(), c.el.msgs.children.map(n => n.textContent).join(' | ').slice(0, 160));

   // Two real boundaries: both must be drawn.
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [
            { ...marker, created_at: '2026-01-02T09:05:00Z', timestamp: '2026-01-02T09:05:00Z' },
            at(9),
            { ...marker, created_at: '2026-01-01T09:05:00Z', timestamp: '2026-01-01T09:05:00Z' },
            at(3)
         ],
         has_more: false, next_before: null, session_ended: false, uploads: []
      })
   });
   await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });
   const two = c.el.msgs.children.filter(n => n.className === 'ami-session-end');
   ok('a conversation that ended twice shows both boundaries',
      two.length === 2, 'dividers=' + two.length);

   // The live `session_ended` flag must not add a third divider on top of a
   // replayed marker - that is the duplicate this guard exists to prevent.
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [at(2), marker, at(1)],
         has_more: false, next_before: null,
         session_ended: true, uploads: []
      })
   });
   await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });
   const noDup = c.el.msgs.children.filter(n => n.className === 'ami-session-end');
   ok('a replayed marker suppresses the inferred one', noDup.length === 1,
      'dividers=' + noDup.length);

   // The server writes the row; the widget matches on it. If these drift, the
   // marker silently renders as an ordinary chat bubble.
   const serverSrc = fsSync.readFileSync(
      process.cwd() + '/src/server/services/session-lifecycle.service.ts', 'utf8');
   const srcNow = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('the server exports the marker the widget matches on',
      /export const SESSION_END_MARKER = '\[ended session\]'/.test(serverSrc));
   ok('and it is written as a system row on expiry',
      /role: 'system',\s*\n\s*content: SESSION_END_MARKER/.test(serverSrc));
   ok('a repeated expiry does not stack duplicate markers',
      /sinceLastMarker/.test(serverSrc) && /if \(sinceLastMarker\)/.test(serverSrc));
   ok('and the widget applies the same rule before drawing one',
      /hasSpokenSinceLastEnd: function/.test(srcNow) &&
      /if \(!self\.hasSpokenSinceLastEnd\(\)\) return;/.test(srcNow));

   // It must never reach the model as something the user typed.
   const replySrc = fsSync.readFileSync(
      process.cwd() + '/src/server/services/chat/stage.reply.ts', 'utf8');
   ok('system rows are filtered out of the replayed AI context',
      /\.filter\(m => m\.role !== 'system'\)/.test(replySrc));
}

console.log('\n[17] Scroll behaviour: no stray control, and replies follow the conversation');
// Three reported bugs, one cause.
//
//   scrollDown() animated, firing a scroll event every frame. The jump-to-latest
//   check ran on each and saw a transcript still in transit, so it decided the
//   user was "not at the bottom" and appeared - after a small scroll up, and every
//   time Ami started typing. The same animation meant the final resting position
//   depended on it finishing, so replies sometimes stopped short of the bottom.
{
   const mkScroll = () => {
      const c = Object.create(W);
      c.el = {
         msgs: document.createElement('div'), win: document.createElement('div'),
         loadMoreStrip: null, loadMore: null,
         jumpLatest: document.createElement('button'),
         typing: document.createElement('div'),
         input: document.createElement('textarea')
      };
      c.el.win.appendChild(c.el.msgs);
      const G = { scrollHeight: 1200, clientHeight: 400 };
      Object.defineProperty(c.el.msgs, 'scrollHeight', { get: () => G.scrollHeight, configurable: true });
      Object.defineProperty(c.el.msgs, 'clientHeight', { get: () => G.clientHeight, configurable: true });
      c._G = G;
      c.formatTime = W.formatTime;
      c.userAvatarHtml = () => '';
      // The REAL addMessage is used, not a stub. It is the thing that decides
      // whether to follow the conversation down, so replacing it would have made
      // these assertions pass no matter what it did. Only its rendering
      // dependencies are stubbed.
      c.icons = W.icons;
      c.renderContent = (t) => t;
      return c;
   };
   const bottom = c => c.el.msgs.scrollHeight - c.el.msgs.scrollTop - c.el.msgs.clientHeight <= 24;
   // A user scroll: the box moves, then the handler runs.
   const userScroll = (c, top) => {
      c.el.msgs.scrollTop = top;
      (c.el.msgs.listeners.scroll || [])[0].call(c.el.msgs);
   };
   // bindEvents wires a dozen elements by id, so they are registered in the shim's
   // id registry first - otherwise it throws on the first missing one and the
   // scroll listener, registered late, is never attached.
   const bound = () => {
      for (const id of ['ami-chat-button', 'ami-close', 'ami-minimize', 'ami-send', 'ami-header', 'ami-badge']) {
         dom.registry[id] = document.createElement('div');
      }
      const c = mkScroll();
      c.el.input = document.createElement('textarea');
      c.el.attachBtn = document.createElement('button');
      c.el.fileInput = document.createElement('input');
      c.el.badge = document.createElement('div');
      c.stageFiles = () => { };
      c.isMobile = () => false;
      c.bindEvents();
      return c;
   };

   const atBottom = bound();
   userScroll(atBottom, atBottom._G.scrollHeight - atBottom._G.clientHeight);
   ok('scrolling all the way down keeps the control hidden',
      atBottom.el.jumpLatest.classList.contains('show') === false);

   // The reported case: a small scroll up.
   const nudged = bound();
   nudged._pinnedToBottom = true;
   userScroll(nudged, nudged._G.scrollHeight - nudged._G.clientHeight - 60);
   ok('scrolling up a little DOES show the control',
      nudged.el.jumpLatest.classList.contains('show') === true);
   ok('and it marks that we are no longer following the conversation',
      nudged._pinnedToBottom === false);

   // The other reported case: the control appearing while Ami is typing.
   const typing = bound();
   typing._pinnedToBottom = true;
   userScroll(typing, typing._G.scrollHeight - typing._G.clientHeight);
   ok('at the bottom it is hidden before typing', typing.el.jumpLatest.classList.contains('show') === false);
   typing.showTyping();
   ok('typing does NOT bring the control back',
      typing.el.jumpLatest.classList.contains('show') === false,
      JSON.stringify(typing.el.jumpLatest.className));

   ok('a reply scrolls the transcript to the bottom', (() => {
      const x = mkScroll();
      x._pinnedToBottom = true;
      x.addMessage('assistant', 'a reply', {});
      return bottom(x) === true;
   })());

   ok('and it lands there without an animation to wait for', (() => {
      const x = mkScroll();
      x._pinnedToBottom = true;
      x.addMessage('assistant', 'a reply', {});
      // No timer pending to release a scroll lock: an instant assignment settles
      // at once, so the position is final on return.
      return x.el.msgs.scrollTop === x._G.scrollHeight;
   })());

   ok('a reply does NOT yank a user who is reading back', (() => {
      const x = mkScroll();
      x._pinnedToBottom = false;
      x.el.msgs.scrollTop = 100;
      x.addMessage('assistant', 'a reply', {});
      return x.el.msgs.scrollTop === 100;
   })());

   ok('the typing indicator leaves the position alone while reading back', (() => {
      const x = mkScroll();
      x._pinnedToBottom = false;
      x.el.msgs.scrollTop = 100;
      x.showTyping();
      return x.el.msgs.scrollTop === 100;
   })());

   // Source-level: the smooth scroll must not come back on the follow path.
   const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('only the explicit jump animates', /scrollDown: function \(opts\)/.test(src) &&
      /if \(opts\.smooth\)/.test(src));
   ok('a live message follows only when pinned',
      /if \(!opts\.quiet && this\._pinnedToBottom !== false\) this\.scrollDown\(\);/.test(src));
   ok('scroll events during our own scroll are ignored by the control',
      /if \(!self\._autoScrolling\)[\s\S]{0,900}toggleJumpToLatest/.test(src));
   // Scoped to the scroll handler, with comments stripped: the fix is explained in
   // a comment that quotes the exact mistake, so matching the raw text trips over
   // its own explanation. `this._pinnedToBottom` in a Widget METHOD is correct -
   // there `this` is the widget; inside a DOM listener it is the element.
   const scrollHandler = (() => {
      const i = src.indexOf("addEventListener('scroll'");
      if (i === -1) return '';
      const end = src.indexOf('}, { passive: true });', i);
      return src.slice(i, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
   })();
   ok('the follow flag is written to the widget, not to the DOM element',
      /self\._pinnedToBottom = atBottom\(\)/.test(scrollHandler) &&
      !/this\._pinnedToBottom/.test(scrollHandler),
      scrollHandler.slice(-120));
      ok('and the scroll lock is released by a timer that holds the widget, not `this`',
         /releaseScrollLock\(widget\)/.test(src) && !/releaseScrollLock\(this\)/.test(src));
   ok('late layout growth re-pins the transcript',
      /ResizeObserver/.test(src) && /gap <= JUMP_TOLERANCE_PX\) m\.scrollTop = m\.scrollHeight/.test(src));
}

console.log('\n[18] The divider appears when the session closes, without a reload');
// Reported as "the ended session didn't show". It was in the database the whole
// time - the server had written the marker - but the user was looking at a panel
// rendered six minutes EARLIER. The server only learns a session has expired on
// the next request, and nothing redrew the transcript until the next history load,
// so at the five-minute mark the conversation simply stopped: the nudge appeared,
// then nothing.
//
// The widget therefore draws the divider itself at the idle threshold. The server
// still persists the marker; this only makes it visible when it happens.
{
   const c = Object.create(W);
   c.el = {
      msgs: document.createElement('div'), win: document.createElement('div'),
      jumpLatest: document.createElement('button'), typing: document.createElement('div')
   };
   c.el.win.appendChild(c.el.msgs);
   c.formatTime = W.formatTime;
   c.userAvatarHtml = () => '';
   c.icons = W.icons;
   c.renderContent = t => t;
   c._idleMs = 5 * 60 * 1000;
   c.markActivity();
   c.addMessage = W.addMessage;
   // A boundary needs conversation on both sides of it. With an empty transcript
   // the timer correctly declines to draw one, so the test seeds a single turn -
   // otherwise it would be asserting the opposite of the intent.
   c.addMessage('user', 'something said', { quiet: true });

   let fired = null;
   // A controllable clock, so the five minutes can be crossed instantly.
   c.armSessionEnd = W.armSessionEnd;
   // Captured BEFORE the swap. Restoring with a bare `setTimeout` would assign the
   // stub back onto itself, leaving the global permanently inert - and every later
   // `await new Promise(r => setTimeout(r, 0))` would then wait forever. That is
   // what hung this suite twice.
   const REAL_SET_TIMEOUT = globalThis.setTimeout;
   globalThis.setTimeout = (fn, ms) => {
      if (ms > 1000 && ms <= 5 * 60 * 1000 + 2000) { fired = fn; return 1; }
      return 0;
   };
   try {
      c.armSessionEnd();
      ok('a timer is armed at the idle threshold', typeof fired === 'function');

      // Still active: the user spoke 10 seconds ago.
      c._lastActivity = Date.now() - 10000;
      fired();
      ok('it does NOT fire while the user is still active',
         c._sessionEnded !== true, String(c._sessionEnded));

      // Genuinely idle.
      c._lastActivity = Date.now() - (6 * 60 * 1000);
      fired();
      ok('it fires once the user is properly idle', c._sessionEnded === true);
      const d = c.el.msgs.children.filter(n => n.className === 'ami-session-end');
      ok('drawing a divider', d.length === 1, 'dividers=' + d.length);
      ok('labelled as the session boundary',
         d[0] && d[0].children[0] && d[0].children[0].textContent === 'Session ended',
         d[0] && d[0].children[0] && JSON.stringify(d[0].children[0].textContent));

      // A second tick must not draw a second divider.
      c._sessionEndTimer = null;
      fired();
      ok('a repeated tick does not stack dividers',
         c.el.msgs.children.filter(n => n.className === 'ami-session-end').length === 1);

      // Replying re-arms rather than leaving a stale timer to fire.
      const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
      ok('every reply re-arms the close timer',
         /armNudge: function \(\)[\s\S]{0,300}this\.armSessionEnd\(\)/.test(src));
      ok('opening the panel arms it too',
         /startIdleWatch: function \(\)[\s\S]{0,900}this\.armSessionEnd\(\)/.test(src));
      ok('reopening the panel re-arms it via stopIdleWatch',
         /stopIdleWatch: function \(\)[\s\S]{0,200}this\.cancelSessionEnd\(\)/.test(src));
      ok('the timer re-checks idleness before drawing, in case a reply slipped in',
         /Date\.now\(\) - \(self\._lastActivity \|\| 0\) < ms\) return;/.test(src));
      // Widened from 4000 to 9000: the wipe sits past several comments and an
      // in-flight guard added since, and a window this tight turns a harmless
      // insertion into a failure that reads like a regression.
      ok('the local divider cannot duplicate the persisted one',
         /loadHistory[\s\S]{0,9000}while \(m\.firstChild\) m\.removeChild\(m\.firstChild\)/.test(src));
   } finally {
      globalThis.setTimeout = REAL_SET_TIMEOUT;
   }
}

console.log('\n[19] Stage directives are not shown as conversation');
// Reported as "the stages messages dont retain". They ARE retained - all 8 were in
// Postgres and reachable by paging - but every one was stored with role `user`,
// because that is how the model reads an instruction. So each rendered in the
// transcript as a user bubble containing the literal instruction:
//
//   [SYSTEM] The user closed the ticket form without submitting. Nothing was
//   filed. Acknowledge briefly and offer to pick it up later.
//
// A user who cancelled the form came back to that in their own speech bubble.
//
// They stay persisted on purpose: the model needs them for continuity, and the
// assistant's acknowledgement is a genuine turn that should survive a reload.
{
   const mkCtx = () => {
      const c = Object.create(W);
      c.el = {
         msgs: document.createElement('div'), win: document.createElement('div'),
         jumpLatest: document.createElement('button'), typing: document.createElement('div')
      };
      c.el.win.appendChild(c.el.msgs);
      c.sessionId = 'remiel.baking'; c.apiUrl = p => 'https://host' + p;
      c.scrollDown = () => { }; c.setIdleMs = () => { }; c.setNudgeMs = () => { };
      c.markActivity = () => { }; c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
      c.icons = W.icons; c.renderContent = t => t;
      c.resetSessionEnd = W.resetSessionEnd;
      c.chronological = W.chronological;
      c.toggleLoadMore = () => { };
      return c;
   };
   const at = (id, role, content) => ({
      id: String(id), role, content, created_at: '2026-10-06T06:0' + (id % 10) + ':00Z'
   });
   const DIRECTIVE = '[SYSTEM] The user closed the ticket form without submitting. ' +
      'Nothing was filed. Acknowledge briefly and offer to pick it up later.';

   // Real rows: the directive with role 'user', bracketed by real turns.
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [
            at(149, 'assistant', 'Right on it! Opening the form.'),
            at(147, 'assistant', 'No worries, Remiel! Looks like you closed it.'),
            at(146, 'user', DIRECTIVE),
            at(145, 'user', 'please open the ticket form')
         ],
         has_more: false, next_before: null, session_ended: false, uploads: []
      })
   });
   const c = mkCtx();
   await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 0)); });

   const texts = c.el.msgs.children.map(n => n.textContent);
   ok('the directive is not rendered at all',
      !texts.some(t => t.indexOf('[SYSTEM]') === 0), texts.join(' | ').slice(0, 200));
   ok('nor does the word SYSTEM leak into the transcript',
      !texts.some(t => /\[SYSTEM\]/.test(t)));
   ok('the surrounding real turns are all still shown', texts.length === 3,
      'rendered=' + texts.length + ' :: ' + texts.join(' | ').slice(0, 160));
   ok('the acknowledgement Ami gave is kept',
      texts.some(t => /closed it/.test(t)));

   // The SECOND render site. The first page hid these and an older page printed
   // them, so a directive filed before the current window surfaced as raw
   // instruction text the moment the user scrolled far enough back.
   const c2 = mkCtx();
   c2.hasMore = true; c2.nextBefore = '140'; c2.loadingOlder = false;
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [at(142, 'user', 'older real message'), at(141, 'user', DIRECTIVE)],
         has_more: false, next_before: null
      })
   });
   await capture(async () => { c2.loadOlder('test'); await new Promise(r => setTimeout(r, 0)); });
   const older = c2.el.msgs.children.map(n => n.textContent);
   ok('an older page hides the directive too',
      !older.some(t => /\[SYSTEM\]/.test(t)), older.join(' | ').slice(0, 160));
   ok('while still rendering the real message beside it',
      older.some(t => /older real message/.test(t)));

   // A marker on an older page must go ABOVE what is already on screen - it marks
   // a boundary being scrolled back towards, not something that just happened.
   const c3 = mkCtx();
   c3.hasMore = true; c3.nextBefore = '140'; c3.loadingOlder = false;
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [
            at(141, 'user', 'older real message'),
            at(140, 'system', '[ended session]')
         ],
         has_more: false, next_before: null
      })
   });
   // Seed one message so "before the existing content" is observable.
   c3.addMessage('user', 'already on screen', { quiet: true });
   await capture(async () => { c3.loadOlder('test'); await new Promise(r => setTimeout(r, 0)); });
   const order = c3.el.msgs.children.map(n => n.textContent);
   ok('a marker on an older page is inserted at the top, not appended',
      order.length === 3 && /Session ended/.test(order[0]) && /already on screen/.test(order[2]),
      order.join(' | ').slice(0, 160));

   // And the directive must still reach the model.
   const replySrc = fsSync.readFileSync(
      process.cwd() + '/src/server/services/chat/stage.reply.ts', 'utf8');
   ok('the directive is only hidden from the VIEW, not from the model',
      /\.filter\(m => m\.role !== 'system'\)/.test(replySrc));
   ok('the filter does not exclude the [SYSTEM] rows the model needs',
      !/\[SYSTEM\]/.test(replySrc) && !/isStageDirective/.test(replySrc));
}

console.log('\n[20] The closed-session divider survives, the form is not idleness, and jump floats');
// Reported: "I can't see it live but I can after refreshing".
//
// The divider WAS drawn live, and then removed. checkIdle polls every 60s and
// retires any divider once `idleFor >= idleMs()` - which is the exact instant the
// widget draws it. So it appeared and vanished inside a minute, and only came back
// on refresh, when the server's persisted marker replayed it.
{
   const mkCtx = () => {
   const c = Object.create(W);
   c.el = {
      msgs: document.createElement('div'), win: document.createElement('div'),
      jumpLatest: document.createElement('button'), typing: document.createElement('div')
   };
   c.el.win.appendChild(c.el.msgs);
   c.formatTime = W.formatTime;
   c.userAvatarHtml = () => '';
   c.icons = W.icons;
   c.renderContent = t => t;
   c._idleMs = 5 * 60 * 1000;
   c.markActivity();
   c.addMessage = W.addMessage;
   // A boundary needs conversation on both sides of it. With nothing in the
   // transcript the timer correctly declines to draw one, so the test seeds a
   // single turn - otherwise it would be asserting the opposite of the intent.
   c.addMessage('user', 'something said', { quiet: true });
      return c;
   };

   const c = mkCtx();
   c.addSessionEnd({ now: true, final: true });
   ok('a divider drawn at close time is present', c._sessionEnded === true);
   ok('and it is flagged as the real boundary', c._sessionEndFinal === true);
   // The poller fires a minute later, with idle well past the threshold.
   c._lastActivity = Date.now() - (10 * 60 * 1000);
   const retired = c.checkIdle();
   ok('the idle poller leaves it alone', retired === false && c._sessionEnded === true,
      'retired=' + retired);
   ok('and the divider is still in the transcript',
      c.el.msgs.children.filter(n => n.className === 'ami-session-end').length === 1);
   c.resetSessionEnd();
   ok('resetting clears the final flag too',
      c._sessionEnded === false && c._sessionEndFinal === false);

   // The form is activity, not silence.
   const f = mkCtx();
   f.armSessionEnd = () => { };
   f.cancelSessionEnd = () => { };
   f.cancelNudge = () => { };
   f.armNudge = () => { };
   f._suspendIdle('ticket form');
   ok('opening the form suspends the close timer', f._idleSuspended === true);
   f._lastActivity = Date.now() - (4 * 60 * 1000);   // four minutes inside the form
   f._resumeIdle('ticket form');
   ok('closing it restarts the clocks', f._idleSuspended === false);
   ok('and counts as activity', Date.now() - f._lastActivity < 2000);
   ok('the clocks really do come back',
      f._idleSuspended === false && f._nudgeFired === false &&
      Date.now() - f._lastActivity < 2000,
      'suspended=' + f._idleSuspended + ' nudgeFired=' + f._nudgeFired);

   // The suspend and resume keys MUST match. They once read 'ticket form open'
   // and 'ticket form closed', so the resume silently matched nothing and the
   // clocks stayed paused for the rest of the session.
   const src0 = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   const suspendKeys = [...src0.matchAll(/_suspendIdle\(([^)]*)\)/g)].map(m => m[1]);
   const resumeKeys = [...src0.matchAll(/_resumeIdle\(([^)]*)\)/g)].map(m => m[1]);
   ok('suspend and resume use the same key',
      suspendKeys.length > 0 && suspendKeys.length === resumeKeys.length &&
      suspendKeys.every((k, i) => k === resumeKeys[i]),
      JSON.stringify({ suspendKeys, resumeKeys }));
   ok('and it is a single shared constant, not two literals',
      /var SESSION_SUSPEND_LABEL = 'ticket-form';/.test(src0));

   const g = mkCtx();
   g.armSessionEnd = () => { }; g.cancelSessionEnd = () => { };
   g.cancelNudge = () => { }; g.armNudge = () => { };
   g._suspendIdle('a');
   g._suspendIdle('b');
   g._resumeIdle('a');
   ok('nested suspensions do not resume each other', g._idleSuspended === true);
   g._resumeIdle('b');
   ok('the last one to clear lifts the suspension', g._idleSuspended === false);
   g._resumeIdle('a');
   ok('resuming something that is not suspended is harmless', g._idleSuspended === false);

   const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('the form suspends on open and resumes on close',
      /openTicketModal[\s\S]{0,900}_suspendIdle\(SESSION_SUSPEND_LABEL\)/.test(src) &&
      /onClose[\s\S]{0,700}_resumeIdle\(SESSION_SUSPEND_LABEL\)/.test(src));
   // The live draws used to call addSessionEnd directly, which is why the badge
   // also fired on REPLAYED history. They now route through showSessionEnded, the
   // one place that decides what ending a session looks like AND notifies.
   ok('the live close timer draws the boundary through showSessionEnded',
      /showSessionEnded\(\{ fromServer: false \}\)/.test(src));
   ok('showSessionEnded marks it final so the poller leaves it alone',
      /final: opts\.final !== false/.test(src) &&
      /if \(this\._sessionEndFinal\) return false;/.test(src));
   ok('and the poller is told to skip it',
      /if \(this\._sessionEndFinal\) return false;/.test(src));

   const css = fsSync.readFileSync(process.cwd() + '/public/widget.css', 'utf8');
      ok('a zero-height anchor, NOT the input area, carries the control',
         /\.ami-jump-anchor \{[^}]*position:\s*relative[^}]*height:\s*0/.test(css));
      ok('the input area cannot anchor it - its overflow would clip it away',
         !/#ami-input-area \{[^}]*position:\s*relative/.test(css) &&
         /#ami-input-area \{[^}]*overflow-y:\s*auto/.test(css));
      ok('the control floats above the anchor',
         /\.ami-jump-latest \{[^}]*position:\s*absolute/.test(css) &&
         /\.ami-jump-latest \{[^}]*bottom:\s*var\(--space-2\)/.test(css) &&
         !/\.ami-jump-latest \{[^}]*bottom:\s*100%/.test(css));
      ok('centred over it, and not in the flex flow',
         /left:\s*50%/.test(css) && /transform:\s*translateX\(-50%\)/.test(css) &&
         !/\.ami-jump-latest \{[^}]*flex:\s*0 0 auto/.test(css));
      ok('and is lifted clear of the transcript',
         /\.ami-jump-latest \{[^}]*z-index:\s*4/.test(css));
      ok('the anchor wraps the button, as a sibling of the input area',
         /class="ami-jump-anchor"[\s\S]{0,200}id="ami-jump-latest"/.test(src) &&
         /class="ami-jump-anchor"[\s\S]{0,400}id="ami-input-area"/.test(src));
}

console.log('\n[21] A page scrolled back lands in the right ORDER');
// Prepending a whole page reversed it.
//
// `chronological()` correctly sorts the server's newest-first page oldest-first,
// and then `prependMessage` inserted each row above the previous one - because
// the page is walked oldest-first, the last row processed (the NEWEST) ended up
// on top. A page of ten scrolled-back messages rendered upside down.
//
// Section 8 never caught it because it prepends a single message, where
// "prepend" and "reverse" are indistinguishable.
{
   const c = Object.create(W);
   c.el = { msgs: document.createElement('div'), win: document.createElement('div') };
   c.el.win.appendChild(c.el.msgs);
   c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
   c.icons = W.icons; c.renderContent = t => t;
   c.scrollDown = () => {};
   c.chronological = W.chronological;
   c.resetSessionEnd = () => {}; c.toggleLoadMore = () => {};
   c.hasMore = true; c.nextBefore = '140'; c.loadingOlder = false;
   c.sessionId = 'x'; c.apiUrl = p => 'https://host' + p;

   // What is already on screen, then the page that arrives - EXACTLY as the
   // endpoint returns it: ORDER BY id DESC.
   c.addMessage('user', 'existing-NEWEST', { quiet: true });
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [
            { id: '134', role: 'assistant', content: 'page-NEWEST', created_at: '2026-10-06T06:00:00Z' },
            { id: '133', role: 'user', content: 'page-3', created_at: '2026-10-06T06:00:00Z' },
            { id: '132', role: 'assistant', content: 'page-2', created_at: '2026-10-06T06:00:00Z' },
            { id: '131', role: 'user', content: 'page-OLDEST', created_at: '2026-10-06T06:00:00Z' }
         ],
         has_more: false, next_before: null
      })
   });
   await capture(async () => { c.loadOlder('test'); await new Promise(r => setTimeout(r, 0)); });

   const order = c.el.msgs.children.map(n => n.children[1].children[0].textContent);
   ok('the scrolled-back page reads oldest to newest',
      JSON.stringify(order) === JSON.stringify(
         ['page-OLDEST', 'page-2', 'page-3', 'page-NEWEST', 'existing-NEWEST']),
      order.join(' | '));
   ok('every row from the page is present', order.length === 5, 'rows=' + order.length);
   ok('and nothing from the page landed after what was already there',
      order.indexOf('page-OLDEST') < order.indexOf('existing-NEWEST'));

   // Two pages in a row must still read in order.
   c.hasMore = true; c.nextBefore = '131';
   globalThis.fetch = async () => ({
      status: 200, statusText: 'OK',
      headers: { get: () => 'application/json' },
      json: async () => ({
         messages: [
            { id: '131', role: 'user', content: 'older-NEWEST', created_at: '2026-10-06T06:00:00Z' },
            { id: '130', role: 'assistant', content: 'older-OLDEST', created_at: '2026-10-06T06:00:00Z' }
         ],
         has_more: false, next_before: null
      })
   });
   await capture(async () => { c.loadOlder('test'); await new Promise(r => setTimeout(r, 0)); });
   const two = c.el.msgs.children.map(n => n.children[1].children[0].textContent);
   ok('a second page stacks above the first, still in order',
      two[0] === 'older-OLDEST' && two[1] === 'older-NEWEST' &&
      two[2] === 'page-OLDEST' && two[two.length - 1] === 'existing-NEWEST',
      two.join(' | '));

   const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('the batch takes one anchor before the loop',
      /var anchor = m\.firstChild;/.test(src));
   ok('and every row in the page is inserted against it',
      /prependMessage\(msg\.role, msg\.content, msg\.timestamp, msg\.timestamp, anchor\)/.test(src));
}

console.log('\n[22] Idle cycles do not stack dividers');
// An abandoned tab produced SEVEN "Session ended" dividers in one thread, and
// then the newest row was a divider - so the transcript opened scrolled to the
// bottom onto nothing but "Session ended", which read as "my whole conversation
// is gone".
//
// A boundary between two conversations means nothing when there is no second
// conversation, so both the server and the widget now decline to add one unless
// something was actually said since the last boundary.
{
   const { Pool } = await import('pg');
   const c = Object.create(W);
   c.el = {
      msgs: document.createElement('div'), win: document.createElement('div'),
      jumpLatest: document.createElement('button'), typing: document.createElement('div')
   };
   c.el.win.appendChild(c.el.msgs);
   c.formatTime = W.formatTime; c.userAvatarHtml = () => '';
   c.icons = W.icons; c.renderContent = t => t;
   c.scrollDown = () => {}; c.markActivity = () => {};
   c.addMessage = W.addMessage;
   const divider = () => c.el.msgs.children.filter(n => n.className === 'ami-session-end').length;

   // Nothing said since the last boundary: no new divider.
   c.addMessage('user', 'a turn', { quiet: true });
   c.addSessionEnd({ now: true, final: true });
   ok('a boundary is drawn after a real turn', divider() === 1);
   ok('and it is not drawn again while nothing else is said',
      c.hasSpokenSinceLastEnd() === false);
   c.addSessionEnd({ now: true, final: true, replay: true });
   ok('so an idle cycle cannot stack a second one directly above it', divider() === 2,
      'dividers=' + divider());

   // Something said since: a new boundary is legitimate.
   const c2 = Object.create(c);
   c2.el = { msgs: document.createElement('div'), jumpLatest: document.createElement('button'), typing: document.createElement('div') };
   c2.el.msgs.appendChild(document.createElement('div'));
   c2.el.msgs.children[0].className = 'ami-msg-row user';
   c2.addSessionEnd({ now: true, final: true });
   ok('after a new turn a boundary is allowed again',
      c2.hasSpokenSinceLastEnd() === true);

   const serverSrc = fsSync.readFileSync(
      process.cwd() + '/src/server/services/session-lifecycle.service.ts', 'utf8');
   const widgetSrc = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
   ok('the server applies the same rule',
      /const sinceLastMarker = conv\.messages[\s\S]{0,200}if \(sinceLastMarker\)/.test(serverSrc));
   ok('and both sides agree on what counts as conversation since the boundary',
      /\.role === 'user' \|\| m\.role === 'assistant'/.test(serverSrc) &&
      /cls\.indexOf\('ami-msg-row'\) !== -1/.test(widgetSrc));
}

console.log('\n[23] The inferred session-ended divider survives the idle poller');
// When the server returns session_ended: true WITHOUT a replayed marker row
// (the server just expired it and hasn't persisted the row to this page yet),
// loadHistory draws a final divider. That divider must NOT be retired by the
// 60s idle check on the next cycle - "I can't see it live but I can after
// refreshing" if it is.
{
    const c = Object.create(W);
    c.el = {
        msgs: document.createElement('div'), win: document.createElement('div'),
        jumpLatest: document.createElement('button'), typing: document.createElement('div')
    };
    c.el.win.appendChild(c.el.msgs);
    c.formatTime = W.formatTime;
    c.userAvatarHtml = () => '';
    c.icons = W.icons;
    c.renderContent = t => t;
    c.scrollDown = () => {};
    c.setIdleMs = W.setIdleMs;
    c.setNudgeMs = W.setNudgeMs;
    c.markActivity = W.markActivity;
    c.chronological = W.chronological;
    c.resetSessionEnd = W.resetSessionEnd;
    c.addSessionEnd = W.addSessionEnd;
    c.addMessage = W.addMessage;
    c._idleMs = 5 * 60 * 1000;

    globalThis.fetch = async () => ({
        ok: true, status: 200, statusText: 'OK',
        headers: { get: () => 'application/json' },
        json: async () => ({
            messages: [
                { role: 'assistant', content: 'last reply', created_at: '2026-01-01T09:00:00Z', timestamp: '2026-01-01T09:00:00Z' },
                { role: 'user', content: 'a question', created_at: '2026-01-01T08:00:00Z', timestamp: '2026-01-01T08:00:00Z' }
            ],
            has_more: false, next_before: null,
            session_ended: true, uploads: [], goodbye: null, greeting: null
        })
    });
    c.apiUrl = () => '/api/history/x';
    c.sessionId = 'test';
    c.el.status = document.createElement('span');
    c.setStatus = function (t) { c.el.status.textContent = t; };

    await capture(async () => { c.loadHistory(); await new Promise(r => setTimeout(r, 20)); });

    const dividers = c.el.msgs.children.filter(n => n.className === 'ami-session-end');
    ok('loadHistory draws a divider for session_ended:true', dividers.length === 1,
        'dividers=' + dividers.length);
    ok('the inferred divider is flagged final', c._sessionEndFinal === true,
        'final=' + c._sessionEndFinal);

    // Push idle well past the threshold and run the poller.
    c._lastActivity = Date.now() - (10 * 60 * 1000);
    const retired = c.checkIdle();
    ok('checkIdle leaves the final divider in place', retired === false && c._sessionEnded === true,
        'retired=' + retired);
    ok('the divider is still on screen', c.el.msgs.children.filter(n => n.className === 'ami-session-end').length === 1);
}

console.log('\n[24] The idle poller draws a divider when the one-shot timer was killed');
// Background-tab throttling can prevent armSessionEnd's setTimeout from firing.
// The 60s poller must draw the divider as a safety net so the boundary still
// appears without a refresh.
{
    const c = Object.create(W);
    c.el = {
        msgs: document.createElement('div'), win: document.createElement('div'),
        jumpLatest: document.createElement('button'), typing: document.createElement('div')
    };
    c.el.win.appendChild(c.el.msgs);
    c.formatTime = W.formatTime;
    c.userAvatarHtml = () => '';
    c.icons = W.icons;
    c.renderContent = t => t;
    c.scrollDown = () => {};
    c.setIdleMs = W.setIdleMs;
    c.setNudgeMs = W.setNudgeMs;
    c.markActivity = W.markActivity;
    c.addMessage = W.addMessage;
    c.addSessionEnd = W.addSessionEnd;
    c.hasSpokenSinceLastEnd = W.hasSpokenSinceLastEnd;
    c._idleMs = 5 * 60 * 1000;
    c._lastActivity = Date.now() - (6 * 60 * 1000);

    // A single turn so hasSpokenSinceLastEnd() returns true, but NO divider yet.
    c.addMessage('user', 'said something', { quiet: true });
    ok('no divider before the poll', c._sessionEnded === false);
    ok('there is conversation to bound', c.hasSpokenSinceLastEnd() === true);

    const drew = c.checkIdle();
    ok('the safety-net draw fires', c._sessionEnded === true, 'sessionEnded=' + c._sessionEnded);
    ok('the divider is on screen', c.el.msgs.children.filter(n => n.className === 'ami-session-end').length === 1);
    ok('it is flagged final so the next poll does not retire it', c._sessionEndFinal === true);

    // A second poll must not stack a second divider.
    c.checkIdle();
    ok('no duplicate after a second poll', c.el.msgs.children.filter(n => n.className === 'ami-session-end').length === 1);

    // Suspended (ticket form open): safety-net draw must NOT fire.
    const f = Object.create(c);
    f.el = { msgs: document.createElement('div') };
    f._idleSuspended = true;
    f._sessionEnded = false; f._sessionEndedNode = null; f._sessionEndFinal = false;
    f._lastActivity = Date.now() - (6 * 60 * 1000);
    f.scrollDown = () => {};
    f.hasSpokenSinceLastEnd = W.hasSpokenSinceLastEnd;
    f.addSessionEnd = W.addSessionEnd;
    f.idleMs = W.idleMs;
    f.formatTime = W.formatTime;
    f.el.msgs.appendChild(document.createElement('div')).className = 'ami-msg-row user';
    f.checkIdle();
    ok('suspended idle does not draw a divider', f._sessionEnded === false,
        'sessionEnded=' + f._sessionEnded);
}

console.log('\n[25] Minimising the panel must not restart the countdown');
// The whole point of keeping the timer alive across close() is that a user who
// hides the panel and walks away comes back to a "Session ended" divider. It was
// undone one line below the fix that disabled the cancel:
//
//    this.cancelNudge();
//    this.markActivity();      <-- hiding the panel is not activity
//
// markActivity() pushed _lastActivity to now AND re-armed the full period, so
// every minimise bought another five minutes. The boundary could then never
// arrive while the panel was closed - precisely the case the timer exists for.
{
    const c = Object.create(W);
    c.isOpen = true;
    c._idleMs = 5 * 60 * 1000;
    c._lastActivity = Date.now() - (4 * 60 * 1000);   // four minutes of silence
    let cancelled = 0;
    c.cancelNudge = () => { cancelled++; };
    c.cancelSessionEnd = () => { cancelled += 100; };
    c.markActivity = () => { c._lastActivity = Date.now(); };
    c.el = {
        win: document.createElement('div'), badge: document.createElement('div')
    };
    c.el.win.style.display = 'flex';

    const before = c._lastActivity;
    c.close();
    ok('hiding the panel does not count as activity', c._lastActivity === before,
        'advanced by ' + (c._lastActivity - before) + 'ms');
    ok('and the boundary is already inside the idle window',
        Date.now() - c._lastActivity >= 4 * 60 * 1000);
    ok('the close timer survives the panel being closed', cancelled === 1,
        'cancel calls=' + cancelled);
    ok('only the nudge is cancelled - nobody answers it about a hidden panel',
        c._nudgeFired === false);

    const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
    const closeBody = (src.match(/close: function \(\) \{[\s\S]*?\n    \},/) || [''])[0];
    // Strip comments first: the body explains at length why it used to call
    // `markActivity()` and `cancelSessionEnd()`, so a naive scan of the text
    // finds both names and fails for the wrong reason.
    const code = closeBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    ok('close() never cancels the session-end poller',
        !/cancelSessionEnd/.test(code));
    ok('close() never marks activity',
        !/markActivity/.test(code));
}

console.log('\n[26] A refresh adopts the server clock instead of resetting it');
// Both history branches called markActivity(), which set _lastActivity to now.
// The server does not expire on that - it expires on the persisted last_seen and
// deliberately does not touch it on a history read - so reloading at minute four
// handed the user a brand new five minutes client-side while the server was still
// counting down. The boundary then fired late, or never.
{
    const mkCtx = () => {
        const c = Object.create(W);
        c._idleMs = 5 * 60 * 1000;
        c._lastActivity = 0;
        c.armSessionEnd = () => { };
        c.markActivity = W.markActivity;
        c.idleMs = W.idleMs;
        c.setIdleMs = W.setIdleMs;
        c.setIdleRemaining = W.setIdleRemaining;
        c.armNudge = () => { };
        return c;
    };

    const four = mkCtx();
    four.setIdleRemaining(60 * 1000);           // one minute of a five-minute period left
    const elapsed = Date.now() - four._lastActivity;
    ok('60s remaining back-dates activity by 4 minutes',
        elapsed > (3.9 * 60 * 1000) && elapsed <= (4 * 60 * 1000),
        'elapsed=' + elapsed);
    ok('so the existing checks see the session as four minutes idle',
        Date.now() - four._lastActivity >= four.idleMs() - 60 * 1000);

    const over = mkCtx();
    over.setIdleRemaining(0);
    ok('0s remaining back-dates by the FULL period, so it fires at once',
        Date.now() - over._lastActivity >= over.idleMs(),
        'elapsed=' + (Date.now() - over._lastActivity));

    const fresh = mkCtx();
    fresh.setIdleRemaining(fresh.idleMs());
    ok('a full period remaining means "active just now"',
        Date.now() - fresh._lastActivity < 2000);

    const missing = mkCtx();
    missing.setIdleRemaining(undefined);
    ok('an older server that sends nothing falls back to a local reset',
        Date.now() - missing._lastActivity < 2000);

    const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
    ok('both history branches adopt the server remaining time',
        (src.match(/setIdleRemaining\(d\.idle_remaining_ms\)/g) || []).length === 2,
        'call sites=' + (src.match(/setIdleRemaining\(d\.idle_remaining_ms\)/g) || []).length);
    ok('and neither of them resets the clock locally any more',
        !/loadHistory[\s\S]{0,9000}setNudgeMs\(d\.nudge_ms\);\s*\n\s*self\.markActivity\(\)/.test(src));
}

console.log('\n[27] Unread cues fire on live events, never on replayed history');
// Badging lived inside addSessionEnd, which is also what loadHistory calls to
// REPLAY persisted `[ended session]` rows - while the panel is closed, on every
// page load. So any session that had ever ended showed a permanent "1", and the
// count climbed with the number of boundaries. Same root cause for the title.
{
    const mkCtx = (open) => {
        const c = Object.create(W);
        c.isOpen = open;
        c.unread = 0;
        c._seenEndKeys = {};
        c.el = {
            msgs: document.createElement('div'), win: document.createElement('div'),
            badge: document.createElement('div'), typing: document.createElement('div')
        };
        c.el.win.appendChild(c.el.msgs);
        c.formatTime = W.formatTime;
        c.scrollDown = () => { };
        c.addSessionEnd = W.addSessionEnd;
        c.showSessionEnded = W.showSessionEnded;
        c.notifyUnread = W.notifyUnread;
        c.flashTitle = W.flashTitle;
        c.restoreTitle = W.restoreTitle;
        c._idleMs = 5 * 60 * 1000;
        c._lastActivity = Date.now();
        c._sessionEnded = false;
        c._sessionEndedNode = null;
        c._sessionEndFinal = false;
        c._markerRetired = false;
        return c;
    };

    // Pinned, not whatever the shim happens to start with: the shim's document
    // has no `title` until something assigns one, and asserting against an
    // undefined baseline tests the harness rather than the widget.
    document.title = 'Ami Helpdesk';
    const baseTitle = document.title;

    const hidden = mkCtx(false);
    hidden.showSessionEnded({ fromServer: false });
    ok('a live boundary while hidden badges', hidden.unread === 1);
    ok('and flashes the tab title',
        /^\(1\)/.test(document.title), document.title);
    hidden.restoreTitle();
    ok('restoring puts the real title back', document.title === baseTitle);

    // The regression: three historical boundaries replayed on page load.
    const replay = mkCtx(false);
    for (let i = 0; i < 3; i++) {
        replay.addSessionEnd({ time: new Date().toISOString(), replay: true });
    }
    ok('replaying history draws every divider',
        replay.el.msgs.children.filter(n => n.className === 'ami-session-end').length === 3);
    ok('but badges NOT AT ALL - no unread from history',
        replay.unread === 0, 'unread=' + replay.unread);
    ok('and does not touch the title', !/^\(\d+\)/.test(document.title));
    ok('and the badge stays hidden', replay.el.badge.style.display !== 'block');

    // Dedup is on the EXACT boundary. "Any divider exists" would refuse the
    // second real boundary, which only reappears after a reload - the bug.
    const two = mkCtx(true);
    two.showSessionEnded({ fromServer: false, markerKey: 'm1', time: '2026-01-01T00:00:00Z' });
    const first = two.el.msgs.children.filter(n => n.className === 'ami-session-end').length;
    two.showSessionEnded({ fromServer: false, markerKey: 'm1', time: '2026-01-01T00:00:00Z' });
    ok('the SAME boundary is not drawn twice',
        two.el.msgs.children.filter(n => n.className === 'ami-session-end').length === first);
    two.showSessionEnded({ fromServer: false, markerKey: 'm2', time: '2026-01-01T05:00:00Z' });
    ok('a DIFFERENT boundary IS drawn - two real ends, two dividers',
        two.el.msgs.children.filter(n => n.className === 'ami-session-end').length === first + 1);

    const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
    ok('addSessionEnd no longer touches the badge at all',
        !/addSessionEnd: function \([\s\S]{0,1800}this\.unread/.test(src));
    ok('notifyUnread refuses while the panel is open',
        /notifyUnread: function \([\s\S]{0,200}if \(this\.isOpen\) return;/.test(src));
    ok('and the instance is reachable, so an external trigger has something to call',
        /instance: function \(\) \{ return this\._instance \|\| null; \}/.test(src));
}

console.log('\n[29] A reload comes back to where the user was');
{
    // The panel always booted closed and loadHistory always scrollDown()'d, so
    // reloading the MIS page while reading a long thread threw away both the open
    // panel and the scroll position - and on an embedded widget an accidental
    // refresh is easy, which made it most of the session.
    const c = Object.create(W);
    c.loginUser = 'remiel.baking';
    c.el = { msgs: document.createElement('div') };
    c.el.msgs.scrollHeight = 2000;
    c.el.msgs.clientHeight = 400;
    c.el.msgs.scrollTop = 900;             // scrolled back, not at the bottom
    c._pinnedToBottom = true;
    c.readViewState = W.readViewState;
    c.writeViewState = W.writeViewState;
    c.rememberScroll = W.rememberScroll;
    c.restoreScroll = W.restoreScroll;

    c.rememberScroll();
    const saved = JSON.parse(sessionStorage.getItem('ami_view_remiel.baking'));
    ok('the scroll position is remembered', saved && saved.scroll === 900,
        JSON.stringify(saved));

    // Keyed per login, so two people on one machine do not inherit each other.
    // Enumerated through the storage API rather than Object.keys, which on a real
    // Storage object returns nothing at all - it exposes length and key(i).
    const storedKeys = [];
    for (let i = 0; i < sessionStorage.length; i++) storedKeys.push(sessionStorage.key(i));
    ok('and keyed on the login, not globally',
        storedKeys.some(k => k.indexOf('ami_view_remiel.baking') === 0),
        JSON.stringify(storedKeys));

    c.restoreScroll();
    ok('the position is restored on reload', c.el.msgs.scrollTop === 900,
        'scrollTop=' + c.el.msgs.scrollTop);
    ok('and reading history means not pinned to the bottom, so a reply will not drag them away',
        c._pinnedToBottom === false);

    // At the bottom there is nothing to restore - that is where the newest message
    // is - and remembering an offset would fight it.
    const atBottom = Object.create(W);
    atBottom.loginUser = 'remiel.baking';
    atBottom.el = { msgs: c.el.msgs };
    atBottom.el.msgs.scrollTop = 1600;    // scrollHeight 2000 - clientHeight 400 = 1600
    atBottom.readViewState = W.readViewState;
    atBottom.writeViewState = W.writeViewState;
    atBottom.rememberScroll = W.rememberScroll;
    atBottom.rememberScroll();
    ok('no position is stored when already at the bottom',
        JSON.parse(sessionStorage.getItem('ami_view_remiel.baking')).scroll === null);

    // Clamped, so a shorter transcript cannot leave them scrolled past the end -
    // which happens whenever the older pages they had scrolled through are no
    // longer loaded (a fresh page, one page of ten).
    sessionStorage.setItem('ami_view_remiel.baking', JSON.stringify({ scroll: 900 }));
    const shrunk = Object.create(W);
    shrunk.loginUser = 'remiel.baking';
    shrunk.el = { msgs: document.createElement('div') };
    shrunk.el.msgs.scrollHeight = 500;
    shrunk.el.msgs.clientHeight = 400;
    shrunk._pinnedToBottom = true;
    shrunk.readViewState = W.readViewState;
    shrunk.restoreScroll = W.restoreScroll;
    shrunk.restoreScroll();
    ok('and clamped to what is actually scrollable',
        shrunk.el.msgs.scrollTop === 100, 'scrollTop=' + shrunk.el.msgs.scrollTop);

    const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
    ok('opening the panel records that it is open', /open: true/.test(src));
    ok('closing records it is closed AND remembers the position',
        /rememberScroll\(\);[\s\S]{0,120}open: false/.test(src));
    ok('a boot while it was open reopens it',
        /readViewState\(\)\.open/.test(src));
}

console.log('\n[30] One history load at a time');
{
    // discover() and open() both fire loadHistory(). Click the launcher during
    // base discovery and open() issued its request against an empty apiBase(),
    // which resolves against the embedding page and fails - silently, since the
    // catch only writes to the history debug log.
    const src = fsSync.readFileSync(process.cwd() + '/public/widget/main.js', 'utf8');
    ok('loadHistory refuses to start a second load',
        /if \(this\._historyPending\) return this\._historyPending;/.test(src));
    ok('and clears the guard in BOTH outcomes, so a failed load can be retried',
        /\.then\(function \(\) \{ self\._historyPending = null; \},\s*\n\s*function \(\) \{ self\._historyPending = null; \}\)/.test(src));
    ok('returning the promise lets callers await it', /return this\._historyPending;/.test(src));

    const c = Object.create(W);
    let calls = 0;
    c._historyPending = Promise.resolve({ ok: 1 });
    const first = c._historyPending;
    // Simulate the guard body without a network: the point is that a second call
    // while one is in flight is a no-op.
    const guarded = (self) => {
        if (self._historyPending) return self._historyPending;
        calls++;
        return Promise.resolve({});
    };
    ok('a second call returns the in-flight promise',
        guarded(c) === first);
    ok('and does not start another fetch', calls === 0);
}

console.log('\n[28] The lightbox never parses a filename as HTML');
// `caption` is the user's own uploaded filename and was concatenated raw into an
// innerHTML string, so a crafted name executed script in the MIS page's origin on
// a single click. Both copies of the helper had it.
{
    for (const file of ['main.js', 'ui.js']) {
        const src = fsSync.readFileSync(process.cwd() + '/public/widget/' + file, 'utf8');
        ok(file + ' does not build the lightbox with innerHTML',
            !/ami-lb-caption' \+/.test(src) && !/l\.innerHTML = '<img src="/.test(src));
        ok(file + ' sets the caption with textContent instead',
            /cap\.textContent = String\(caption\)/.test(src));
    }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
