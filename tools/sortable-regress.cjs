// Behavioural tests for the dashboard table sorter's comparison logic.
//
// dashboard-markup-regress.cjs checks that the tables are *marked up* correctly.
// This file checks that sorting those tables actually orders them correctly,
// which is where the subtle bugs live: blanks must not jump to the top when the
// sort is reversed, "1,234" must not sort as the number 1, and "item 9" must
// come before "item 10".
//
// Runs against the compiled output in public/Dashboard/js, so it fails if the
// committed build is stale - the same trap that shipped the settingsMeta bug.

const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const modPath = path.join(ROOT, 'public', 'Dashboard', 'js', 'sortable.js');

let sortable;
try {
  sortable = require(modPath);
} catch {
  console.error('FAIL  public/Dashboard/js/sortable.js is missing - run: npm run build');
  process.exit(1);
}

const { _compare: compare, _parseNum: parseNum, _comparatorFor: comparatorFor } = sortable;

let passed = 0;
let failed = 0;

function ok(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + e.message);
  }
}

function eq(actual, expected, what) {
  assert.strictEqual(actual, expected, what);
}

/** Sort a copy of `values` the way the page actually sorts them. */
function sorted(values, kind, asc) {
  return values.slice().sort(comparatorFor(kind, asc));
}

/**
 * compare() returns a signed magnitude (a - b), not -1/0/1. Asserting an exact
 * value here would pin the implementation to returning 1, which is the opposite
 * of what we want: a magnitude is what keeps equal rows stable.
 */
function sign(value) {
  return Math.sign(value);
}

console.log('\n[1] number parsing strips the formatting the tables actually render');
ok('thousands separators: "1,234" is 1234', () => eq(parseNum('1,234'), 1234));
ok('currency prefix: "$0.30" is 0.3', () => eq(parseNum('$0.30'), 0.3));
ok('percent suffix: "12.5%" is 12.5', () => eq(parseNum('12.5%'), 12.5));
ok('comma-decimal thousands and 2dp: "$1,234.50" is 1234.5', () =>
  eq(parseNum('$1,234.50'), 1234.5));
ok('plain integer', () => eq(parseNum('42'), 42));
ok('a bare dash is NaN, not zero', () => {
  assert.ok(Number.isNaN(parseNum('-')), 'a dash must not become 0');
});
ok('an em-dash is NaN', () => assert.ok(Number.isNaN(parseNum('—'))));
ok('text with no digits is NaN', () => assert.ok(Number.isNaN(parseNum('n/a'))));

console.log('\n[2] numeric ordering compares magnitude, not digits');
ok('"1,234" sorts above "99"', () => eq(sign(compare('num', '1,234', '99')), 1));
ok('"99" sorts below "1,234"', () => eq(sign(compare('num', '99', '1,234')), -1));
ok('compare returns the magnitude, not just 1 (stable-sort friendly)', () =>
  eq(compare('num', '1,234', '99'), 1135));
ok('equal magnitudes compare equal', () => eq(compare('num', '$0.30', '0.3'), 0));
ok('a full ascending pass is ordered', () =>
  assert.deepStrictEqual(
    sorted(['$1,234.50', '99', '0.30', '7'], 'num', true),
    ['0.30', '7', '99', '$1,234.50']));
ok('and the descending pass is the reverse', () =>
  assert.deepStrictEqual(
    sorted(['$1,234.50', '99', '0.30', '7'], 'num', false),
    ['$1,234.50', '99', '7', '0.30']));

console.log('\n[3] blanks sort LAST in both directions');
// This is the bug this section exists for. `asc ? compare : -compare` cannot
// achieve this: negating the whole result reverses any blank rule compare()
// applies, so blanks that sank on the first click floated to the top on the
// second. Blanks have to be settled before the direction is applied.
const BLANKY = ['3', '—', '1', '—', '2', '-', ''];
const isBlank = v => v === '' || v === '-' || v === '—';

ok('ascending puts blanks last', () => {
  const out = sorted(BLANKY, 'num', true);
  assert.deepStrictEqual(out.slice(0, 3), ['1', '2', '3']);
  assert.ok(out.slice(3).every(isBlank), 'a blank reached the top: ' + JSON.stringify(out));
});
ok('descending ALSO puts blanks last', () => {
  const out = sorted(BLANKY, 'num', false);
  assert.deepStrictEqual(out.slice(0, 3), ['3', '2', '1']);
  assert.ok(out.slice(3).every(isBlank), 'a blank reached the top: ' + JSON.stringify(out));
});
ok('the last real value is ahead of every blank, descending', () => {
  const out = sorted(BLANKY, 'num', false);
  eq(out.findIndex(isBlank), 3);
});
ok('text columns pin blanks too', () => {
  const out = sorted(['bob', '—', 'alice'], 'text', true);
  assert.deepStrictEqual(out, ['alice', 'bob', '—']);
  assert.deepStrictEqual(sorted(['bob', '—', 'alice'], 'text', false), ['bob', 'alice', '—']);
});
ok('two blanks are equal to each other', () => {
  eq(comparatorFor('num', true)('—', '-'), 0);
  eq(comparatorFor('num', false)('—', '-'), 0);
});
ok('every blank spelling is recognised', () => {
  for (const blank of ['', '-', '--', '—', '–']) {
    eq(comparatorFor('num', true)(blank, '5'), 1, `"${blank}" was not treated as a blank`);
    eq(comparatorFor('num', false)(blank, '5'), 1, `"${blank}" floated on descending`);
  }
});
ok('a non-numeric value in a num column still sorts consistently', () => {
  // Not NaN, so compare() falls back to locale compare rather than throwing.
  const out = sorted(['5', 'n/a', '1'], 'num', true);
  eq(out.length, 3);
  eq(out.indexOf('1') < out.indexOf('5'), true);
});

