# AGENTS.md

Guidance for Codex and other AI coding agents working in this repository.

This file is a living project manual. Update it when the workflow, architecture, commit standards, or safety expectations change.

## Project Snapshot

AI Trader Backend is a Node.js/TypeScript service that sits between n8n market signals and Alpaca broker execution.

The backend owns:

- signal ingestion
- subscription-driven order resolution
- centralized risk checks
- async broker order submission
- broker activity ingestion
- tracked position lifecycle management
- exit evaluation
- account snapshots
- system event audit trails
- web UI APIs and authentication

The web UI lives in `apps/web/` and is a React/Vite app that talks to the backend HTTP API.

The Prisma schema in `prisma/schema.prisma` is the source of truth for the database model.

## Collaboration Workflow

The normal feature workflow uses three layers:

1. The main ChatGPT conversation is used for higher-level planning.
   The user discusses what they want to build, why it matters, and how it may affect the project as a whole.

2. ChatGPT produces a detailed task handoff for Codex.
   The handoff should include the goal, relevant context, constraints, expected validation, and any known risks.

3. Codex works in VS Code on the implementation.
   Codex should inspect the repo, make focused code changes, run checks, create commits, and provide concise progress updates.

When a feature is complete, the user may ask Codex for a summary to hand back to ChatGPT. That summary should focus on what changed, why it changed, files touched, tests run, deployment notes, and any remaining risks or follow-up work.

## Branch Workflow

New features should be developed on a new Git branch created from `main`.

Typical flow:

```bash
git checkout main
git pull origin main
git checkout -b feature-or-fix-name
```

All work for a feature should stay on that branch until it is complete and ready to merge back into `main`.

Usually there should only be one open feature branch besides `main`, because this is a solo project. Emergency fixes may be created separately when production needs a quick repair.

Do not create a new branch unless the user asks for one or the current task clearly starts a new feature. If the user says to continue an existing branch, stay on that branch.

Never run destructive Git commands such as `git reset --hard` or `git checkout -- <file>` unless the user explicitly asks for that exact action.

## Commit Standards

Use conventional commit-style subjects where practical:

```text
feat(scope): describe change
fix(scope): describe change
refactor(scope): describe change
docs: describe change
chore(scope): describe change
```

Every commit should include a detailed body, not only a subject.

Commit body rules:

- Capitalize the first word of each sentence unless it is a code symbol, field name, function name, or other case-sensitive identifier.
- Use line breaks between logical thoughts.
- Explain what changed, why it changed, and any tests or validation.
- Mention schema, migration, deployment, or operational implications when relevant.
- Keep the body factual and specific to the commit.

Preferred format:

```bash
git commit -m "fix(scope): concise subject" -m "First paragraph explains the main behavior change.

Second paragraph explains implementation details and important tradeoffs.

Third paragraph explains tests, validation, migrations, or operational notes."
```

Before committing, inspect the staged diff:

```bash
git status --short
git diff --cached --stat
```

Do not include unrelated changes in a commit. If unrelated local changes exist, leave them alone unless the user asks otherwise.

## Core Commands

Backend commands from the repo root:

```bash
npm run dev
npm run check
npm run test
npm run test:watch
npm run build
npm run start
npm run dev:tunnel
```

On Windows PowerShell, use `npm.cmd` if script execution blocks the `npm.ps1` shim:

```bash
npm.cmd run check
npm.cmd test
npm.cmd run build
```

Web UI commands from `apps/web/`:

```bash
npm run dev
npm run build
npm run lint
```

Database commands:

```bash
docker compose up -d postgres
npx prisma migrate dev
npx prisma generate
npx tsx src/db/seed.ts
```

Run `npx prisma generate` after Prisma schema changes.

## Validation Expectations

For backend changes, run at least:

```bash
npm run check
npm run test
npm run build
```

For web UI changes, run the relevant UI checks:

```bash
cd apps/web
npm run build
npm run lint
```

Run targeted tests first when iterating, then the broader suite before committing.

If a command cannot be run, report that clearly with the reason.

## Architecture Rules

Prefer existing project boundaries:

- `src/routes/` defines Express routers.
- `src/controllers/` parses requests and shapes responses.
- `src/services/` owns business logic.
- `src/integrations/` wraps external APIs such as Alpaca.
- `src/workers/` owns background polling loops.
- `src/validators/` owns Zod request schemas.

Controllers should stay thin. Put lifecycle, risk, reconciliation, reporting, and broker behavior in services.

Do not bypass the service layer from UI or route code.

Use Prisma and typed data structures instead of ad hoc string parsing when a structured model exists.

## Trading Safety Rules

This project controls broker-facing trading behavior. Treat lifecycle and safety changes carefully.

Preserve these principles:

