import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useSecurities, useSecuritiesSummary } from './hooks';
import { getAdminToken } from '../../lib/api';
import type {
  SecuritiesQueryParams,
  SecuritySortBy,
  SortDirection,
} from './types';
import './SecuritiesPage.css';

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250];

function getNumberParam(
  params: URLSearchParams,
  key: string,
  fallback: number
) {
  const value = Number(params.get(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getStringParam(params: URLSearchParams, key: string) {
  return params.get(key) ?? '';
}

function getEnabledFilterParam(params: URLSearchParams) {
  const value = params.get('status');

  if (value === 'enabled' || value === 'disabled') {
    return value;
  }

  return 'all';
}

function getSubscriptionStatusParam(params: URLSearchParams) {
  const value = params.get('subscriptionStatus');

  if (
    value === 'configured' ||
    value === 'unconfigured' ||
    value === 'all'
  ) {
    return value;
  }

  return 'all';
}

function getSortByParam(params: URLSearchParams): SecuritySortBy {
  const value = params.get('sortBy');

  if (
    value === 'symbol' ||
    value === 'name' ||
    value === 'assetType' ||
    value === 'sector' ||
    value === 'industry' ||
    value === 'enabled' ||
    value === 'subscriptionCount'
  ) {
    return value;
  }

  return 'symbol';
}

function getSortDirectionParam(params: URLSearchParams): SortDirection {
  return params.get('sortDirection') === 'desc' ? 'desc' : 'asc';
}

export function SecuritiesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() => getNumberParam(searchParams, 'page', 1));
  const [pageSize, setPageSize] = useState(() => getNumberParam(searchParams, 'pageSize', 50));
  const [searchInput, setSearchInput] = useState(() => getStringParam(searchParams, 'search'));
  const [search, setSearch] = useState(() => getStringParam(searchParams, 'search'));
  const [sector, setSector] = useState(() => getStringParam(searchParams, 'sector'));
  const [industry, setIndustry] = useState(() => getStringParam(searchParams, 'industry'));
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>(() => getEnabledFilterParam(searchParams));
  const [subscriptionStatus, setSubscriptionStatus] = useState<'all' | 'configured' | 'unconfigured'>(() => getSubscriptionStatusParam(searchParams));
  const [sortBy, setSortBy] = useState<SecuritySortBy>(() => getSortByParam(searchParams)  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => getSortDirectionParam(searchParams));

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
      sortBy,
      sortDirection,
    }),
    [
      page,
      pageSize,
      search,
      sector,
      industry,
      enabledFilter,
      subscriptionStatus,
      sortBy,
      sortDirection,
    ]
  );

  const token = getAdminToken();
  const securitiesQuery = useSecurities(query, token);

  const summaryQuery = useSecuritiesSummary(token);
  const summary = summaryQuery.data?.summary;

  // Extract securities data, pagination, and filters from the query result
  const securities = securitiesQuery.data?.data ?? [];
  const pagination = securitiesQuery.data?.pagination;
  const filters = securitiesQuery.data?.filters;

  // Calculate pagination details
  const total = pagination?.total ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const firstResult = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastResult = Math.min(page * pageSize, total);

  // store the url state (with sorting/filtering) to send to security detail page
  const location = useLocation();
  const returnToSecuritiesUrl = `${location.pathname}${location.search}`;

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

  function applySummaryFilter(
    filter: 'total' | 'enabled' | 'disabled' | 'configured' | 'unconfigured'
  ) {
    setPage(1);

    if (filter === 'total') {
      setEnabledFilter('all');
      setSubscriptionStatus('all');
      return;
    }

    if (filter === 'enabled') {
      setEnabledFilter('enabled');
      setSubscriptionStatus('all');
      return;
    }

    if (filter === 'disabled') {
      setEnabledFilter('disabled');
      setSubscriptionStatus('all');
      return;
    }

    if (filter === 'configured') {
      setEnabledFilter('all');
      setSubscriptionStatus('configured');
      return;
    }

    if (filter === 'unconfigured') {
      setEnabledFilter('all');
      setSubscriptionStatus('unconfigured');
    }
  }

  function handleSort(nextSortBy: SecuritySortBy) {
    setPage(1);

    if (sortBy === nextSortBy) {
      setSortDirection((current) => (current === 'asc' ? 'desc' : 'asc'));
      return;
    }

    setSortBy(nextSortBy);
    setSortDirection('asc');
  }

  function getSortLabel(column: SecuritySortBy) {
    if (sortBy !== column) {
      return '';
    }

    return sortDirection === 'asc' ? ' ↑' : ' ↓';
  }

  useEffect(() => {
    const nextParams = new URLSearchParams();

    if (page !== 1) {
      nextParams.set('page', String(page));
    }

    if (pageSize !== 50) {
      nextParams.set('pageSize', String(pageSize));
    }

    if (search) {
      nextParams.set('search', search);
    }

    if (sector) {
      nextParams.set('sector', sector);
    }

    if (industry) {
      nextParams.set('industry', industry);
    }

    if (enabledFilter !== 'all') {
      nextParams.set('status', enabledFilter);
    }

    if (subscriptionStatus !== 'all') {
      nextParams.set('subscriptionStatus', subscriptionStatus);
    }

    if (sortBy !== 'symbol') {
      nextParams.set('sortBy', sortBy);
    }

    if (sortDirection !== 'asc') {
      nextParams.set('sortDirection', sortDirection);
    }

    setSearchParams(nextParams, { replace: true });

    const availableIndustries = filters?.industries;
    if (!industry || !availableIndustries) {
      return;
    }
    if (!availableIndustries.includes(industry)) {
      setPage(1);
      setIndustry('');
    }
  }, [
    page,
    pageSize,
    search,
    sector,
    industry,
    enabledFilter,
    subscriptionStatus,
    sortBy,
    sortDirection,
    setSearchParams,
    industry,
    filters?.industries,
  ]);

  return (
    <div className="securities-page">
      <div className="page-header">
        <div>
          <h1>Securities</h1>
          <p>Manage the symbol registry for trading.</p>
        </div>
      </div>

      <section className="securities-summary-grid">

        <button
          type="button"
          className={`summary-card summary-card-button ${
            enabledFilter === 'all' && subscriptionStatus === 'all' ? 'summary-card-active' : ''
          }`}
          onClick={() => applySummaryFilter('total')}
        >
          <span>Total Securities</span>
          <strong>{summary?.total ?? '-'}</strong>
        </button>

        <button
          type="button"
          className={`summary-card summary-card-button ${
            enabledFilter === 'enabled' ? 'summary-card-active' : ''
          }`}
          onClick={() => applySummaryFilter('enabled')}
        >
          <span>Enabled</span>
          <strong>{summary?.enabled ?? '-'}</strong>
        </button>

        <button
          type="button"
          className={`summary-card summary-card-button warning-card ${
            enabledFilter === 'disabled' ? 'summary-card-active' : ''
          }`}
          onClick={() => applySummaryFilter('disabled')}
        >
          <span>Disabled</span>
          <strong>{summary?.disabled ?? '-'}</strong>
        </button>

        <button
          type="button"
          className={`summary-card summary-card-button ${
            subscriptionStatus === 'configured' ? 'summary-card-active' : ''
          }`}
          onClick={() => applySummaryFilter('configured')}
        >
          <span>Configured</span>
          <strong>{summary?.configured ?? '-'}</strong>
        </button>

        <button
          type="button"
          className={`summary-card summary-card-button ${
            subscriptionStatus === 'unconfigured' ? 'summary-card-active' : ''
          }`}
          onClick={() => applySummaryFilter('unconfigured')}
        >
          <span>Unconfigured</span>
          <strong>{summary?.unconfigured ?? '-'}</strong>
        </button>

        <article className="summary-card">
          <span>Enabled Subscriptions</span>
          <strong>{summary?.enabledSubscriptions ?? '-'}</strong>
        </article>
      </section>


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
              setIndustry('');
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
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('symbol')}
                >
                  Symbol{getSortLabel('symbol')}
                </button>
              </th>
              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('name')}
                >
                  Name{getSortLabel('name')}
                </button>
              </th>

              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('assetType')}
                >
                  Type{getSortLabel('assetType')}
                </button>
              </th>

              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('sector')}
                >
                  Sector{getSortLabel('sector')}
                </button>
              </th>

              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('industry')}
                >
                  Industry{getSortLabel('industry')}
                </button>
              </th>

              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('subscriptionCount')}
                >
                  Subscriptions{getSortLabel('subscriptionCount')}
                </button>
              </th>

              <th>
                <button
                  type="button"
                  className="sortable-header"
                  onClick={() => handleSort('enabled')}
                >
                  Status{getSortLabel('enabled')}
                </button>
              </th>
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
                      state={{ returnTo: returnToSecuritiesUrl }}
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