export type Strategy = {
  id: number;
  key: string;
  name: string;
  description: string | null;
  allowedSymbolsJson?: unknown;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
};
