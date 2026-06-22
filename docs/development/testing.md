# Testing

AI Trader uses Vitest for backend service tests.

The current testing focus is production-safety behavior around the trading lifecycle, close-fill attribution, canonical trade-cycle APIs, configuration snapshots, and reporting.

## Commands

Run the backend test suite:
```bash
npm run test
```

Run tests in watch mode while developing:
```bash
npm run test:watch
```

Run TypeScript checks:
```bash
npm run check
```
Run the production build:
```bash
npm run build
```

## Test/build separation

Tests live beside the backend service code using the pattern:
```bash
src/**/*.test.ts
```

Vitest is configured to run source test files only and ignore compiled output in dist.

Production builds use `tsconfig.build.json`, which excludes test files so compiled test code is not emitted into dist.

## Current coverage

Current service-level coverage includes:

```text
- unlock-to-trailing-stop exit lifecycle behavior
- close-fill attribution from broker activities to tracked trade cycles
- observer-mode close attribution for development databases watching production paper Alpaca state
- duplicate broker activity ingestion safety
- trade-cycle summary/detail assembly
- tracked-position config snapshot capture and snapshot precedence
- trade-performance aggregation and closedAt date filtering
- worker health status derivation, persistence throttling, transition events, and System Status readiness semantics
- Alpaca request metadata enforcement, API usage aggregation, rate-limit deferral, usage persistence, and System Status exposure
- adaptive Alpaca REST polling decisions, market modes, forced sync, rate-limit-compatible skips, and System Status serialization
```

Prefer small service-level tests that mock external dependencies such as Prisma and Alpaca.

Tests should verify safety-critical behavior directly:

```text
do not submit duplicate broker orders
do not attach fills to the wrong trade cycle
do not treat failed protection as successful protection
do not silently ignore broker/order uncertainty
do not let mutable live config rewrite historical trade meaning
do not mark worker health failed for idle, not-due, or per-record business outcomes
do not let nonessential Alpaca rate-limit deferrals look like business failures
do not let adaptive skips increment Alpaca request metrics
do not let forced synchronization bypass active rate-limit backoff
```

Adaptive polling tests should use injected clocks/providers and fake timers where useful. They must not call real Alpaca endpoints or sleep in real time.

Focused commands used while changing adaptive polling:

```bash
npm run test -- src/services/adaptive-polling.service.test.ts
npm run test -- src/workers/order.worker.test.ts src/services/position-tracking.service.test.ts
npm run test -- src/services/system-status.service.test.ts
npm run check
```
