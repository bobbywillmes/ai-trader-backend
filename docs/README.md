# AI Trader Backend Docs

This directory contains the operational, architectural, and integration documentation for the AI Trader backend.

The root `README.md` is the project front door. These docs are the working manual.

## 🚀 Start Here

| Need	                                                  | Open |
| --- | --- |
| Understand the backend safety model	                    | [Risk & Safety](architecture/risk-and-safety.md) |
| Audit global vs account-scoped risk settings            | [Account Risk Settings](architecture/account-risk-settings.md) |
| Understand how a signal becomes a full trade cycle      | [Trading Lifecycle](architecture/trading-lifecycle.md) |
| Understand the momentum scanner catalyst/news pipeline  | [Momentum Scanner Architecture](architecture/catalyst-news-foundation.md) |
| Run or debug the n8n Momentum Scanner Review workflow   | [Momentum Scanner Review Workflow](integrations/n8n/momentum-scanner-review.md) |
| Understand background worker health and stale detection | [Worker Health](architecture/workers.md) |
| Deploy or update production                             | [Production Deployment](production/deployment.md) |
| Follow the normal local → GitHub → VPS workflow         | [Production Workflow](production/production-workflow.md) |
| Run or debug Prisma migrations                          | [Database Migrations](production/database-migrations.md) |
| Diagnose production problems                            | [Troubleshooting](production/troubleshooting.md) |
| Understand the n8n → backend contract                   | [n8n Integration](integrations/n8n.md) |
| Manage trading accounts and broker credentials          | [Trading Account Admin API](api/trading-accounts.md) |
| Understand Alpaca broker API observability              | [Alpaca Integration](integrations/alpaca.md) |
| Generate and view the database diagram                  | [Database Visualization](database/README.md) |

## 🧱 Architecture Docs

Architecture docs explain how the backend is designed and why major pieces exist.

### [Risk and Safety](architecture/risk-and-safety.md)

Explains the backend safety model, including:

- runtime trading settings
- kill switch behavior
- paper/live mode protection
- centralized risk gate
- production startup checks
- entry blocking rules
- safe launch posture

### [Account Risk Settings](architecture/account-risk-settings.md)

Audits current global Settings fields against the account-scoped trading model, including:

- where each setting is stored, read, displayed, and edited
- which settings should stay global emergency controls
- which limits should move to `TradingAccount`
- which limits should be enforced through `TradingAccountAllocation`
- which settings are already owned by `TradingAccountSubscription`
- migration phases before live multi-account trading

Use this doc when changing global Settings, account-level risk limits, allocation bucket enforcement, or paper/live safety behavior.

### [Trading Lifecycle](architecture/trading-lifecycle.md)

Explains the full backend-managed lifecycle:

```text
n8n signal
  -> entry decision snapshot
  -> backend validation
  -> risk gate
  -> order intent
  -> broker order
  -> tracked position / trade cycle
  -> exit profile
  -> broker fill import
  -> position closure
  -> trade history / reporting
```

Use this doc when changing signal handling, tracked positions, exit profiles, broker activity imports, or lifecycle event logging.

### [Momentum Scanner Architecture](architecture/catalyst-news-foundation.md)

Documents the review-only momentum scanner foundation:

- Massive news ingestion
- database-backed `MomentumUniverseMember` research coverage
- `NewsPullCursor` worker checkpoints
- `CatalystEvent` and `CatalystTickerImpact`
- `MomentumCandidate`
- price and volume confirmation
- `MomentumScannerHandoff`
- Admin UI pipeline review and universe management pages
- n8n signal routes
- Slack review alerts
- safety boundaries and future work

Use this doc when changing catalyst/news ingestion, candidate generation, price confirmation, scanner handoffs, or Momentum Scanner Admin UI behavior.

### [Worker Health](architecture/workers.md)

Documents recurring worker inventory, cadence, health status derivation, persistence, System Status fields, transition events, and troubleshooting.

## 🔌 API Docs

API docs describe backend HTTP surfaces that are stable enough to call from admin tools, automation, or future UI work.

### [Trading Account Admin API](api/trading-accounts.md)

Documents admin-only trading account read/update endpoints and account-scoped broker credential upsert, verification, and revocation behavior.

## 🔁 Integration Docs

Integration docs describe how external systems interact with the backend.

### [n8n Integration](integrations/n8n.md)

