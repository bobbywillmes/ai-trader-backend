// Read-only database security preflight (Phase 4A.2C3B.1).
//
// It reads only the PostgreSQL catalogs (pg_proc, pg_trigger, pg_roles, pg_auth_members, pg_class, ...).
// It never reads "_prisma_migrations", never grants, alters or creates anything, and cannot activate
// execution. Every query is a SELECT, so it also runs as the least-privilege runtime role it assesses.
//
// Three modes share one set of findings:
//   DEVELOPMENT_OBSERVATION  reports outstanding hardening; `ready` stays informative and the process may start.
//   BROKER_ENABLED           fails closed: any finding, or any failure to evaluate, means not ready. It assesses the
//                            connection it runs over, so that connection must BE the configured restricted runtime
//                            identity (session_user = current_user = expected role, expected database and schema).
//   ADMIN_DIAGNOSTIC         an administrator inspects a named role. Diagnostic only: it can never authorize broker
//                            readiness, because the connection is not the runtime identity.
//
// Execution-critical definitions (trigger semantics, function bodies) are compared with a code-controlled,
// reviewed manifest (database-security-manifest.ts), never with a baseline read from the database being assessed.

import { SECURITY_MANIFEST, type ManifestFunction, type ManifestTrigger } from './database-security-manifest.js';

export type SecurityReadinessMode = 'DEVELOPMENT_OBSERVATION' | 'BROKER_ENABLED' | 'ADMIN_DIAGNOSTIC';
export type SqlRows = <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>;
export type SecurityFinding = { code: string; message: string; detail?: unknown };
export type SecurityReadinessReport = {
  mode: SecurityReadinessMode;
  schema: string;
  runtimeRole: string | null;
  /** Non-secret identity evidence for the connection that was assessed; null when it could not be read. */
  identity: { sessionUser: string; currentUser: string; database: string; schema: string } | null;
  manifestVersion: string;
  /** True only for a clean BROKER_ENABLED assessment over the actual runtime identity. */
  brokerReadinessAuthorized: boolean;
  /** True when no finding exists. In DEVELOPMENT_OBSERVATION this is informational only. */
  ready: boolean;
  /** Whether this mode permits the process to continue; BROKER_ENABLED requires `ready`. */
  startupAllowed: boolean;
  findings: SecurityFinding[];
  checkedAt: string;
};

