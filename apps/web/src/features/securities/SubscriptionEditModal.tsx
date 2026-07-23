import { Modal } from '@mantine/core';
import { useState } from 'react';
import type { SecuritySubscription } from './types';
import type { ExitProfile } from '../exitProfiles/types';

type EditForm = {
  exitProfileId: string;
};

type Props = {
  subscription: SecuritySubscription | null;
  exitProfiles: ExitProfile[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: {
    subscriptionId: number;
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
    exitProfileId: subscription.exitProfile?.id?.toString() ?? '',
  }));

  const selectedProfile = exitProfiles.find(
    (p) => p.id.toString() === form.exitProfileId
  );

  function handleSave() {
    if (!form.exitProfileId) return;
    onSave({
      subscriptionId: subscription.id,
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