Documents the broader n8n → backend contract, including:

- signal-level authentication
- entry decision snapshot endpoint
- entry signal endpoint
- open positions endpoint
- production testing notes

Use this doc when modifying shared n8n authentication, ETF watcher signal routes, or backend signal route behavior.

### [Momentum Scanner Review Workflow](integrations/n8n/momentum-scanner-review.md)

Documents the review-only n8n workflow for momentum scanner handoffs, including:

- workflow schedule
- `signal-key` auth
- node sequence
- handoff queue semantics
- Slack delivery behavior
- troubleshooting

Use this doc when editing or debugging the `AI Trader - Momentum Scanner Review` workflow.

### [Alpaca Integration](integrations/alpaca.md)

Documents the backend-owned Alpaca REST integration, request metadata requirements, API usage tracking, rate-limit backoff behavior, persistence, and the Admin UI usage panel.

Use this doc when adding Alpaca adapter calls, changing broker polling behavior, or investigating Alpaca rate-limit pressure.

## 🔐 Security Docs

### [Access Control & RBAC](security/README.md)

Documents human admin authentication, machine authentication, roles, permissions, trading account access, owner onboarding, setup links, and the read-only account viewer portal.

Use this doc when changing:

- `AdminUser`
- `AdminSession`
- `AdminUserSetupToken`
- `TradingAccountAccess`
- admin authentication routes
- RBAC middleware
- Users & Access
- invite/setup onboarding
- `/portal` viewer routing
- account-scoped viewer API routes

## 🚢 Production Docs

Production docs are operational runbooks. They should be accurate, practical, and command-focused.

### [Production Deployment](production/deployment.md)

Initial and routine production deployment checklist for the backend and admin UI.

Use this when setting up production or walking through a full deployment verification.

### [Production Workflow](production/production-workflow.md)

The normal day-to-day production update flow:

```text
work locally
  -> test locally
  -> commit
  -> push to GitHub
  -> SSH into VPS
  -> pull latest
  -> migrate if needed
  -> rebuild/restart
  -> verify production
```

Use this when shipping routine code changes.

### [Database Migrations](production/database-migrations.md)

Prisma and production database migration guide.

Use this when:

- adding or changing Prisma models
- deploying schema changes
- debugging missing-column errors
- checking migration state
- validating production DB updates

### [Troubleshooting](production/troubleshooting.md)

Symptom-driven production debugging notes.

Use this when something is broken and you need to quickly identify likely causes.

## 🗄️ Database Docs

### [Database Visualization](database/README.md)

Documents how to generate DBML from Prisma and import the schema into dbdiagram.io.

## 🧪 Testing Docs

### [Testing](development/testing.md)

Documents backend test commands and the current service-level coverage around lifecycle attribution, trade-cycle APIs, config snapshots, and reporting.

## 🟢 Current Production Posture

The backend is designed to support conservative paper-production testing before live trading.

Production should be verified in this order:

```text
backend health
  -> database migration status
  -> environment config
  -> broker mode
  -> runtime settings
  -> risk gate behavior
  -> admin UI
  -> n8n dry run
  -> n8n signal handling
```

Automated trading should only be enabled deliberately after production health, settings, broker mode, and n8n behavior are confirmed.

## ✍️ Documentation Conventions

The documentation structure is intentionally split by purpose:

```text
docs/
  api/              Backend API notes
  architecture/     System design and lifecycle explanations
  integrations/     External system contracts and workflows
  production/       Deployment, migrations, workflows, and troubleshooting
  database/         Database visualization and schema docs
  development/      Local development and testing docs
```

Guidelines:

- Keep the root `README.md` short.
- Put detailed operational instructions in `/docs`.
- Prefer task-specific docs over one large document.
- Avoid duplicating long command blocks across multiple files.
- Link to the source doc instead of copying the same instructions.
- Use concise top-level headings.
- Use icons on `##` headings where they improve scanability.
- Keep production docs practical and command-focused.
- Update docs in the same commit as behavior changes when possible.

## 🧭 Future Docs to Add

Likely future additions:

```text
docs/local-development.md
docs/api/signals.md
docs/api/settings.md
docs/api/tracked-positions.md
docs/api/market-diary.md
docs/integrations/admin-ui.md
docs/architecture/data-models.md
docs/decisions/
```

Add these when the existing docs become too broad or when a topic starts needing its own focused reference.