/** Triggers whose continued, enabled presence the quarantine and exposure guarantees depend on. */
export const CRITICAL_TRIGGERS: ReadonlyArray<readonly [table: string, trigger: string, fn: string]> = [
  ['BrokerActivity', 'BrokerActivity_external_signal_quarantine', 'external_signal_broker_evidence_quarantine'],
  ['BrokerOrder', 'BrokerOrder_external_signal_quarantine', 'external_signal_broker_evidence_quarantine'],
  ['EntryExposureClaim', 'EntryExposureClaim_external_signal_acquired_at_stamp', 'external_signal_exposure_claim_acquired_at_stamp'],
  ['EntryExposureClaim', 'EntryExposureClaim_external_signal_c2_guard', 'external_signal_exposure_claim_c2_guard'],
  ['EntryExposureClaim', 'EntryExposureClaim_external_signal_delete_guard', 'external_signal_exposure_claim_delete_guard'],
  ['EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_delivery_fence', 'external_signal_c2_delivery_event_fence'],
  ['EntryExposureClaimEvent', 'EntryExposureClaimEvent_external_signal_c2_not_sent_guard', 'external_signal_c2_not_sent_evidence_guard'],
  ['EntryExposureClaimEvent', 'EntryExposureClaimEvent_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_claim_event'],
  ['EntryExposureClaim', 'EntryExposureClaim_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_exposure_claim'],
  ['BrokerActivity', 'BrokerActivity_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_broker_activity'],
  ['BrokerOrder', 'BrokerOrder_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_broker_order'],
  ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump', 'external_signal_dispatch_fence_bump_order_ref'],
  ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify', 'external_signal_dispatch_fence_consumption_verify'],
  ['ExternalSignalBrokerWorkerClaim', 'ExternalSignalBrokerWorkerClaim_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_order_ref'],
  ['ExternalSignalDispatchFence', 'ExternalSignalDispatchFence_guard', 'external_signal_dispatch_fence_guard'],
  ['ExternalSignalDispatchFence', 'ExternalSignalDispatchFence_truncate_guard', 'external_signal_dispatch_fence_guard'],
  ['ExternalSignalTradeCycleAccount', 'ExternalSignalTradeCycleAccount_a_epoch_stamp', 'external_signal_epoch_created_at_stamp'],
  ['MarketPolicyBrokerDispatchConsumption', 'BrokerDispatchConsumption_a_lock_prelude', 'external_signal_mi_consumption_lock_prelude'],
  ['MarketPolicyBrokerDispatchDecision', 'MarketPolicyBrokerDispatchDecision_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_order_ref'],
  ['MarketPolicyBrokerUnenforcedDispatch', 'MarketPolicyBrokerUnenforcedDispatch_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_order_ref'],
  ['OrderIntent', 'OrderIntent_a_epoch_stamp', 'external_signal_epoch_marked_intent_created_at_stamp'],
  ['OrderIntent', 'OrderIntent_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_intent'],
  ['OrderIntent', 'OrderIntent_dispatch_fence_create', 'external_signal_dispatch_fence_create'],
  ['OrderIntentBrokerOpportunityEvent', 'OrderIntentBrokerOpportunityEvent_dispatch_fence_bump', 'external_signal_dispatch_fence_bump_order_ref'],
  ['Signal', 'Signal_received_at_guard', 'external_signal_signal_received_at_guard'],
  ['ExternalSignalBrokerDispatchActivation', 'ExternalSignalBrokerDispatchActivation_apply', 'external_signal_broker_dispatch_activation_apply'],
  ['ExternalSignalBrokerDispatchActivation', 'ExternalSignalBrokerDispatchActivation_guard', 'external_signal_broker_dispatch_activation_guard'],
  ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_guard', 'external_signal_broker_consumption_guard'],
  ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_pair_check', 'external_signal_dispatch_pair_check'],
  ['ExternalSignalBrokerSendPermission', 'ExternalSignalBrokerSendPermission_a_guard', 'external_signal_broker_send_permission_guard'],
  ['ExternalSignalBrokerSendPermission', 'ExternalSignalBrokerSendPermission_immutable', 'external_signal_broker_send_evidence_immutable'],
  ['ExternalSignalBrokerSendPermission', 'ExternalSignalBrokerSendPermission_truncate_guard', 'external_signal_broker_send_evidence_immutable'],
  ['ExternalSignalBrokerSendPermission', 'ExternalSignalBrokerSendPermission_zz_a_fence_bump', 'external_signal_dispatch_fence_bump_order_ref'],
  ['ExternalSignalBrokerSendPermission', 'ExternalSignalBrokerSendPermission_zz_b_fence_verify', 'external_signal_broker_send_permission_fence_verify'],
  ['ExternalSignalBrokerSendResolution', 'ExternalSignalBrokerSendResolution_a_guard', 'external_signal_broker_send_resolution_guard'],
  ['ExternalSignalBrokerSendResolution', 'ExternalSignalBrokerSendResolution_immutable', 'external_signal_broker_send_evidence_immutable'],
  ['ExternalSignalBrokerSendResolution', 'ExternalSignalBrokerSendResolution_truncate_guard', 'external_signal_broker_send_evidence_immutable'],
  ['ExternalSignalBrokerDispatchState', 'ExternalSignalBrokerDispatchState_guard', 'external_signal_broker_dispatch_state_guard'],
  ['ExternalSignalBrokerWorkerClaim', 'ExternalSignalBrokerWorkerClaim_guard', 'external_signal_broker_worker_claim_guard'],
  ['ExternalSignalEntryExecutionAuthorization', 'ExternalSignalEntryExecutionAuthorization_guard', 'external_signal_entry_authorization_guard'],
  ['ExternalSignalEntryExecutionObligation', 'ExternalSignalEntryExecutionObligation_generation_check', 'external_signal_frozen_generation_check'],
  ['ExternalSignalEntryExecutionObligation', 'ExternalSignalEntryExecutionObligation_guard', 'external_signal_entry_obligation_guard'],
  ['ExternalSignalExecutionRolloutActivation', 'ExternalSignalExecutionRolloutActivation_apply', 'external_signal_execution_rollout_activation_apply'],
  ['ExternalSignalExecutionRolloutActivation', 'ExternalSignalExecutionRolloutActivation_guard', 'external_signal_execution_rollout_activation_guard'],
  ['ExternalSignalExecutionRolloutActivation', 'ExternalSignalExecutionRolloutActivation_invalidate', 'external_signal_execution_activation_invalidate'],
  ['ExternalSignalExecutionRolloutState', 'ExternalSignalExecutionRolloutState_guard', 'external_signal_execution_rollout_state_guard'],
  ['MarketPolicyBrokerDispatchConsumption', 'MarketPolicyBrokerDispatchConsumption_external_pair_check', 'external_signal_dispatch_pair_check'],
  ['MarketPolicyBrokerUnenforcedDispatch', 'MarketPolicyBrokerUnenforcedDispatch_external_guard', 'external_signal_unenforced_dispatch_guard'],
  ['OrderIntent', 'OrderIntent_external_signal_dispatch_quarantine', 'external_signal_order_intent_dispatch_quarantine'],
  ['OrderIntent', 'OrderIntent_external_signal_obligation_required', 'external_signal_order_intent_obligation_required'],
  ['OrderIntent', 'OrderIntent_external_signal_origin_immutable', 'external_signal_order_intent_origin_immutable'],
  ['Signal', 'Signal_external_exit_touch_source_cycle', 'external_signal_exit_touch_source_cycle'],
  ['Signal', 'Signal_v2_immutability_guard', 'external_signal_signal_v2_immutability_guard'],
];

