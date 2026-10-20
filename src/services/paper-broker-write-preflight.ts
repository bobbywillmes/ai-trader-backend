import { readFileSync } from 'node:fs';

export type PaperBrokerWritePreflightMode = 'inspect' | 'development-validation' | 'production';

export type PaperBrokerWritePreflightArgs = {
  mode: PaperBrokerWritePreflightMode;
  expectedTradingAccountId: number | null;
  expectedBrokerAccountId: string | null;
  expectedImageRevision: string | null;
  expectedDatabase: string | null;
  expectedDatabaseHost: string | null;
  expectedDatabasePort: number | null;
  expectedDatabaseUser: string | null;
};

const VALUE_FLAGS = new Set([
  '--mode', '--expected-trading-account-id', '--expected-broker-account-number', '--expected-image-revision',
  '--expected-database', '--expected-database-host', '--expected-database-port', '--expected-database-user',
]);

export function parsePaperBrokerWritePreflightArgs(argv: string[]): PaperBrokerWritePreflightArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`Unknown or unsupported argument: ${flag}`);
    if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    values.set(flag, next);
    index += 1;
  }
  const rawMode = values.get('--mode') ?? 'inspect';
  if (!['inspect', 'development-validation', 'production'].includes(rawMode)) throw new Error('Use --mode inspect, development-validation, or production.');
  const mode = rawMode as PaperBrokerWritePreflightMode;
  const accountValue = values.get('--expected-trading-account-id');
  const portValue = values.get('--expected-database-port');
  const expectedTradingAccountId = accountValue === undefined ? null : Number(accountValue);
  const expectedDatabasePort = portValue === undefined ? null : Number(portValue);
  if (accountValue !== undefined && (!Number.isInteger(expectedTradingAccountId) || expectedTradingAccountId! < 1)) throw new Error('Invalid --expected-trading-account-id.');
  if (portValue !== undefined && (!Number.isInteger(expectedDatabasePort) || expectedDatabasePort! < 1 || expectedDatabasePort! > 65535)) throw new Error('Invalid --expected-database-port.');
  const parsed = { mode, expectedTradingAccountId, expectedBrokerAccountId: values.get('--expected-broker-account-number') ?? null,
    expectedImageRevision: values.get('--expected-image-revision') ?? null, expectedDatabase: values.get('--expected-database') ?? null,
    expectedDatabaseHost: values.get('--expected-database-host') ?? null, expectedDatabasePort,
    expectedDatabaseUser: values.get('--expected-database-user') ?? null };
  if (mode !== 'inspect' && Object.entries(parsed).some(([key, value]) => key !== 'mode' && value === null)) {
    throw new Error('Execution readiness requires account, broker account_number, image revision, database name, host, port, and user assertions.');
  }
  return parsed;
}

export type PaperBrokerWriteDatabaseTarget = { database: string; host: string | null; port: number | null; user: string };

export function readEmbeddedImageRevision(path = '/app/.image-revision') {
  const revision = readFileSync(path, 'utf8').trim();
  if (!revision) throw new Error('Embedded image revision evidence is missing or empty.');
  return revision;
}

export function assertPaperBrokerWritePreflightContext(args: PaperBrokerWritePreflightArgs, nodeEnv: string,
  imageRevision: string | undefined, target: PaperBrokerWriteDatabaseTarget) {
  if (args.mode === 'inspect') return;
  if (target.database !== args.expectedDatabase) throw new Error('Connected PostgreSQL database name does not match the explicit target assertion.');
  if (target.host !== args.expectedDatabaseHost) throw new Error('Connected PostgreSQL server host does not match the explicit target assertion.');
  if (target.port !== args.expectedDatabasePort) throw new Error('Connected PostgreSQL server port does not match the explicit target assertion.');
  if (target.user !== args.expectedDatabaseUser) throw new Error('Connected PostgreSQL user does not match the explicit target assertion.');
  if (!imageRevision || imageRevision !== args.expectedImageRevision) throw new Error('Staged image revision does not match the exact reviewed commit assertion.');
  if (args.mode === 'production' && nodeEnv !== 'production') throw new Error(`Production preflight requires NODE_ENV=production; received ${nodeEnv}.`);
  if (args.mode === 'development-validation' && nodeEnv !== 'development') throw new Error(`Development validation preflight requires NODE_ENV=development; received ${nodeEnv}.`);
}
