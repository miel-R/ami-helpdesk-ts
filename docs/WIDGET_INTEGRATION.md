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