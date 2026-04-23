import { getAlpacaAccount } from '../integrations/alpaca/account.adapter.js';
import { normalizeAccount } from '../integrations/alpaca/normalizers.js';

export async function getNormalizedAccount() {
  const raw = await getAlpacaAccount();
  return normalizeAccount(raw);
}