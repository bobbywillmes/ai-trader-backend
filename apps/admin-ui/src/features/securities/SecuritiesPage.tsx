import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSecurities } from './hooks';
import { getAdminToken } from '../../lib/api';
import type { SecuritiesQueryParams } from './types';
import './SecuritiesPage.css';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

export function SecuritiesPage() {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('');
  const [industry, setIndustry] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [subscriptionStatus, setSubscriptionStatus] = useState<'all' | 'configured' | 'unconfigured'>('all');

  const query = useMemo<SecuritiesQueryParams>(
    () => ({
      page,
      pageSize,
      search: search || undefined,
      sector: sector || undefined,
      industry: industry || undefined,
      enabled:
        enabledFilter === 'all'
          ? undefined
          : enabledFilter === 'enabled',
      subscriptionStatus,
    }),
    [
      page,
      pageSize,
      search,
      sector,
      industry,
      enabledFilter,
      subscriptionStatus
    ]
  );

  const securitiesQuery = useSecurities(query, getAdminToken());

  // Extract securities data, pagination, and filters from the query result
  const securities = securitiesQuery.data?.data ?? [];
  const pagination = securitiesQuery.data?.pagination;
  const filters = securitiesQuery.data?.filters;

  // Calculate pagination details
  const total = pagination?.total ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const firstResult = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = Math.min(page * pageSize, total);

  function handleApplyFilters() {
    setPage(1);
    setSearch(searchInput.trim());
  }

  function handleClearFilters() {
    setPage(1);
    setSearchInput('');
    setSearch('');
    setSector('');
    setIndustry('');
    setEnabledFilter('all');
    setSubscriptionStatus('all');
  }

  function handlePageSizeChange(nextPageSize: number) {
    setPage(1);
    setPageSize(nextPageSize);
  }

  return (
    <div className="securities-page">
      <div className="page-header">
        <div>
          <h1>Securities</h1>
          <p>Manage the symbol registry for trading.</p>
        </div>
      </div>

      <section className="securities-controls">
        <div className="control-group search-control">
          <label htmlFor="security-search">Search</label>
          <input
            id="security-search"
            type="text"
            value={searchInput}
            placeholder="Symbol or company name"
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                handleApplyFilters();
              }
            }}
          />
        </div>

        <div className="control-group">
          <label htmlFor="security-sector">Sector</label>
          <select
            id="security-sector"
            value={sector}
            onChange={(event) => {
              setPage(1);
              setSector(event.target.value);
            }}
          >
            <option value="">All sectors</option>
            {(filters?.sectors ?? []).map((sectorOption) => (
              <option key={sectorOption} value={sectorOption}>
                {sectorOption}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="security-industry">Industry</label>
          <select
            id="security-industry"
            value={industry}
            onChange={(event) => {
              setPage(1);
              setIndustry(event.target.value);
            }}
          >
            <option value="">All industries</option>
            {(filters?.industries ?? []).map((industryOption) => (
              <option key={industryOption} value={industryOption}>
                {industryOption}
              </option>
            ))}
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="security-status">Status</label>
          <select
            id="security-status"
            value={enabledFilter}
            onChange={(event) => {
              setPage(1);
              setEnabledFilter(
                event.target.value as 'all' | 'enabled' | 'disabled'
              );
            }}
          >
            <option value="all">All statuses</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="security-subscriptions">Subscriptions</label>
          <select
            id="security-subscriptions"
            value={subscriptionStatus}
            onChange={(event) => {
              setPage(1);
              setSubscriptionStatus(
                event.target.value as 'all' | 'configured' | 'unconfigured'
              );
            }}
          >
            <option value="all">All securities</option>
            <option value="configured">Configured only</option>
            <option value="unconfigured">Unconfigured only</option>
          </select>
        </div>

        <div className="control-group">
          <label htmlFor="security-page-size">Rows</label>
          <select
            id="security-page-size"
            value={pageSize}
            onChange={(event) =>
              handlePageSizeChange(Number(event.target.value))
            }
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className="filter-actions">
          <button type="button" onClick={handleApplyFilters}>
            Apply
          </button>

          <button type="button" className="secondary-button" onClick={handleClearFilters}>
            Clear
          </button>
        </div>
      </section>

      <section className="securities-table-card">
        {securitiesQuery.isError && (
          <div className="table-message error-message">
            Failed to load securities.
          </div>
        )}

        <table className="securities-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Name</th>
              <th>Type</th>
              <th>Sector</th>
              <th>Industry</th>
              <th>Subscriptions</th>
              <th>Status</th>
              <th className="actions-column">Actions</th>
            </tr>
          </thead>

          <tbody>
            {securitiesQuery.isLoading ? (
              <tr>
                <td colSpan={8} className="table-message">
                  Loading securities...
                </td>
              </tr>
            ) : securities.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-message">
                  No securities found.
                </td>
              </tr>
            ) : (
              securities.map((security) => (
                <tr key={security.id}>
                  <td className="symbol-cell">{security.symbol}</td>
                  <td>{security.name}</td>
                  <td>
                    <span className="type-pill">
                      {security.assetType}
                    </span>
                  </td>
                  <td>{security.sector ?? '-'}</td>
                  <td>{security.industry ?? '-'}</td>
                  <td>
                    <span
                      className={
                        security.subscriptionCount > 0
                          ? 'subscription-count subscription-count-active'
                          : 'subscription-count subscription-count-none'
                      }
                    >
                      {security.subscriptionCount}
                    </span>
                  </td>
                  <td>
                    <span
                      className={
                        security.enabled
                          ? 'status-pill status-enabled'
                          : 'status-pill status-disabled'
                      }
                    >
                      {security.enabled ? 'Enabled' : 'Disabled'}
                    </span>
                  </td>
                  <td className="actions-column">
                    <Link
                      className="table-link-button"
                      to={`/securities/${security.symbol}`}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <footer className="pagination-bar">
          <div className="pagination-summary">
            Showing {firstResult}-{lastResult} of {total}
          </div>

          <div className="pagination-actions">
            <button
              type="button"
              disabled={page <= 1 || securitiesQuery.isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              Previous
            </button>

            <span>
              Page {page} of {totalPages}
            </span>

            <button
              type="button"
              disabled={page >= totalPages || securitiesQuery.isFetching}
              onClick={() =>
                setPage((current) => Math.min(totalPages, current + 1))
              }
            >
              Next
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}