import { Client } from 'pg';
import { assertLifecycleRepairAcceptanceEnvironment, LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE } from './guard.js';

const url = assertLifecycleRepairAcceptanceEnvironment();
url.pathname = '/postgres'; url.search = '';
const client = new Client({ connectionString: url.toString() });
await client.connect();
await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE]);
await client.query(`DROP DATABASE IF EXISTS "${LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE}"`);
await client.query(`CREATE DATABASE "${LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE}"`);
await client.end();
console.log(`Reset isolated database ${LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE}.`);