console.log('\n[4] text ordering uses numeric collation');
ok('"item 9" comes before "item 10"', () =>
  assert.deepStrictEqual(
    sorted(['item 10', 'item 9', 'item 1'], 'text', true),
    ['item 1', 'item 9', 'item 10']));
ok('plain alphabetical', () =>
  assert.deepStrictEqual(
    sorted(['charlie', 'alice', 'bob'], 'text', true),
    ['alice', 'bob', 'charlie']));
ok('case-insensitive ("Alice" with "bob")', () =>
  assert.deepStrictEqual(sorted(['bob', 'Alice'], 'text', true), ['Alice', 'bob']));
ok('numeric collation also orders a bare-number username ("9" before "10")', () =>
  // Deliberate: localeCompare's numeric option compares digit runs as numbers,
  // so "9" precedes "10" rather than being ordered as the text "10" < "9".
  assert.deepStrictEqual(sorted(['10', '9'], 'text', true), ['9', '10']));
ok('descending text is the reverse', () =>
  assert.deepStrictEqual(
    sorted(['charlie', 'alice', 'bob'], 'text', false),
    ['charlie', 'bob', 'alice']));

console.log('\n[5] date ordering');
ok('earlier before later', () => eq(sign(compare('date', '2026-01-02', '2026-01-10')), -1));
ok('later after earlier', () => eq(sign(compare('date', '2026-01-10', '2026-01-02')), 1));
ok('same instant compares equal', () =>
  eq(compare('date', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00Z'), 0));
ok('a blank date sorts last in both directions', () => {
  eq(comparatorFor('date', true)('—', '2026-01-02'), 1);
  eq(comparatorFor('date', false)('—', '2026-01-02'), 1);
});
ok('an unparseable date is not treated as the epoch', () => {
  // Must not become 0 / 1970 and jump to the top.
  assert.ok(Number.isNaN(Date.parse('never')));
  eq(sign(compare('date', 'never', '2026-01-02')), 1);
});
ok('a real date sorts before an unparseable one', () =>
  eq(sign(compare('date', '2026-01-02', 'never')), -1));

console.log('\n[6] _compare is antisymmetric');
// If compare(a,b) !== -compare(b,a) it is not a valid ordering, and the result
// would depend on the engine's sort algorithm rather than on the data.
// Blanks are excluded by design: comparatorFor settles them ahead of the
// direction flip, which is exactly what makes it deliberately non-antisymmetric.
const samples = ['1', '20', 'x', '2026-01-01', '$5.00', 'zz', '2026-12-31'];
let antisymmetric = true;
let offender = '';
for (const kind of ['text', 'num', 'date']) {
  for (const a of samples) {
    for (const b of samples) {
      const ab = compare(kind, a, b);
      const ba = compare(kind, b, a);
      if (ab !== -ba && ab !== 0) { antisymmetric = false; offender = kind + ' ' + a + '/' + b; }
    }
  }
}
ok('_compare(a,b) === -_compare(b,a) for every sampled pair', () =>
  assert.ok(antisymmetric, 'not antisymmetric at: ' + offender));
ok('_compare is total on non-blank input (never throws)', () => {
  for (const kind of ['text', 'num', 'date']) {
    for (const a of samples) for (const b of samples) {
      assert.ok(Number.isFinite(compare(kind, a, b)), kind + ' produced ' + compare(kind, a, b));
    }
  }
});

console.log('\n[7] test-only exports are present');
ok('_resetSortState is exported', () => eq(typeof sortable._resetSortState, 'function'));
ok('_compare is exported', () => eq(typeof sortable._compare, 'function'));
ok('_parseNum is exported', () => eq(typeof sortable._parseNum, 'function'));
ok('_comparatorFor is exported', () => eq(typeof sortable._comparatorFor, 'function'));
ok('wireSortableTables is exported', () => eq(typeof sortable.wireSortableTables, 'function'));
ok('resortTables is exported', () => eq(typeof sortable.resortTables, 'function'));

console.log('\n' + (failed
  ? `FAILED: ${passed} passed, ${failed} failed`
  : `ALL PASS: ${passed} passed, 0 failed`));
process.exit(failed ? 1 : 0);