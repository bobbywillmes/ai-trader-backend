import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { SNAPSHOT_MANIFEST_VERSION, verifySnapshotProvenance } from './position-lifecycle-offline-snapshot.service.js';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});

async function fixture(overrides:Record<string,unknown>={}){
  const root=join(tmpdir(),`ai-trader-snapshot-${randomUUID()}`);roots.push(root);await mkdir(root,{recursive:true});
  const dumpPath=join(root,'synthetic.dump');const bytes=Buffer.from('synthetic PostgreSQL custom archive fixture');await writeFile(dumpPath,bytes,{mode:0o600});
  const manifest={schemaVersion:SNAPSHOT_MANIFEST_VERSION,createdAt:'2026-10-25T12:00:00.000Z',backup:{fileName:'synthetic.dump',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),format:'POSTGRES_CUSTOM'},source:{dockerContext:'default',composeProjectDirectory:'C:/Users/bobby/Desktop/AI Trader Backend',composeConfigSha256:'a'.repeat(64),service:'postgres',containerName:'ai-trader-postgres',image:'postgres:16',volumeName:'ai-trader-backend_postgres_data',volumeDestination:'/var/lib/postgresql/data',database:'ai_trader',databaseUser:'trader',postgresMajor:16,containerId:'b'.repeat(64),databaseSystemIdentifier:'123456789',productionContainersAbsent:true,tunnelsAbsent:true},approval:{approvedBy:'fixture-owner',approvedAt:'2026-10-25T12:01:00.000Z',purpose:'POSITION_LIFECYCLE_EVIDENCE_INVENTORY'},...overrides};
  const manifestPath=join(root,'synthetic.manifest.json');await writeFile(manifestPath,JSON.stringify(manifest),{mode:0o600});return{manifestPath,dumpPath,manifest};
}

describe('offline snapshot provenance',()=>{
  it('accepts an exact approved synthetic archive and manifest',async()=>{const f=await fixture();await expect(verifySnapshotProvenance(f.manifestPath,f.dumpPath)).resolves.toMatchObject({backup:{sha256:f.manifest.backup.sha256},source:{database:'ai_trader'}});});
  it('rejects a changed archive checksum',async()=>{const f=await fixture();await writeFile(f.dumpPath,'tampered');await expect(verifySnapshotProvenance(f.manifestPath,f.dumpPath)).rejects.toThrow(/size differs|checksum differs/);});
  it('rejects provenance that cannot prove production and tunnel absence',async()=>{const f=await fixture({source:{...(await fixture()).manifest.source,productionContainersAbsent:false}});await expect(verifySnapshotProvenance(f.manifestPath,f.dumpPath)).rejects.toThrow(/development-only source isolation/);});
  it('rejects a mismatched source identity rather than trusting a filename',async()=>{const f=await fixture({source:{...(await fixture()).manifest.source,containerName:'production-postgres'}});await expect(verifySnapshotProvenance(f.manifestPath,f.dumpPath)).rejects.toThrow();});
});
