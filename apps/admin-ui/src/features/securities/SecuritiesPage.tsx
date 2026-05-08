import React, { useState, Fragment } from 'react';
import { toast, ToastContainer } from 'react-toastify';
import { getAdminToken } from '../../lib/api';
import { useSecurities, useCreateSecurity, useUpdateSecurity } from './hooks';
import { ASSET_TYPES } from './types';
import type { Security, SecurityForm } from './types';

const EMPTY_FORM: SecurityForm = {
  symbol: '',
  name: '',
  assetType: 'STOCK',
  sector: '',
  industry: '',
  enabled: true,
};

function securityToForm(security: Security): SecurityForm {
  return {
    symbol: security.symbol,
    name: security.name,
    assetType: security.assetType,
    sector: security.sector ?? '',
    industry: security.industry ?? '',
    enabled: security.enabled,
  };
}

type MessageType = 'success' | 'error' | 'warning' | 'info';

function showMessage(text: string, type: MessageType = 'info') {
  if (type === 'success') { toast.success(text); return; }
  if (type === 'error') { toast.error(text); return; }
  if (type === 'warning') { toast.warning(text); return; }
  toast.info(text);
}

export function SecuritiesPage() {
  const [token] = useState<string | null>(() => getAdminToken());
  const [creatingSecurity, setCreatingSecurity] = useState(false);
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [securityForm, setSecurityForm] = useState<SecurityForm>(EMPTY_FORM);

  const {
    data: securities = [],
    isLoading,
    isError,
    error,
  } = useSecurities(token);

  const createSecurityMutation = useCreateSecurity(token);
  const updateSecurityMutation = useUpdateSecurity(token);

  function startCreatingSecurity() {
    setCreatingSecurity(true);
    setEditingSymbol(null);
    setSecurityForm(EMPTY_FORM);
  }

  function startEditingSecurity(security: Security) {
    setCreatingSecurity(false);
    setEditingSymbol(security.symbol);
    setSecurityForm(securityToForm(security));
  }

  function cancelSecurityForm() {
    setCreatingSecurity(false);
    setEditingSymbol(null);
  }

  async function handleSaveSecurity() {
    const symbol = securityForm.symbol.trim().toUpperCase();
    const name = securityForm.name.trim();

    if (!symbol) {
      showMessage('Symbol is required.', 'error');
      return;
    }

    if (!name) {
      showMessage('Name is required.', 'error');
      return;
    }

    const commonFields = {
      name,
      assetType: securityForm.assetType as Security['assetType'],
      sector: securityForm.sector.trim() || undefined,
      industry: securityForm.industry.trim() || undefined,
      enabled: securityForm.enabled,
    };

    try {
      if (editingSymbol !== null) {
        await updateSecurityMutation.mutateAsync({
          symbol: editingSymbol,
          payload: commonFields,
        });
        showMessage(`Security updated: ${editingSymbol}`, 'success');
      } else {
        await createSecurityMutation.mutateAsync({ symbol, ...commonFields });
        showMessage(`Security added: ${symbol}`, 'success');
      }

      setCreatingSecurity(false);
      setEditingSymbol(null);
    } catch (err) {
      showMessage(
        err instanceof Error ? err.message : 'Failed to save security.',
        'error'
      );
    }
  }

  return (
    <section>
      <div className="page-header">
        <p className="eyebrow">AI Trader Admin</p>
        <h1>Securities</h1>
        <p className="muted">Manage the symbol registry for trading.</p>
      </div>

      <section className="card">
        <div className="section-header">
          <h2>Securities</h2>
          <button className="small-button" onClick={startCreatingSecurity}>
            Add Security
          </button>
        </div>

        {isError && (
          <p className="error">
            {error instanceof Error
              ? error.message
              : 'Failed to load securities.'}
          </p>
        )}

        {isLoading && <p className="muted">Loading securities...</p>}

        {creatingSecurity && (
          <SecurityEditor
            form={securityForm}
            setForm={setSecurityForm}
            onSave={handleSaveSecurity}
            onCancel={cancelSecurityForm}
            isCreating={true}
          />
        )}

        {!isLoading && !securities.length && (
          <p className="muted">No securities.</p>
        )}

        {securities.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Name</th>
                <th>Type</th>
                <th>Sector</th>
                <th>Industry</th>
                <th>Enabled</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {securities.map((security) => (
                <Fragment key={security.symbol}>
                  <tr>
                    <td>{security.symbol}</td>
                    <td>{security.name}</td>
                    <td>{security.assetType}</td>
                    <td>{security.sector ?? '—'}</td>
                    <td>{security.industry ?? '—'}</td>
                    <td>{security.enabled ? 'Yes' : 'No'}</td>
                    <td>
                      <button
                        className="small-button secondary"
                        onClick={() => startEditingSecurity(security)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>

                  {editingSymbol === security.symbol && (
                    <tr>
                      <td colSpan={7}>
                        <SecurityEditor
                          form={securityForm}
                          setForm={setSecurityForm}
                          onSave={handleSaveSecurity}
                          onCancel={cancelSecurityForm}
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

type SecurityEditorProps = {
  form: SecurityForm;
  setForm: React.Dispatch<React.SetStateAction<SecurityForm>>;
  onSave: () => void;
  onCancel: () => void;
  isCreating: boolean;
};

function SecurityEditor({
  form,
  setForm,
  onSave,
  onCancel,
  isCreating,
}: SecurityEditorProps) {
  return (
    <div className="inline-editor">
      <label>
        <span>Symbol</span>
        <input
          value={form.symbol}
          disabled={!isCreating}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              symbol: event.target.value.toUpperCase(),
            }))
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

      <label>
        <span>Asset Type</span>
        <select
          value={form.assetType}
          onChange={(event) =>
            setForm((current) => ({
              ...current,
              assetType: event.target.value,
            }))
          }
        >
          {ASSET_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>

      <label>
        <span>Sector</span>
        <input
          value={form.sector}
          onChange={(event) =>
            setForm((current) => ({ ...current, sector: event.target.value }))
          }
        />
      </label>

      <label>
        <span>Industry</span>
        <input
          value={form.industry}
          onChange={(event) =>
            setForm((current) => ({ ...current, industry: event.target.value }))
          }
        />
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
