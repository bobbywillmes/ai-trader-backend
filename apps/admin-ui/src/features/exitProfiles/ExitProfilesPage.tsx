import React, { useState, Fragment } from 'react';
import { toast, ToastContainer } from 'react-toastify';
import { getAdminToken } from '../../lib/api';
import {
  useExitProfiles,
  useCreateExitProfile,
  useUpdateExitProfile,
} from './hooks';
import { useSubscriptions } from '../subscriptions/hooks';
import type { ExitProfile, ExitProfileForm } from './types';

const EMPTY_FORM: ExitProfileForm = {
  key: '',
  name: '',
  description: '',
  targetPct: '',
  stopLossPct: '',
  trailingStopPct: '',
  maxHoldDays: '',
  exitMode: 'fixed_bracket',
  takeProfitBehavior: 'immediate',
  enabled: true,
};

function exitProfileToForm(profile: ExitProfile): ExitProfileForm {
  return {
    key: profile.key,
    name: profile.name,
    description: profile.description ?? '',
    targetPct: profile.targetPct === null ? '' : String(profile.targetPct),
    stopLossPct: profile.stopLossPct === null ? '' : String(profile.stopLossPct),
    trailingStopPct:
      profile.trailingStopPct === null ? '' : String(profile.trailingStopPct),
    maxHoldDays: profile.maxHoldDays === null ? '' : String(profile.maxHoldDays),
    exitMode: profile.exitMode,
    takeProfitBehavior: profile.takeProfitBehavior,
    enabled: profile.enabled,
  };
}

function emptyToNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (Number.isNaN(parsed)) throw new Error(`Invalid number: ${value}`);
  return parsed;
}

function emptyToIntOrNull(value: string): number | null {
  const parsed = emptyToNumberOrNull(value);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed)) throw new Error(`Expected whole number: ${value}`);
  return parsed;
}

type MessageType = 'success' | 'error' | 'warning' | 'info';

function showMessage(text: string, type: MessageType = 'info') {
  if (type === 'success') { toast.success(text); return; }
  if (type === 'error') { toast.error(text); return; }
  if (type === 'warning') { toast.warning(text); return; }
  toast.info(text);
}

