import type { ReadonlyInventoryDb } from './position-lifecycle-evidence-query.service.js';
import { loadPositionLifecycleEvidenceBatch } from './position-lifecycle-evidence-query.service.js';
import { classifyPositionLifecycleEvidence } from './position-lifecycle-evidence-classifier.js';
import { LIFECYCLE_EVIDENCE_CLASSIFIER_VERSION, LIFECYCLE_EVIDENCE_INVENTORY_SCHEMA_VERSION, type InventoryGroupSummary, type LifecycleInventoryReasonCode, type PositionLifecycleEvidenceInventoryReport, type PositionLifecycleEvidenceResult, type ShadowLifecycleClassification } from './position-lifecycle-evidence-inventory.types.js';

export type InventoryDatabaseIdentity = { database:string;host:string|null;port:number|null;user:string;transactionReadOnly:boolean;defaultTransactionReadOnly:boolean;superuser:boolean;hasProtectedWritePrivilege:boolean };
export type ApprovedInventoryDatabaseIdentity = Pick<InventoryDatabaseIdentity,'database'|'host'|'port'|'user'>;

const classifications: ShadowLifecycleClassification[] = ['COMPLETE_LOCAL_ORDER_CHAIN','POSITIVE_EXTERNAL_ORIGIN','UNKNOWN_INCOMPLETE_LINEAGE','CONTRADICTORY_EVIDENCE'];
const zeroClassifications=()=>Object.fromEntries(classifications.map((key)=>[key,0])) as Record<ShadowLifecycleClassification,number>;

export function assertApprovedInventoryDatabaseIdentity(identity: InventoryDatabaseIdentity, approved: ApprovedInventoryDatabaseIdentity[], options: { allowDisposablePrivilegedRole?: boolean } = {}) {
  const disposable=identity.database.startsWith('ai_trader_test_');
  if (!approved.some((item)=>item.database===identity.database&&item.host===identity.host&&item.port===identity.port&&item.user===identity.user)) throw new Error('Lifecycle inventory database identity is not explicitly approved.');
  if (!identity.transactionReadOnly) throw new Error('Lifecycle inventory transaction is not read-only.');
  if ((!disposable||!options.allowDisposablePrivilegedRole)&&(identity.superuser||identity.hasProtectedWritePrivilege||!identity.defaultTransactionReadOnly)) throw new Error('Persistent lifecycle inventory requires a non-superuser, SELECT-only role with default_transaction_read_only enabled.');
}

