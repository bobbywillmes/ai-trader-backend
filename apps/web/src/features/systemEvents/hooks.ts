import { useQuery } from '@tanstack/react-query';
import { getSecurityActivity } from './api';

export const securityActivityKeys = {
  detail: (symbol: string) => ['securityActivity', symbol] as const,
};

export function useSecurityActivity(symbol: string | undefined, token: string | null) {
  return useQuery({
    queryKey: symbol ? securityActivityKeys.detail(symbol) : ['securityActivity'],
    queryFn: () => getSecurityActivity(symbol as string, token as string),
    enabled: Boolean(symbol && token),
  });
}
