# AI Trader Backend Docs

This directory contains the operational, architectural, and integration documentation for the AI Trader backend.

The root `README.md` is the project front door. These docs are the working manual.

## 🧭 Start Here

Use this index to find the right document for the task at hand.

| Need	                                             | Open |
| -------------------------------------------------- | -----------------------  |
| Understand the backend safety model	             | Risk & Safety            |
| Understand how a signal becomes a tracked position | Trading Lifecycle        |
| Deploy or update production	                     | Production Deployment    |
| Follow the normal local → GitHub → VPS workflow	 | Production Workflow      |
| Run or debug Prisma migrations	                 | Database Migrations      |
| Diagnose production problems	                     | Troubleshooting          |
| Understand the n8n → backend contract	             | n8n Integration          |



## 🏗️ Architecture Docs

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
- Trading Lifecycle

Explains the full backend-managed lifecycle:

```
n8n signal
→ backend validation
→ risk gate
→ order intent
→ broker order
→ tracked position
→ exit profile
→ broker fill import
→ position closure
```

Use this doc when changing signal handling, tracked positions, exit profiles, broker activity imports, or lifecycle event logging.

## 🔌 Integration Docs

Integration docs describe how external systems interact with the backend.

### [n8n Integration](integrations/n8n.md)

Documents the production n8n workflow contract, including:

- entry signal endpoint
- expected request headers
- expected payload shape
- success responses
- expected blocking responses
- diary event behavior
- production testing notes

Use this doc when modifying the n8n workflow or backend signal routes.

## 🏭 Production Docs

Production docs are operational runbooks. They should be accurate, practical, and command-focused.

### [Production Deployment](production/deployment.md)

Initial and routine production deployment checklist for the backend and admin UI.

Use this when setting up production or walking through a full deployment verification.

### [Production Workflow](production/production-workflow.md)

The normal day-to-day production update flow:
```
work locally
→ test locally
→ commit
→ push to GitHub
→ SSH into VPS
→ pull latest
→ migrate if needed
→ rebuild/restart
→ verify production
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
- Troubleshooting

Symptom-driven production debugging notes.

Use this when something is broken and you need to quickly identify likely causes.

## 🧪 Testing Docs

### [Testing](development/testing.md)

Basic integration testing has been set up with Vitest. Tests have been created around the position lifecycle, particularly around the exit cycle.

## 🧪 Current Production Posture

The backend is designed to support conservative paper-production testing before live trading.

Production should be verified in this order:

```
backend health
→ database migration status
→ environment config
→ broker mode
→ runtime settings
→ risk gate behavior
→ admin UI
→ n8n dry run
→ n8n signal handling
```

Automated trading should only be enabled deliberately after production health, settings, broker mode, and n8n behavior are confirmed.

## 📝 Documentation Conventions

The documentation structure is intentionally split by purpose:
```
docs/
  architecture/     System design and lifecycle explanations
  integrations/     External system contracts and workflows
  production/       Deployment, migrations, workflows and troubleshooting
```
Guidelines:

- Keep the root README.md short.
- Put detailed operational instructions in /docs.
- Prefer task-specific docs over one large document.
- Avoid duplicating long command blocks across multiple files.
- Link to the source doc instead of copying the same instructions.
- Use concise top-level headings.
- Use icons on ## headings where they improve scanability.
- Keep production docs practical and command-focused.
- Update docs in the same commit as behavior changes when possible.

## 🧹 Future Docs to Add

Likely future additions:
```
docs/local-development.md
docs/api/signals.md
docs/api/settings.md
docs/api/tracked-positions.md
docs/api/market-diary.md
docs/integrations/alpaca.md
docs/integrations/admin-ui.md
docs/architecture/workers.md
docs/architecture/data-models.md
docs/decisions/
```
Add these when the existing docs become too broad or when a topic starts needing its own focused reference.