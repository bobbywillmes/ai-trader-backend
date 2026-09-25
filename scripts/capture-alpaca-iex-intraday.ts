import { captureMain } from '../src/dev/alpaca-iex/cli.js';

captureMain().then(() => {
  // All journal writes and lock release completed; native close cannot hold this manual process open.
  process.exit(process.exitCode ?? 0);
}).catch(() => {
  console.error('Research capture failed. Check Node 24, explicit ALPACA_MARKET_DATA_* config, session date, capture lock and writable output. No raw error is printed.');
  process.exitCode = 1;
});
