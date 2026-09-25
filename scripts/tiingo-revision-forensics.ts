import { revisionsMain } from '../src/dev/intraday-providers/revisions.js';

revisionsMain().then(path => process.stdout.write(path + '\n')).catch(error => {
  process.stderr.write(String(error) + '\n'); process.exitCode = 1;
});
