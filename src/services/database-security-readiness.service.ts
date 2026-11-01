// Read-only database security preflight (Phase 4A.2C3B.1).
//
// It reads only the PostgreSQL catalogs (pg_proc, pg_trigger, pg_roles, pg_auth_members, pg_class, ...).
// It never reads "_prisma_migrations", never grants, alters or creates anything, and cannot activate
// execution. Every query is a SELECT, so it also runs as the least-privilege runtime role it assesses.
//
// Two reporting levels share one set of findings:
//   DEVELOPMENT_OBSERVATION  reports outstanding hardening; `ready` stays informative and the process may start.
//   BROKER_ENABLED           fails closed: any finding, or any failure to evaluate, means not ready.

export type SecurityReadinessMode = 'DEVELOPMENT_OBSERVATION' | 'BROKER_ENABLED';
export type SqlRows = <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>;
export type SecurityFinding = { code: string; message: string; detail?: unknown };
export type SecurityReadinessReport = {
  mode: SecurityReadinessMode;
  schema: string;
  runtimeRole: string | null;
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
  ['ExternalSignalBrokerDispatchActivation', 'ExternalSignalBrokerDispatchActivation_apply', 'external_signal_broker_dispatch_activation_apply'],
  ['ExternalSignalBrokerDispatchActivation', 'ExternalSignalBrokerDispatchActivation_guard', 'external_signal_broker_dispatch_activation_guard'],
  ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_guard', 'external_signal_broker_consumption_guard'],
  ['ExternalSignalBrokerDispatchConsumption', 'ExternalSignalBrokerDispatchConsumption_pair_check', 'external_signal_dispatch_pair_check'],
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

export async function assessDatabaseSecurity(query: SqlRows, options: { mode: SecurityReadinessMode; runtimeRole?: string; now?: Date }): Promise<SecurityReadinessReport> {
  const findings: SecurityFinding[] = [];
  const identity = await gather('Database identity', async () => (await query<{ schema: string; current_role_name: string }>(`SELECT current_schema() AS schema, current_user::text AS current_role_name`))[0]!, findings);
  const schema = 'value' in identity ? identity.value.schema : 'public';
  const roleName = options.runtimeRole ?? ('value' in identity ? identity.value.current_role_name : null);

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

  // 3. The runtime role.
  if (roleName === null) return finish(options, schema, null, findings);
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
  return finish(options, schema, roleName, findings);
}

function finish(options: { mode: SecurityReadinessMode; now?: Date }, schema: string, runtimeRole: string | null, findings: SecurityFinding[]): SecurityReadinessReport {
  const ready = findings.length === 0;
  return {
    mode: options.mode, schema, runtimeRole, ready,
    // Development observation never blocks startup; broker-enabled readiness fails closed on any finding.
    startupAllowed: options.mode === 'DEVELOPMENT_OBSERVATION' || ready,
    findings, checkedAt: (options.now ?? new Date()).toISOString(),
  };
}
