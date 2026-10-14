# Widget Integration Guide

## Quick Embed

```html
<!-- 1. Configure (before script) -->
<script>
  window.AmiChatConfig = {
    baseUrl: 'https://helpdesk.yourcompany.com',  // Required: your chatbot domain
    userName: 'Juan Dela Cruz',                    // From MIS session
    userEmail: 'juan.delacruz@company.com',        // From MIS session
    userDepartment: 'IT',                          // From MIS session
    userRole: 'user',                              // 'user' or 'admin'
    loginUser: 'juan.delacruz',                    // MIS login ID (required)
    identityToken: 'signed-jwt-from-mis-php',      // Optional: for admin access
    userAvatar: 'https://.../avatar.jpg'           // Optional
  };
</script>

<!-- 2. Load widget -->
<script src="https://helpdesk.yourcompany.com/widget.js"></script>
```

## Configuration Options

| Option | Required | Type | Description |
|--------|----------|------|-------------|
| `baseUrl` | Yes | string | Chatbot server URL (no trailing slash) |
| `loginUser` | Yes | string | MIS login ID - keys history/quota |
| `userName` | No | string | Display name (falls back to login) |
| `userEmail` | No | string | Email for ticket submission |
| `userDepartment` | No | string | Department name |
| `userRole` | No | string | `'user'` or `'admin'` |
| `identityToken` | No | string | Signed JWT from MIS PHP |
| `userAvatar` | No | string | Avatar image URL |
| `sessionId` | No | string | Override session key (default: loginUser) |
| `assetBase` | No | string | Override asset CDN URL |

## MIS PHP Integration

### Generating the Identity Token

```php
<?php
// mis-identity.php - Include in your MIS session bootstrap

function generateAmiIdentityToken(array $user): string {
    $secret = 'YOUR_IDENTITY_SECRET'; // Same as IDENTITY_SECRET in .env
    
    $payload = [
        'login' => $user['login_id'],           // e.g. 'juan.delacruz'
        'name' => $user['full_name'],           // e.g. 'Juan Dela Cruz'
        'dept' => $user['department'],          // e.g. 'IT'
        'role' => $user['mis_role'],            // 'admin', 'approver', or 'user'
        'exp' => time() + (12 * 60 * 60)        // 12 hour expiry
    ];
    
    $body = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', $body, $secret, true)), '+/', '-_'), '=');
    
    return $body . '.' . $sig;
}

// In your page template:
$amiToken = generateAmiIdentityToken($currentUser);
?>
<script>
  window.AmiChatConfig = {
    baseUrl: 'https://helpdesk.company.com',
    loginUser: '<?= htmlspecialchars($user["login_id"]) ?>',
    userName: '<?= htmlspecialchars($user["full_name"]) ?>',
    userEmail: '<?= htmlspecialchars($user["email"]) ?>',
    userDepartment: '<?= htmlspecialchars($user["department"]) ?>',
    userRole: '<?= htmlspecialchars($user["mis_role"]) ?>',
    identityToken: '<?= $amiToken ?>'
  };
</script>
<script src="https://helpdesk.company.com/widget.js"></script>
```

### Self-Signed Certificate Fallback

A LAN deployment serves the widget over HTTPS from a **self-signed** certificate
(`TLS_CERT_FILE` / `TLS_KEY_FILE`). Until a browser has been told to proceed past
that warning it refuses both `/widget.js` **and** `/widget.css` — the stylesheet is
injected at runtime by `main.js`, not linked in the page. The result is that the chat
launcher silently never appears, and the user cannot tell whether Ami is broken, not
deployed, or simply not yet enabled.

The fix on the MIS side is to detect the situation and explain it. Add this to the MIS
page that embeds the widget:

```php
<style>
    #ami-cert-fallback {
        position: fixed; bottom: 20px; right: 20px;
        width: 60px; height: 60px; border-radius: 999px; border: none;
        background: linear-gradient(135deg, #6b2fb5 0%, #8a4fd1 100%);
        color: #fff; display: none; align-items: center; justify-content: center;
        cursor: pointer; position: relative;
        box-shadow: 0 4px 12px rgba(0,0,0,.25);
        z-index: 1040; /* under the Bootstrap backdrop (1050) */
    }
    #ami-cert-fallback.is-visible { display: flex; }
</style>

<button id="ami-cert-fallback" type="button" aria-label="Ami chat setup">
    <!-- the same SVG AmiIcons.bot uses, so it reads as the real launcher -->
</button>

<script>
(function () {
    var ORIGIN = 'https://your-widget-host:3000';  // match AmiChatConfig.baseUrl
    var button = document.getElementById('ami-cert-fallback');

    // A completed TLS handshake IS the question being asked. Any HTTP answer,
    // including the 503 /api/health returns when storage is degraded, means the
    // browser already trusts the certificate.
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 5000);

    fetch(ORIGIN + '/api/health', { mode: 'cors', cache: 'no-store', signal: ctl.signal })
        .then(function () { button.classList.remove('is-visible'); })
        .catch(function () { button.classList.add('is-visible'); })  // explain, don't guess
        .then(function () { clearTimeout(timer); });

    // When the user says they have dismissed the warning, send them to the
    // confirmation page rather than reloading. Reloading only re-runs the probe
    // that just failed, so it cannot tell them whether their click registered.
    // document.getElementById('amiCertReload')
    //     .addEventListener('click', function () {
    //         window.location.href = ORIGIN + '/cert-trusted.html';
    //     });
})();
</script>
```

