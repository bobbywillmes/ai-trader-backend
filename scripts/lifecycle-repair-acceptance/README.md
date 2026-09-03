# Historical lifecycle repair acceptance

This harness is restricted to `ai_trader_lifecycle_repair_acceptance`. It must
never target the normal development or production database. It installs the
fail-closed broker transport before importing the application; unexpected
network requests fail instead of reaching Alpaca.

Set process-local `DATABASE_URL` to the disposable database and set:

```powershell
$env:LIFECYCLE_REPAIR_ACCEPTANCE='I_UNDERSTAND_THIS_IS_DISPOSABLE_LIFECYCLE_REPAIR_DATA'
```

Then run `npm.cmd run acceptance:lifecycle-repair:reset`, deploy migrations to
that disposable database, run `npm.cmd run acceptance:lifecycle-repair:fixture`,
and start with `npm.cmd run acceptance:lifecycle-repair:server`. The fixture prints
its generated owner login and attention ID for opening `/operational-attention`
and the linked Lifecycle Repair Workbench. Reset is the teardown procedure. The normal application has no
fixture or reset endpoint. Synthetic fixture IDs must be generated locally and
must never copy a production identity.
