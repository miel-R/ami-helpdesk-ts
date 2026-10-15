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
    //
    // The ?back= parameter is only a fallback. The confirmation page reads the
    // live address from GET /api/public/cert-config, so an admin changing it in
    // Dashboard -> Settings does not also have to edit this page - and this PHP
    // file never has to know about it. Note that PHP and the chatbot server are
    // separate processes with separate environments: getenv() here would NOT see
    // a value the dashboard saved, which is exactly why the page asks the server
    // instead.
    // document.getElementById('amiCertReload')
    //     .addEventListener('click', function () {
    //         window.location.href = ORIGIN + '/cert-trusted.html?back=' +
    //             encodeURIComponent(HELPDESK_URL);
    //     });
})();
</script>
```

#### The confirmation page

`public/cert-trusted.html` ships with the widget host and is where the user lands after
clicking **Proceed**. It says the same thing every time:

> **All set** - *This browser is checked.* You are done. You can close this tab.

**It does not probe anything, and that is deliberate.** By the time this document
renders, the certificate is already accepted: a browser cannot load an HTTPS page over a
certificate it rejects without first showing the warning the user just dismissed. An
earlier version re-ran the `/api/health` probe and reported pass/fail, which meant a
setup that was already finished spent its first seconds claiming to be "Checking...".
Since the outcome can only ever be "done", the finished state is written into the markup
and nothing has to verify it.

The consequence worth stating plainly: if this page *does* load, the widget will load
too. There is no longer a branch where the page reports failure.

It is a single self-contained file with no build step, no CDN and no dependency on
`widget.js`/`widget.css` - the same constraint as the block above, because it is loaded
at the exact moment those assets may still be refused. It lives in `public/`, so it is
pinned to the widget origin and served by the same `express.static` mount as the widget.

**There are no buttons.** The one action available - returning to the Helpdesk - is an
ordinary `<a href>`, not a `<button>` with a click handler. A button would be a worse
link: it breaks with JavaScript disabled, hides the destination from the status bar, and
loses right-click → open in new tab. The earlier version used
`window.history.back()` with a `window.close()` fallback, and both failed in practice -
the page is opened in a new tab, so there is no history entry behind it, and browsers
refuse `window.close()` on a tab they did not open.

The Helpdesk address is **a dashboard setting**, fetched from
`GET /api/public/cert-config` rather than baked into the page, so changing it in
Dashboard → Settings takes effect immediately. The `?back=` parameter the MIS page
passes and `document.referrer` are fallbacks, and if none of the three yields an
`http(s)` address the page simply says to return to the Helpdesk tab.

The saved value lives in Postgres (`ticket_modal_config`, under the
`_cert_back_url` row) for the same reason the Ticket Forms switches do: it is changed
by an admin from the dashboard while the chatbot is running, and an env var would mean
a restart for every tweak. Resolution order is **database → `AMI_CERT_BACK_URL` →
built-in default**, so an unset database row still honours the env var and a deleted
row falls back cleanly.

Rules that matter here:

- **Never use an inline `<script>`.** The server sets helmet's default CSP on every
  response, and that header says `script-src 'self'` with no `'unsafe-inline'`, so an
  inline script block is refused outright. Use `<script src="cert-trusted.js">` with a
  **relative** `src`, which `script-src 'self'` allows and which resolves correctly
  under both the root mount and `/mis_helpdesk/ami-helpdesk/`. See the callout below.
- **No external dependency either.** The script must not import `widget.js` or
  `widget.css`, because those are exactly what fails to load. A same-origin file of its
  own is fine - by the time this page renders the certificate is already trusted, so a
  same-origin asset always loads.
- **Write the outcome in the markup.** The result is static text, not something a
  script swaps in. A page whose good news depends on script execution is a page that
  can show nothing at all.
- **Place the markup after the `<!DOCTYPE html>`.** A DOCTYPE that follows any content is
  ignored by the HTML parser and puts the whole page into quirks mode.
- **Time out the one request that remains.** The settings lookup is the only async work
  left, and a stalled fetch must not leave a half-drawn link behind. `showLink()` is
  called on both settle and reject so the region is always filled.
- **Validate the back target.** `?back=` is attacker-controllable, so `safeUrl()` accepts
  `http:`/`https:` only and refuses everything else, turning a `javascript:` URL into a
  no-op rather than an injection. Build the link with `createElement` and `textContent`,
  never `innerHTML`, so there is no string to escape in the first place.
- **Guard the `AbortController` constructor.** `new AbortController()` throws
  synchronously on a browser that lacks it, which kills the IIFE before the promise
  exists - so `showLink()` never runs and the region stays empty. Check
  `typeof window.AbortController === 'function'` and fall back before constructing one.

> **Why this page lost its link once already.** The symptom was a page that rendered fine
> but whose "Back to the Helpdesk" link was simply absent - no visible error, no dead
> button, just nothing where the link should be.
>
> The cause was CSP, not JavaScript. `helmet()` (`src/server/app.ts`) sends
> `script-src 'self'` on every page, which refuses inline `<script>` blocks. The page had
> exactly one script and it was inline, so it never ran, so `#backslot` stayed empty. It
> had been that way since the page was first added - the earlier "Checking…" freeze had
> the same cause and was misdiagnosed as a syntax error. A syntax error was present too,
> and fixing it changed nothing, which is what finally pointed at the header.
>
> `tools/cert-page-regress.cjs` now fails the build if the HTML contains an inline
> script block or an inline event handler, so this cannot silently come back. It also
> runs `node --check` and executes the script in a `vm` sandbox with a stub DOM, so a
> dead script cannot pass review either way.

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