/**
 * PostgreSQL fires triggers of the same table, timing and event in trigger-NAME order (byte order), so several guarantees rest on names:
 * the claim-row lock of the C2 delivery fence must run before the not-sent guard reads, the Market Intelligence lock prelude before its
 * validation, the receipt/epoch stamps before every other BEFORE INSERT guard, and the dispatch-fence bump before its verification. The
 * manifest implies the order only through names, so a NEW trigger whose name sorts in between would silently change it. `contiguous`
 * additionally forbids any other trigger of that table, timing and event between the listed ones; `first` requires the first listed
 * trigger to fire before every other trigger of that table, timing and event.
 */
export type TriggerOrderRule = { table: string; timing: 'BEFORE' | 'AFTER'; event: 'INSERT' | 'UPDATE' | 'DELETE'; sequence: readonly string[]; contiguous: boolean; first?: boolean; reason: string };
export const TRIGGER_ORDER_INVARIANTS: readonly TriggerOrderRule[] = [
  { table: 'EntryExposureClaimEvent', timing: 'BEFORE', event: 'INSERT', contiguous: true, first: true, reason: 'the claim-row lock must precede the not-sent contradiction read',
    sequence: ['EntryExposureClaimEvent_external_signal_c2_delivery_fence', 'EntryExposureClaimEvent_external_signal_c2_not_sent_guard'] },
  { table: 'MarketPolicyBrokerDispatchConsumption', timing: 'BEFORE', event: 'INSERT', contiguous: true, first: true, reason: 'the canonical lock prelude must precede the Market Intelligence consumption validation',
    sequence: ['BrokerDispatchConsumption_a_lock_prelude', 'BrokerDispatchConsumption_validate'] },
  { table: 'OrderIntent', timing: 'BEFORE', event: 'INSERT', contiguous: false, first: true, reason: 'the candidate timestamp stamp must precede every other BEFORE INSERT guard',
    sequence: ['OrderIntent_a_epoch_stamp', 'OrderIntent_external_signal_dispatch_quarantine'] },
  { table: 'ExternalSignalTradeCycleAccount', timing: 'BEFORE', event: 'INSERT', contiguous: false, first: true, reason: 'the candidate timestamp stamp must precede every other BEFORE INSERT guard',
    sequence: ['ExternalSignalTradeCycleAccount_a_epoch_stamp'] },
  { table: 'ExternalSignalBrokerDispatchConsumption', timing: 'AFTER', event: 'INSERT', contiguous: false, reason: 'the single post-pair bump must precede its verification',
    sequence: ['ExternalSignalBrokerDispatchConsumption_zz_a_fence_bump', 'ExternalSignalBrokerDispatchConsumption_zz_b_fence_verify'] },
  { table: 'ExternalSignalBrokerSendPermission', timing: 'AFTER', event: 'INSERT', contiguous: true, reason: 'the single permission bump must precede its exact-delta verification',
    sequence: ['ExternalSignalBrokerSendPermission_zz_a_fence_bump', 'ExternalSignalBrokerSendPermission_zz_b_fence_verify'] },
];

export type TriggerCatalogRow = { table_name: string; trigger_name: string; tgtype: number; enabled: string };
/** Pure evaluation of TRIGGER_ORDER_INVARIANTS against catalog rows (ROW triggers only). */
export function evaluateTriggerOrder(rows: readonly TriggerCatalogRow[], rules: readonly TriggerOrderRule[] = TRIGGER_ORDER_INVARIANTS) {
  const eventBit = { INSERT: 4, DELETE: 8, UPDATE: 16 } as const;
  return rules.flatMap(rule => {
    const fired = rows
      .filter(row => row.table_name === rule.table && (row.tgtype & 1) === 1 && ((row.tgtype & 2) === 2) === (rule.timing === 'BEFORE') && (row.tgtype & eventBit[rule.event]) !== 0)
      .map(row => row.trigger_name)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const positions = rule.sequence.map(name => fired.indexOf(name));
    const problems: string[] = [];
    if (positions.some(position => position < 0)) problems.push(`missing (or not enabled) among the ${rule.timing} ${rule.event} row triggers: ${rule.sequence.filter((_, i) => positions[i]! < 0).join(', ')}`);
    else {
      if (positions.some((position, i) => i > 0 && position <= positions[i - 1]!)) problems.push(`firing order is ${positions.map((p, i) => `${rule.sequence[i]}@${p}`).join(' ')}`);
      if (rule.contiguous && positions.some((position, i) => i > 0 && position !== positions[i - 1]! + 1)) problems.push(`another trigger fires between them: ${fired.join(' > ')}`);
      if (rule.first && positions[0] !== 0) problems.push(`${rule.sequence[0]} is not the first ${rule.timing} ${rule.event} trigger: ${fired.join(' > ')}`);
    }
    return problems.length ? [{ table: rule.table, timing: rule.timing, event: rule.event, reason: rule.reason, problems }] : [];
  });
}

