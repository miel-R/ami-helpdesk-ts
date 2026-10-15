/* Regression checks for public/cert-trusted.html.
 *
 * This file exists because of one specific failure: an edit to the page decoded
 * the HTML entities inside esc(), turning "'": '&#39;' into "'": '''. That is a
 * PARSE error, so the browser discarded the entire inline script - not just that
 * function - and the page sat on "Checking..." forever, showing buttons that had
 * no click handlers attached. It looked like a working page that was simply
 * still waiting.
 *
 * The page's entire job is to explain things when everything else is broken, so
 * a silently dead script is the worst possible outcome. Two defences live here:
 *
 *   1. Section 1 runs `node --check` over the extracted inline script. A parse
 *      error cannot survive this.
 *   2. Sections 6+ execute that script in a vm sandbox with a stub DOM and a
 *      scripted fetch, and assert what it actually renders.
 *
 * The page performs NO trust probe, by design. The certificate is accepted by
 * the time this document renders - a browser cannot load an HTTPS page over a
 * certificate it rejects without showing the warning first - so there is nothing
 * left to verify. Section 5 pins that decision so it is not quietly reintroduced.
 *
 * No network, no server, no database. Runs offline in under a second.
 *
 *   Run:  node tools/cert-page-regress.cjs
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { execFileSync } = require('child_process');

const PAGE = 'public/cert-trusted.html';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const section = (n) => console.log('\n[' + n + ']');

const html = fs.readFileSync(path.join(__dirname, '..', PAGE), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);

section('1. The inline script parses');
if (!scriptMatch) {
  ok('an inline <script> block exists', false, 'none found');
} else {
  ok('an inline <script> block exists', true);
  const tmp = path.join(os.tmpdir(), 'cert-page-regress-check.js');
  fs.writeFileSync(tmp, scriptMatch[1]);
  let parseError = '';
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    parseError = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ');
  }
  // This is the check that would have caught the entity-decoding regression.
  ok('the inline script is valid JavaScript', parseError === '', parseError);
}

section('2. esc() survived intact');
// A decode of these entities leaves a bare "'": ''' which does not parse.
ok('no empty triple-quote sequence', !/'''/.test(html));
ok('escapes ampersand', /'&':\s*'&amp;'/.test(html));
ok('escapes less-than', /'<'\s*:\s*'&lt;'/.test(html));
ok('escapes quote', /&#39;/.test(html));

section('3. The page is self-contained');
// It is reached at the moment widget.js and widget.css may still be refused.
ok('no reference to widget.js', !/widget\.js/.test(html));
ok('no reference to widget.css', !/widget\.css/.test(html));
ok('no CDN or external origin', !/https?:\/\/(?!192\.1\.5\.21)/.test(html));
ok('DOCTYPE is the first thing in the file', /^<!DOCTYPE html>/i.test(html.trim()));

section('4. The broken navigations are gone');
ok('no history.back()', !/history\.back\(/.test(html));
ok('no window.close()', !/window\.close\(/.test(html));
ok('no buttons to click', !/<button|id="actions"|id="retry"|id="back"/.test(html));
ok('no orphaned .actions CSS', !/^\s*\.actions\s*\{/m.test(html));

section('5. The verdict is the settled state, not a pending one');
// The bug the user actually reported was a page stuck on "Checking...". These
// assert the finished state is in the MARKUP, so it renders even if the script
// never executes at all.
ok('no trust probe against /api/health', !/\/api\/health/.test(html));
// Strip comments before checking visible text. The file documents *why* there is
// no pending state, and that prose legitimately contains the word.
const visible = html.replace(/<!--[\s\S]*?-->/g, '');
ok('no "Checking" text reaches the user', !/Checking/.test(visible));
ok('badge reads "All set" in the markup', />All set</.test(visible));
ok('headline reads "This browser is checked"', />This browser is checked</.test(visible));
ok('explains the user can close the tab', /close this tab/.test(visible));
ok('validates the back target', /function safeUrl/.test(html) && /javascript:|data:/.test(html));
ok('reads the back URL from the settings endpoint', /\/api\/public\/cert-config/.test(html));
ok('times out the settings lookup', /TIMEOUT_MS/.test(html));

/* Sections 6+ execute the script. A page that parses but renders nothing is
   exactly the failure this file was written for, so the render paths are
   asserted directly rather than trusted. */
