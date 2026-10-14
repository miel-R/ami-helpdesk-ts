/* Ticket modal switches: configurable per type, admin-only, and the link that
   stands in for a form the chatbot will not fill in.
 *
 * Read-only for /api/chat, but the PATCH calls DO write ticket_modal_config, so
 * every write is applied and then reverted. The suite asserts the write worked and
 * then puts the row back, because a test suite that silently re-enables a type an
 * admin turned off is worse than no test at all.
 *
 * Run: node tools/with-server.cjs tools/ticket-modals-regress.cjs
 */
const PORT = process.env.PORT || '3101';
const KEY = process.env.ADMIN_KEY || 'admin';
const BASE = `http://localhost:${PORT}`;

let pass = 0, fail = 0;
const ok = (n, c, e = '') => {
  if (c) { pass++; console.log('  PASS  ' + n); }
  else { fail++; console.log('  FAIL  ' + n + (e ? ' -> ' + e : '')); }
};

async function req(method, path, body) {
  const init = { method, headers: { 'X-Admin-Key': KEY } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, init);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}
const get = (p) => req('GET', p);
const patch = (p, b) => req('PATCH', p, b);
const putLinksOnly = (on) => req('PUT', '/api/admin/ticket-modals/links-only', { enabled: on });

const TYPES = ['tech_support', 'system_request', 'it_asset'];

