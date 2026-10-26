import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { runOfflineSnapshotInventory,verifySnapshotProvenance,type SnapshotProvenanceManifest } from '../src/services/position-lifecycle-offline-snapshot.service.js';

function arg(name:string){const prefix=`--${name}=`;const value=process.argv.slice(2).find(item=>item.startsWith(prefix))?.slice(prefix.length);if(!value)throw new Error(`Missing required ${prefix}<value>.`);return value;}
function integer(name:string,fallback:number){const raw=process.argv.slice(2).find(item=>item.startsWith(`--${name}=`))?.split('=')[1];const value=raw===undefined?fallback:Number(raw);if(!Number.isInteger(value))throw new Error(`--${name} must be an integer.`);return value;}

async function main(){
  if(process.env.DATABASE_URL||process.env.NODE_ENV)throw new Error('Offline snapshot inventory refuses DATABASE_URL and NODE_ENV; use only explicit snapshot arguments.');
  const manifestPath=resolve(arg('manifest'));const dumpPath=resolve(arg('dump'));const outputPath=resolve(arg('output'));
  const manifest=await verifySnapshotProvenance(manifestPath,dumpPath);
  const expectedTarget=JSON.parse(await readFile(resolve(arg('target-identity')),'utf8')) as {database:string;host:string|null;port:number|null;sessionUser:string};
  await runOfflineSnapshotInventory({targetUrl:arg('target-url'),expectedTarget,manifest:manifest as SnapshotProvenanceManifest,outputPath,workspaceRoot:process.cwd(),pageSize:integer('page-size',250),maxPositions:integer('max-positions',10_000),statementTimeoutMs:integer('timeout-ms',30_000),maxOutputBytes:integer('max-output-bytes',50*1024*1024)});
  process.stdout.write(`Offline inventory written to ${outputPath}\n`);
}

main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'Offline inventory failed.'}\n`);process.exitCode=1;});
