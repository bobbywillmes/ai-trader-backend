# Production Workflow

This doc covers the day-to-day workflow for local development, committing, and deploying to the production VPS — including the production safety baseline, operating rule, and emergency controls.

---

## 🏗 Production Stack

The hosted production-like environment runs on Hostinger VPS using Docker Compose.

```text
Hostinger VPS
  → Caddy reverse proxy / HTTPS
  → React admin UI static build
  → Node/Express backend
  → PostgreSQL
  → Prisma migrations
  → Alpaca paper trading integration
  → background workers
```

Current production URL pattern:

```http
https://srv1700402.hstgr.cloud/        → Admin UI
https://srv1700402.hstgr.cloud/health  → Public health check
https://srv1700402.hstgr.cloud/api/*   → Backend API
```

---

## 🛠 Local Development Workflow

Make changes locally first.

Recommended local validation before committing:

```bash
npm run check
npm run build

cd apps/admin-ui
npm run build
cd ../..
```

Then commit and push:

```bash
git add .
git commit -m "feat(scope): describe change"
git push origin main
```

Use conventional commit-style prefixes where practical:

```text
feat(admin-ui): ...
feat(api): ...
fix(worker): ...
refactor(db): ...
docs: ...
chore(deploy): ...
```

---

## 🔃 Routine Production Update Flow

SSH into the AI Trader VPS:

```bash
ssh root@srv1700402.hstgr.cloud
```

Go to the deployed app directory:

```bash
cd /opt/ai-trader
```

Pull the latest code:

```bash
git pull origin main
```

Apply pending Prisma migrations:

```bash
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

For backend-only changes:

```bash
docker compose -f docker-compose.prod.yml build backend
docker compose -f docker-compose.prod.yml up -d backend
```

For admin UI changes, rebuild Caddy because the React static build is bundled into the Caddy image:

```bash
docker compose -f docker-compose.prod.yml build caddy
docker compose -f docker-compose.prod.yml up -d caddy
```

For changes that touch both backend and admin UI:

```bash
docker compose -f docker-compose.prod.yml build backend caddy
docker compose -f docker-compose.prod.yml up -d
```

If you edit `/opt/ai-trader/.env`, restart production with the production
compose file so the backend container receives the updated environment:

```bash
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

Do not use plain `docker compose down && docker compose up -d` in production.
That uses the default development compose file and can leave the production
backend unavailable or missing required environment variables.

Check container status:

```bash
docker compose -f docker-compose.prod.yml ps
```

Check recent logs:

```bash
docker compose -f docker-compose.prod.yml logs --tail=100 backend
docker compose -f docker-compose.prod.yml logs --tail=100 caddy
```

---

## 🛡 Production Safety Baseline

The first production startup should remain conservative:

```env
NODE_ENV=production
ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false
ALPACA_BASE_URL=https://paper-api.alpaca.markets
MASSIVE_API_KEY=...
MASSIVE_BASE_URL=https://api.massive.com
```

Runtime database settings should also remain conservative unless deliberately changed from the admin UI:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
```

This means the backend can run in production, sync account state, read Alpaca paper positions, receive n8n dry-run context requests, and write Market Diary events without accepting automated order-entry activity.

---

## 🛡 Production Operating Rule

```text
Deploy safely.
Verify health.
Verify system status.
Keep automated trading disabled.
Let n8n run dry.
Only enable paper trading deliberately.
```

---

## 🚨 Emergency Controls

### Stop opening new positions

Use the Kill Switch:

```text
Settings → Trading Controls → Kill Switch On
```

This blocks new entries while keeping the system online for monitoring, syncing, position tracking, exit workflows, reports, and admin visibility.

### Stop automated trading broadly

Turn off Automated Trading:

```text
Settings → Trading Controls → Automated Trading Off
```

### Stop the backend

Stop the backend containers from the production host:

```bash
docker compose -f docker-compose.prod.yml down
```

Use this only if the service itself needs to be taken offline.
