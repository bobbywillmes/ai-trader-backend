import {
  disconnectTrackedPositionAttributionRepairDb,
  runTrackedPositionAttributionRepairCli,
} from '../src/services/tracked-position-attribution-repair.service.js';

runTrackedPositionAttributionRepairCli()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(disconnectTrackedPositionAttributionRepairDb);