- n8n sends signals, but the backend decides whether an entry is allowed.
- The risk gate is the centralized entry safety boundary.
- Alpaca orders must use stable idempotency keys.
- Background workers must avoid duplicate broker submissions.
- Position lifecycle transitions should be guarded against overlapping worker ticks.
- Broker-confirmed data belongs in `BrokerActivity`.
- Significant transitions and uncertainty should be visible through `SystemEvent`.
- Ambiguous broker/order/position attribution should remain unresolved rather than guessed.

Be especially careful when editing:

- `src/services/risk-gate.service.ts`
- `src/services/place-order.service.ts`
- `src/workers/order.worker.ts`
- `src/services/position-tracking.service.ts`
- `src/services/broker-activity.service.ts`
- `src/services/close-position.service.ts`
- `src/services/exit-evaluator.service.ts`
- `src/services/trailing-stop-exit.service.ts`
- `src/services/reconciliation.service.ts`
- `prisma/schema.prisma`

## Trade Lifecycle Notes

The intended lifecycle is:

```text
n8n signal
-> backend validation
-> subscription resolution
-> risk gate
-> OrderIntent
-> async order worker
-> BrokerOrder
-> BrokerActivity fill import
-> TrackedPosition
-> ExitProfile evaluation
-> broker close or trailing stop
-> close fill attribution
-> position closure
-> trade cycle and performance reporting
```

`GET /api/trade-cycles` and `GET /api/trade-cycles/:id` are the canonical lifecycle review APIs.

`GET /api/trade-performance` should derive from canonical trade-cycle summaries instead of recomputing from raw tables independently.

Trade-cycle config snapshots should remain immutable once captured. If subscription context is recovered after position creation, capture the snapshot then, but do not overwrite an existing snapshot.

## Database And Migration Rules

Stop and tell the user before creating a migration if a schema change is not clearly necessary or if there may be a simpler event-based or JSON-snapshot-based approach.

When a schema change is required:

1. Update `prisma/schema.prisma`.
2. Create a Prisma migration.
3. Regenerate Prisma client if needed.
4. Commit the generated `docs/database/ai-trader.dbml` update from Prisma generation alongside the schema and migration files.
5. Update services, tests, and docs in the same branch.
6. Call out migration/deployment implications in the final summary and commit body.

Do not run `prisma format` in this repository. The Prisma schema intentionally uses hand-aligned whitespace for readability, so schema edits should preserve existing formatting and only change the lines required for the model change.

Do not backfill production data casually. Treat historical trading data as audit-sensitive.

## Web UI Guidance

The web UI is an operational console, not a marketing site.

Keep UI changes:

- dense but readable
- predictable for repeated use
- consistent with existing feature folders under `apps/web/src/features/`
- connected to backend APIs through feature-specific `api.ts`, `hooks.ts`, and `types.ts`

Only rebuild the web UI when UI code changes.

When building apps/web, Vite may report a large-chunk warning. This is expected for this internal web application and does not need to be highlighted unless the build fails or the warning materially changes.

## Documentation Rules

The root `README.md` is the project front door.

Detailed documentation should live under `docs/`:

- `docs/architecture/` for system design
- `docs/integrations/` for external contracts
- `docs/production/` for deployment and runbooks
- `docs/development/` for testing and local development notes

Update docs in the same commit as behavior changes when the docs would otherwise become stale.

## Operational Posture

Default production posture should remain conservative:

```text
tradingEnabled=false
paperMode=true
killSwitchEnabled=false
ALLOW_LIVE_TRADING=false
ALLOW_TRADING_ENABLED_ON_START=false
```

Routine production update flow:

```text
create feature branch from main
-> work locally on the feature branch
-> validate locally
-> commit
-> merge the completed feature branch back into main
-> push main to GitHub
-> SSH into VPS
-> pull latest
-> run migrations if needed
-> rebuild/restart containers
-> verify health
-> verify web UI
-> verify n8n behavior
```

Typical local branch flow before production deployment:

```bash
git checkout main
git pull origin main
git checkout -b feature-or-fix-name

# work, validate, and commit on the feature branch

git checkout main
git merge feature-or-fix-name
git push origin main
```

If the feature branch contains multiple commits, keep those commits meaningful. Do not squash by default unless the user asks for a squash merge.

Use the production compose file in production:

```bash
docker compose -f docker-compose.prod.yml ...
```

Do not use plain `docker compose down && docker compose up -d` on the production host.

## Final Response Expectations

When finishing a task, summarize:

- what changed
- files touched
- tests and checks run
- migrations or deployment implications
- anything intentionally not changed
- suggested next steps if useful

For commit-related tasks, include the final commit hash.

For handoff back to ChatGPT, provide a higher-level summary with enough context for the main planning conversation to resume without rereading the whole implementation thread.
