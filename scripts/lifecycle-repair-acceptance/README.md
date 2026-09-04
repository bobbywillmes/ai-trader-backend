# Historical lifecycle repair acceptance

This harness is restricted to `ai_trader_lifecycle_repair_acceptance`. It must
never target the normal development or production database. It installs the
fail-closed broker transport before importing the application; unexpected
network requests fail instead of reaching Alpaca.

Set process-local `DATABASE_URL` to the disposable database and set:

```powershell
$env:LIFECYCLE_REPAIR_ACCEPTANCE='I_UNDERSTAND_THIS_IS_DISPOSABLE_LIFECYCLE_REPAIR_DATA'
```

The fixture creates a disposable SYSTEM_OWNER, PAPER account, and ACTIVE
credential containing generated synthetic values. No real broker credential is
needed or accepted by this workflow. Every harness command installs the
fail-closed broker transport before importing application code. Unexpected
network requests fail, and the historical repair path permits no broker write.

## Automated staged acceptance

Run this sequence without starting either development server:

```powershell
npm.cmd run acceptance:lifecycle-repair:reset
npx.cmd prisma migrate deploy
npm.cmd run acceptance:lifecycle-repair:fixture
npm.cmd run acceptance:lifecycle-repair:verify-fixture
npm.cmd run acceptance:lifecycle-repair:staged-path
npm.cmd run acceptance:lifecycle-repair:reset
```

`staged-path` consumes the fixture by applying both synthetic repair actions and
resolving its Operational Attention episode. Do not run it before a manual
browser ceremony; reset and reseed first if it has already run.

## Manual browser acceptance

Prepare the isolated scenario:

```powershell
npm.cmd run acceptance:lifecycle-repair:reset
npx.cmd prisma migrate deploy
npm.cmd run acceptance:lifecycle-repair:fixture
npm.cmd run acceptance:lifecycle-repair:verify-fixture
npm.cmd run acceptance:lifecycle-repair:server
```

Keep that backend process running. In a separate terminal, with no production
environment variables, start the frontend:

```powershell
npm.cmd --prefix apps/web run dev
```

Vite proxies `/api` to [http://127.0.0.1:3000](http://127.0.0.1:3000) by
default. Use the generated owner login, open `/operational-attention`, and:

1. Review, approve, and apply terminalization.
2. Refresh or re-preview and confirm that link-only attention remains active.
3. Review, approve, and apply linking.
4. Run persisted reconciliation for the synthetic account and confirm the
   actions become VERIFIED and the attention resolves.

Stop both servers, then tear down the disposable scenario:

```powershell
npm.cmd run acceptance:lifecycle-repair:reset
```

The normal application has no fixture or reset endpoint. Synthetic fixture IDs
are generated locally and must never copy a production identity.