/** The migrated schema's function-level path; migrations pin exactly this on every application function. */
export const trustedSearchPath = (schema: string) => `search_path=pg_catalog, ${/^[a-z_][a-z0-9_]*$/.test(schema) ? schema : `"${schema.replaceAll('"', '""')}"`}, pg_temp`;

type Gather<T> = { value: T } | { error: string };
async function gather<T>(label: string, run: () => Promise<T>, findings: SecurityFinding[]): Promise<Gather<T>> {
  try { return { value: await run() }; }
  catch (error) {
    // A check that cannot run proves nothing, so it is itself a finding rather than a pass.
    const message = error instanceof Error ? error.message : String(error);
    findings.push({ code: 'CHECK_UNAVAILABLE', message: `${label} could not be evaluated: ${message}` });
    return { error: message };
  }
}

export type AssessmentOptions = {
  mode: SecurityReadinessMode;
  /** BROKER_ENABLED: the role, database and schema the backend is configured to use; the connection must match all three. */
  expected?: { role: string; database: string | null; schema: string };
  /** ADMIN_DIAGNOSTIC only: the role an administrator inspects. */
  inspectRole?: string;
  now?: Date;
};

export async function assessDatabaseSecurity(query: SqlRows, options: AssessmentOptions): Promise<SecurityReadinessReport> {
  const findings: SecurityFinding[] = [];
  const identityResult = await gather('Database identity', async () => (await query<{ schema: string; session_user_name: string; current_role_name: string; database: string }>(
    `SELECT current_schema() AS schema, session_user::text AS session_user_name, current_user::text AS current_role_name, current_database()::text AS database`))[0]!, findings);
  const schema = 'value' in identityResult ? identityResult.value.schema : 'public';
  const identity = 'value' in identityResult ? { sessionUser: identityResult.value.session_user_name, currentUser: identityResult.value.current_role_name, database: identityResult.value.database, schema } : null;

  if (options.mode === 'BROKER_ENABLED') {
    // The assessment is only meaningful for the connection that will run broker-capable operations, so the
    // connection itself must prove it is the configured restricted identity. Any gap fails closed.
    const expected = options.expected;
    if (!expected?.role) findings.push({ code: 'RUNTIME_IDENTITY_UNCONFIGURED', message: 'No expected runtime role was supplied, so the connection identity cannot be verified.' });
    if (identity && expected?.role) {
      const mismatches: string[] = [];
      if (identity.sessionUser !== expected.role) mismatches.push(`session_user is ${identity.sessionUser}, expected ${expected.role}`);
      if (identity.currentUser !== expected.role) mismatches.push(`current_user is ${identity.currentUser}, expected ${expected.role}`);
      if (identity.sessionUser !== identity.currentUser) mismatches.push('session_user and current_user differ (SET ROLE or SET SESSION AUTHORIZATION is in effect)');
      if (expected.database === null) mismatches.push('the configured database name is unavailable');
      else if (identity.database !== expected.database) mismatches.push(`connected database is ${identity.database}, configured ${expected.database}`);
      if (identity.schema !== expected.schema) mismatches.push(`active schema is ${identity.schema}, configured ${expected.schema}`);
      if (mismatches.length) findings.push({ code: 'RUNTIME_IDENTITY_MISMATCH', message: `The assessed connection is not the configured runtime identity: ${mismatches.join('; ')}.`, detail: { sessionUser: identity.sessionUser, currentUser: identity.currentUser, database: identity.database, schema: identity.schema } });
    }
  }
  // BROKER_ENABLED and DEVELOPMENT_OBSERVATION assess the connection's own identity. Only the administrator
  // diagnostic inspects another role, and its report never authorizes broker readiness.
  const roleName = options.mode === 'ADMIN_DIAGNOSTIC' ? (options.inspectRole ?? null) : (identity?.currentUser ?? null);

  // 1. Every application function pins the trusted path; none is SECURITY DEFINER; none has a foreign owner setting drift.
  const functions = await gather('Function audit', () => query<{ fn: string; prosecdef: boolean; pinned: boolean; paths: string[] }>(
    `SELECT p.oid::regprocedure::text AS fn, p.prosecdef,
            ($1::text = ANY (coalesce(p.proconfig, ARRAY[]::text[]))) AS pinned,
            ARRAY(SELECT c FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%') AS paths
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname=current_schema() AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
     ORDER BY 1`, [trustedSearchPath(schema)]), findings);
  if ('value' in functions) {
    const unpinned = functions.value.filter(row => !row.pinned);
    if (unpinned.length) findings.push({ code: 'FUNCTION_SEARCH_PATH_UNPINNED', message: `${unpinned.length} application function(s) lack the trusted search_path; a CREATE OR REPLACE discards it.`, detail: unpinned.map(row => ({ fn: row.fn, paths: row.paths })) });
    const definers = functions.value.filter(row => row.prosecdef);
    if (definers.length) findings.push({ code: 'FUNCTION_SECURITY_DEFINER', message: `${definers.length} application function(s) are SECURITY DEFINER; the guards must run with the caller's privileges.`, detail: definers.map(row => row.fn) });
    if (functions.value.length === 0) findings.push({ code: 'NO_APPLICATION_FUNCTIONS', message: 'No application functions were found; the schema is not migrated.' });
  }

  // 2. Critical triggers exist, bind the expected function and fire for ordinary sessions.
  const triggers = await gather('Trigger audit', () => query<{ table_name: string; trigger_name: string; fn: string; enabled: string }>(
    `SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name, p.proname::text AS fn, t.tgenabled::text AS enabled
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
     WHERE NOT t.tgisinternal AND n.nspname=current_schema()`), findings);
  if ('value' in triggers) {
    const byKey = new Map(triggers.value.map(row => [`${row.table_name}\u0000${row.trigger_name}`, row]));
    const problems = CRITICAL_TRIGGERS.flatMap(([table, trigger, fn]) => {
      const found = byKey.get(`${table}\u0000${trigger}`);
      if (!found) return [{ table, trigger, problem: 'missing' }];
      if (found.fn !== fn) return [{ table, trigger, problem: `bound to ${found.fn}` }];
      // 'O' fires in origin and local modes, 'A' always. 'D' is disabled and 'R' fires only under replica mode.
      if (found.enabled !== 'O' && found.enabled !== 'A') return [{ table, trigger, problem: `state ${found.enabled}` }];
      return [];
    });
    if (problems.length) findings.push({ code: 'CRITICAL_TRIGGER_UNSAFE', message: `${problems.length} critical trigger(s) are missing, rebound or not firing for ordinary sessions.`, detail: problems });
  }

  // 2b. Trigger execution ORDER. PostgreSQL fires same-timing, same-event triggers in name order; several guarantees depend on it.
  const order = await gather('Trigger order audit', () => query<TriggerCatalogRow>(
    `SELECT c.relname::text AS table_name, t.tgname::text AS trigger_name, t.tgtype::int AS tgtype, t.tgenabled::text AS enabled
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE NOT t.tgisinternal AND n.nspname=current_schema() AND t.tgenabled IN ('O','A') AND c.relname = ANY ($1::text[])`,
    [[...new Set(TRIGGER_ORDER_INVARIANTS.map(rule => rule.table))]]), findings);
  if ('value' in order) {
    const violations = evaluateTriggerOrder(order.value);
    if (violations.length) findings.push({ code: 'CRITICAL_TRIGGER_ORDER_UNSAFE', message: `${violations.length} trigger firing-order invariant(s) are violated; guarantees that depend on trigger-name order no longer hold.`, detail: violations });
  }

  // 3. Execution-critical definitions match the reviewed manifest: trigger timing/events/scope/WHEN/columns/arguments
  // and the bound function's identity, and every application function's body, language, volatility and result.
  const catalog = await gather('Security manifest comparison', () => readSecurityCatalog(query), findings);
  if ('value' in catalog) {
    const drift = compareWithManifest(catalog.value);
    if (drift.functionsChanged.length) findings.push({ code: 'PROTECTED_FUNCTION_CHANGED', message: `${drift.functionsChanged.length} application function(s) differ from the reviewed security manifest ${SECURITY_MANIFEST.version}.`, detail: drift.functionsChanged });
    if (drift.functionsMissing.length) findings.push({ code: 'PROTECTED_FUNCTION_MISSING', message: `${drift.functionsMissing.length} reviewed function(s) are missing from the schema.`, detail: drift.functionsMissing });
    if (drift.functionsUnreviewed.length) findings.push({ code: 'FUNCTION_NOT_IN_MANIFEST', message: `${drift.functionsUnreviewed.length} application function(s) are not in the reviewed security manifest; review and add them with their migration.`, detail: drift.functionsUnreviewed });
    if (drift.triggersChanged.length) findings.push({ code: 'TRIGGER_DEFINITION_CHANGED', message: `${drift.triggersChanged.length} trigger(s) differ from the reviewed definition (timing, events, scope, WHEN, columns, arguments or bound function).`, detail: drift.triggersChanged });
    // The 27 critical triggers above remain an additional, narrower check; this covers every reviewed trigger.
    if (drift.triggersMissing.length) findings.push({ code: 'PROTECTED_TRIGGER_MISSING', message: `${drift.triggersMissing.length} reviewed trigger(s) are missing from the schema.`, detail: drift.triggersMissing });
    if (drift.triggersUnreviewed.length) findings.push({ code: 'TRIGGER_NOT_IN_MANIFEST', message: `${drift.triggersUnreviewed.length} trigger(s) are not in the reviewed security manifest.`, detail: drift.triggersUnreviewed });
  }

  // 4. The runtime role.
  if (roleName === null) return finish(options, schema, null, identity, findings);
  const role = await gather('Runtime role audit', async () => (await query<{
    exists: boolean; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean;
    temporary: boolean; memberships: unknown[]; owned_relations: string[]; owned_functions: string[]; owns_schema: boolean; owns_database: boolean;
    can_set_replication_role: boolean; migrations_owner: boolean; migrations_access: boolean;
  }>(
    `WITH r AS (SELECT * FROM pg_roles WHERE rolname=$1)
     SELECT EXISTS (SELECT 1 FROM r) AS exists,
       coalesce((SELECT rolsuper FROM r),false) AS rolsuper, coalesce((SELECT rolcreaterole FROM r),false) AS rolcreaterole,
       coalesce((SELECT rolcreatedb FROM r),false) AS rolcreatedb, coalesce((SELECT rolreplication FROM r),false) AS rolreplication,
       coalesce((SELECT rolbypassrls FROM r),false) AS rolbypassrls,
       coalesce(has_database_privilege($1, current_database(), 'TEMPORARY'),false) AS temporary,
       -- Every row, whatever its options: INHERIT FALSE with SET TRUE still permits SET ROLE.
       ARRAY(SELECT to_jsonb(am) - 'oid' - 'member' - 'grantor' || jsonb_build_object('role', pg_get_userbyid(am.roleid)) FROM pg_auth_members am WHERE am.member=(SELECT oid FROM r)) AS memberships,
       ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relowner=(SELECT oid FROM r) AND c.relkind IN ('r','p','v','m','S','f')) AS owned_relations,
       ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proowner=(SELECT oid FROM r)) AS owned_functions,
       EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname=current_schema() AND n.nspowner=(SELECT oid FROM r)) AS owns_schema,
       EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.datdba=(SELECT oid FROM r)) AS owns_database,
       -- session_replication_role skips ordinary triggers. SET on it is superuser-only unless explicitly granted (PostgreSQL 15+).
       coalesce((SELECT has_parameter_privilege($1, 'session_replication_role', 'SET')), false) AS can_set_replication_role,
       -- Catalog metadata only: this never reads the migration table's rows.
       coalesce((SELECT c.relowner=(SELECT oid FROM r) FROM pg_class c WHERE c.oid=to_regclass('"_prisma_migrations"')), false) AS migrations_owner,
       coalesce((SELECT has_table_privilege($1, c.oid, 'SELECT,INSERT,UPDATE,DELETE') FROM pg_class c WHERE c.oid=to_regclass('"_prisma_migrations"')), false) AS migrations_access`,
    [roleName]))[0]!, findings);
  // Effective privileges (inheritance and PUBLIC included) that bypass or undermine the guards.
  const privileges = 'value' in role && role.value.exists ? await gather('Dangerous privilege audit', async () => (await query<{ truncate_tables: string[]; trigger_tables: string[]; create_schemas: string[]; database_create: boolean }>(
    `SELECT ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','f') AND has_table_privilege($1, c.oid, 'TRUNCATE') ORDER BY 1) AS truncate_tables,
            ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                  WHERE n.nspname=current_schema() AND c.relkind IN ('r','p','f','v') AND has_table_privilege($1, c.oid, 'TRIGGER') ORDER BY 1) AS trigger_tables,
            ARRAY(SELECT n.nspname::text FROM pg_namespace n
                  WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND has_schema_privilege($1, n.oid, 'CREATE') ORDER BY 1) AS create_schemas,
            has_database_privilege($1, current_database(), 'CREATE') AS database_create`, [roleName]))[0]!, findings) : null;
  if (privileges && 'value' in privileges) {
    const p = privileges.value;
    if (p.truncate_tables.length) findings.push({ code: 'RUNTIME_ROLE_TRUNCATE_PRIVILEGE', message: `Runtime role ${roleName} may TRUNCATE ${p.truncate_tables.length} table(s); TRUNCATE bypasses row-level delete guards.`, detail: p.truncate_tables });
    if (p.trigger_tables.length) findings.push({ code: 'RUNTIME_ROLE_TRIGGER_PRIVILEGE', message: `Runtime role ${roleName} holds TRIGGER on ${p.trigger_tables.length} relation(s) and could create triggers on them.`, detail: p.trigger_tables });
    if (p.create_schemas.length) findings.push({ code: 'RUNTIME_ROLE_SCHEMA_CREATE_PRIVILEGE', message: `Runtime role ${roleName} may CREATE objects in schema(s): ${p.create_schemas.join(', ')}.`, detail: p.create_schemas });
    if (p.database_create) findings.push({ code: 'RUNTIME_ROLE_DATABASE_CREATE_PRIVILEGE', message: `Runtime role ${roleName} holds CREATE on the database and could create schemas.` });
  }
  if ('value' in role) {
    const r = role.value;
    if (!r.exists) findings.push({ code: 'RUNTIME_ROLE_MISSING', message: `Runtime role ${roleName} does not exist.` });
    else {
      const attributes = (['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls'] as const).filter(key => r[key]).map(key => key.replace(/^rol/, '').toUpperCase());
      if (r.rolsuper) findings.push({ code: 'RUNTIME_ROLE_SUPERUSER', message: `Runtime role ${roleName} is a superuser, which bypasses every grant and can disable trigger enforcement.` });
      const others = attributes.filter(name => name !== 'SUPER');
      if (others.length) findings.push({ code: 'RUNTIME_ROLE_PRIVILEGED_ATTRIBUTE', message: `Runtime role ${roleName} holds ${others.join(', ')}.`, detail: others });
      if (r.owned_relations.length || r.owned_functions.length || r.owns_schema || r.owns_database)
        findings.push({ code: 'RUNTIME_ROLE_OWNS_OBJECTS', message: `Runtime role ${roleName} owns schema objects, so it could ALTER or DROP guards and triggers.`, detail: { relations: r.owned_relations.length, functions: r.owned_functions.length, schema: r.owns_schema, database: r.owns_database, sample: [...r.owned_relations, ...r.owned_functions].slice(0, 5) } });
      if (r.can_set_replication_role && !r.rolsuper) findings.push({ code: 'RUNTIME_ROLE_CAN_BYPASS_TRIGGERS', message: `Runtime role ${roleName} may SET session_replication_role, which skips ordinary triggers.` });
      if (r.rolsuper) findings.push({ code: 'RUNTIME_ROLE_CAN_BYPASS_TRIGGERS', message: `Runtime role ${roleName} is a superuser and may SET session_replication_role to skip ordinary triggers.` });
      if (r.temporary) findings.push({ code: 'RUNTIME_ROLE_TEMPORARY_PRIVILEGE', message: `Runtime role ${roleName} may create temporary objects (TEMPORARY on the database); run docs/database/least-privilege-temporary-revocation.sql.` });
      if (r.memberships.length) findings.push({ code: 'RUNTIME_ROLE_MEMBERSHIP', message: `Runtime role ${roleName} holds ${r.memberships.length} role membership(s); non-inheriting SET-capable memberships still permit SET ROLE.`, detail: r.memberships });
      if (r.migrations_owner || r.migrations_access) findings.push({ code: 'RUNTIME_ROLE_MIGRATION_ADMINISTRATOR', message: `Runtime role ${roleName} owns or can access the migration history table.`, detail: { owner: r.migrations_owner, access: r.migrations_access } });
    }
  }
  return finish(options, schema, roleName, identity, findings);
}

