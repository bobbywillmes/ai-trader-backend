import 'dotenv/config';
import { Client } from 'pg';

import { runPositionLifecycleEvidenceInventory, type ApprovedInventoryDatabaseIdentity } from '../src/services/position-lifecycle-evidence-report.service.js';

function approvedIdentities():ApprovedInventoryDatabaseIdentity[]{
  throw new Error('Persistent lifecycle inventory is disabled: no independently managed development-tier database identity exists. Use only the disposable PostgreSQL acceptance harness.');
}

async function main(){const identities=approvedIdentities();const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required.');const pageArg=process.argv.find((value)=>value.startsWith('--page-size='));const pageSize=pageArg?Number(pageArg.split('=')[1]):250;const client=new Client({connectionString:url});await client.connect();try{const report=await runPositionLifecycleEvidenceInventory(client,{approvedIdentities:identities,pageSize});process.stdout.write(`${JSON.stringify(report,null,2)}\n`);}finally{await client.end();}}

main().catch((error)=>{process.stderr.write(`${error instanceof Error?error.message:'Lifecycle inventory failed.'}\n`);process.exitCode=1;});
