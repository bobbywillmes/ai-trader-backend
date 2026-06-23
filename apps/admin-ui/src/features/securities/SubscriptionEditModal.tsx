import { Modal } from '@mantine/core';
import { useState } from 'react';
import type { SecuritySubscription } from './types';
import type { ExitProfile } from '../exitProfiles/types';

type EditForm = {
  sizingType: 'fixed_qty' | 'dollar_amount';
  sizingValue: string;
  exitProfileId: string;
};

type Props = {
  subscription: SecuritySubscription | null;
  exitProfiles: ExitProfile[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    subscriptionId: number;
    sizingType: 'fixed_qty' | 'dollar_amount';
    sizingValue: number;
    exitProfileId: number;
  }) => void;
  isPending: boolean;
};

type EditModalContentProps = Omit<Props, 'subscription'> & {
  subscription: SecuritySubscription;
};

export function SubscriptionEditModal(props: Props) {
  if (!props.isOpen || !props.subscription) {
    return null;
  }

  return (
    <SubscriptionEditModalContent
      key={props.subscription.id}
      {...props}
      subscription={props.subscription}
    />
  );
}

function SubscriptionEditModalContent({
  subscription,
  exitProfiles,
  isOpen,
  onClose,
  onSave,
  isPending,
}: EditModalContentProps) {
  const [form, setForm] = useState<EditForm>(() => ({
    sizingType: subscription.sizingType,
    sizingValue: subscription.sizingValue.toString(),
    exitProfileId: subscription.exitProfile?.id?.toString() ?? '',
  }));

  const selectedProfile = exitProfiles.find(
    (p) => p.id.toString() === form.exitProfileId
  );

  function handleSave() {
    if (!form.exitProfileId) return;
    const sizingValue = parseFloat(form.sizingValue);
    if (isNaN(sizingValue) || sizingValue <= 0) return;
    onSave({
      subscriptionId: subscription.id,
      sizingType: form.sizingType,
      sizingValue,
      exitProfileId: Number(form.exitProfileId),
    });
  }

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={`Edit: ${subscription.name}`}
      size="md"
      centered
    >
      <div className="sub-edit-form">
        <div className="sub-edit-section">
          <div className="sub-edit-section-title">Sizing</div>
          <div className="sub-edit-row">
            <label className="sub-edit-label">
              Type
              <select
                className="sub-edit-select"
                value={form.sizingType}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    sizingType: e.target.value as 'fixed_qty' | 'dollar_amount',
                  }))
                }
              >
                <option value="fixed_qty">Fixed Quantity</option>
                <option value="dollar_amount">Dollar Amount</option>
              </select>
            </label>
            <label className="sub-edit-label">
              {form.sizingType === 'dollar_amount' ? 'Amount ($)' : 'Quantity'}
              <input
                type="number"
                className="sub-edit-input"
                value={form.sizingValue}
                min="0"
                step={form.sizingType === 'dollar_amount' ? '100' : '1'}
                onChange={(e) =>
                  setForm((f) => ({ ...f, sizingValue: e.target.value }))
                }
              />
            </label>
          </div>
        </div>

        <div className="sub-edit-divider" />

        <div className="sub-edit-section">
          <div className="sub-edit-section-title">Exit Profile</div>
          <label className="sub-edit-label sub-edit-label--full">
            Profile
            <select
              className="sub-edit-select"
              value={form.exitProfileId}
              onChange={(e) =>
                setForm((f) => ({ ...f, exitProfileId: e.target.value }))
              }
            >
              <option value="" disabled>Select a profile...</option>
              {exitProfiles.map((p) => (
                <option key={p.id} value={p.id.toString()}>
                  {p.key} — {p.name}
                </option>
              ))}
            </select>
          </label>
          {selectedProfile && (
            <div className="sub-edit-profile-info">
              <div className="sub-edit-stat">
                <span className="sub-edit-stat-label">Target</span>
                <span className="sub-edit-stat-value">
                  {selectedProfile.targetPct !== null ? `${selectedProfile.targetPct}%` : '—'}
                </span>
              </div>
              <div className="sub-edit-stat">
                <span className="sub-edit-stat-label">Stop</span>
                <span className="sub-edit-stat-value">
                  {selectedProfile.stopLossPct !== null ? `${selectedProfile.stopLossPct}%` : '—'}
                </span>
              </div>
              {selectedProfile.trailingStopPct !== null && (
                <div className="sub-edit-stat">
                  <span className="sub-edit-stat-label">Trailing Stop</span>
                  <span className="sub-edit-stat-value">{selectedProfile.trailingStopPct}%</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="sub-edit-divider" />

        <div className="sub-edit-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={handleSave}
            disabled={isPending || !form.exitProfileId}
          >
            {isPending ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