function finish(options: { mode: SecurityReadinessMode; now?: Date }, schema: string, runtimeRole: string | null, identity: SecurityReadinessReport['identity'], findings: SecurityFinding[]): SecurityReadinessReport {
  const ready = findings.length === 0;
  return {
    mode: options.mode, schema, runtimeRole, identity, manifestVersion: SECURITY_MANIFEST.version, ready,
    // Development observation never blocks startup; broker-enabled readiness fails closed on any finding.
    // The administrator diagnostic never permits anything: it is not the runtime identity.
    startupAllowed: options.mode === 'DEVELOPMENT_OBSERVATION' || (options.mode === 'BROKER_ENABLED' && ready),
    brokerReadinessAuthorized: options.mode === 'BROKER_ENABLED' && ready,
    findings, checkedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** SQL expression for a function-body digest: CRLF becomes LF, a standalone CR is kept. */
export const bodyDigestSql = (body: string) => `encode(sha256(convert_to(replace(${body}, chr(13) || chr(10), chr(10)), 'UTF8')), 'hex')`;

export type SecurityCatalog = { functions: Record<string, ManifestFunction>; triggers: Record<string, ManifestTrigger> };

/**
 * Reads the definition facts the manifest pins. Bodies are hashed in the database after converting only CRLF
 * line endings to LF, so a checkout with CRLF line endings produces the same digest as one with LF. A standalone
 * carriage return is preserved: inside a string literal it is part of the function's semantics.
 */
export async function readSecurityCatalog(query: SqlRows): Promise<SecurityCatalog> {
  const functions = await query<{ signature: string } & ManifestFunction>(
    `SELECT p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS signature,
            l.lanname::text AS language, p.provolatile::text AS volatility, p.prokind::text AS kind, p.prosecdef AS "securityDefiner",
            p.proisstrict AS strict, pg_get_function_result(p.oid) AS result,
            ${bodyDigestSql("p.prosrc || coalesce(pg_get_function_sqlbody(p.oid), '')")} AS "bodySha256"
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname=current_schema() AND p.prokind IN ('f','p') AND l.lanname NOT IN ('c','internal')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
     ORDER BY 1`);
  const triggers = await query<{ key: string } & ManifestTrigger>(
    `SELECT c.relname::text || '/' || t.tgname::text AS key,
            CASE WHEN pn.nspname = current_schema() THEN '' ELSE pn.nspname::text || '.' END || p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS function,
            t.tgenabled::text AS enabled,
            CASE WHEN t.tgtype & 64 <> 0 THEN 'INSTEAD OF' WHEN t.tgtype & 2 <> 0 THEN 'BEFORE' ELSE 'AFTER' END AS timing,
            array_to_string(ARRAY[CASE WHEN t.tgtype & 4 <> 0 THEN 'INSERT' END, CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END,
                                  CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END, CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END], ',') AS events,
            CASE WHEN t.tgtype & 1 <> 0 THEN 'ROW' ELSE 'STATEMENT' END AS scope,
            CASE WHEN t.tgqual IS NULL THEN '' ELSE coalesce(substring(pg_get_triggerdef(t.oid) from ' WHEN (.*) EXECUTE (?:FUNCTION|PROCEDURE) '), '<unparsed>') END AS "when",
            array_to_string(ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::int2[]) k JOIN pg_attribute a ON a.attrelid=t.tgrelid AND a.attnum=k ORDER BY 1), ',') AS columns,
            encode(t.tgargs, 'hex') AS arguments,
            t.tgdeferrable AS deferrable, t.tginitdeferred AS "initiallyDeferred",
            coalesce(t.tgoldtable, '') || '/' || coalesce(t.tgnewtable, '') AS "transitionTables"
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
     WHERE NOT t.tgisinternal AND n.nspname=current_schema()
     ORDER BY 1`);
  return {
    functions: Object.fromEntries(functions.map(({ signature, ...rest }) => [signature, rest])),
    triggers: Object.fromEntries(triggers.map(({ key, ...rest }) => [key, rest])),
  };
}

const differing = (found: object, reviewed: object) => (Object.keys(reviewed) as Array<keyof typeof reviewed>).filter(key => (found as Record<string, unknown>)[key] !== (reviewed as Record<string, unknown>)[key]);

export function compareWithManifest(catalog: SecurityCatalog, manifest: { functions: Record<string, ManifestFunction>; triggers: Record<string, ManifestTrigger> } = SECURITY_MANIFEST) {
  const names = <T>(a: Record<string, T>, b: Record<string, T>) => Object.keys(a).filter(key => !(key in b)).sort();
  return {
    functionsChanged: Object.keys(manifest.functions).filter(key => key in catalog.functions).flatMap(key => {
      const fields = differing(catalog.functions[key]!, manifest.functions[key]!);
      return fields.length ? [{ function: key, fields }] : [];
    }),
    functionsMissing: names(manifest.functions, catalog.functions),
    functionsUnreviewed: names(catalog.functions, manifest.functions),
    triggersChanged: Object.keys(manifest.triggers).filter(key => key in catalog.triggers).flatMap(key => {
      const fields = differing(catalog.triggers[key]!, manifest.triggers[key]!);
      return fields.length ? [{ trigger: key, fields, found: catalog.triggers[key] }] : [];
    }),
    triggersMissing: names(manifest.triggers, catalog.triggers),
    triggersUnreviewed: names(catalog.triggers, manifest.triggers),
  };
}
