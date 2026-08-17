import { Client } from 'pg';

const source = process.env.DATABASE_URL ?? '';
if (!source) throw new Error('DATABASE_URL is required.');
const url = new URL(source);
if (url.pathname !== '/ai_trader_live_entry_acceptance') {
  throw new Error('Reset refuses to operate unless DATABASE_URL targets ai_trader_live_entry_acceptance.');
}
url.pathname = '/postgres';
url.search = '';
const client = new Client({ connectionString: url.toString() });
await client.connect();
await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'ai_trader_live_entry_acceptance' AND pid <> pg_backend_pid()`);
await client.query('DROP DATABASE IF EXISTS "ai_trader_live_entry_acceptance"');
await client.query('CREATE DATABASE "ai_trader_live_entry_acceptance"');
await client.end();
console.log('Reset isolated database ai_trader_live_entry_acceptance.');
