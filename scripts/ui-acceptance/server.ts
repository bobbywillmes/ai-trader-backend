import { Client } from 'pg';
import { assertAcceptanceEnvironment, assertDatabaseIdentity, loadAcceptanceDatabaseUrl } from './guard.js';

assertAcceptanceEnvironment();
process.env.DATABASE_URL = loadAcceptanceDatabaseUrl();
const identity = new Client({ connectionString: process.env.DATABASE_URL });
await identity.connect();
await assertDatabaseIdentity(identity);
await identity.end();

const originalFetch = globalThis.fetch;
globalThis.fetch = async input => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(`UI_ACCEPTANCE_OUTBOUND_NETWORK_BLOCKED: ${url.hostname}`);
  return originalFetch(input);
};

const [{ createApp }, { acceptanceReadOnlyGuard }] = await Promise.all([
  import('../../src/app/app.js'), import('./write-guard.js'),
]);
const app = createApp({ beforeBusinessRoutes: [acceptanceReadOnlyGuard] });
app.listen(3304, '0.0.0.0', () => console.log('Phase 3B.4 read-only acceptance API listening on 3304.'));
