import { alpacaRequest } from './client.js';

export type AlpacaAccountActivity = {
  id: string;
  activity_type?: string;
  type?: string;

  symbol?: string;
  side?: string;

  qty?: string;
  cum_qty?: string;
  leaves_qty?: string;
  price?: string;
  net_amount?: string;

  order_id?: string;
  transaction_time?: string;
  date?: string;

  [key: string]: unknown;
};

type GetAlpacaAccountActivitiesParams = {
  activityType?: string;
  after?: Date | string;
  until?: Date | string;
  date?: Date | string;
  direction?: 'asc' | 'desc';
  pageSize?: number;
  pageToken?: string;
};

function toQueryDate(value: Date | string) {
  return value instanceof Date ? value.toISOString() : value;
}

export async function getAlpacaAccountActivities(
  params: GetAlpacaAccountActivitiesParams = {}
): Promise<AlpacaAccountActivity[]> {
  const path = params.activityType
    ? `/v2/account/activities/${encodeURIComponent(params.activityType)}`
    : '/v2/account/activities';

  const search = new URLSearchParams();

  if (params.after) search.set('after', toQueryDate(params.after));
  if (params.until) search.set('until', toQueryDate(params.until));
  if (params.date) search.set('date', toQueryDate(params.date));
  if (params.direction) search.set('direction', params.direction);
  if (params.pageSize) search.set('page_size', String(params.pageSize));
  if (params.pageToken) search.set('page_token', params.pageToken);

  const query = search.toString();

  return alpacaRequest<AlpacaAccountActivity[]>(
    query ? `${path}?${query}` : path
  );
}