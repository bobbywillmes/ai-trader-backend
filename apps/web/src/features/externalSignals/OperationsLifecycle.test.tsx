// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountCycleLifecycle, ExecutionLifecycle, OperationsCycle } from './types';
import { absence, matchLifecycles, parseExecutionLifecycle, truncationNotice } from './lifecycle';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiRequest: mocks.request }));
import { OperationsTab } from './OperationsTab';

const meta = (total = 0, returned = Math.min(total, 100)) => ({ returned, total, truncated: returned < total });
type Overrides = { lifecycle?: Partial<AccountCycleLifecycle['lifecycle']>; readiness?: Partial<AccountCycleLifecycle['readiness']>; evidence?: Partial<AccountCycleLifecycle['evidence']>; recovery?: Partial<AccountCycleLifecycle['recovery']> };
function lifecycleFor(accountCycleId: number, o: Overrides = {}): AccountCycleLifecycle {
  return {
    accountCycleId,
    lifecycle: { stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: 'ENTRY_SHADOW_ALLOWED', ...o.lifecycle },
    readiness: {
      scope: 'NOT_APPLICABLE_NO_INTENT', frozenGeneration: { id: null, generation: null, enabled: null, authorityMode: null, effectiveAt: null },
      rolloutRelationship: { activeExecutionGenerationId: 3, activeDispatchGenerationId: 3, matchesExecution: false, matchesDispatch: false },
      executionState: { version: 5, activatedAt: '2026-11-01T00:00:00Z' }, dispatchState: { version: 6, activatedAt: '2026-11-01T00:00:00Z' },
      effectiveAssignmentAuthority: false, assignmentAuthorityState: 'NOT_YET_FROZEN', accountOperational: true, assignmentOperational: true,
      receipt: { signalId: 11, receivedAt: '2026-11-04T10:00:00Z', freshness: 'FRESH' }, c2WorkerClaimPresent: false, authorizationDeadlineStatus: 'NOT_COMMITTED', ...o.readiness,
    },
    evidence: {
      executionObligation: null, marketIntelligenceObligation: null, orderIntent: null, exposure: null, workerClaim: null,
      authorization: { pairPresent: false, status: 'NOT_COMMITTED', expired: false, tradingViewConsumption: null, marketIntelligenceConsumption: null },
      brokerSendPermissionEstablished: false,
      broker: { attributionProvenance: 'DIRECT_LINKED_EVIDENCE_ONLY_PRE_C3C', absenceIsAuthoritativeNonDeliveryProof: false, orderEvidencePresent: false, activityEvidencePresent: false, orders: [], ordersMetadata: meta(), activities: [], activitiesMetadata: meta() },
      exposureEvents: [], exposureEventsMetadata: meta(), ...o.evidence,
    },
    recovery: {
      retainedExposureReviewRequired: false, retainedExposureReasonCode: null, authoritativeReconciliationRequired: false, unresolvedAuthoritativeOnlyCount: 0, activeAttentionCount: 0,
      activeOperationalAttention: [], activeOperationalAttentionMetadata: meta(), operationalAttention: [], operationalAttentionMetadata: meta(), ...o.recovery,
    },
  };
}
const intent = (status: string, id = 70) => ({ id, status, clientOrderId: `client-${id}`, createdAt: '2026-11-04T10:01:00Z', updatedAt: '2026-11-04T10:02:00Z', blockReason: null });
const claim = { id: 81, claimedAt: '2026-11-04T10:03:00Z', dispatchStateVersion: 6 };
const pair = { pairPresent: true, status: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED', expired: false, tradingViewConsumption: { id: 91, authorizedAt: '2026-11-04T10:04:00Z', deadlineAt: '2026-11-04T10:05:00Z', consumedAt: null }, marketIntelligenceConsumption: { id: 92, consumedAt: '2026-11-04T10:04:00Z' } };
const heldClaim = (status: string, held = true) => ({ id: 60, status, acquiredAt: '2026-11-04T10:01:00Z', releasedAt: held ? null : '2026-11-04T10:06:00Z', releaseReason: held ? null : 'BLOCKED', held });
const obligations = { executionObligation: { id: 50, createdAt: '2026-11-04T10:01:00Z', executionEpochAt: null, authorizationId: 4, rolloutGenerationId: 3 }, marketIntelligenceObligation: { id: 51, frozenAt: '2026-11-04T10:01:00Z', validUntil: '2026-11-04T10:30:00Z' } };

const account = (id: number, name = 'Paper A') => ({ id, status: 'ENTRY_SHADOW_ALLOWED', tradingAccountId: id + 100, tradingAccountSubscriptionId: id + 200, subscriptionId: id + 300, entrySignalRouteId: id + 400, entryRolloutGenerationId: null, entryReservationKey: null, pendingExitAcceptedAt: null, terminalAt: null, terminalReasonCode: null, noExposureProof: null, tradingAccount: { id: id + 100, displayName: name, environment: 'PAPER' }, correlationDecisions: [] });
function cycleWith(accounts: ReturnType<typeof account>[], lifecycle: ExecutionLifecycle | undefined | unknown, extra: Record<string, unknown> = {}): OperationsCycle {
  return { id: 40, externalTradeCycleRef: 'tv-40', status: 'ROUTED', terminalAt: null, terminalReasonCode: null, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', shadowOnly: true, actualExecutionAuthority: 'NONE', hypotheticalEntryAuthority: 'SHADOW_RESERVATION_ONLY', unresolvedExitCount: 0, attentionExitCount: 0, security: { id: 5, symbol: 'QQQ' }, binding: { id: 2, externalStrategyKey: 'mean', signalSource: { id: 1, name: 'TradingView' }, strategy: { id: 3, key: 'mean', name: 'Mean' } }, revision: { id: 7, revision: 1, authorityMode: 'TRADE_ELIGIBLE', status: 'ACTIVE' }, work: [], exitObligations: [], signals: [], accountCycles: accounts, correlationDecisions: [], executionLifecycle: lifecycle, ...extra } as unknown as OperationsCycle;
}
const envelope = (accountCycles: AccountCycleLifecycle[], sourceLifecycle: { stage: string; reasonCode: string } = { stage: 'ACCOUNT_LIFECYCLES_PROJECTED', reasonCode: 'SEE_ACCOUNT_CYCLES' }) => ({ observedAt: '2026-11-04T10:10:00Z', readinessMayChangeAfterObservation: true, capabilities: { finalizationScheduling: 'HARD_DISABLED_PRE_C3C', brokerPost: 'UNAVAILABLE_PRE_C3C', tradingViewSellExecution: 'UNAVAILABLE', tradingViewLiveExecution: 'UNAVAILABLE' }, sourceLifecycle, accountCycles }) as ExecutionLifecycle;

let client: QueryClient, detail: unknown, detailError = false, calls: Array<[string, { method?: string } | undefined]> = [];
const listResult = (cycles: unknown[]) => ({ cycles, summary: { shadowOnly: true, totalCycles: cycles.length, unresolvedExitObligations: 0, work: {}, stalledLeases: 0, evaluatedAt: '2026-11-04T00:00:00Z' }, pagination: { page: 1, pageSize: 25, total: cycles.length, totalPages: 1 } });
function mount(initial = '/?section=operations') { client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); return render(<MantineProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[initial]}><OperationsTab token="owner" /></MemoryRouter></QueryClientProvider></MantineProvider>); }
const open = async () => { fireEvent.click(await screen.findByRole('button', { name: 'Inspect' })); await screen.findByText('Execution lifecycle'); };
const expand = (name: RegExp, scope?: HTMLElement) => fireEvent.click((scope ? within(scope) : screen).getByRole('button', { name }));
const remove = Symbol('remove');
function mutatePath(root: Record<string, unknown>, path: Array<string | number>, value: unknown | typeof remove) {
  let cursor: unknown = root;
  for (const part of path.slice(0, -1)) cursor = Array.isArray(cursor) && typeof part === 'number' ? cursor[part] : typeof cursor === 'object' && cursor !== null ? (cursor as Record<string, unknown>)[String(part)] : undefined;
  const last = path.at(-1)!;
  if (Array.isArray(cursor) && typeof last === 'number') cursor[last] = value;
  else if (typeof cursor === 'object' && cursor !== null) {
    if (value === remove) delete (cursor as Record<string, unknown>)[String(last)];
    else (cursor as Record<string, unknown>)[String(last)] = value;
  }
}
beforeEach(() => {
  vi.clearAllMocks(); detailError = false; calls = [];
  mocks.request.mockImplementation(async (path: string, options?: { method?: string }) => {
    calls.push([path, options]);
    if (path.endsWith('/execution-rollouts')) return { activeExecutionGenerationId: null, executionEpochAt: null, rolloutStateVersion: 1, generations: [], activationEvents: [] };
    if (path.endsWith('/broker-dispatch-state')) return { state: { version: 1, activeRolloutGenerationId: null, activatedAt: null }, activationEvents: [] };
    if (path.includes('/entry-execution-authorizations')) return { authorizations: [] };
    if (path.endsWith('/operations/40')) { if (detailError) throw new Error('boom'); return detail; }
    if (path.includes('/operations?')) return listResult([cycleWith([account(20)], undefined)]);
    throw new Error(path);
  });
});
afterEach(() => { cleanup(); client.clear(); });

