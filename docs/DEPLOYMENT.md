# Deployment Guide

## Production Deployment

### Prerequisites
- Docker 24+ & Docker Compose 2+
- Domain with SSL certificate
- Google Gemini API key
- n8n webhook URL for ticket submission
- MIS database access (optional, for catalogs)

### Server Requirements
- 2+ GB RAM
- 2+ CPU cores
- 10+ GB disk space
- Ubuntu 22.04+ / Debian 12+ / RHEL 9+

## Deployment Steps

### 1. Prepare Environment

```bash
# On production server
mkdir -p /opt/ami-helpdesk
cd /opt/ami-helpdesk

# Copy project files
git clone <repo> .
# OR copy built files

# Configure environment
cp .env.example .env
# Edit .env with production values
```

### 2. Required .env Variables

```bash
# AI Provider (at least one required)
GEMINI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-3.5-flash-lite
OPENAI_API_KEY=              # Optional fallback
OPENAI_MODEL=gpt-4o-mini

# n8n Webhooks (required)
N8N_WEBHOOK_URL=https://n8n.yourcompany.com/webhook/ticket
N8N_TEST_WEBHOOK_URL=https://n8n.yourcompany.com/webhook-test/ticket

# Database (required for production)
DATABASE_URL=postgresql://ami_helpdesk:secure_password@postgres:5432/ami_helpdesk
POSTGRES_PASSWORD=secure_password_here

# Authentication
IDENTITY_SECRET=generate-with-openssl-rand-base64-32
ADMIN_USERS=admin1,admin2
ADMIN_KEY=generate-secure-random-string

# MIS Database (for catalogs + user directory)
MIS_DB_HOST=mis-db.yourcompany.com
MIS_DB_PORT=3306
MIS_DB_NAME=scrf
MIS_DB_USER=chatbot_readonly
MIS_DB_PASSWORD=mis_readonly_password

# Limits
RATE_LIMIT_PER_DAY=10
SESSION_TIMEOUT_MINUTES=5
SESSION_NUDGE_MINUTES=4
MAX_FILE_SIZE=10485760

# Network
PORT=3000
CORS_ORIGIN=https://your-intranet.company.com
TIMEZONE=Asia/Manila

# TLS (if terminating at container)
TLS_CERT_FILE=/app/certs/server.crt
TLS_KEY_FILE=/app/certs/server.key
```

### 3. SSL Certificates

```bash
mkdir -p certs
# Place your certificates:
# certs/server.crt - Full chain certificate
# certs/server.key - Private key (chmod 600)
```

### 4. Deploy

```bash
# Build and start
docker compose up -d --build

# Verify
docker compose ps
docker compose logs -f ami-chatbot
```

### 5. Verify Deployment

```bash
# Health check
curl https://helpdesk.yourcompany.com/api/health

# Expected response:
# {"status":"ok","webhook_configured":true,"ai_configured":true,"storage":"postgres"}
```

## Reverse Proxy (Nginx)

```nginx
# /etc/nginx/sites-available/ami-helpdesk
upstream ami_chatbot {
    server 127.0.0.1:3000;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name helpdesk.yourcompany.com;

    ssl_certificate /etc/nginx/ssl/helpdesk.crt;
    ssl_certificate_key /etc/nginx/ssl/helpdesk.key;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security headers
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    add_header Referrer-Policy strict-origin-when-cross-origin;

    # Widget assets - no cache
    location ~* \.(js|css|png|ico|svg|woff2?)$ {
        proxy_pass http://ami_chatbot;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API & Widget - no cache
    location / {
        proxy_pass http://ami_chatbot;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache off;
        proxy_buffering off;
    }
}

server {
    listen 80;
    server_name helpdesk.yourcompany.com;
    return 301 https://$server_name$request_uri;
}
```

```bash
# Enable site
ln -s /etc/nginx/sites-available/ami-helpdesk /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## MIS PHP Integration

### 1. Add Identity Token Generation

```php
// In your MIS session bootstrap / header include
require_once __DIR__ . '/ami-identity.php';

$amiToken = generateAmiIdentityToken([
    'login_id' => $_SESSION['user']['login_id'],
    'full_name' => $_SESSION['user']['full_name'],
    'department' => $_SESSION['user']['department'],
    'mis_role' => $_SESSION['user']['role']  // 'admin', 'approver', or 'user'
]);
```

### 2. Include Widget on Pages

```php
<!-- In your MIS layout/template -->
<script>
  window.AmiChatConfig = {
    baseUrl: 'https://helpdesk.yourcompany.com',
    loginUser: '<?= htmlspecialchars($_SESSION["user"]["login_id"]) ?>',
    userName: '<?= htmlspecialchars($_SESSION["user"]["full_name"]) ?>',
    userEmail: '<?= htmlspecialchars($_SESSION["user"]["email"]) ?>',
    userDepartment: '<?= htmlspecialchars($_SESSION["user"]["department"]) ?>',
    userRole: '<?= htmlspecialchars($_SESSION["user"]["mis_role"]) ?>',
    identityToken: '<?= $amiToken ?>'
  };
</script>
<script src="https://helpdesk.yourcompany.com/widget.js"></script>
```

### 3. Identity Token Generator (ami-identity.php)

```php
<?php
function generateAmiIdentityToken(array $claims): string {
    $secret = getenv('IDENTITY_SECRET') ?: 'your-identity-secret';
    
    $payload = [
        'login' => $claims['login_id'],
        'name' => $claims['full_name'] ?? '',
        'dept' => $claims['department'] ?? '',
        'role' => $claims['mis_role'] ?? 'user',
        'exp' => time() + (12 * 60 * 60)  // 12 hours
    ];
    
    $body = rtrim(strtr(base64_encode(json_encode($payload)), '+/', '-_'), '=');
    $sig = rtrim(strtr(base64_encode(hash_hmac('sha256', $body, $secret, true)), '+/', '-_'), '=');
    
    return $body . '.' . $sig;
}
?>
```

## Monitoring & Maintenance

### Health Checks
```bash
# Container health
docker compose ps

# Application health
curl -s https://helpdesk.yourcompany.com/api/health | jq .

# Database
docker compose exec postgres pg_isready -U ami_helpdesk -d ami_helpdesk
```

### Logs
```bash
# Application logs
docker compose logs -f ami-chatbot --tail=100

# PostgreSQL logs
docker compose logs postgres --tail=50

# Nginx logs
tail -f /var/log/nginx/ami-helpdesk.access.log
```

### Backup
```bash
# Database backup
docker compose exec postgres pg_dump -U ami_helpdesk ami_helpdesk > backup_$(date +%Y%m%d).sql

# Volume backup (conversations, uploads)
docker run --rm -v ami-helpdesk-node_ami_data:/data -v $(pwd):/backup alpine tar czf /backup/ami_data_$(date +%Y%m%d).tar.gz /data
```

### Updates
```bash
# Pull latest code
git pull

# Rebuild and restart
docker compose build --no-cache ami-chatbot
docker compose up -d

# Or zero-downtime (if multiple replicas)
docker compose up -d --scale ami-chatbot=2
docker compose up -d --scale ami-chatbot=1
```

## Troubleshooting

| Issue | Check |
|-------|-------|
| Container restarting | `docker compose logs ami-chatbot` |
| "No AI provider" | `GEMINI_API_KEY` set in .env? |
| "Database unavailable" | Postgres healthy? `DATABASE_URL` correct? |
| "No identity" | Widget sending `login_user`? MIS session valid? |
| "Not admin" | User in `ADMIN_USERS`? Token valid? MIS role = admin? |
| Tickets not creating | n8n webhook reachable? Returns `control_number`? |
| Slow responses | Check `docker stats`, DB indexes, AI latency |

## Rollback

```bash
# Quick rollback to previous image
docker tag ami-helpdesk-ts:latest ami-helpdesk-ts:broken
docker tag ami-helpdesk-ts:previous ami-helpdesk-ts:latest
docker compose up -d

# Database rollback (if schema changed)
docker compose exec postgres psql -U ami_helpdesk -d ami_helpdesk -f rollback.sql
```

## Security Checklist

- [ ] `IDENTITY_SECRET` is 32+ random bytes
- [ ] `POSTGRES_PASSWORD` is strong
- [ ] `ADMIN_KEY` is set for admin dashboard
- [ ] TLS certificates valid and not expiring soon
- [ ] `CORS_ORIGIN` restricted to your domain
- [ ] Firewall: only 80/443 open, 3000/5432 internal only
- [ ] Regular security updates: `docker compose pull && docker compose up -d`
- [ ] Backup tested quarterly