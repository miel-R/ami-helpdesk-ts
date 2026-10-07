<?php
/**
 * Ami chatbot - MIS-signed identity token.
 *
 * Drop this into the MIS helpdesk and call amiIdentityToken() when building
 * window.AmiChatConfig. It lets the chatbot take each person's role from MIS
 * instead of keeping a second admin list, WITHOUT trusting the browser: the
 * role is HMAC-signed here, server-side, and src/server/identity.js verifies
 * the signature in constant time.
 *
 * The secret must match IDENTITY_SECRET in the chatbot's .env, and must never
 * be echoed into the page. tools/identity-signing-regress.cjs runs this exact
 * file under PHP and checks Node accepts the result, so the two can never drift.
 */

if (!defined('AMI_IDENTITY_SECRET')) {
    // Prefer an env var so the secret stays out of version control.
    $secret = getenv('AMI_IDENTITY_SECRET');
    if (!$secret) {
        // Fallback for convenience - move this to a real config in production.
        $secret = 'CHANGE_ME_TO_MATCH_IDENTITY_SECRET';
    }
    define('AMI_IDENTITY_SECRET', $secret);
}

/**
 * Build a signed identity assertion for one person.
 *
 * @param string $login MIS login id, e.g. "remiel.baking"
 * @param string $name  Display name
 * @param string $dept  Department
 * @param string $role  MIS session value from $_SESSION["user_role"]. MIS uses
 *                      "Admin"/"User" (capitalised); matching is case-insensitive,
 *                      and anything that is not "admin" becomes a regular user
 * @return string base64url(payload) . "." . base64url(HMAC-SHA256)
 */
function amiIdentityToken($login, $name, $dept, $role)
{
    $b64u = function ($bin) {
        return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
    };

    $payload = array(
        'login' => (string) $login,
        'name'  => (string) $name,
        'dept'  => (string) $dept,
        // Anything that is not exactly "admin" is treated as a regular user, so
        // an unexpected role string can never grant access.
        'role'  => strtolower(trim((string) $role)) === 'admin' ? 'admin' : 'user',
        // 12 hours: long enough for a normal shift, short enough that a tab
        // left open overnight does not keep asserting a stale role.
        'exp'   => (int) (microtime(true) * 1000) + 12 * 60 * 60 * 1000,
    );

    $body = $b64u(json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    $sig  = $b64u(hash_hmac('sha256', $body, AMI_IDENTITY_SECRET, true));

    return $body . '.' . $sig;
}