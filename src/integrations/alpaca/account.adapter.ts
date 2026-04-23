import { alpacaRequest } from './client.js';
import type { AlpacaAccount } from './alpaca.types.js';

export async function getAlpacaAccount(): Promise<AlpacaAccount> {
  return alpacaRequest<AlpacaAccount>('/v2/account');
}