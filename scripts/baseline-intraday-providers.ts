import { baselineMain } from '../src/dev/intraday-providers/experiment.js';
baselineMain().catch(() => { console.error('Research baseline failed: check date, completed prior session, dedicated Massive key, entitlement and unused output directory.'); process.exitCode = 1; });
