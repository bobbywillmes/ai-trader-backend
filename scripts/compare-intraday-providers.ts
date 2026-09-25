import { compareMain } from '../src/dev/intraday-providers/compare.js';
compareMain().catch(() => { console.error('Offline provider comparison failed: check experiment/run linkage, journal integrity, shared baseline and reference identities.'); process.exitCode = 1; });
