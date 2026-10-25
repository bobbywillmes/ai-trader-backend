import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { Client } from 'pg';

import { runPositionLifecycleEvidenceInventory } from './position-lifecycle-evidence-report.service.js';

export const SNAPSHOT_MANIFEST_VERSION = 'AI_TRADER_DEVELOPMENT_BACKUP_V1' as const;

const manifestSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_MANIFEST_VERSION),
  createdAt: z.iso.datetime(),
  backup: z.object({ fileName: z.string().min(1), byteLength: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), format: z.literal('POSTGRES_CUSTOM') }).strict(),
  source: z.object({
    dockerContext: z.literal('default'), composeProjectDirectory: z.string().min(1), composeConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
    service: z.literal('postgres'), containerName: z.literal('ai-trader-postgres'), image: z.string().regex(/^postgres:16(?:\.|$)?/),
    volumeName: z.string().regex(/_postgres_data$/), volumeDestination: z.literal('/var/lib/postgresql/data'),
    database: z.literal('ai_trader'), databaseUser: z.literal('trader'), postgresMajor: z.literal(16),
    containerId: z.string().min(12), databaseSystemIdentifier: z.string().regex(/^\d+$/),
    productionContainersAbsent: z.boolean(), tunnelsAbsent: z.boolean(),
  }).strict(),
  approval: z.object({ approvedBy: z.string().min(1), approvedAt: z.iso.datetime(), purpose: z.literal('POSITION_LIFECYCLE_EVIDENCE_INVENTORY') }).strict(),
}).strict();

export type SnapshotProvenanceManifest = z.infer<typeof manifestSchema>;

async function sha256File(path:string) {
  const hash=createHash('sha256');
  await pipeline(createReadStream(path),hash);
  return hash.digest('hex');
}

export async function verifySnapshotProvenance(manifestPath:string,dumpPath:string):Promise<SnapshotProvenanceManifest>{
  const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
  const stat=await lstat(dumpPath);
  if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Snapshot archive must be a regular, non-symbolic-link file.');
  if(manifest.backup.fileName!==dumpPath.replaceAll('\\','/').split('/').at(-1))throw new Error('Snapshot archive filename differs from verified provenance.');
  if(stat.size!==manifest.backup.byteLength)throw new Error('Snapshot archive size differs from verified provenance.');
  if(await sha256File(dumpPath)!==manifest.backup.sha256)throw new Error('Snapshot archive checksum differs from verified provenance.');
  if(!manifest.source.productionContainersAbsent||!manifest.source.tunnelsAbsent)throw new Error('Snapshot provenance does not prove development-only source isolation.');
  return manifest;
}

function assertSafeOutputPath(outputPath:string,workspaceRoot:string){
  if(!isAbsolute(outputPath))throw new Error('Inventory output path must be absolute.');
  if(extname(outputPath).toLowerCase()!=='.json')throw new Error('Inventory output must be a JSON file.');
  const relation=relative(resolve(workspaceRoot),resolve(outputPath));
  if(relation===''||(!relation.startsWith('..')&&!isAbsolute(relation)))throw new Error('Inventory output must be outside the Git workspace.');
}

async function writePrivateAtomic(path:string,value:unknown,maxBytes:number){
  const body=`${JSON.stringify(value,null,2)}\n`;
  if(Buffer.byteLength(body)>maxBytes)throw new Error(`Inventory report exceeds the ${maxBytes}-byte output limit.`);
  await mkdir(dirname(path),{recursive:true});
  await lstat(path).then(()=>{throw new Error('Inventory output path already exists; refusing to overwrite it.');},error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
  const temporary=`${path}.incomplete-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle;
  try{
    handle=await open(temporary,'wx',0o600);
    await handle.writeFile(body,'utf8');
    await handle.sync();
    await handle.close();handle=undefined;
    await chmod(temporary,0o600);
    if(process.platform!=='win32'&&((await lstat(temporary)).mode&0o077)!==0)throw new Error('Inventory report permissions are not owner-only.');
    await rename(temporary,path);
  }catch(error){await handle?.close().catch(()=>undefined);await rm(temporary,{force:true}).catch(()=>undefined);throw error;}
}

export async function runOfflineSnapshotInventory(args:{targetUrl:string;expectedTarget:{database:string;host:string|null;port:number|null;sessionUser:string};manifest:SnapshotProvenanceManifest;outputPath:string;workspaceRoot:string;pageSize?:number;maxPositions?:number;statementTimeoutMs?:number;maxOutputBytes?:number}){
  if(!args.expectedTarget.database.startsWith('ai_trader_snapshot_'))throw new Error('Offline inventory target must use the ai_trader_snapshot_ disposable database prefix.');
  if(new URL(args.targetUrl).pathname.slice(1)!==args.expectedTarget.database)throw new Error('Offline target URL database differs from the explicitly approved target.');
  assertSafeOutputPath(args.outputPath,args.workspaceRoot);
  const client=new Client({connectionString:args.targetUrl,connectionTimeoutMillis:5_000,query_timeout:(args.statementTimeoutMs??30_000)+5_000});
  await client.connect();
  try{
    const report=await runPositionLifecycleEvidenceInventory(client,{approvedIdentities:[args.expectedTarget],reportHmacKey:randomBytes(32),...(args.pageSize===undefined?{}:{pageSize:args.pageSize}),...(args.maxPositions===undefined?{}:{maxPositions:args.maxPositions}),...(args.statementTimeoutMs===undefined?{}:{statementTimeoutMs:args.statementTimeoutMs})});
    const artifact={contract:'POSITION_LIFECYCLE_OFFLINE_SNAPSHOT_INVENTORY_V1',sourceSnapshot:{createdAt:args.manifest.createdAt,archiveSha256:args.manifest.backup.sha256,sourceDatabase:args.manifest.source.database,sourceSystemIdentifier:args.manifest.source.databaseSystemIdentifier,sourceContainerId:args.manifest.source.containerId},analysisTarget:{database:report.databaseIdentity.database,host:report.databaseIdentity.host,port:report.databaseIdentity.port,sessionUser:report.databaseIdentity.sessionUser},report};
    await writePrivateAtomic(args.outputPath,artifact,args.maxOutputBytes??50*1024*1024);
    return artifact;
  }finally{await client.end();}
}
