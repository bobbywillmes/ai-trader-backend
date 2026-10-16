import { pathToFileURL } from 'node:url';
import { runHistoricalOrderLifecycleCli } from '../src/services/historical-order-lifecycle-cli.service.js';

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  runHistoricalOrderLifecycleCli(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
