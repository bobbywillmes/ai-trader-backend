import 'dotenv/config';
import { Client } from 'pg';

import { runPositionLifecycleEvidenceInventory, type ApprovedInventoryDatabaseIdentity } from '../src/services/position-lifecycle-evidence-report.service.js';

function approvedIdentities():ApprovedInventoryDatabaseIdentity[]{
  if(process.env.ALLOW_PERSISTENT_DEVELOPMENT_LIFECYCLE_INVENTORY!=='I_UNDERSTAND_READ_ONLY')throw new Error('Persistent lifecycle inventory is disabled. Set the explicit development-only acknowledgement first.');
  const raw=process.env.LIFECYCLE_INVENTORY_APPROVED_DATABASE_IDENTITIES;if(!raw)throw new Error('LIFECYCLE_INVENTORY_APPROVED_DATABASE_IDENTITIES must contain an exact JSON identity allowlist.');
  const value:unknown=JSON.parse(raw);if(!Array.isArray(value)||value.length===0)throw new Error('The lifecycle inventory identity allowlist must be a non-empty JSON array.');
  return value.map((item)=>{if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('Invalid lifecycle inventory identity.');const row=item as Record<string,unknown>;if(typeof row.database!=='string'||(typeof row.host!=='string'&&row.host!==null)||typeof row.port!=='number'||typeof row.user!=='string')throw new Error('Each approved identity requires exact database, host, port, and user fields.');return {database:row.database,host:row.host,port:row.port,user:row.user};});
}

async function main(){const identities=approvedIdentities();const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required.');const pageArg=process.argv.find((value)=>value.startsWith('--page-size='));const pageSize=pageArg?Number(pageArg.split('=')[1]):250;const client=new Client({connectionString:url});await client.connect();try{const report=await runPositionLifecycleEvidenceInventory(client,{approvedIdentities:identities,pageSize});process.stdout.write(`${JSON.stringify(report,null,2)}\n`);}finally{await client.end();}}

main().catch((error)=>{process.stderr.write(`${error instanceof Error?error.message:'Lifecycle inventory failed.'}\n`);process.exitCode=1;});
