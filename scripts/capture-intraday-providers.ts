import { experimentMain } from '../src/dev/intraday-providers/experiment.js';
experimentMain().catch(() => {
  console.error('Research experiment failed: check session date, baseline, Node 24, capture locks, daily budget and writable output. No raw error is printed.');
  process.exitCode = 1;
});
