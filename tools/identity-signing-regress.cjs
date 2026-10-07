// MIS-signed identity assertions.
//
// Covers the guarantee that matters: the chatbot may take the role from MIS,
// but ONLY when the signature verifies. A forged, tampered or expired token
// must fall back to the database role, so this suite deliberately tries to
// escalate and expects to fail.

const { signIdentity, verifyIdentity, normalizeRole, resolveRole } = require('../dist/server/services/identity.service');

const SECRET = 'test-secret-do-not-use-in-production';
const OTHER_SECRET = 'attacker-guess';

let passed = 0;
let failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { passed++; console.log(`    PASS  ${label}`); }
  else { failed++; console.log(`    FAIL  ${label}${detail ? ` -> ${detail}` : ''}`); }
}

console.log('[1] round trip');
{
  const token = signIdentity(
    { login: 'remiel.baking', name: 'Remiel Baking', dept: 'MIS', role: 'admin' },
    SECRET
  );
  ok('token has two parts', token.split('.').length === 2);
  const claims = verifyIdentity(token, SECRET);
  ok('verifies with the right secret', !!claims);
  ok('keeps the login', claims && claims.login === 'remiel.baking');
  ok('keeps the role', claims && claims.role === 'admin');
  ok('keeps the name', claims && claims.name === 'Remiel Baking');
  ok('keeps the department', claims && claims.dept === 'MIS');
  ok('has a future expiry', claims && claims.exp > Date.now());
}

console.log('\n[2] forgery is rejected');
{
  ok('wrong secret fails', verifyIdentity(
    signIdentity({ login: 'mallory', role: 'admin' }, SECRET), OTHER_SECRET) === null);
  ok('no secret configured fails closed',
    verifyIdentity(signIdentity({ login: 'mallory', role: 'admin' }, SECRET), '') === null);
  ok('garbage fails', verifyIdentity('not-a-token', SECRET) === null);
  ok('empty fails', verifyIdentity('', SECRET) === null);
  ok('missing token fails', verifyIdentity(undefined, SECRET) === null);
  ok('wrong type fails', verifyIdentity({ login: 'x' }, SECRET) === null);
  ok('extra dots fail', verifyIdentity('a.b.c', SECRET) === null);
}

