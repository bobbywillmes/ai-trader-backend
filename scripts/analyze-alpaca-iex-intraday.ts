import { analyzeMain } from '../src/dev/alpaca-iex/cli.js';

analyzeMain().catch(() => {
  console.error('Offline analysis failed: check run directory, supported manifest/calendar, journal integrity and cutoff. Source files were not modified.');
  process.exitCode = 1;
});
