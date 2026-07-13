/// <reference types="node" />

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { bootstrapTradingAccountRiskSettings } from '../src/services/trading-account-risk-settings-bootstrap.service.js';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseApplyMode(args: string[]) {
  const unknown = args.filter((arg) => arg !== '--apply');

  if (unknown.length > 0) {
    throw new Error(`Unknown argument(s): ${unknown.join(', ')}`);
  }

  return args.includes('--apply');
}

function formatValue(value: number | null) {
  return value === null ? 'null' : String(value);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireEnv('DATABASE_URL') }),
});

async function main() {
  const apply = parseApplyMode(process.argv.slice(2));
  const report = await bootstrapTradingAccountRiskSettings(prisma, { apply });

  console.log(`Trading account risk settings bootstrap: ${report.mode}`);
  console.log(
    `${report.changedAccountCount} of ${report.accountCount} account(s) require routine-limit backfill.`
  );

  for (const account of report.accounts) {
    const fields = Object.entries(account.fields);
    console.log(
      `- TradingAccount ${account.tradingAccountId} (${account.displayName}): ${fields.length === 0 ? 'no changes' : account.createsRiskSettings ? 'create settings row' : 'populate null fields'}`
    );

    for (const [field, value] of fields) {
      console.log(`  ${field}: ${formatValue(value ?? null)}`);
    }

    for (const field of account.unresolvedFields) {
      console.log(`  ${field}: unresolved (legacy global fallback is null)`);
    }
  }

  if (!apply && report.changedAccountCount > 0) {
    console.log('Dry run only. Re-run with --apply to write the reported fields.');
  }
}

main()
  .catch((error) => {
    console.error('Trading account risk settings bootstrap failed.');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
