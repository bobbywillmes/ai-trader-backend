import { phaseBMain } from '../src/dev/alpaca-iex/phase-b-cli.js';

phaseBMain().catch(() => {
  console.error('Phase B failed. Check explicit command, run/artifact integrity, fetch IDs, dedicated credentials and provider entitlement. No provider response or secret is printed.');
  process.exitCode = 1;
});
