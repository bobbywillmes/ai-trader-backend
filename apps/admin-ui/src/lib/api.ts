const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

const TOKEN_STORAGE_KEY = 'ai_trader_admin_token';

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, message: string, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export function getAdminToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setAdminToken(token: string) {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearAdminToken() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

type ApiRequestOptions = {
  method?: string;
  token?: string | null;
  body?: unknown;
};

function serializeBody(body: unknown): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (
    typeof body === 'string' ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof Blob
  ) {
    return body;
  }

  return JSON.stringify(body);
}

export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {}
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  const body = serializeBody(options.body);

  if (body !== undefined && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  const responseText = await response.text();

  let data: any = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { message: responseText };
    }
  }

  if (!response.ok) {
    throw new Error(data?.message ?? `Request failed with status ${response.status}`);
  }

  return data as T;
}

export async function patchSubscription(
  subscriptionId: number,
  payload: {
    enabled?: boolean;
    sizingValue?: number;
    exitProfileKey?: string;
  },
  token: string
) {
  const res = await fetch(`${API_BASE_URL}/api/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => null);
  console.log('res', res);
  console.log('res.status:', res.status);
  console.log('data:', data);

  if (!res.ok) {
    throw new Error(data?.message ?? `Failed to update subscription. Status: ${res.status}`);
  }

  return data;
}