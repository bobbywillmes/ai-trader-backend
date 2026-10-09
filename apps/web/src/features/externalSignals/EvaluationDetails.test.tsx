// @vitest-environment happy-dom
import { MantineProvider } from '@mantine/core';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { EvaluationDetails } from './EvaluationDetails';
import type { SignalRoute } from './types';
afterEach(cleanup);
const route: SignalRoute = { id: 1, tradingAccountId: 2, tradingAccountSubscriptionId: 3, subscriptionId: 4,
  targetSnapshot: { tradingAccountName: 'Paper', subscriptionKey: 'test', subscriptionName: 'Test',
    strategy: { id: 5, key: 'momentum', name: 'Momentum' }, security: { id: 6, symbol: 'RSP' } } };
it('explains historical routes without inventing evaluation', () => {
  render(<MantineProvider><EvaluationDetails route={route} authority="EVALUATION_ONLY" /></MantineProvider>);
  expect(screen.getByText('Not evaluated — predates SignalEvaluation')).toBeTruthy();
});
it('shows eligible applicability alongside separate evaluation-only authority and ordered evidence', () => {
  const time = '2026-09-14T12:00:00Z';
  render(<MantineProvider><EvaluationDetails authority="EVALUATION_ONLY" route={{ ...route, evaluationVersion: 1, evaluation: {
    id: 7, signalRouteId: 1, evaluationVersion: 1, event: 'ENTRY_LONG', intent: 'ENTRY', riskDirection: 'RISK_INCREASING',
    status: 'COMPLETED', outcome: 'ELIGIBLE', reasonCode: null, prospectiveExitManagementMode: 'EXTERNAL_SIGNAL',
    positionExitManagementMode: null, trackedPositionId: null, positionExitStateId: null,
    startedAt: time, completedAt: time, createdAt: time,
    gates: [{ id: 1, sequence: 1, gateKey: 'ROUTE_TARGET', result: 'PASS', reasonCode: null, evidenceJson: { subscriptionId: 4 }, evaluatedAt: time }],
  } }} /></MantineProvider>);
  expect(screen.getByText('Authority: EVALUATION_ONLY')).toBeTruthy();
  expect(screen.getByText('Prospective exit ownership: EXTERNAL_SIGNAL')).toBeTruthy();
  expect(screen.getByText(/eligible/i)).toBeTruthy();
  expect(screen.getByText('1. ROUTE_TARGET')).toBeTruthy();
  expect(screen.getByText(/No execution handoff exists/)).toBeTruthy();
});
it('shows ELIGIBLE applicability beside a BLOCKED route shadow with no trading effect', () => {
  const time = '2026-10-09T18:51:00Z';
  render(<MantineProvider><EvaluationDetails authority="EVALUATION_ONLY" route={{ ...route, evaluationVersion: 1, evaluation: {
    id: 8, signalRouteId: 1, evaluationVersion: 1, event: 'ENTRY_LONG', intent: 'ENTRY', riskDirection: 'RISK_INCREASING', status: 'COMPLETED', outcome: 'ELIGIBLE', reasonCode: null,
    prospectiveExitManagementMode: 'BACKEND_MANAGED', positionExitManagementMode: null, trackedPositionId: null, positionExitStateId: null, startedAt: time, completedAt: time, createdAt: time, gates: [],
  }, marketEligibilityAttempts: [{ id: 9, signalRouteId: 1, attempt: 1, integrationVersion: 'SIGNAL_ROUTE_MARKET_ELIGIBILITY_V1', status: 'COMPLETED', strategyId: 5, eligibilityDecisionId: 10, reasonCode: 'SHADOW_EVALUATION_COMPLETED', startedAt: time, completedAt: time, evidenceJson: {}, eligibilityDecision: {
    id: 10, outcome: 'BLOCKED', reasonCode: 'REQUIRED_STATE_BLOCKED', evaluatedAt: time, validUntil: '2026-10-09T19:00:00Z', policyRevisionId: 3, marketRegimeAssessmentId: 28, evaluationVersion: 'STRATEGY_MARKET_ELIGIBILITY_V1', currentFreshness: 'CURRENT', policyRevision: { id: 3, revision: 3, activatedAt: time }, marketRegimeAssessment: { id: 28, compositionVersion: 'MARKET_REGIME_COMPOSITION_V1', targetAt: time, observedAt: time }, gates: [{ id: 11, ordinal: 1, dimension: 'TREND', algorithmVersion: 'TREND_V1', requirement: 'REQUIRED', outcome: 'BLOCKED', observedState: 'NEUTRAL', sourceHealth: 'AVAILABLE', sourceAssessmentId: 298, allowedStatesJson: ['UP'], reasonCode: 'STATE_NOT_ALLOWED' }],
  } }] }} /></MantineProvider>);
  expect(screen.getByText('Market-policy shadow')).toBeTruthy();
  expect(screen.getByText(/SHADOW ONLY \/ NO TRADING EFFECT/)).toBeTruthy();
  expect(screen.getByText(/Recorded outcome:/).textContent).toContain('BLOCKED');
  expect(screen.getByText(/Policy revision 3/)).toBeTruthy();
  expect(screen.getByText(/source assessment #298/)).toBeTruthy();
  expect(screen.getAllByText(/eligible/i).length).toBeGreaterThan(0);
});
