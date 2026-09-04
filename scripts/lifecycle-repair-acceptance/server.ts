import { assertLifecycleRepairAcceptanceEnvironment } from './guard.js';
import { installMockAlpacaTransport } from '../manual-acceptance/mock-alpaca-transport.js';
import { MANUAL_ACCEPTANCE_SENTINEL } from '../../src/services/manual-acceptance-environment.js';

assertLifecycleRepairAcceptanceEnvironment();
process.env.MANUAL_ACCEPTANCE_HARNESS = MANUAL_ACCEPTANCE_SENTINEL;
installMockAlpacaTransport();
await import('../../src/app/server.js');