export function ExitProfilesPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [creatingExitProfile, setCreatingExitProfile] = useState(false);
  const [editingExitProfileId, setEditingExitProfileId] = useState<number | null>(null);
  const [exitProfileForm, setExitProfileForm] = useState<ExitProfileForm>(EMPTY_FORM);

  const {
    data: exitProfiles = [],
    isLoading,
    isError,
    error,
  } = useExitProfiles(token);

  const { data: subscriptions = [] } = useSubscriptions(token);

  const createExitProfileMutation = useCreateExitProfile(token);
  const updateExitProfileMutation = useUpdateExitProfile(token);

  function startCreatingExitProfile() {
    setCreatingExitProfile(true);
    setEditingExitProfileId(null);
    setExitProfileForm(EMPTY_FORM);
  }

  function startEditingExitProfile(profile: ExitProfile) {
    setCreatingExitProfile(false);
    setEditingExitProfileId(profile.id);
    setExitProfileForm(exitProfileToForm(profile));
  }

  function cancelExitProfileForm() {
    setCreatingExitProfile(false);
    setEditingExitProfileId(null);
  }

  async function handleSaveExitProfile() {
    const key = exitProfileForm.key.trim();
    const name = exitProfileForm.name.trim();

    if (!key) {
      showMessage('Exit profile key is required.', 'error');
      return;
    }

    if (!name) {
      showMessage('Exit profile name is required.', 'error');
      return;
    }

    const commonFields = {
      name,
      description: exitProfileForm.description.trim() || null,
      targetPct: emptyToNumberOrNull(exitProfileForm.targetPct),
      stopLossPct: emptyToNumberOrNull(exitProfileForm.stopLossPct),
      trailingStopPct: emptyToNumberOrNull(exitProfileForm.trailingStopPct),
      maxHoldDays: emptyToIntOrNull(exitProfileForm.maxHoldDays),
      exitMode: exitProfileForm.exitMode,
      takeProfitBehavior: exitProfileForm.takeProfitBehavior,
      enabled: exitProfileForm.enabled,
    };

    try {
      if (editingExitProfileId !== null) {
        const matchingProfile = exitProfiles.find(
          (p) => p.id === editingExitProfileId
        );
        const usedByEnabled = matchingProfile
          ? subscriptions.filter(
              (s) => s.enabled && s.exitProfile?.key === matchingProfile.key
            )
          : [];

        if (usedByEnabled.length > 0) {
          const confirmed = window.confirm(
            `This exit profile is used by ${usedByEnabled.length} enabled subscription(s). Saving will affect live exit behavior. Continue?`
          );
          if (!confirmed) return;
        }

        await updateExitProfileMutation.mutateAsync({
          id: editingExitProfileId,
          payload: commonFields,
        });

        showMessage(`Exit profile updated: ${key}`, 'success');
      } else {
        await createExitProfileMutation.mutateAsync({ key, ...commonFields });
        showMessage(`Exit profile created: ${key}`, 'success');
      }

      setCreatingExitProfile(false);
      setEditingExitProfileId(null);
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : 'Failed to save exit profile.',
        'error'
      );
    }
  }

  return (
    <section>
      <div className="page-header">
        <p className="eyebrow">AI Trader Admin</p>
        <h1>Exit Profiles</h1>
        <p className="muted">View and edit exit profiles.</p>
      </div>

      <section className="card">
        <div className="section-header">
          <h2>Exit Profiles</h2>
          <button className="small-button" onClick={startCreatingExitProfile}>
            New Exit Profile
          </button>
        </div>

        {isError && (
          <p className="error">
            {error instanceof Error
              ? error.message
              : 'Failed to load exit profiles.'}
          </p>
        )}

        {isLoading && <p className="muted">Loading exit profiles...</p>}

        {creatingExitProfile && (
          <ExitProfileEditor
            form={exitProfileForm}
            setForm={setExitProfileForm}
            onSave={handleSaveExitProfile}
            onCancel={cancelExitProfileForm}
            isCreating={true}
          />
        )}

        {!isLoading && !exitProfiles.length && (
          <p className="muted">No exit profiles.</p>
        )}

        {exitProfiles.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Target %</th>
                <th>Stop %</th>
                <th>Trail %</th>
                <th>Max Days</th>
                <th>Mode</th>
                <th>Behavior</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {exitProfiles.map((profile) => (
                <Fragment key={profile.id}>
                  <tr>
                    <td>{profile.key}</td>
                    <td>{profile.targetPct ?? '—'}</td>
                    <td>{profile.stopLossPct ?? '—'}</td>
                    <td>{profile.trailingStopPct ?? '—'}</td>
                    <td>{profile.maxHoldDays ?? '—'}</td>
                    <td>{profile.exitMode}</td>
                    <td>{profile.takeProfitBehavior}</td>
                    <td>{profile.enabled ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        className="small-button secondary"
                        onClick={() => startEditingExitProfile(profile)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>

                  {editingExitProfileId === profile.id && (
                    <tr>
                      <td colSpan={9}>
                        <ExitProfileEditor
                          form={exitProfileForm}
                          setForm={setExitProfileForm}
                          onSave={handleSaveExitProfile}
                          onCancel={cancelExitProfileForm}
                          isCreating={false}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <ToastContainer
        position="top-right"
        autoClose={5000}
        hideProgressBar={false}
        newestOnTop
        closeOnClick
        pauseOnFocusLoss
        draggable
        pauseOnHover
        theme="dark"
      />
    </section>
  );
}

type ExitProfileEditorProps = {
  form: ExitProfileForm;
  setForm: React.Dispatch<React.SetStateAction<ExitProfileForm>>;
  onSave: () => void;
  onCancel: () => void;
  isCreating: boolean;
};

function ExitProfileEditor({
  form,
  setForm,
  onSave,
  onCancel,
  isCreating,
}: ExitProfileEditorProps) {
  return (
    <div className="inline-editor">
      <label>
        <span>Key</span>
        <input
          value={form.key}
          disabled={!isCreating}
          onChange={(event) =>
            setForm((current) => ({ ...current, key: event.target.value }))
          }
        />
      </label>

      <label>
        <span>Name</span>
        <input
          value={form.name}
          onChange={(event) =>
            setForm((current) => ({ ...current, name: event.target.value }))
          }
        />
      </label>

      <label className="wide-field">
        <span>Description</span>
        <input
          value={form.description}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              description: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Target %</span>
        <input
          value={form.targetPct}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              targetPct: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Stop %</span>
        <input
          value={form.stopLossPct}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              stopLossPct: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Trail %</span>
        <input
          value={form.trailingStopPct}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              trailingStopPct: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Max Hold Days</span>
        <input
          value={form.maxHoldDays}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              maxHoldDays: event.target.value,
            }))
          }
        />
      </label>

      <label>
        <span>Exit Mode</span>
        <select
          value={form.exitMode}
          onChange={(event) =>
            setForm((current) => ({ ...current, exitMode: event.target.value }))
          }
        >
          <option value="fixed_target">fixed_target</option>
          <option value="fixed_bracket">fixed_bracket</option>
          <option value="hybrid">hybrid</option>
          <option value="ai_assisted">ai_assisted</option>
        </select>
      </label>

      <label>
        <span>Take Profit Behavior</span>
        <select
          value={form.takeProfitBehavior}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              takeProfitBehavior: event.target.value,
            }))
          }
        >
          <option value="immediate">immediate</option>
          <option value="trail_after_target">trail_after_target</option>
          <option value="ai_confirm">ai_confirm</option>
        </select>
      </label>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={form.enabled}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              enabled: event.target.checked,
            }))
          }
        />
        <span>Enabled</span>
      </label>

      <div className="editor-actions">
        <button className="small-button" onClick={onSave}>
          Save
        </button>
        <button className="small-button secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
