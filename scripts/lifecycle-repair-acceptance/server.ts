import { assertLifecycleRepairAcceptanceEnvironment } from './guard.js';
import { installMockAlpacaTransport } from '../manual-acceptance/mock-alpaca-transport.js';

assertLifecycleRepairAcceptanceEnvironment();
installMockAlpacaTransport();
await import('../../src/app/server.js');
