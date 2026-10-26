import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { loadApproval,loadCredential,loadRestoreReceipt,resolveOutput,runOfflineSnapshotInventory,verifySnapshotProvenance,type DockerEvidence } from '../src/services/position-lifecycle-offline-snapshot.service.js';

function arg(name:string){const prefix=`--${name}=`;const value=process.argv.slice(2).find(item=>item.startsWith(prefix))?.slice(prefix.length);if(!value)throw new Error(`Missing required ${prefix}<value>.`);return value;}
function integer(name:string,fallback:number){const raw=process.argv.slice(2).find(item=>item.startsWith(`--${name}=`))?.split('=')[1];const value=raw===undefined?fallback:Number(raw);if(!Number.isInteger(value))throw new Error(`--${name} must be an integer.`);return value;}
function command(file:string,args:string[]){const result=spawnSync(file,args,{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(`${file} verification failed: ${(result.stderr||result.stdout).trim()}`);return result.stdout.trim();}
function repositoryRoot(){return command('git',['rev-parse','--show-toplevel']);}
function dockerEvidence(containerId:string,volumeName:string):DockerEvidence{
  const container=JSON.parse(command('docker',['inspect',containerId]))[0] as {Id:string;Config:{Image:string;Labels:Record<string,string>};State:{Running:boolean};Mounts:Array<{Name?:string;Destination:string}>;NetworkSettings:{Ports:Record<string,Array<{HostIp:string;HostPort:string}>|null>}};
  const volume=JSON.parse(command('docker',['volume','inspect',volumeName]))[0] as {Name:string;Labels:Record<string,string>};const port=container.NetworkSettings.Ports['5432/tcp']?.[0];const mount=container.Mounts.find(item=>item.Destination==='/var/lib/postgresql/data');
  return{containerId:container.Id,image:container.Config.Image,running:container.State.Running,project:container.Config.Labels['com.docker.compose.project']??'',service:container.Config.Labels['com.docker.compose.service']??'',runLabel:container.Config.Labels['ai-trader-snapshot-run']??'',volumeName:mount?.Name??'',volumeRunLabel:volume.Labels['ai-trader-snapshot-run']??'',volumePurpose:volume.Labels['ai-trader-purpose']??'',hostIp:port?.HostIp??'',hostPort:Number(port?.HostPort),mountDestination:mount?.Destination??''};
}

async function main(){
  if(process.env.DATABASE_URL||process.env.NODE_ENV)throw new Error('Offline snapshot inventory refuses DATABASE_URL and NODE_ENV.');
  if(process.argv.some(value=>/postgres(?:ql)?:\/\//i.test(value)||/password=/i.test(value)))throw new Error('Database credentials are forbidden in process arguments.');
  const manifestPath=resolve(arg('manifest'));const dumpPath=resolve(arg('dump'));const approvalPath=resolve(arg('approval'));const approvalKeyPath=resolve(arg('approval-key'));const receiptPath=resolve(arg('restore-receipt'));const credentialPath=resolve(arg('credential-file'));
  const {manifest,manifestSha256}=await verifySnapshotProvenance(manifestPath,dumpPath);const {approval,key,approvalSha256}=await loadApproval(approvalPath,approvalKeyPath,manifestSha256,manifest);const receipt=await loadRestoreReceipt(receiptPath,key,approvalSha256,manifest.backup.sha256,approval.approvedAt);const credential=await loadCredential(credentialPath,receipt);
  const outputPath=await resolveOutput({outputRoot:resolve(arg('output-root')),outputName:arg('output-name'),repositoryRoot:repositoryRoot()});const evidence=dockerEvidence(receipt.container.id,receipt.volume.name);
  await runOfflineSnapshotInventory({credential,receipt,manifest,manifestSha256,approvalSha256,outputPath,dockerEvidence:evidence,pageSize:integer('page-size',250),maxPositions:integer('max-positions',10_000),statementTimeoutMs:integer('timeout-ms',30_000),maxOutputBytes:integer('max-output-bytes',50*1024*1024)});
  process.stdout.write(`Offline inventory completed for approved run ${receipt.runId}.\n`);
}
main().catch(error=>{process.stderr.write(`${error instanceof Error?error.message:'Offline inventory failed.'}\n`);process.exitCode=1;});
