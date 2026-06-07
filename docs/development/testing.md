# Testing

AI Trader uses Vitest for backend service tests.

The current testing focus is production-safety behavior around the trading lifecycle, especially exit handling.

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

The initial test coverage focuses on the unlock-to-trailing-stop exit lifecycle:
```text
target not reached -> do nothing
target reached -> unlock target and submit trailing stop
trailing stop already submitted -> do not submit duplicate order
broker submission failure -> mark attention/failure state
existing Alpaca order found by client order ID -> recover without duplicate submission
Testing style
```
Prefer small service-level tests that mock external dependencies such as Prisma and Alpaca.

Tests should verify safety-critical behavior directly:
```text
do not submit duplicate broker orders
do not close positions unexpectedly
do not treat failed protection as successful protection
do not silently ignore broker/order uncertainty
```