console.log('\n[3] tampering is detected');
{
  // Someone re-encodes the payload to claim admin but keeps the old signature.
  const token = signIdentity({ login: 'mallory', name: 'M', dept: 'X', role: 'user' }, SECRET);
  const [body, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({
    login: 'mallory', name: 'M', dept: 'X', role: 'admin', exp: Date.now() + 60000
  }), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  ok('swapped payload keeps old sig -> rejected', verifyIdentity(`${forged}.${sig}`, SECRET) === null);
  ok('untouched original still verifies', verifyIdentity(`${body}.${sig}`, SECRET) !== null);
}

console.log('\n[4] expiry');
{
  const expired = signIdentity(
    { login: 'remiel.baking', role: 'admin', exp: Date.now() - 1000 }, SECRET);
  ok('expired token rejected', verifyIdentity(expired, SECRET) === null);
  const soon = signIdentity(
    { login: 'remiel.baking', role: 'admin', exp: Date.now() + 60000 }, SECRET);
  ok('token valid in 60s accepted', verifyIdentity(soon, SECRET) !== null);

  // Hand-build a correctly signed token that simply omits exp. Note we cannot
  // use signIdentity for this: it defaults exp when the value is falsy, which is
  // the right behaviour for the signer. The property under test is on the
  // VERIFIER: a payload with no usable expiry must not be accepted.
  const crypto = require('crypto');
  const b64u = (s) => Buffer.from(s).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const noExp = b64u(JSON.stringify({ login: 'mallory', name: 'M', dept: 'X', role: 'admin' }));
  const noExpSig = b64u(crypto.createHmac('sha256', SECRET).update(noExp).digest());
  ok('correctly signed but no exp -> rejected',
    verifyIdentity(`${noExp}.${noExpSig}`, SECRET) === null);
}

console.log('\n[5] MIS role -> chatbot role');
{
  // The three roles MIS actually uses. Only Admin may reach the admin commands;
  // Approver is a MIS workflow permission and deliberately grants nothing extra.
  ok('MIS "Admin"    -> admin', normalizeRole('Admin') === 'admin');
  ok('MIS "Approver" -> user (no admin access)', normalizeRole('Approver') === 'user');
  ok('MIS "User"     -> user', normalizeRole('User') === 'user');
  ok('Approver and User are identical to the chatbot',
    normalizeRole('Approver') === normalizeRole('User'));

  // Case and whitespace tolerance, because MIS stores them capitalised.
  ok('lowercase admin -> admin', normalizeRole('admin') === 'admin');
  ok('"ADMIN" -> admin', normalizeRole('ADMIN') === 'admin');
  ok('"Admin " (trailing space) -> admin', normalizeRole('Admin ') === 'admin');
  ok('"approver" -> user', normalizeRole('approver') === 'user');

  // An unexpected string must never be a route to admin.
  ok('"administrator" -> user', normalizeRole('administrator') === 'user');
  ok('"superver" -> user', normalizeRole('superver') === 'user');
  ok('"Admin,User" -> user', normalizeRole('Admin,User') === 'user');
  ok('empty -> user', normalizeRole('') === 'user');
  ok('undefined -> user', normalizeRole(undefined) === 'user');
}

console.log('\n[5b] resolveRole honours the same mapping');
{
  const base = { loginId: 'remiel.baking', dbRole: 'user', secret: SECRET, allowlist: '' };

  const approverTok = signIdentity({ login: 'remiel.baking', name: 'R', dept: 'MIS', role: 'approver' }, SECRET);
  const approver = resolveRole({ ...base, identityToken: approverTok });
  ok('signed Approver resolves to user', approver.role === 'user');
  ok('signed Approver is not admin', approver.isAdmin === false);

  const userTok = signIdentity({ login: 'remiel.baking', name: 'R', dept: 'MIS', role: 'user' }, SECRET);
  ok('signed User resolves to user', resolveRole({ ...base, identityToken: userTok }).role === 'user');

  const adminTok = signIdentity({ login: 'remiel.baking', name: 'R', dept: 'MIS', role: 'Admin' }, SECRET);
  ok('signed Admin resolves to admin', resolveRole({ ...base, identityToken: adminTok }).role === 'admin');

  // A signed "user" must not strip admin the database already grants.
  ok('signed User does not revoke database admin',
    resolveRole({ ...base, dbRole: 'admin', identityToken: userTok }).role === 'admin');
}

// Cross-language check: run the real PHP signer from tools/ and confirm Node
// accepts its token. This is the part that actually matters in production, since
// PHP produces every real token - a mismatch in encoding, key order or the
// HMAC itself would silently demote every real user to 'user'.
console.log('\n[6] PHP -> Node compatibility');
{
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  const phpSrc = path.join(__dirname, 'ami-identity-token.php');
  const php = fs.readFileSync(phpSrc, 'utf8');
  // Use the REAL values from the MIS session: the key is "user_role" and the
  // value is capitalised "Admin". Testing lowercase 'admin' here would hide a
  // mismatch between what PHP signs and what the chatbot expects.
  const script = php
    + "\necho amiIdentityToken('remiel.baking', 'Remiel Baking', 'MIS', 'Admin');\n";
  const scriptFile = path.join(os.tmpdir(), `ami-token-${process.pid}.php`);
  fs.writeFileSync(scriptFile, script, 'utf8');

  let phpAvailable = true;
  let phpToken = '';
  try {
    phpToken = execFileSync('php', ['-d', 'error_reporting=E_ALL', scriptFile], {
      encoding: 'utf8', env: { ...process.env, AMI_IDENTITY_SECRET: SECRET }
    }).trim();
  } catch (e) {
    phpAvailable = false;
    console.log(`    SKIP  php not runnable here (${e.message.split('\n')[0]})`);
  } finally {
    try { fs.unlinkSync(scriptFile); } catch { /* ignore */ }
  }

  if (phpAvailable) {
    ok('php emitted a two-part token', phpToken.split('.').length === 2, phpToken.slice(0, 40));
    const claims = verifyIdentity(phpToken, SECRET);
    ok('node accepts the php token', !!claims);
    ok('php login survives', claims && claims.login === 'remiel.baking', JSON.stringify(claims));
    ok('capitalised "Admin" from MIS becomes admin', claims && claims.role === 'admin');
    ok('php name survives', claims && claims.name === 'Remiel Baking');
    ok('php dept survives', claims && claims.dept === 'MIS');
    ok('node rejects php token under a different secret',
      verifyIdentity(phpToken, OTHER_SECRET) === null);
  }

  // A regular MIS user must not come back as admin. Same code path, different
  // session value.
  if (phpAvailable) {
    const userScript = php + "\necho amiIdentityToken('juan.delacruz', 'Juan Dela Cruz', 'Finance', 'User');\n";
    const userFile = path.join(os.tmpdir(), `ami-token-user-${process.pid}.php`);
    fs.writeFileSync(userFile, userScript, 'utf8');
    let userToken = '';
    try {
      userToken = execFileSync('php', ['-d', 'error_reporting=E_ALL', userFile], {
        encoding: 'utf8', env: { ...process.env, AMI_IDENTITY_SECRET: SECRET }
      }).trim();
    } finally {
      try { fs.unlinkSync(userFile); } catch { /* ignore */ }
    }
    const userClaims = verifyIdentity(userToken, SECRET);
    ok('capitalised "User" from MIS becomes user', userClaims && userClaims.role === 'user');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);