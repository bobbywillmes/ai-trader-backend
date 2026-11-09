import type { DispatchStatus, EntryExecutionAuthorization, ExecutionRolloutStatus } from './types';

type RecordValue = Record<string, unknown>;
export type AuthorityParse<T> = { status: 'ok'; value: T } | { status: 'invalid'; reason: string };
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const string = (value: unknown): value is string => typeof value === 'string';
const boolean = (value: unknown): value is boolean => typeof value === 'boolean';
const nullableNumber = (value: unknown) => value === null || number(value);
const nullableString = (value: unknown) => value === null || string(value);
const timestamp = (value: unknown) => string(value) && !Number.isNaN(Date.parse(value));
const nullableTimestamp = (value: unknown) => value === null || timestamp(value);
const array = (value: unknown, item: (value: unknown) => boolean) => Array.isArray(value) && value.every(item);
const executionGeneration = (value: unknown) => record(value) && number(value.id) && number(value.generation) && string(value.direction) && boolean(value.enabled) && string(value.authorityMode) && timestamp(value.effectiveAt);
const executionEvent = (value: unknown) => record(value) && number(value.id) && number(value.rolloutGenerationId) && string(value.action) && string(value.reason) && timestamp(value.createdAt);

export function parseExecutionRolloutStatus(value: unknown): AuthorityParse<ExecutionRolloutStatus> {
  if (!record(value) || !nullableNumber(value.activeExecutionGenerationId) || !number(value.rolloutStateVersion) || !nullableTimestamp(value.executionEpochAt) || !array(value.generations, executionGeneration) || !array(value.activationEvents, executionEvent)) return { status: 'invalid', reason: 'Execution rollout response is malformed.' };
  return { status: 'ok', value: value as unknown as ExecutionRolloutStatus };
}

const dispatchEvent = (value: unknown) => record(value) && number(value.id) && number(value.rolloutGenerationId) && string(value.action) && number(value.stateVersion) && string(value.reason) && timestamp(value.createdAt);
export function parseDispatchStatus(value: unknown): AuthorityParse<DispatchStatus> {
  if (!record(value) || !record(value.state) || !number(value.state.version) || !nullableNumber(value.state.activeRolloutGenerationId) || !nullableTimestamp(value.state.activatedAt) || !array(value.activationEvents, dispatchEvent)) return { status: 'invalid', reason: 'Broker dispatch response is malformed.' };
  return { status: 'ok', value: value as unknown as DispatchStatus };
}

const authorization = (value: unknown) => record(value) && number(value.id) && number(value.rolloutGenerationId) && number(value.authorizationSequence) && string(value.status) && number(value.tradingAccountId) && number(value.tradingAccountSubscriptionId) && number(value.subscriptionId) && number(value.securityId) && number(value.signalSourceId) && number(value.strategySignalBindingId) && number(value.strategySignalRevisionId) && number(value.strategyRevision) && timestamp(value.authorizedAt) && nullableTimestamp(value.revokedAt) && nullableTimestamp(value.invalidatedAt) && nullableString(value.invalidationReasonCode);
export function parseEntryExecutionAuthorizations(value: unknown, accountId: number, assignmentId: number): AuthorityParse<{ authorizations: EntryExecutionAuthorization[] }> {
  if (!record(value) || !array(value.authorizations, authorization)) return { status: 'invalid', reason: 'Assignment authorization history response is malformed.' };
  const authorizations = value.authorizations as unknown[];
  if (authorizations.some(item => (item as RecordValue).tradingAccountId !== accountId || (item as RecordValue).tradingAccountSubscriptionId !== assignmentId)) return { status: 'invalid', reason: 'Assignment authorization history does not match the requested account scope.' };
  return { status: 'ok', value: value as unknown as { authorizations: EntryExecutionAuthorization[] } };
}