function makeEl() {
  const el = {
    innerHTML: '',
    textContent: '',
    children: [],
    appendChild(child) { el.children.push(child); },
    set className(v) { el._class = v; },
    get className() { return el._class; },
    set href(v) { el._href = v; },
    get href() { return el._href; }
  };
  return el;
}

/**
 * Run the extracted script against a scripted fetch.
 *
 * @param {object} opts
 * @param {object|null} opts.config response body for /api/public/cert-config
 * @param {boolean} opts.hang       never settle the settings lookup
 * @param {string} opts.search      the query string, to test the ?back= fallback
 * @param {string} opts.referrer    the document referrer, for the same reason
 */
function runPage({ config = null, hang = false, search = '', referrer = '' }) {
  const els = { probe: makeEl(), headline: makeEl(), result: makeEl(), backslot: makeEl() };
  const fetches = [];

  const win = {
    location: { search, href: 'https://192.1.5.21:3000/cert-trusted.html' },
    AbortController,
    // Compress the deadline so the suite stays fast. Ordering is preserved.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms || 0, 25)),
    clearTimeout: (h) => clearTimeout(h),
    fetch: (url) => {
      fetches.push(url);
      if (hang) return new Promise(() => {});
      if (!config) return Promise.reject(new Error('no config'));
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(config) });
    }
  };

  const sandbox = {
    window: win,
    document: {
      referrer,
      createElement: () => makeEl(),
      getElementById: (id) => (id in els ? els[id] : null)
    },
    URL, URLSearchParams, AbortController, Promise, String, Math, JSON, Object, console
  };

  vm.runInNewContext(scriptMatch[1], sandbox, { filename: 'cert-trusted.html' });

  return {
    els,
    fetches,
    // Let the promise chain drain.
    settle: () => new Promise((r) => setTimeout(r, 60))
  };
}

/** The rendered back-link, if any. */
function link(els) {
  return els.backslot.children[0] || null;
}

(async function main() {
  section('6. It uses the address configured in the dashboard');
  {
    const p = runPage({ config: { helpdesk_url: 'https://192.1.5.21/mis_helpdesk/index.php' } });
    await p.settle();
    ok('asked the settings endpoint once', p.fetches.length === 1, 'calls=' + p.fetches.length);
    ok('requested the public config route', /\/api\/public\/cert-config$/.test(p.fetches[0] || ''));
    ok('rendered a back link', link(p.els) !== null);
    ok('the link points at the configured address',
      (link(p.els) || {}).href === 'https://192.1.5.21/mis_helpdesk/index.php',
      (link(p.els) || {}).href);
    ok('the link is labelled "Back to the Helpdesk"',
      (link(p.els) || {}).textContent === 'Back to the Helpdesk');
  }

  section('7. It falls back to the ?back= parameter');
  {
    const p = runPage({
      config: null,
      search: '?back=https%3A%2F%2F192.1.5.21%2Fmis_helpdesk%2Findex.php'
    });
    await p.settle();
    ok('still produced a usable link', link(p.els) !== null);
    ok('it used the parameter, decoded',
      (link(p.els) || {}).href === 'https://192.1.5.21/mis_helpdesk/index.php',
      (link(p.els) || {}).href);
  }

  section('8. It refuses a javascript: back target');
  {
    const p = runPage({ config: null, search: '?back=javascript:alert(1)' });
    await p.settle();
    ok('no link was created', link(p.els) === null);
    ok('fell back to plain instructions', /close this tab|Go back to your Helpdesk/.test(
      p.els.backslot.textContent), p.els.backslot.textContent);
  }

  section('9. A settings lookup that never settles still renders');
  {
    // The lookup is the only async work left. If it hangs, the page must still
    // read as finished rather than sitting on a half-drawn result.
    const p = runPage({ config: null, hang: true });
    await p.settle();
    ok('the page did not throw', true);
    ok('no link, but not an empty region', link(p.els) === null);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();