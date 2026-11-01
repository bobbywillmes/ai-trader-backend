import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { readSecurityCatalog } from '../src/services/database-security-readiness.service.js';

// Regenerates src/services/database-security-manifest.ts from a FRESHLY MIGRATED DISPOSABLE database. Never point it
// at a persistent database: the manifest is the reviewed baseline, so it must come from the migrations in this
// repository, not from whatever a live database currently holds. Review the diff before committing.
//   tsx scripts/generate-database-security-manifest.ts --from <disposable database url>
const index = process.argv.indexOf('--from');
const url = index > -1 ? process.argv[index + 1] : undefined;
if (!url) { console.error('Usage: tsx scripts/generate-database-security-manifest.ts --from <fresh disposable database url>'); process.exit(64); }

const client = new Client({ connectionString: url });
await client.connect();
try {
  const catalog = await readSecurityCatalog(async (sql, params) => (await client.query(sql, params)).rows as never);
  const applied = (await client.query(`SELECT migration_name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1`)).rows[0]?.migration_name as string;
  const latest = readdirSync('prisma/migrations', { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort().at(-1);
  if (applied !== latest) throw new Error(`The database is at migration ${applied}, the repository at ${latest}; migrate the disposable database fully first.`);
  const header = readFileHeader();
  writeFileSync('src/services/database-security-manifest.ts', `${header}
export const SECURITY_MANIFEST: { version: string; migration: string; functions: Record<string, ManifestFunction>; triggers: Record<string, ManifestTrigger> } = ${JSON.stringify({ version: applied, migration: applied, functions: catalog.functions, triggers: catalog.triggers }, null, 2)};
`);
  console.log(`Wrote manifest for ${applied}: ${Object.keys(catalog.functions).length} functions, ${Object.keys(catalog.triggers).length} triggers.`);
} finally { await client.end(); }

function readFileHeader() {
  const source = readFileSync('src/services/database-security-manifest.ts', 'utf8');
  return source.slice(0, source.indexOf('export const SECURITY_MANIFEST')).trimEnd() + '\n';
}
