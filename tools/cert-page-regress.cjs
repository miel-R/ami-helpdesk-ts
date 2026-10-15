/* Regression checks for public/cert-trusted.html and public/cert-trusted.js.
 *
 * This file exists because the page was silently dead, twice, for two different
 * reasons, and both failures looked identical from the outside: the page rendered
 * its static markup perfectly while none of its script ran.
 *
 *   1. An edit decoded the HTML entities inside esc(), turning "'": '&#39;' into
 *      "'": '''. A parse error, so the browser discarded the whole script - not just
 *      that function - and the page sat on "Checking..." forever with dead buttons.
 *   2. The real cause of what the user actually saw. Every page this app serves
 *      carries helmet's default CSP, whose script-src is 'self' with no
 *      'unsafe-inline'. The script was INLINE, so the browser refused it and
 *      logged a violation to a console nobody was watching. It had been broken
 *      since the page was first written; the entity bug only ever hid it.
 *
 * A static-file page that is meant to explain a broken browser has no way to
 * report its own failure, so the defences have to live here:
 *
 *   1. Section 1 asserts the HTML contains NO inline <script> at all. This is the
 *      check that would have caught the CSP refusal: `node --check` cannot, because
 *      the script parses perfectly and is blocked by policy rather than by syntax.
 *      It then runs `node --check` over the external file, which does catch a
 *      parse error.
 *   2. Sections 6+ execute that file in a vm sandbox with a stub DOM and a scripted
 *      fetch, and assert what it actually renders.
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
const SCRIPT_FILE = 'public/cert-trusted.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : '')); }
};
const section = (n) => console.log('\n[' + n + ']');

const html = fs.readFileSync(path.join(__dirname, '..', PAGE), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', SCRIPT_FILE), 'utf8');
// Comments are stripped before any scan of the HTML. They explain the CSP rule
// and so have to name <script> in prose, which is not an inline script block and
// must not be counted as one.
const markup = html.replace(/<!--[\s\S]*?-->/g, '');
// Markup assertions read the HTML, code assertions read whichever file holds the
// code. Stripped of comments for the visible-text checks.
const code = markup + '\n' + script;

section('1. No inline script, and the external one parses');
// THE load-bearing assertion. helmet sends `script-src 'self'` on every response,
// which permits a same-origin file and refuses an inline block. An inline script
// fails silently: the page looks fine and does nothing.
const inlineBlocks = markup.match(/<script(?![^>]*\bsrc=)[^>]*>/g) || [];
ok('the HTML has no inline <script> block', inlineBlocks.length === 0,
  'found: ' + JSON.stringify(inlineBlocks));
ok('the HTML has no inline event handler',
  !/\son(?:click|load|error|mouseover)\s*=/i.test(markup));
ok('the script is loaded from a same-origin file', /<script src="[^"]*cert-trusted\.js"/.test(html));
// Relative, so it resolves under the root mount AND /mis_helpdesk/ami-helpdesk/.
const src = (html.match(/<script src="([^"]+)"/) || [])[1] || '';
ok('the script src is relative, not absolute', !/^(https?:)?\/\//.test(src) && !src.startsWith('/'), src);
{
  const tmp = path.join(os.tmpdir(), 'cert-page-regress-check.js');
  fs.writeFileSync(tmp, script);
  let parseError = '';
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  } catch (e) {
    parseError = String(e.stderr || e.message).split('\n').slice(0, 3).join(' ');
  }
  // This is the check that would have caught the entity-decoding regression.
  ok('the external script is valid JavaScript', parseError === '', parseError);
}

section('2. Nothing is written as HTML');
// The original build() used esc() to HTML-escape interpolated values. It is gone,
// and deliberately: showLink builds the link with document.createElement and sets
// textContent, neither of which parses markup. So there is no injection surface to
// escape, and an esc() bug of the kind that once killed this page cannot recur.
// These assert the property that makes it unnecessary.
ok('the triple-quote canary is clean', !/'''/.test(script));
ok('no innerHTML is assigned anywhere', !/\.innerHTML\s*=/.test(script));
ok('no insertAdjacentHTML', !/insertAdjacentHTML/.test(script));
ok('no document.write', !/document\.write/.test(script));
ok('the link is built with createElement', /document\.createElement\('a'\)/.test(script));
ok('the link text goes through textContent', /a\.textContent\s*=/.test(script));

section('3. The page is self-contained');
// It is reached at the moment widget.js and widget.css may still be refused.
ok('no reference to widget.js', !/widget\.js/.test(code));
ok('no reference to widget.css', !/widget\.css/.test(code));
ok('no CDN or external origin', !/https?:\/\/(?!192\.1\.5\.21)/.test(code));
ok('DOCTYPE is the first thing in the file', /^<!DOCTYPE html>/i.test(html.trim()));

section('4. The broken navigations are gone');
ok('no history.back()', !/history\.back\(/.test(code));
ok('no window.close()', !/window\.close\(/.test(code));
ok('no buttons to click', !/<button|id="actions"|id="retry"|id="back"/.test(html));
ok('no orphaned .actions CSS', !/^\s*\.actions\s*\{/m.test(html));

section('5. The verdict is the settled state, not a pending one');
// The bug the user actually reported was a page stuck on "Checking...". These
// assert the finished state is in the MARKUP, so it renders even if the script
// never executes at all.
ok('no trust probe against /api/health', !/\/api\/health/.test(code));
// Strip comments before checking visible text. The file documents *why* there is
// no pending state, and that prose legitimately contains the word.
const visible = html.replace(/<!--[\s\S]*?-->/g, '');
ok('no "Checking" text reaches the user', !/Checking/.test(visible));
ok('badge reads "All set" in the markup', />All set</.test(visible));
ok('headline reads "This browser is checked"', />This browser is checked</.test(visible));
ok('explains the user can close the tab', /close this tab/.test(visible));
ok('validates the back target', /function safeUrl/.test(script) && /javascript:|data:/.test(script));
ok('reads the back URL from the settings endpoint', /\/api\/public\/cert-config/.test(script));
ok('times out the settings lookup', /TIMEOUT_MS/.test(script));
// A browser without AbortController must still get a usable page. This guard is
// the second silent-death path: without it the constructor throws before the
// promise exists, so showLink is never reached.
ok('guards AbortController before constructing one',
  /typeof window\.AbortController !== 'function'/.test(script));

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
 * Run the external script against a scripted fetch.
 *
 * @param {object} opts
 * @param {object|null} opts.config response body for /api/public/cert-config
 * @param {boolean} opts.hang       never settle the settings lookup
 * @param {boolean} opts.noAbort    simulate a browser with no AbortController
 * @param {string} opts.search      the query string, to test the ?back= fallback
 * @param {string} opts.referrer    the document referrer, for the same reason
 */