async function identity(db:ReadonlyInventoryDb):Promise<InventoryDatabaseIdentity>{
  const row=(await db.query<{database:string;host:string|null;port:number|null;user:string;transactionReadOnly:string;defaultTransactionReadOnly:string;superuser:boolean;hasProtectedWritePrivilege:boolean}>(`
    SELECT current_database() AS database, host(inet_server_addr()) AS host, inet_server_port() AS port, current_user AS "user",
      current_setting('transaction_read_only') AS "transactionReadOnly", current_setting('default_transaction_read_only') AS "defaultTransactionReadOnly",
      r.rolsuper AS superuser,
      (has_table_privilege(current_user,'"TrackedPosition"','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'"OrderIntent"','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'"EntryExposureClaim"','INSERT,UPDATE,DELETE') OR has_table_privilege(current_user,'"PositionLifecycleProvenanceDecision"','INSERT,UPDATE,DELETE')) AS "hasProtectedWritePrivilege"
    FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if(!row)throw new Error('Unable to verify lifecycle inventory database identity.');
  return {...row,transactionReadOnly:row.transactionReadOnly==='on',defaultTransactionReadOnly:row.defaultTransactionReadOnly==='on'};
}

function summarize(positions:PositionLifecycleEvidenceResult[]){
  const counts=zeroClassifications(); const reasonCodeCounts:Partial<Record<LifecycleInventoryReasonCode,number>>={}; const groups=new Map<string,InventoryGroupSummary>();
  const readiness={completeLocalOwnershipEvidence:0,incompleteLocalLineage:0,contradictoryEvidence:0,noAccountAttribution:0,openPositionsWithExitState:0,openPositionsRequiringLegacyExitContinuityReview:0,positionsWithUnresolvedClaimsOrRecovery:0};
  for(const position of positions){counts[position.shadowClassification]++;for(const reason of position.reasonCodes)reasonCodeCounts[reason]=(reasonCodeCounts[reason]??0)+1;
    const key=JSON.stringify([position.identity.environment,position.identity.positionBroker,position.currentState.status]);let group=groups.get(key);if(!group){group={databaseTier:'DEVELOPMENT',accountEnvironment:position.identity.environment,broker:position.identity.positionBroker,positionStatus:position.currentState.status,positions:0,classifications:zeroClassifications(),completeLocalOwnershipEvidence:0,incompleteLocalLineage:0,contradictoryEvidence:0,noAccountAttribution:0,openPositionsWithExitState:0,openPositionsRequiringLegacyExitContinuityReview:0,positionsWithUnresolvedClaimsOrRecovery:0};groups.set(key,group);}group.positions++;group.classifications[position.shadowClassification]++;const recovery=position.claim?.status==='UNRESOLVED'||position.operationalAttention.some((item)=>item.status!=='RESOLVED'&&(/RECOVERY|HISTORICAL_ENTRY_LIFECYCLE/.test(item.code)||item.source==='RECONCILIATION'));if(position.shadowClassification==='COMPLETE_LOCAL_ORDER_CHAIN'){group.completeLocalOwnershipEvidence++;readiness.completeLocalOwnershipEvidence++;}if(position.shadowClassification==='UNKNOWN_INCOMPLETE_LINEAGE'){group.incompleteLocalLineage++;readiness.incompleteLocalLineage++;}if(position.shadowClassification==='CONTRADICTORY_EVIDENCE'){group.contradictoryEvidence++;readiness.contradictoryEvidence++;}if(position.identity.tradingAccountId===null){group.noAccountAttribution++;readiness.noAccountAttribution++;}if(['open','closing'].includes(position.currentState.status)&&position.exitState){group.openPositionsWithExitState++;readiness.openPositionsWithExitState++;}if(position.readiness.legacyExitContinuityReviewRequired){group.openPositionsRequiringLegacyExitContinuityReview++;readiness.openPositionsRequiringLegacyExitContinuityReview++;}if(recovery){group.positionsWithUnresolvedClaimsOrRecovery++;readiness.positionsWithUnresolvedClaimsOrRecovery++;}}
  return {totalPositions:positions.length,classifications:counts,reasonCodeCounts,readiness,groups:[...groups.values()].sort((a,b)=>(a.accountEnvironment??'').localeCompare(b.accountEnvironment??'')||a.broker.localeCompare(b.broker)||a.positionStatus.localeCompare(b.positionStatus))};
}

export async function runPositionLifecycleEvidenceInventory(db:ReadonlyInventoryDb,args:{approvedIdentities:ApprovedInventoryDatabaseIdentity[];pageSize?:number;now?:Date;allowDisposablePrivilegedRole?:boolean}):Promise<PositionLifecycleEvidenceInventoryReport>{
  const pageSize=args.pageSize??250;if(!Number.isInteger(pageSize)||pageSize<1||pageSize>1000)throw new Error('Inventory page size must be an integer from 1 through 1000.');
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{const verified=await identity(db);assertApprovedInventoryDatabaseIdentity(verified,args.approvedIdentities,args.allowDisposablePrivilegedRole===undefined?{}:{allowDisposablePrivilegedRole:args.allowDisposablePrivilegedRole});const positions:PositionLifecycleEvidenceResult[]=[];let after=0;for(;;){const batch=await loadPositionLifecycleEvidenceBatch(db,{afterPositionId:after,limit:pageSize});if(!batch.length)break;positions.push(...batch.map(classifyPositionLifecycleEvidence));after=batch.at(-1)!.identity.trackedPositionId;}await db.query('ROLLBACK');return {schemaVersion:LIFECYCLE_EVIDENCE_INVENTORY_SCHEMA_VERSION,classifierVersion:LIFECYCLE_EVIDENCE_CLASSIFIER_VERSION,generatedAt:(args.now??new Date()).toISOString(),databaseIdentity:{database:verified.database,host:verified.host,port:verified.port,user:verified.user,transactionReadOnly:verified.transactionReadOnly,tier:'DEVELOPMENT'},filters:{afterPositionId:null,pageSize},summary:summarize(positions),positions};}catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}
}
