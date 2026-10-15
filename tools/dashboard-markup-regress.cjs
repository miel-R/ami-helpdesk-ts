/* Dashboard markup regression: static checks over public/Dashboard/index.html
 * and css/dashboard.css. These are the checks that would have caught the two
 * failures that actually shipped:
 *
 *   1. A duplicated id that made a control silently inert (README: the Costs
 *      user filter had two elements called `usageUser` and the top-bar input
 *      won, so typing in the other box did nothing). getElementById returns the
 *      FIRST match, so a duplicate id is a control that quietly stops working.
 *
 *   2. A CDN <link> for bootstrap-icons. The dashboard is otherwise fully
 *      vendored under ./bootstrap-5.3.8-dist/, but the icons stylesheet pointed
 *      at cdn.jsdelivr.net. On a box with no internet route every icon in the UI
 *      disappears and, because it is a render-blocking <link>, first paint stalls
 *      waiting on a request that cannot complete. A local icons stylesheet was
 *      already vendored but had no fonts/ directory beside it, so swapping the
 *      href alone would have rendered nothing at all - worse than the CDN.
 *
 * Run: node tools/dashboard-markup-regress.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'public', 'Dashboard', 'index.html');
const CSS = path.join(ROOT, 'public', 'Dashboard', 'css', 'dashboard.css');
const BOOTSTRAP_DIR = path.join(ROOT, 'public', 'Dashboard', 'bootstrap-5.3.8-dist');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS  ' + name);
  } else {
    fail++;
    console.log('  FAIL  ' + name + (extra ? ' -> ' + extra : ''));
  }
};

const html = fs.readFileSync(HTML, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

console.log('\n[1] offline-first: no external runtime dependencies');
{
  // Strip the SVG xmlns (a namespace URL, never fetched) and any commented-out
  // markup before hunting for real references, so license headers and docs do
  // not trip the check.
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/xmlns="[^"]*"/g, '');

  const external = [...body.matchAll(/(?:src|href)\s*=\s*["'](https?:\/\/[^"']+)["']/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('https://192.1.5.21')); // the widget origin, not fetched as a dep

  ok(
    'no external http(s) src/href in markup',
    external.length === 0,
    external.join(', ')
  );

  ok(
    'bootstrap-icons referenced locally, not from a CDN',
    /bootstrap-5\.3\.8-dist\/css\/bootstrap-icons\.min\.css/.test(html)
      && !/cdn\.jsdelivr\.net\/npm\/bootstrap-icons/.test(html)
  );

  // The vendored icons stylesheet is useless without its font files. Assert they
  // exist, so this cannot regress the way it did. The fonts must sit in css/fonts/
  // because bootstrap-icons.min.css lives in css/ and resolves url("fonts/...") as a
  // sibling path - putting them anywhere else silently renders zero glyphs.
  for (const font of ['bootstrap-icons.woff2', 'bootstrap-icons.woff']) {
    ok(
      'vendored icon font present: css/fonts/' + font,
      fs.existsSync(path.join(BOOTSTRAP_DIR, 'css', 'fonts', font))
    );
  }

  // Every local css/js the page pulls in should actually be on disk.
  const localRefs = [...body.matchAll(/(?:src|href)\s*=\s*["'](\.\/[^"']+)["']/g)].map((m) => m[1]);
  for (const ref of localRefs) {
    const p = path.join(ROOT, 'public', 'Dashboard', ref.replace(/^\.\//, ''));
    ok('local asset exists: ' + ref, fs.existsSync(p));
  }
}

console.log('\n[2] unique ids (a duplicate silently disables a control)');
{
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  for (const id of ids) seen.set(id, (seen.get(id) || 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => id + ' x' + n);
  ok('no duplicate ids', dupes.length === 0, dupes.join(', '));
  ok('page actually has ids', ids.length > 20, 'found ' + ids.length);
}

console.log('\n[3] every data-tab has a matching panel and vice versa');
{
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  const panels = [...html.matchAll(/data-panel="([^"]+)"/g)].map((m) => m[1]);
  ok('has tabs', tabs.length > 0, String(tabs.length));
  for (const t of tabs) ok('tab "' + t + '" has a panel', panels.includes(t));
  for (const p of panels) ok('panel "' + p + '" has a tab', tabs.includes(p));
  const dupeTabs = tabs.filter((t, i) => tabs.indexOf(t) !== i);
  ok('no duplicate tabs', dupeTabs.length === 0, dupeTabs.join(', '));
}

console.log('\n[4] tab accessibility wiring');
{
  // The container declares role="tablist", which promises children with
  // role="tab" + aria-selected and arrow-key navigation. If the markup makes
  // that promise the client does not keep, a screen reader is told something
  // untrue. Assert the static half is present.
  const tabButtons = [...html.matchAll(/<button[^>]*data-tab="([^"]+)"[^>]*>/g)].map((m) => m[0]);
  ok('tab buttons found', tabButtons.length > 0, String(tabButtons.length));
  for (const btn of tabButtons) {
    const id = (btn.match(/data-tab="([^"]+)"/) || [])[1];
    ok('tab "' + id + '" declares role="tab"', /role="tab"/.test(btn));
    ok('tab "' + id + '" has aria-selected', /aria-selected="/.test(btn));
    ok('tab "' + id + '" has aria-controls', /aria-controls="/.test(btn));
    ok('tab "' + id + '" has tabindex', /tabindex="/.test(btn));
  }
  const tabPanels = [...html.matchAll(/<section[^>]*data-panel="([^"]+)"[^>]*>/g)].map((m) => m[0]);
  for (const panel of tabPanels) {
    const id = (panel.match(/data-panel="([^"]+)"/) || [])[1];
    ok('panel "' + id + '" has id', /\bid="/.test(panel));
    ok('panel "' + id + '" has role="tabpanel"', /role="tabpanel"/.test(panel));
    ok('panel "' + id + '" has aria-labelledby', /aria-labelledby="/.test(panel));
  }
}

console.log('\n[5] dark mode: theme attribute + enough dark rules to matter');
{
  ok('html declares a bootstrap theme', /<html[^>]*data-bs-theme=/.test(html));
  // A half-wired dark mode is worse than none: it renders white cards on a dark
  // page. Require that the stylesheet darkens more than just the body.
  const darkRules = (css.match(/\[data-bs-theme="dark"\]/g) || []).length;
  ok('stylesheet has dark rules', darkRules > 0, 'found ' + darkRules);
  ok('dark mode covers card headers, not only body', /\.card-header|\.table|\.bg-white|\.form-control|\.btn-close/.test(
    css.slice(css.indexOf('[data-bs-theme="dark"]'))),
    'only body is darkened; cards/tables/inputs would stay white'
  );
}

console.log('\n[6] theme toggle + persistence hooks present in client');
{
  const main = fs.readFileSync(path.join(ROOT, 'src', 'dashboard', 'main.ts'), 'utf8');
  // Theme handling was split out of main.ts into its own module, so read both:
  // asserting on main.ts alone would fail the moment the code is split again,
  // which is the wrong reason for this test to go red.
  const themePath = path.join(ROOT, 'src', 'dashboard', 'theme.ts');
  const theme = fs.existsSync(themePath) ? fs.readFileSync(themePath, 'utf8') : '';
  const client = main + theme;
  ok('theme is persisted (localStorage)', /localStorage/.test(client));
  ok('aria-pressed used on theme button', /aria-pressed/.test(client)
    && /aria-pressed/.test(html));
  ok('auto-refresh skips when an input has focus', /document\.activeElement/.test(main)
    && /(INPUT|TEXTAREA|SELECT)/.test(main));
  ok('chart.js loaded with defer', /<script[^>]*chart\.js[^>]*defer/.test(html));
}

console.log('\n[7] sortable tables opt-in via data-sortable');
{
  // Sorting is opt-in per table so the generic sorter never fights a table that
  // needs server order. At least the tables with numeric columns should opt in.
  const sortable = [...html.matchAll(/data-sortable(?:\s*=\s*"([^"]*)")?/g)];
  ok('at least one table opts into sorting', sortable.length > 0, String(sortable.length));
  ok('sortable tables declare sortable columns', (html.match(/data-sort-col/g) || []).length > 0);
}

console.log('\n[8] no inline event handlers (CSP script-src does not allow them)');
{
  // helmet serves `script-src 'self'` with no 'unsafe-inline'. An onclick=
  // attribute is refused exactly like an inline <script>. This is the same class
  // of silent breakage that froze the certificate page.
  const inline = [...html.matchAll(/\son[a-z]+="/g)].map((m) => m[0]);
  ok('no inline on* handlers', inline.length === 0, inline.join(', '));
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ': ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail === 0 ? 0 : 1);