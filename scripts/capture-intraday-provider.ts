import { childMain } from '../src/dev/intraday-providers/experiment.js';
childMain().then(() => process.exit(process.exitCode ?? 0)).catch(() => {
  if (process.connected) process.send?.({ status: 'child_failed' }, () => process.exit(1));
  else process.exit(1);
});
