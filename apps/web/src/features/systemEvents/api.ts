import { apiRequest } from '../../lib/api';
import type { SecurityActivityResponse } from './types';

export function getSecurityActivity(
  symbol: string,
  token: string
): Promise<SecurityActivityResponse> {
  return apiRequest<SecurityActivityResponse>(
    `/api/system-events/security-activity/${encodeURIComponent(symbol)}?limit=10`,
    { token }
  );
}