#### The confirmation page

`public/cert-trusted.html` ships with the widget host and is where the user lands after
clicking "I have proceeded". It re-runs the same probe and then reports one of three
outcomes, because "something happened" is only useful if it is specific:

| Probe result | Shown | Meaning |
| --- | --- | --- |
| any response, `status !== 404` | **Done** - "It's done, thank you. You can close this page now." | Certificate accepted; go back to the MIS page and the launcher will be there |
| any response, `status === 404` | **Almost** | TLS is fine, but `/api/health` is not being served. The launcher still may not appear, so this is not reported as success |
| rejection or 5s timeout | **Not yet** | The warning has not actually been dismissed yet; repeat the steps |

It is a single self-contained file with no build step, no CDN and no dependency on
`widget.js`/`widget.css` - the same constraint as the block above, because it is loaded
at the exact moment those assets may still be refused. It lives in `public/`, so it is
pinned to the widget origin and served by the same `express.static` mount as the widget.

Rules that matter here:

- **Inline everything.** Nothing in the block may depend on `widget.js` or
  `widget.css`, because those are exactly what fails to load.
- **Treat a 503 as trusted.** `/api/health` answers 503 when storage is degraded, which
  is a reachable server, not a certificate problem.
- **Always time out.** A hung request is indistinguishable from a blocked one to the
  user, and both mean no chat.
- **Place the markup after the `<!DOCTYPE html>`.** A DOCTYPE that follows any content is
  ignored by the HTML parser and puts the whole page into quirks mode.
- **Pin the probe origin absolutely.** The widget host is also reachable under
  `/mis_helpdesk/ami-helpdesk/`, where a relative `/api/health` resolves to a path the API
  never serves. That 404 is harmless to TLS but reads as a false alarm.

## Role Resolution Priority

1. **Signed Identity Token** (highest) - From MIS PHP, verified with `IDENTITY_SECRET`
2. **MIS User Directory** - Server-to-server lookup via `MIS_DB_*` config
3. **Database Role** - Stored in `users.role` (set via admin dashboard)
4. **ADMIN_USERS Allowlist** - Comma-separated logins in `.env`

The raw `user_role` from the widget is **never trusted** for authorization.

## Widget API (for Advanced Integration)

```javascript
// Get widget instance
const widget = window.AmiWidget;

// Send a message programmatically
widget.send('Hello, I need help with my printer');

// Open/close programmatically
widget.open();
widget.close();
widget.toggle();

// Listen for events
widget.on('message', (data) => {
  console.log('New message:', data); // { role, content, timestamp }
});

widget.on('ticket_created', (data) => {
  console.log('Ticket created:', data.control_number);
});

// Get current session
const session = widget.getSession();
```

## Styling Customization

The widget uses CSS custom properties. Override in your page:

```css
:root {
  --ami-primary: #1a73e8;           /* Primary brand color */
  --ami-background: #ffffff;        /* Chat window background */
  --ami-user-bubble: #e8f0fe;       /* User message background */
  --ami-assistant-bubble: #f1f3f4;  /* Assistant message background */
  --ami-text-primary: #202124;      /* Primary text */
  --ami-text-secondary: #5f6368;    /* Secondary text */
  --ami-border: #dadce0;            /* Borders */
  --ami-radius: 12px;               /* Border radius */
  --ami-font: 'Google Sans', system-ui, sans-serif;
}
```

## CSP (Content Security Policy)

If you use CSP, allow these:

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://helpdesk.yourcompany.com;
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' https://helpdesk.yourcompany.com;
  font-src 'self' data:;
  frame-ancestors 'self';
```

## Multiple Widget Instances

Only one widget per page is supported. For SPA navigation:

```javascript
// On route change - destroy and reinitialize
if (window.AmiWidget) {
  window.AmiWidget.destroy();
  delete window.AmiWidget;
}
// Re-run the script tag or call AmiWidget.init()
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Please sign in to MIS" | Missing `loginUser` | Ensure `loginUser` is set from PHP session |
| "Not administrator" | Role not resolved | Check `identityToken` signature, `IDENTITY_SECRET` match, `ADMIN_USERS` |
| Widget not loading | CSP blocking | Add `helpdesk.yourdomain.com` to CSP directives |
| Chat icon never appears, other pages work | Self-signed cert not yet bypassed | Both `widget.js` and `widget.css` fail to load. See [Self-Signed Certificate Fallback](#self-signed-certificate-fallback) |
| History not loading | CORS | Ensure `CORS_ORIGIN` includes your domain |
| Ticket not submitting | n8n error | Check webhook logs, verify n8n returns `control_number` |

## Migration from JavaScript Version

| Old | New |
|-----|-----|
| `widget.js` (ES modules) | Same entry point |
| Chat-based intake | Modal forms (`modal.js`) |
| `AmiIntake` module | Removed |
| `$create` command | Assistant opens the modal via `open_ticket_modal` (admins may still command it directly) |
| Header "Create Ticket" button | Removed — the assistant triggers the form |
| Chat commands | Same (`$help`, `$reset`, etc.) |