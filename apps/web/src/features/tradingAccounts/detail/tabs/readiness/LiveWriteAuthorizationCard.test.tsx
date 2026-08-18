// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MantineProvider } from '@mantine/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TradingAccountReadinessAssessment } from '../../../types';

const mocks = vi.hoisted(() => ({ grant: vi.fn(), revoke: vi.fn() }));
vi.mock('../../../hooks', () => ({
  useGrantLiveWriteApproval: () => ({ mutate: mocks.grant, isPending: false, isError: false, error: null }),
  useRevokeLiveWriteApproval: () => ({ mutate: mocks.revoke, isPending: false, isError: false, error: null }),
  useLiveWriteApprovals: () => ({
    data: {
      deploymentCanWrite: true,
      deploymentRole: 'PRODUCTION_EXECUTOR',
      history: [],
      capabilities: [
        {
          capability: 'RISK_REDUCING', effective: false, reason: 'INVALIDATED',
          approval: { revision: 2, status: 'INVALIDATED', grantedAt: null, expiresAt: null, invalidationReason: 'Credential changed.' },
          fingerprints: { configurationFingerprint: 'a'.repeat(64), credentialFingerprint: 'b'.repeat(64) },
        },
        { capability: 'ENTRY', effective: false, reason: 'MISSING', approval: null, fingerprints: { configurationFingerprint: 'c'.repeat(64), credentialFingerprint: 'd'.repeat(64) } },
      ],
    },
  }),
}));

import { LiveWriteAuthorizationCard } from './LiveWriteAuthorizationCard';

describe('LiveWriteAuthorizationCard', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('submits the latest ACTIVE LIVE_ENTRY_ARMING assessment ID for RISK_REDUCING reauthorization', async () => {
    const latest = {
      id: 91,
      purpose: 'LIVE_ENTRY_ARMING',
      validity: 'CURRENT',
    } as TradingAccountReadinessAssessment;
    render(<MantineProvider><LiveWriteAuthorizationCard accountId={2} token="token" latest={latest} /></MantineProvider>);
    const user = userEvent.setup();
    await user.type(screen.getAllByLabelText('Reason')[0]!, 'Reauthorize risk reduction');
    await user.type(screen.getByLabelText('Type APPROVE LIVE RISK_REDUCING'), 'APPROVE LIVE RISK_REDUCING');
    await user.click(screen.getAllByRole('button', { name: 'Grant' })[0]!);
    expect(mocks.grant).toHaveBeenCalledWith({
      capability: 'RISK_REDUCING',
      payload: {
        reason: 'Reauthorize risk reduction',
        typedConfirmation: 'APPROVE LIVE RISK_REDUCING',
        readinessAssessmentId: 91,
        expectedConfigurationFingerprint: 'a'.repeat(64),
        expectedCredentialFingerprint: 'b'.repeat(64),
        expectedRevision: 2,
      },
    });
  });
});