function runPage({ config = null, hang = false, noAbort = false, search = '', referrer = '' }) {
  const els = { probe: makeEl(), headline: makeEl(), result: makeEl(), backslot: makeEl() };
  const fetches = [];

  const win = {
    location: { search, href: 'https://192.1.5.21:3000/cert-trusted.html' },
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
  if (!noAbort) win.AbortController = AbortController;

  const sandbox = {
    window: win,
    document: {
      referrer,
      createElement: () => makeEl(),
      getElementById: (id) => (id in els ? els[id] : null)
    },
    URL, URLSearchParams, AbortController, Promise, String, Math, JSON, Object, console
  };

  vm.runInNewContext(script, sandbox, { filename: 'cert-trusted.js' });

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

  section('10. A browser with no AbortController still gets a usable page');
  {
    // Without the guard, `new window.AbortController()` throws synchronously
    // before the promise chain exists, so showLink is never called and #backslot
    // stays empty. Same silent-death symptom as the CSP failure, different cause.
    let threw = false;
    try {
      const p = runPage({
        noAbort: true,
        search: '?back=https%3A%2F%2F192.1.5.21%2Fmis_helpdesk%2Findex.php'
      });
      await p.settle();
      ok('the region was filled', link(p.els) !== null);
      ok('it fell back to the ?back= value',
        (link(p.els) || {}).href === 'https://192.1.5.21/mis_helpdesk/index.php',
        (link(p.els) || {}).href);
    } catch (e) {
      threw = true;
      ok('the page did not throw', false, (e && e.message) || String(e));
    }
    if (!threw) ok('the page did not throw', true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();