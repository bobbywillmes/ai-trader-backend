import { Modal } from '@mantine/core';
import { useState, useEffect } from 'react';
import type { Strategy } from '../strategies/types';
import type { ExitProfile } from '../exitProfiles/types';
import type { CreateSubscriptionPayload } from '../subscriptions/types';

type CreateForm = {
  key: string;
  name: string;
  brokerMode: string;
  sizingType: 'fixed_qty' | 'dollar_amount';
  sizingValue: string;
  strategyId: string;
  exitProfileId: string;
};

const EMPTY_FORM: CreateForm = {
  key: '',
  name: '',
  brokerMode: 'paper',
  sizingType: 'dollar_amount',
  sizingValue: '1000',
  strategyId: '',
  exitProfileId: '',
};

type Props = {
  symbol: string;
  strategies: Strategy[];
  exitProfiles: ExitProfile[];
  isOpen: boolean;
  onClose: () => void;
  onSave: (payload: CreateSubscriptionPayload) => void;
  isPending: boolean;
};

export function SubscriptionCreateModal({
  symbol,
  strategies,
  exitProfiles,
  isOpen,
  onClose,
  onSave,
  isPending,
}: Props) {
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);

  useEffect(() => {
    if (isOpen) {
      setForm({
        ...EMPTY_FORM,
        strategyId: strategies.length === 1 ? strategies[0].id.toString() : '',
        exitProfileId: exitProfiles.length === 1 ? exitProfiles[0].id.toString() : '',
      });
    }
  }, [isOpen, strategies, exitProfiles]);

  const selectedProfile = exitProfiles.find(
    (p) => p.id.toString() === form.exitProfileId
  );

  const isValid =
    form.key.trim() &&
    form.name.trim() &&
    form.strategyId &&
    form.exitProfileId &&
    parseFloat(form.sizingValue) > 0;

  function handleSave() {
    if (!isValid) return;
    onSave({
      key: form.key.trim(),
      name: form.name.trim(),
      symbol,
      broker: 'alpaca',
      brokerMode: form.brokerMode,
      sizingType: form.sizingType,
      sizingValue: parseFloat(form.sizingValue),
      strategyId: Number(form.strategyId),
      exitProfileId: Number(form.exitProfileId),
    });
  }

  function set(field: keyof CreateForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title={`New Subscription — ${symbol}`}
      size="md"
      centered
    >
      <div className="sub-edit-form">
        <div className="sub-edit-section">
          <div className="sub-edit-section-title">Identity</div>
          <div className="sub-edit-row">
            <label className="sub-edit-label">
              Key
              <input
                type="text"
                className="sub-edit-input"
                value={form.key}
                placeholder="e.g. aapl-trend-1"
                onChange={(e) => set('key', e.target.value)}
              />
            </label>
            <label className="sub-edit-label">
              Name
              <input
                type="text"
                className="sub-edit-input"
                value={form.name}
                placeholder="e.g. AAPL Trend Strategy"
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="sub-edit-divider" />

        <div className="sub-edit-section">
          <div className="sub-edit-section-title">Sizing</div>
          <div className="sub-edit-row">
            <label className="sub-edit-label">
              Type
              <select
                className="sub-edit-select"
                value={form.sizingType}
                onChange={(e) => set('sizingType', e.target.value)}
              >
                <option value="dollar_amount">Dollar Amount</option>
                <option value="fixed_qty">Fixed Quantity</option>
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
                onChange={(e) => set('sizingValue', e.target.value)}
              />
            </label>
          </div>
        </div>

        <div className="sub-edit-divider" />

        <div className="sub-edit-section">
          <div className="sub-edit-section-title">Assignments</div>
          <label className="sub-edit-label sub-edit-label--full">
            Strategy
            <select
              className="sub-edit-select"
              value={form.strategyId}
              onChange={(e) => set('strategyId', e.target.value)}
            >
              <option value="" disabled>Select a strategy...</option>
              {strategies.map((s) => (
                <option key={s.id} value={s.id.toString()}>
                  {s.key} — {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="sub-edit-label sub-edit-label--full">
            Exit Profile
            <select
              className="sub-edit-select"
              value={form.exitProfileId}
              onChange={(e) => set('exitProfileId', e.target.value)}
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

        <div className="sub-edit-section">
          <div className="sub-edit-section-title">Settings</div>
          {/* TODO: remove `disabled` and re-enable the Live option once live trading is supported */}
          <label className="sub-edit-label" style={{ width: 'calc(50% - 0.375rem)' }}>
            Broker Mode
            <select
              className="sub-edit-select"
              value={form.brokerMode}
              disabled
            >
              <option value="paper">Paper</option>
            </select>
          </label>
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
            disabled={isPending || !isValid}
          >
            {isPending ? 'Creating...' : 'Create Subscription'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