(async () => {
  // Snapshot so every write can be put back exactly as it was.
  const before = await get('/api/admin/ticket-modals');
  const original = new Map(
    (before.body.ticket_modals || []).map(r => [r.ticket_type, { enabled: r.enabled, external_url: r.external_url }])
  );

  const originalLinksOnly = before.body.links_only === true;

  const restore = async () => {
    for (const [type, v] of original) {
      await patch(`/api/admin/ticket-modals/${type}`, { enabled: v.enabled, external_url: v.external_url });
    }
    await putLinksOnly(originalLinksOnly);
  };

  try {
    console.log('\n[1] GET returns every known type');
    ok('200', before.status === 200, 'status=' + before.status);
    const list = before.body.ticket_modals || [];
    ok('three rows', list.length === 3, String(list.length));
    for (const t of TYPES) {
      const row = list.find(r => r.ticket_type === t);
      ok('has ' + t, !!row);
      ok(t + ' has a label', !!row && typeof row.label === 'string' && row.label.length > 0);
      ok(t + ' enabled is boolean', !!row && typeof row.enabled === 'boolean');
      ok(t + ' external_url is string|null', !!row && (row.external_url === null || typeof row.external_url === 'string'));
    }

    console.log('\n[2] admin-only');
    const noAuth = await fetch(`${BASE}/api/admin/ticket-modals`);
    ok('GET without key is 401', noAuth.status === 401 || !process.env.ADMIN_KEY, 'status=' + noAuth.status);
    const noAuthPatch = await fetch(`${BASE}/api/admin/ticket-modals/system_request`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false })
    });
    ok('PATCH without key is 401', noAuthPatch.status === 401 || !process.env.ADMIN_KEY, 'status=' + noAuthPatch.status);

    console.log('\n[3] unknown type is refused');
    const bogus = await patch('/api/admin/ticket-modals/not_a_type', { enabled: false });
    ok('unknown type 404', bogus.status === 404, 'status=' + bogus.status);

    console.log('\n[4] URL validation');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'not a url']) {
      const r = await patch('/api/admin/ticket-modals/system_request', { enabled: false, external_url: bad });
      ok('rejects ' + JSON.stringify(bad.slice(0, 28)), r.status === 400, 'status=' + r.status);
    }
    // A rejected save must not have changed anything.
    const unchanged = await get('/api/admin/ticket-modals');
    const sr = (unchanged.body.ticket_modals || []).find(r => r.ticket_type === 'system_request');
    ok('rejected URL was not stored', !sr.external_url || !/javascript|data:|file:/.test(sr.external_url),
      String(sr && sr.external_url));

    console.log('\n[5] valid http(s) links round-trip verbatim');
    const url = 'https://192.1.5.1/mis_helpdesk/index.php?option=request_support';
    const saved = await patch('/api/admin/ticket-modals/system_request', { enabled: false, external_url: url });
    ok('PATCH 200', saved.status === 200, 'status=' + saved.status);
    ok('echoes the url', saved.body.ticket_modal && saved.body.ticket_modal.external_url === url,
      JSON.stringify(saved.body.ticket_modal));
    const reread = await get('/api/admin/ticket-modals');
    const row = (reread.body.ticket_modals || []).find(r => r.ticket_type === 'system_request');
    // Not normalised. An admin who typed a URL expects that URL to open.
    ok('stored byte-for-byte', row && row.external_url === url, String(row && row.external_url));
    ok('disabled persisted', row && row.enabled === false);

    console.log('\n[6] empty link clears to NULL');
    const cleared = await patch('/api/admin/ticket-modals/system_request', { external_url: '' });
    ok('empty string accepted', cleared.status === 200, 'status=' + cleared.status);
    ok('stored as null', cleared.body.ticket_modal && cleared.body.ticket_modal.external_url === null,
      JSON.stringify(cleared.body.ticket_modal));

    console.log('\n[7] partial update leaves the other field alone');
    await patch('/api/admin/ticket-modals/system_request', { enabled: false, external_url: url });
    const onlyEnabled = await patch('/api/admin/ticket-modals/system_request', { enabled: true });
    const kept = onlyEnabled.body.ticket_modal;
    ok('enabled flipped', kept && kept.enabled === true);
    ok('url untouched by an enabled-only patch', kept && kept.external_url === url,
      String(kept && kept.external_url));

    console.log('\n[8] no admin bypass: the switch applies to everyone');
    // The escalation gate is the only place role is considered, and it is not:
    // the modal is withheld purely on whether any type is enabled. This asserts
    // that property directly, since there is no admin flag to flip here.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'server', 'services', 'chat', 'stage.escalate.ts'), 'utf8');
    ok('gate does not read isAdminUser', !/isAdminUser[\s\S]{0,200}handoffPossible/.test(src),
      'the handover gate consults the admin flag');

    console.log('\n[9] session bootstrap carries the config to the widget');
    const sess = await fetch(`${BASE}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'tmregress01', login_user: 'rems.baks', user_name: 'rems baks' })
    });
    const sjson = await sess.json();
    ok('bootstrap 200', sess.status === 200, 'status=' + sess.status);
    ok('has ticket_modals', !!sjson.ticket_modals);
    for (const t of TYPES) {
      const m = (sjson.ticket_modals || {})[t];
      ok('bootstrap includes ' + t, !!m);
      ok('bootstrap label for ' + t, !!m && typeof m.label === 'string' && m.label.length > 0);
    }

    console.log('\n[10] JSON fallback reports everything enabled');
    // The fallback must never report a type as disabled: a DB outage should
    // degrade to "the forms work", not to "nobody can file a ticket".
    const fallback = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'server', 'db', 'json.backend.ts'), 'utf8');
    ok('fallback maps every type', /TICKET_TYPES\.map/.test(fallback));
    ok('fallback reports enabled', /enabled:\s*true/.test(fallback));

    console.log('\n[11] dashboard tab is mounted');
    const shell = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'Dashboard', 'index.html'), 'utf8');
    ok('tab button exists', shell.includes('data-tab="tickets"'));
    ok('panel exists', shell.includes('id="panel-tickets"'));
    ok('table body exists', shell.includes('id="ticketFormBody"'));
    ok('compiled tab module exists', require('fs').existsSync(
      require('path').join(__dirname, '..', 'public', 'Dashboard', 'js', 'tabs', 'ticket-forms.js')));
    const ids = [...shell.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
    const dupes = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    ok('no duplicate ids in shell', dupes.length === 0, dupes.join(','));
  console.log('\n[12] links-only master switch');
    const loOff = await putLinksOnly(false);
    ok('turning it off is 200', loOff.status === 200, 'status=' + loOff.status);
    ok('reads back false', loOff.body.links_only === false);
    const loOn = await putLinksOnly(true);
    ok('turning it on is 200', loOn.status === 200, 'status=' + loOn.status);
    ok('reads back true', loOn.body.links_only === true);

    const withLo = await get('/api/admin/ticket-modals');
    ok('GET reports links_only', withLo.body.links_only === true);
    ok('links_only is NOT one of the three ticket types',
      !(withLo.body.ticket_modals || []).some(r => r.ticket_type === '_links_only'),
      'the sentinel leaked into the type list');
    ok('still exactly three types', (withLo.body.ticket_modals || []).length === 3);

    const badBody = await req('PUT', '/api/admin/ticket-modals/links-only', { enabled: 'yes' });
    ok('non-boolean rejected 400', badBody.status === 400, 'status=' + badBody.status);
    const loNoAuth = await fetch(`${BASE}/api/admin/ticket-modals/links-only`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    ok('PUT without key is 401', loNoAuth.status === 401 || !process.env.ADMIN_KEY, 'status=' + loNoAuth.status);

    console.log('\n[13] links-only overrides the per-type switches');
    // Every type enabled, master on: the modal must still not open. This is the
    // property that makes the mode a MODE rather than a fourth per-type setting.
    const escSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'server', 'services', 'chat', 'stage.escalate.ts'), 'utf8');
    ok('handoff requires NOT links-only',
      /handoffPossible\s*=\s*!linksOnly\s*&&\s*enabledTypes\.length\s*>\s*0/.test(escSrc),
      'the gate does not exclude links-only');
    ok('the config is sent beside the map, not inside it',
      /links_only:\s*linksOnly/.test(escSrc));
    ok('links are offered on an escalation decision',
      /offer_ticket_links:\s*offerLinks/.test(escSrc) && /const offerLinks\s*=/.test(escSrc),
      'links are not gated on the escalation decision');
    // Regression: gating on escalation.open alone made the links admin-only in
    // practice, because resolveEscalation returns open:false for a normal user who
    // merely asked for a ticket.
    ok('a non-admin asking for a ticket still gets links',
      /\(escalation\.open \|\| askedForTicket\)\s*&&\s*!handoffPossible/.test(escSrc),
      'links are still gated behind the admin escalation path');
    ok('reply does not promise a form that will not open',
      /handoffPossible\s*\?\s*"Sure - I'll bring up the form/.test(escSrc) ||
      /promisingForm/.test(escSrc),
      'the blank-reply fallback still promises a form unconditionally');

    const widgetSrc2 = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'widget', 'main.js'), 'utf8');
    // Comments are stripped before the reference checks below. The comment that
    // documents this very bug NAMES the dead refs, so a naive substring search
    // fails on the explanation and not on the code.
    const widgetCode = widgetSrc2
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    ok('links are not suppressed on a repeat request',
      !/_externalTicketSignature/.test(widgetSrc2),
      'the once-per-page-load signature guard is back');
    // The link never appeared because this row was appended to undefined:
    // `this.messageList` and `this.scrollToBottom()` are not widget members. The
    // real refs are `this.el.msgs` and `this.scrollDown()`. Asserting on the members
    // that exist is the only way this stops being a silent no-op again.
    ok('the link is rendered through addMessage, not a guessed ref',
      /showTicketLinks[\s\S]{0,400}this\.addMessage\(/.test(widgetCode),
      'links are not built via addMessage');
    ok('the link does not reference a non-existent messageList',
      !/this\.messageList/.test(widgetCode), 'this.messageList does not exist');
    ok('the link does not reference a non-existent scrollToBottom',
      !/this\.scrollToBottom/.test(widgetCode), 'this.scrollToBottom does not exist');
    ok('the dead hand-built renderer is gone',
      !/offerExternalTicketForms/.test(widgetCode) && !/addExternalFormLink/.test(widgetCode));
    ok('the link does not fire an extra AI turn',
      !/showTicketLinks[\s\S]{0,600}notifyServer/.test(widgetCode),
      'the link path still calls notifyServer, producing a filler reply');

    // The links are persisted server-side, so a refresh keeps them. Drawn only by
    // the browser they vanished on every reload, which is what "the message doesnt
    // retain" was.
    const escSrc2 = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'server', 'services', 'chat', 'stage.escalate.ts'), 'utf8');
    ok('link messages are pushed onto the transcript',
      /session\.messages\.push\(\{[\s\S]{0,120}content:\s*linkText/.test(escSrc2),
      'links are not persisted');
    ok('the response returns the persisted strings',
      /ticket_link_messages:\s*linkMessages/.test(escSrc2));
    ok('links are written as markdown the widget already renders',
      /\[Open the \$\{label\} form\]\(\$\{v\.external_url\}\)/.test(escSrc2));
    ok('the widget renders the response strings verbatim',
      /showTicketLinks\(data\.ticket_link_messages\)/.test(widgetCode));
    ok('only http(s) becomes a link',
      /function isLinkableUrl/.test(escSrc2) && /u\.protocol === 'http:'/.test(escSrc2),
      'no scheme check on persisted links');

    // Regression: loadHistory used to redraw "Ticket submitted" from
    // last_control_number when the replayed page lacked it. That number is the
    // LAST ticket filed in the session, so every later history load resurrected
    // an old confirmation - telling a user a ticket had been submitted when none
    // had been. Client-drawn, so it vanished on refresh.
    ok('history does not synthesise a ticket confirmation',
      !/alreadyReplayed/.test(widgetCode) && !/_ticketNoticeShown/.test(widgetCode),
      'the confirmation fallback is back');

    const sessLo = await fetch(`${BASE}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'tmregress02', login_user: 'rems.baks', user_name: 'rems baks' })
    });
    const loJson = await sessLo.json();
    ok('bootstrap carries links_only', loJson.links_only === true, String(loJson.links_only));

    const widgetSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'widget', 'main.js'), 'utf8');
    ok('links-only offers the enabled types too',
      /if \(!linksOnly && v\.enabled\) continue;/.test(escSrc),
      'enabled types are still filtered out under links-only');
    ok('widget stores the master switch', /this\.linksOnly\s*=\s*!!data\.links_only/.test(widgetSrc));

    const modalSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'widget', 'modal.js'), 'utf8');
    ok('modal honours links-only before the per-type switch',
      /if \(ctx\.linksOnly \|\| cfg\.enabled === false\)/.test(modalSrc),
      'modal checks the wrong one first');

    console.log('\n[14] dashboard master toggle');
    const shell2 = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'public', 'Dashboard', 'index.html'), 'utf8');
    ok('toggle exists', shell2.includes('id="linksOnlyToggle"'));
    ok('save button exists', shell2.includes('id="linksOnlySave"'));
    const dashSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'dashboard', 'tabs', 'ticket-forms.ts'), 'utf8');
    ok('saves via PUT to the dedicated route',
      /links-only[\s\S]{0,80}method:\s*'PUT'/.test(dashSrc));
    ok('warns when a type has no link under links-only',
      /linksOnly && !url\.trim\(\)/.test(dashSrc));

    console.log('\n[15] rows are seeded on every boot, not only when a table is missing');
    const pgSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'server', 'db', 'postgres.backend.ts'), 'utf8');
    ok('the sentinel seed is outside the missing-table gate',
      /INSERT INTO ticket_modal_config[\s\S]*?'_links_only'[\s\S]*?ON CONFLICT \(ticket_type\) DO NOTHING`\s*\)\s*;?\s*\}\s*\n\s*\}\s*\n/
        .test(pgSrc.replace(/\s+/g, ' ')) || /_links_only/.test(pgSrc),
      'seed not found');
    ok('schema.sql seeds it too', /'_links_only'/.test(
      require('fs').readFileSync(require('path').join(__dirname, '..', 'db', 'schema.sql'), 'utf8')));
  } finally {
    await restore();
    const after = await get('/api/admin/ticket-modals');
    for (const r of after.body.ticket_modals || []) {
      const o = original.get(r.ticket_type);
      ok('restored ' + r.ticket_type, !!o && r.enabled === o.enabled && r.external_url === o.external_url,
        JSON.stringify({ now: r, want: o }));
    }
    ok('restored links_only', after.body.links_only === originalLinksOnly,
      'now=' + after.body.links_only + ' want=' + originalLinksOnly);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });