# Wasla WhatsApp Server — VPS (Azure Linux VM) Deployment Runbook
# Version target: 2.1.0 · Single instance law · No DNS change in this phase

## 1. Host preparation (once)

sudo mkdir -p /opt/wasla-whatsapp/auth_sessions
sudo chown -R 1000:1000 /opt/wasla-whatsapp/auth_sessions   # image runs as uid 1000 (node)
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin

## 2. Release layout on host

/opt/wasla-whatsapp/
  app/                 # repo checkout or uploaded release archive
    Dockerfile docker-compose.yml .env .dockerignore *.js package*.json .npmrc
  auth_sessions/       # persistent Baileys state (NEVER delete casually)

.env must define (names only):
  SUPABASE_URL, SUPABASE_SERVICE_KEY, BAILEYS_API_KEY,
  AUTH_SESSIONS_DIR=/app/auth_sessions, ALLOWED_ORIGINS= , PORT=3000

## 3. Build + run

cd /opt/wasla-whatsapp/app
docker compose build
docker compose up -d
docker compose ps            # healthy after ~20s
curl -s http://127.0.0.1:3000/health
# → {"ok":true,"version":"2.1.0",...}

## 4. Reverse proxy (TLS terminates here — Node port is NOT public)

Caddy example (/etc/caddy/Caddyfile) once DNS is cut over:

  wasla-whatsapp.<your-domain> {
      reverse_proxy 127.0.0.1:3000
  }

Nginx equivalent:

  server {
    listen 443 ssl http2;
    server_name wasla-whatsapp.<your-domain>;
    ssl_certificate     /etc/letsencrypt/live/<host>/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/<host>/privkey.pem;
    location / {
      proxy_pass http://127.0.0.1:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
      proxy_read_timeout 3600s;   # long-lived Baileys websocket upstreams
    }
  }

Firewall: allow 443 from the internet (or restrict to Supabase Edge egress +
operator IPs). NEVER expose :3000 publicly.

## 5. Persistence guarantees

- Container replace/recreate → auth_sessions survives (host volume).
- VM reboot → docker restarts container (restart: unless-stopped) → sessions
  restore sequentially from disk; no QR re-scan.
- Explicit company logout/disconnect in WASLA UI → QR re-link intended.

## 6. Session migration from current Oracle host (later cutover phase)

tar -C /path/to/oracle/app -czf sessions.tgz auth_sessions
# copy to new VPS, untar into /opt/wasla-whatsapp/auth_sessions with uid 1000
# then start container. Do NOT run two servers against the same Supabase.

## 7. Operations

- Logs: docker logs -f wasla-whatsapp-server
- Diagnostics (auth): curl -H "x-api-key: ***" https://<host>/diag
- Restart: docker compose restart
- Update: docker compose build && docker compose up -d  (sessions persist)

## 8. Rollback

Previous image tag retained locally:
docker compose down && docker tag wasla-whatsapp-server:<prev> wasla-whatsapp-server:2.1.0 && docker compose up -d