describe('Operations execution lifecycle UI', () => {
  it('replaces the blanket SHADOW-only statement with boundary-specific language', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20)]));
    mount();
    const list = await screen.findByTestId('execution-boundary-notice');
    expect(list.textContent).toMatch(/Historical SHADOW correlation and reservation evidence remains SHADOW/);
    expect(list.textContent).toMatch(/PAPER ENTRY execution authority may be configured/);
    expect(list.textContent).toMatch(/not proof that a broker send occurred/);
    expect(screen.queryByText(/SHADOW ONLY/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Actual execution authority: NONE/);
    await open();
    const text = document.body.textContent ?? '';
    for (const phrase of [/finalization scheduling remains unavailable before C3C/, /Broker POST execution is unavailable/, /SELL and LIVE execution remain unavailable/, /EXIT correlation is not a broker SELL/, /C2 claims and final-authorization evidence may exist/]) expect(text).toMatch(phrase);
  });

  it('shows activation history and account-scoped authority without implying broker-send capability', async () => {
    detail=cycleWith([account(20)],envelope([lifecycleFor(20,{readiness:{effectiveAssignmentAuthority:true,assignmentAuthorityState:'FROZEN_EFFECTIVE'}})]));
    mocks.request.mockImplementation(async(path:string,options?:{method?:string})=>{calls.push([path,options]);if(path.endsWith('/execution-rollouts'))return{activeExecutionGenerationId:3,executionEpochAt:'2026-11-01T00:00:00Z',rolloutStateVersion:5,generations:[{id:3,generation:2,direction:'ENTRY',enabled:true,authorityMode:'EXECUTE',effectiveAt:'2026-10-01T00:00:00Z'}],activationEvents:[{id:8,rolloutGenerationId:3,action:'ACTIVATE',reason:'reviewed',createdAt:'2026-11-01T00:00:00Z'}]};if(path.endsWith('/broker-dispatch-state'))return{state:{version:6,activeRolloutGenerationId:3,activatedAt:'2026-11-02T00:00:00Z'},activationEvents:[{id:9,rolloutGenerationId:3,action:'ACTIVATE',stateVersion:6,reason:'reviewed',createdAt:'2026-11-02T00:00:00Z'}]};if(path.includes('/entry-execution-authorizations'))return{authorizations:[{id:12,rolloutGenerationId:3,authorizationSequence:1,status:'AUTHORIZED',tradingAccountId:120,tradingAccountSubscriptionId:220,subscriptionId:320,securityId:5,signalSourceId:1,strategySignalBindingId:2,strategySignalRevisionId:7,strategyRevision:1,authorizedAt:'2026-11-01T00:00:00Z',revokedAt:null,invalidatedAt:null,invalidationReasonCode:null}]};if(path.endsWith('/operations/40'))return detail;return listResult([cycleWith([account(20)],undefined)]);});
    mount();
    const status=await screen.findByTestId('authority-status');
    expect(status.textContent).toMatch(/Active execution generation: 2 \(#3\).*state version 5/);
    expect(status.textContent).toMatch(/Recent dispatch history: ACTIVATE generation #3 \/ v6/);
    expect(status.textContent).toMatch(/does not permit a broker order/);
    await open();
    const assignment=await screen.findByTestId('assignment-authority-20');
    expect(assignment.textContent).toMatch(/Latest authorization #12: AUTHORIZED/);
    expect(assignment.textContent).toMatch(/Frozen authority effective/);
    expect(calls.some(([path])=>path.endsWith('/accounts/120/assignments/220/entry-execution-authorizations'))).toBe(true);
    expect(calls.filter(([,options])=>options?.method&&options.method!=='GET')).toEqual([]);
  });

  it('historical SHADOW cycle without a marked intent: not applicable, no BUY scope, details collapsed', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20)]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText('Not an execution candidate')).toBeTruthy();
    expect(within(card).getByText(/Scope not applicable \(no intent\)/)).toBeTruthy();
    expect(card.textContent).not.toMatch(/PAPER_BUY/);
    expect(within(card).getByText(/2\. C2 worker claimed.* — Not applicable/)).toBeTruthy();
    for (const name of [/Identity/, /Readiness/, /Authorization/, /Exposure claim/, /Broker evidence/, /Recovery and attention/]) expect(within(card).getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false');
    expect(card.textContent).not.toMatch(/Account cycle: #20/);
    expand(/Identity/, card);
    expect(within(card).getByText(/Marked OrderIntent: Not applicable/)).toBeTruthy();
    expect(within(card).getByText(/Frozen assignment \/ subscription \/ route: #220 \/ #320 \/ #420/)).toBeTruthy();
  });

  it('execution-prospective before admission shows not yet created, and not-yet-frozen authority', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'ADMISSION_AWAITING_PROCESSING', reasonCode: 'DURABLE_EXECUTION_PROSPECTIVE_ADMISSION' } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText('Admission awaiting processing')).toBeTruthy();
    expect(within(card).getByText(/Not yet frozen into an obligation/)).toBeTruthy();
    expect(within(card).getByText(/3\. Paired final authorization committed.*Authorization not committed\./)).toBeTruthy();
    expand(/Identity/, card);
    expect(within(card).getByText(/Marked OrderIntent: Not yet created/)).toBeTruthy();
  });

  it('pending PAPER BUY intent', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'PENDING_MARKED_INTENT', reasonCode: 'MARKED_INTENT_AWAITING_C2_OWNERSHIP' }, readiness: { scope: 'PAPER_BUY', assignmentAuthorityState: 'FROZEN_EFFECTIVE', effectiveAssignmentAuthority: true }, evidence: { orderIntent: intent('pending'), ...obligations, exposure: heldClaim('ENTRY_PENDING') } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText(/Pending marked intent/)).toBeTruthy();
    expect(within(card).getByText('Scope PAPER_BUY')).toBeTruthy();
    expect(within(card).getByText(/2\. C2 worker claimed.* — No worker claim recorded/)).toBeTruthy();
    expect(within(card).getByText(/Frozen and currently effective/)).toBeTruthy();
    expand(/Identity/, card);
    expect(within(card).getByText(/Marked OrderIntent: #70 · pending/)).toBeTruthy();
  });

  it('active C2 worker claim is shown as historical evidence separate from stage', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'C2_WORKER_CLAIMED', reasonCode: 'ACTIVE_C2_OWNERSHIP' }, readiness: { scope: 'PAPER_BUY', c2WorkerClaimPresent: true }, evidence: { orderIntent: intent('submitting'), workerClaim: claim, ...obligations, exposure: heldClaim('ENTRY_PENDING') } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText('C2 worker claimed')).toBeTruthy();
    expect(within(card).getByText('Worker claim #81 (historical)')).toBeTruthy();
    expect(within(card).getByText(/3\. Paired final authorization committed.*Authorization not committed\./)).toBeTruthy();
    expect(within(card).getByText(/4\. Broker send permission established.* — Not established/)).toBeTruthy();
  });

  it('committed pair is labeled authorization-only, never definitively not sent', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' }, readiness: { scope: 'PAPER_BUY', c2WorkerClaimPresent: true, authorizationDeadlineStatus: 'OPEN' }, evidence: { orderIntent: intent('submitting'), workerClaim: claim, ...obligations, exposure: heldClaim('ENTRY_PENDING'), authorization: pair } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getAllByText(/Authorization committed — broker send not established/).length).toBeGreaterThan(0);
    expect(card.textContent).not.toMatch(/not sent|never sent|was not sent/i);
    expect(within(card).getByText(/4\. Broker send permission established.* — Not established/)).toBeTruthy();
    expect(within(card).getByText(/5\. Broker adapter invoked.* — Not reported by the pre-C3C projection/)).toBeTruthy();
    expand(/Authorization/, card);
    expect(within(card).getByText(/TradingView consumption: #91/)).toBeTruthy();
    expect(within(card).getByText(/Market Intelligence consumption: #92/)).toBeTruthy();
    expect(within(card).getByText(/Complete pair: yes/)).toBeTruthy();
  });

  it('expired authorization remains an authorization-only fact', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' }, readiness: { scope: 'PAPER_BUY', authorizationDeadlineStatus: 'EXPIRED' }, evidence: { orderIntent: intent('submitting'), ...obligations, exposure: heldClaim('ENTRY_PENDING'), authorization: { ...pair, expired: true } } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText(/Historical authorization committed; deadline expired; broker send not established\./)).toBeTruthy();
    expand(/Readiness/, card);
    expect(within(card).getByText(/Authorization deadline: EXPIRED/)).toBeTruthy();
  });

  it.each([
    ['released claim without release time', (v: AccountCycleLifecycle) => { v.evidence.exposure = { ...heldClaim('BLOCKED', false), releasedAt: null }; }],
    ['held claim marked RELEASED', (v: AccountCycleLifecycle) => { v.evidence.exposure = heldClaim('RELEASED'); }],
    ['authorization stage without complete pair', (v: AccountCycleLifecycle) => { v.lifecycle.stage='AUTHORIZATION_COMMITTED'; }],
    ['expired authorization with open deadline', (v: AccountCycleLifecycle) => { v.evidence.authorization={...pair,expired:true};v.readiness.authorizationDeadlineStatus='OPEN'; }],
    ['worker claim object contradicts false readiness', (v: AccountCycleLifecycle) => { v.evidence.workerClaim=claim; }],
    ['malformed exposure date', (v: AccountCycleLifecycle) => { v.evidence.exposure={...heldClaim('ENTRY_PENDING'),acquiredAt:'not-a-date'}; }],
  ])('rejects contradictory evidence: %s', (_name, mutate) => {
    const value=lifecycleFor(20); mutate(value);
    expect(parseExecutionLifecycle(envelope([value])).status).toBe('invalid');
  });

  it('accepts legitimate released and expired lifecycle evidence', () => {
    const value=lifecycleFor(20,{lifecycle:{stage:'BLOCKED_EXPIRED_OR_TERMINALIZED',reasonCode:'EXPIRED'},readiness:{scope:'PAPER_BUY',authorizationDeadlineStatus:'EXPIRED'},evidence:{exposure:heldClaim('RELEASED',false),authorization:{...pair,expired:true}}});
    expect(parseExecutionLifecycle(envelope([value])).status).toBe('ok');
  });

  it.each([
    ['neither consumption', { pairPresent: false, status: 'NOT_COMMITTED', expired: false, tradingViewConsumption: null, marketIntelligenceConsumption: null }, 'Authorization not committed.'],
    ['only one consumption', { pairPresent: false, status: 'NOT_COMMITTED', expired: false, tradingViewConsumption: pair.tradingViewConsumption, marketIntelligenceConsumption: null }, 'Incomplete authorization pair — inconsistent evidence.'],
    ['complete unexpired pair', pair, 'Authorization committed — broker send not established.'],
    ['complete expired pair', { ...pair, expired: true }, 'Historical authorization committed; deadline expired; broker send not established.'],
  ])('expanded Authorization derives copy for %s', async (_label, authorization, expected) => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, {
      lifecycle: { stage: authorization.pairPresent ? 'AUTHORIZATION_COMMITTED' : authorization.tradingViewConsumption ? 'MISSING_OR_INCONSISTENT_EVIDENCE' : 'PENDING_MARKED_INTENT', reasonCode: 'AUTHORIZATION_EVIDENCE' },
      readiness: { scope: 'PAPER_BUY', authorizationDeadlineStatus: authorization.expired ? 'EXPIRED' : authorization.pairPresent ? 'OPEN' : 'NOT_COMMITTED' },
      evidence: { orderIntent: intent('pending'), ...obligations, exposure: heldClaim('ENTRY_PENDING'), authorization },
    })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expand(/Authorization/, card);
    expect(within(card).getAllByText(expected, { exact: true }).length).toBeGreaterThan(0);
  });

  it.each([
    ['capabilities.brokerPost', (v: Record<string, unknown>) => mutatePath(v, ['capabilities', 'brokerPost'], {})],
    ['sourceLifecycle.stage', (v: Record<string, unknown>) => mutatePath(v, ['sourceLifecycle', 'stage'], {})],
    ['receipt.freshness', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'readiness', 'receipt', 'freshness'], {})],
    ['assignmentAuthorityState', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'readiness', 'assignmentAuthorityState'], {})],
    ['broker.attributionProvenance', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'broker', 'attributionProvenance'], {})],
    ['exposure.status', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'exposure'], { ...heldClaim('ENTRY_PENDING'), status: {} })],
    ['exposureEvents[].eventType', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'exposureEvents'], [{ id: 1, eventType: {}, createdAt: null }])],
    ['operationalAttention[].status', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'recovery', 'operationalAttention'], [{ id: 1, code: null, source: null, status: {}, severity: null, title: null, resolutionPolicy: null, firstObservedAt: null, lastObservedAt: null, resolvedAt: null }])],
    ['missing exposure.held', (v: Record<string, unknown>) => { mutatePath(v, ['accountCycles', 0, 'evidence', 'exposure'], heldClaim('ENTRY_PENDING')); mutatePath(v, ['accountCycles', 0, 'evidence', 'exposure', 'held'], remove); }],
    ['empty exposure', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'exposure'], {})],
    ['missing orderIntent', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'orderIntent'], remove)],
    ['invalid workerClaim', (v: Record<string, unknown>) => { mutatePath(v, ['accountCycles', 0, 'readiness', 'c2WorkerClaimPresent'], true); mutatePath(v, ['accountCycles', 0, 'evidence', 'workerClaim'], {}); }],
    ['invalid frozenGeneration', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'readiness', 'frozenGeneration'], {})],
    ['invalid tradingViewConsumption', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'authorization', 'tradingViewConsumption'], {})],
    ['empty capabilities', (v: Record<string, unknown>) => mutatePath(v, ['capabilities'], {})],
    ['unknown stage', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'lifecycle', 'stage'], 'UNKNOWN')],
    ['unknown scope', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'readiness', 'scope'], 'UNKNOWN')],
    ['unknown deadline status', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'readiness', 'authorizationDeadlineStatus'], 'UNKNOWN')],
    ['malformed history record', (v: Record<string, unknown>) => mutatePath(v, ['accountCycles', 0, 'evidence', 'broker', 'orders'], [{ id: 1, brokerOrderId: {} }])],
  ])('rejects malformed %s without breaking Operations', async (_label, mutate) => {
    const value = structuredClone(envelope([lifecycleFor(20)])) as unknown as Record<string, unknown>;
    mutate(value);
    detail = cycleWith([account(20)], value);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('Execution lifecycle unrecognized')).toBeTruthy();
    expect(screen.getAllByTestId('execution-boundary-notice').length).toBeGreaterThan(0);
    expect(screen.getByText('Account cycles')).toBeTruthy();
  });

  it('accepts explicit null for legitimately nullable evidence', () => {
    const parsed = parseExecutionLifecycle(envelope([lifecycleFor(20)]));
    expect(parsed.status).toBe('ok');
  });

  it('normally blocked and released intent shows settled exposure without a recovery warning', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED', reasonCode: 'ORDER_INTENT_BLOCKED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: { ...intent('blocked'), blockReason: 'KILL_SWITCH' }, ...obligations, exposure: heldClaim('RELEASED', false) } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText('Blocked, expired or terminalized')).toBeTruthy();
    expect(within(card).getByText('Exposure settled')).toBeTruthy();
    expect(screen.queryByTestId('retained-exposure-warning')).toBeNull();
    expect(screen.queryByTestId('authoritative-reconciliation-warning')).toBeNull();
  });

  it('blocked intent retaining exposure shows the prominent retained-exposure warning with account, intent and claim', async () => {
    detail = cycleWith([account(20, 'Paper Retained')], envelope([lifecycleFor(20, { lifecycle: { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('blocked', 71), ...obligations, exposure: heldClaim('ENTRY_PENDING') }, recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE' } })]));
    mount(); await open();
    const warning = screen.getByTestId('retained-exposure-warning');
    expect(warning.textContent).toMatch(/Retained exposure review required/);
    expect(warning.textContent).toMatch(/not safely terminal/);
    expect(warning.textContent).toMatch(/Paper Retained \(PAPER\)/);
    expect(warning.textContent).toMatch(/#71 \(blocked\)/);
    expect(warning.textContent).toMatch(/#60 · status ENTRY_PENDING/);
    expect(warning.textContent).toMatch(/TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE/);
    expect(warning.textContent).toMatch(/cannot release the exposure/);
    expect(screen.queryByTestId('authoritative-reconciliation-warning')).toBeNull();
  });

  it('UNRESOLVED exposure keeps its diagnostic reason distinct from the stage reason', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_AUTHORIZATION_COMMITTED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('blocked'), ...obligations, exposure: heldClaim('UNRESOLVED'), authorization: pair }, recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_UNRESOLVED_EXPOSURE' } })]));
    mount(); await open();
    const warning = screen.getByTestId('retained-exposure-warning');
    expect(warning.textContent).toMatch(/status UNRESOLVED/);
    expect(warning.textContent).toMatch(/TERMINAL_LIFECYCLE_WITH_UNRESOLVED_EXPOSURE/);
    expect(within(screen.getByTestId('lifecycle-20')).getByText(/Reason: TERMINAL_LIFECYCLE_WITH_AUTHORIZATION_COMMITTED/)).toBeTruthy();
  });

  it('terminal/authorization contradiction is flagged as inconsistent', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_AUTHORIZATION_COMMITTED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('blocked'), ...obligations, exposure: heldClaim('RELEASED', false), authorization: pair } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(within(card).getByText('Missing or inconsistent evidence')).toBeTruthy();
    expect(within(card).getByText(/Reason: TERMINAL_LIFECYCLE_WITH_AUTHORIZATION_COMMITTED/)).toBeTruthy();
    expect(within(card).getAllByText(/Authorization committed — broker send not established/).length).toBeGreaterThan(0);
  });

  it('active AUTHORITATIVE_ONLY attention shows a separate reconciliation warning without release controls', async () => {
    const attention = { id: 17, code: 'BROKER_STATE_UNKNOWN', source: 'EXECUTION', status: 'OPEN', severity: 'HIGH', title: 'x', resolutionPolicy: 'AUTHORITATIVE_ONLY', firstObservedAt: null, lastObservedAt: '2026-11-04T10:07:00Z', resolvedAt: null };
    const general = { ...attention, id: 18, code: 'GENERAL_REVIEW', resolutionPolicy: 'OPERATOR_REVIEW' };
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('submitting'), ...obligations, exposure: heldClaim('UNRESOLVED'), authorization: pair }, recovery: { authoritativeReconciliationRequired: true, unresolvedAuthoritativeOnlyCount: 2, activeAttentionCount: 3, activeOperationalAttention: [attention, general], activeOperationalAttentionMetadata: meta(3, 2), operationalAttention: [attention, general], operationalAttentionMetadata: meta(3, 2) } })]));
    mount(); await open();
    const warning = screen.getByTestId('authoritative-reconciliation-warning');
    expect(warning.textContent).toMatch(/Unresolved authoritative-only attention: 2/);
    expect(warning.textContent).toMatch(/BROKER_STATE_UNKNOWN/);
    expect(warning.textContent).toMatch(/resolution policy AUTHORITATIVE_ONLY/);
    expect(warning.textContent).not.toMatch(/GENERAL_REVIEW/);
    expect(warning.textContent).toMatch(/Displaying 1 authoritative-only record/);
    expect(warning.textContent).toMatch(/Nothing on this page releases or reconciles exposure/);
    expect(screen.queryByTestId('retained-exposure-warning')).toBeNull();
    expect(within(warning).queryAllByRole('button')).toHaveLength(0);
  });

  it('more than 100 evidence records show truncation notices and stay collapsed by default', async () => {
    const orders = Array.from({ length: 100 }, (_, i) => ({ id: 1000 - i, brokerOrderId: `bo-${i}`, clientOrderId: null, side: 'buy', status: 'filled', createdAt: null, updatedAt: null }));
    const events = Array.from({ length: 100 }, (_, i) => ({ id: 500 - i, eventType: 'EVT', createdAt: null }));
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'POST_SUBMISSION_BROKER_LIFECYCLE', reasonCode: 'ORDER_INTENT_FILLED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('filled'), ...obligations, exposure: heldClaim('FILLED'), broker: { attributionProvenance: 'DIRECT_LINKED_EVIDENCE_ONLY_PRE_C3C', absenceIsAuthoritativeNonDeliveryProof: false, orderEvidencePresent: true, activityEvidencePresent: false, orders, ordersMetadata: meta(250), activities: [], activitiesMetadata: meta() }, exposureEvents: events, exposureEventsMetadata: meta(101) } })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    expect(card.textContent).not.toMatch(/Order #1000/);
    expand(/Broker evidence/, card);
    expect(within(card).getByText('Showing 100 of 250 records.')).toBeTruthy();
    expect(within(card).getAllByText(/^Order #/).length).toBe(100);
    expand(/Exposure claim/, card);
    expect(within(card).getByText('Showing 100 of 101 records.')).toBeTruthy();
  });

  it('no broker records: explicit attribution limitation, not proof of non-delivery', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'AUTHORIZATION_COMMITTED', reasonCode: 'AUTHORIZATION_COMMITTED_SEND_NOT_ESTABLISHED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('submitting'), ...obligations, exposure: heldClaim('ENTRY_PENDING'), authorization: pair } })]));
    mount(); await open();
    expect(screen.getByText(/None directly linked \(absence is not proof of non-delivery\)/)).toBeTruthy();
    expect(screen.getByTestId('execution-lifecycle-summary').textContent).toMatch(/absence of broker records is not authoritative proof of non-delivery/);
    expand(/Broker evidence/, screen.getByTestId('lifecycle-20'));
    expect(screen.getByText(/Absence is not authoritative non-delivery proof/)).toBeTruthy();
    expect(screen.getByText(/not proof of who submitted them/)).toBeTruthy();
  });

  it('EXIT-only source cycle explains there is no ENTRY lifecycle and no broker SELL', async () => {
    detail = cycleWith([], envelope([], { stage: 'NOT_AN_EXECUTION_CANDIDATE', reasonCode: 'NO_ENTRY_SIGNAL' }));
    mount(); await open();
    expect(screen.getByText(/EXIT-only/)).toBeTruthy();
    expect(screen.getAllByText(/not a broker SELL/).length).toBeGreaterThan(0);
    expect(screen.getByText('No PAPER account cycles.')).toBeTruthy();
  });

  it('multi-account cycle matches lifecycle by accountCycleId, not array position', async () => {
    const a = account(20, 'Paper A'), b = account(21, 'Paper B');
    detail = cycleWith([a, b], envelope([
      lifecycleFor(21, { lifecycle: { stage: 'BLOCKED_EXPIRED_OR_TERMINALIZED', reasonCode: 'ORDER_INTENT_BLOCKED' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('blocked', 72), ...obligations, exposure: heldClaim('RELEASED', false) } }),
      lifecycleFor(20, { lifecycle: { stage: 'PENDING_MARKED_INTENT', reasonCode: 'MARKED_INTENT_AWAITING_C2_OWNERSHIP' }, readiness: { scope: 'PAPER_BUY' }, evidence: { orderIntent: intent('pending', 71), ...obligations, exposure: heldClaim('ENTRY_PENDING') } }),
      lifecycleFor(999),
    ]));
    mount(); await open();
    expect(within(screen.getByTestId('lifecycle-20')).getByText(/Pending marked intent/)).toBeTruthy();
    expect(within(screen.getByTestId('lifecycle-21')).getByText('Blocked, expired or terminalized')).toBeTruthy();
    expand(/Identity/, screen.getByTestId('lifecycle-20'));
    expect(within(screen.getByTestId('lifecycle-20')).getByText(/Marked OrderIntent: #71/)).toBeTruthy();
    expect(screen.getByText(/1 lifecycle entry did not match any account cycle/)).toBeTruthy();
    expect(screen.getByText('2 matched account lifecycle(s)')).toBeTruthy();
  });

  it('summarizes matched lifecycle warnings above account detail', async () => {
    detail = cycleWith([account(20), account(21)], envelope([
      lifecycleFor(20, { evidence: { exposure: heldClaim('UNRESOLVED') }, recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_UNRESOLVED_EXPOSURE' } }),
      lifecycleFor(21, { recovery: { authoritativeReconciliationRequired: true, unresolvedAuthoritativeOnlyCount: 1, activeAttentionCount: 1 } }),
      lifecycleFor(999, { recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: 'UNMATCHED' } }),
    ]));
    mount(); await open();
    expect(screen.getByTestId('lifecycle-warning-summary').textContent).toMatch(/Retained-exposure review required: 1\. Authoritative reconciliation required: 1\./);
  });

  it('wraps long mobile diagnostics and disclosure summaries', async () => {
    const longReason = 'TERMINAL_LIFECYCLE_WITH_UNRESOLVED_EXPOSURE';
    detail = cycleWith([account(20, 'Paper-account-with-an-extremely-long-operational-identifier')], envelope([lifecycleFor(20, {
      lifecycle: { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: longReason }, readiness: { scope: 'PAPER_BUY' },
      evidence: { orderIntent: intent('blocked', 123456789012345), exposure: heldClaim('UNRESOLVED') }, recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: longReason },
    })]));
    mount(); await open();
    const card = screen.getByTestId('lifecycle-20');
    const reason = within(card).getByText(`Reason: ${longReason}`);
    expect(reason.style.overflowWrap).toBe('anywhere');
    expect(reason.closest('.mantine-Badge-root')).toBeNull();
    const warning = screen.getByTestId('retained-exposure-warning');
    expect(within(warning).getByText(/Diagnostic reason:/).style.overflowWrap).toBe('anywhere');
    const disclosure = within(card).getByRole('button', { name: /Recovery and attention/ });
    expect(disclosure.style.overflowWrap).toBe('anywhere');
    expect(disclosure.style.whiteSpace).toBe('normal');
  });

  it('missing, malformed and duplicate lifecycle evidence fail visibly rather than guessing', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(30)]));
    mount(); await open();
    expect(screen.getByText(/No execution lifecycle evidence was returned for account cycle #20/)).toBeTruthy();
    cleanup(); client.clear();
    detail = cycleWith([account(20)], { observedAt: 'x', capabilities: {}, accountCycles: [{ accountCycleId: 20 }] });
    mount(); await open().catch(() => undefined);
    expect(await screen.findByText(/did not match the expected shape/)).toBeTruthy();
    cleanup(); client.clear();
    detail = cycleWith([account(20)], envelope([lifecycleFor(20), lifecycleFor(20)]));
    mount(); await open();
    expect(screen.getByText(/Contradictory lifecycle projections \(2\)/)).toBeTruthy();
    cleanup(); client.clear();
    detail = cycleWith([account(20)], undefined);
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText(/lifecycle projection was not returned/)).toBeTruthy();
  });

  it('loading, error and empty states', async () => {
    detail = cycleWith([account(20)], envelope([lifecycleFor(20)]));
    detailError = true;
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('Unable to load cycle')).toBeTruthy();
    cleanup(); client.clear();
    mocks.request.mockImplementation(async (path: string) => { if (path.includes('/operations?')) return listResult([]); throw new Error(path); });
    mount();
    expect(await screen.findByText('No correlation cycles match this view')).toBeTruthy();
    cleanup(); client.clear();
    mocks.request.mockImplementation(() => new Promise(() => undefined));
    mount();
    expect(screen.getByText('Loading correlation operations…')).toBeTruthy();
    cleanup(); client.clear();
    mocks.request.mockRejectedValue(new Error('down'));
    mount();
    expect(await screen.findByText('Unable to load correlation operations')).toBeTruthy();
  });

  it('adds no mutation or execution controls and issues only GETs while browsing', async () => {
    const failed = { id: 50, signalId: 11, event: 'EXIT_LONG', status: 'FAILED', attemptCount: 1, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: '2026-11-04T00:00:00Z', lastErrorCode: 'X', completedAt: null, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', ageMs: 1, stalledLease: false };
    detail = cycleWith([account(20)], envelope([lifecycleFor(20, { lifecycle: { stage: 'MISSING_OR_INCONSISTENT_EVIDENCE', reasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE' }, evidence: { orderIntent: intent('blocked'), ...obligations, exposure: heldClaim('UNRESOLVED') }, recovery: { retainedExposureReviewRequired: true, retainedExposureReasonCode: 'TERMINAL_LIFECYCLE_WITH_RETAINED_EXPOSURE', authoritativeReconciliationRequired: true, unresolvedAuthoritativeOnlyCount: 1, activeAttentionCount: 1 } })]), { work: [failed] });
    mount(); await open();
    for (const name of [/Identity/, /Readiness/, /Authorization/, /Exposure claim/, /Broker evidence/, /Recovery and attention/]) expand(name, screen.getByTestId('lifecycle-20'));
    const labels = screen.getAllByRole('button').map(button => button.textContent ?? '');
    expect(labels.filter(text => /release|retry|reconcil|acknowledge|activate|finalize|dispatch|send|cancel|close/i.test(text))).toEqual([]);
    expect(labels.filter(text => /requeue/i.test(text))).toEqual(['Requeue failed work']);
    expect(calls.filter(([, options]) => options?.method && options.method !== 'GET')).toEqual([]);
    expect(calls.every(([path]) => /\/api\/external-signal-admin\/(operations|execution-rollouts|broker-dispatch-state|accounts\/\d+\/assignments\/\d+\/entry-execution-authorizations)/.test(path))).toBe(true);
  });

  it('preserves controlled requeue and URL-backed filtering', async () => {
    const failed = { id: 50, signalId: 11, event: 'EXIT_LONG', status: 'FAILED', attemptCount: 1, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: '2026-11-04T00:00:00Z', lastErrorCode: 'X', completedAt: null, createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', ageMs: 1, stalledLease: false };
    detail = cycleWith([account(20)], envelope([lifecycleFor(20)]), { work: [failed] });
    mocks.request.mockImplementation(async (path: string, options?: { method?: string }) => { calls.push([path, options]); if (path.endsWith('/execution-rollouts')) return { activeExecutionGenerationId: null, executionEpochAt: null, rolloutStateVersion: 1, generations: [], activationEvents: [] }; if (path.endsWith('/broker-dispatch-state')) return { state: { version: 1, activeRolloutGenerationId: null, activatedAt: null }, activationEvents: [] }; if (path.includes('/entry-execution-authorizations')) return { authorizations: [] }; if (path.includes('/correlation-work/')) return { id: 50 }; if (path.endsWith('/operations/40')) return detail; return listResult([cycleWith([account(20)], undefined)]); });
    mount(); await open();
    const button = screen.getByRole('button', { name: 'Requeue failed work' });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Confirm controlled requeue/ }));
    fireEvent.click(button);
    await vi.waitFor(() => expect(calls.some(([path, o]) => path.endsWith('/correlation-work/50/requeue') && o?.method === 'POST')).toBe(true));
    fireEvent.change(screen.getByLabelText('Work status'), { target: { value: 'FAILED' } });
    await vi.waitFor(() => expect(calls.some(([path]) => path.includes('workStatus=FAILED'))).toBe(true));
  });
});

describe('lifecycle helpers', () => {
  it('distinguishes not applicable from not yet created', () => {
    expect(absence('NOT_AN_EXECUTION_CANDIDATE')).toBe('Not applicable');
    expect(absence('PENDING_MARKED_INTENT')).toBe('Not yet created');
    expect(absence('BLOCKED_EXPIRED_OR_TERMINALIZED')).toBe('Not recorded');
  });
  it('formats truncation and matches only by id', () => {
    expect(truncationNotice(meta(250))).toBe('Showing 100 of 250 records.');
    expect(truncationNotice(meta(1))).toBe('1 record.');
    const parsed = parseExecutionLifecycle(envelope([lifecycleFor(2), lifecycleFor(1)]));
    if (parsed.status !== 'ok') throw new Error('expected ok');
    const { byId, unmatched } = matchLifecycles([1, 2], parsed.value);
    expect(byId.get(1)?.[0]?.accountCycleId).toBe(1);
    expect(unmatched).toEqual([]);
    expect(parseExecutionLifecycle(null).status).toBe('absent');
    expect(parseExecutionLifecycle({ observedAt: 1 }).status).toBe('invalid');
  });
});
