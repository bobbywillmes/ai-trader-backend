import crypto from 'node:crypto';

import type { ResolvedPlaceOrderInput } from '../validators/place-order.schema.js';

const SUBSCRIPTION_KEY_TOKEN_PREFIX = 'skx';
const SUBSCRIPTION_KEY_HASH_TOKEN_PREFIX = 'skh';
const MAX_CLIENT_ORDER_ID_LENGTH = 128;

function encodeSubscriptionKey(key: string) {
  return Buffer.from(key, 'utf8').toString('hex');
}

function decodeSubscriptionKey(value: string) {
  try {
    return Buffer.from(value, 'hex').toString('utf8');
  } catch {
    return null;
  }
}

function buildTimestampToken(date: Date) {
  return date.toISOString().replace(/[-:.]/g, '').slice(0, 15);
}

export function buildClientOrderId(
  input: ResolvedPlaceOrderInput,
  account: { tradingAccountId: number; environment: 'PAPER' | 'LIVE' }
): string {
  const timestamp = buildTimestampToken(new Date());
  const randomToken = crypto.randomUUID().slice(0, 8);
  const parts = [
    'ai',
    timestamp,
    input.symbol,
    input.side,
    input.orderType,
    `ta${account.tradingAccountId}`,
    account.environment.toLowerCase(),
  ];

  if (input.subscriptionKey) {
    parts.push(
      `${SUBSCRIPTION_KEY_TOKEN_PREFIX}${encodeSubscriptionKey(
        input.subscriptionKey
      )}`
    );
  }

  parts.push(randomToken);

  const clientOrderId = parts.join('-');

  if (clientOrderId.length <= MAX_CLIENT_ORDER_ID_LENGTH) {
    return clientOrderId;
  }

  const subscriptionHash = input.subscriptionKey
    ? crypto
        .createHash('sha256')
        .update(input.subscriptionKey, 'utf8')
        .digest('hex')
        .slice(0, 16)
    : null;
  const compactParts = [
    'ai',
    timestamp,
    input.symbol,
    input.side,
    input.orderType,
    `ta${account.tradingAccountId}`,
    account.environment.toLowerCase(),
  ];

  if (subscriptionHash) {
    compactParts.push(
      `${SUBSCRIPTION_KEY_HASH_TOKEN_PREFIX}${subscriptionHash}`
    );
  }

  compactParts.push(randomToken);

  return compactParts.join('-').slice(0, MAX_CLIENT_ORDER_ID_LENGTH);
}

export function buildSignalEntryClientOrderId(args: {
  signalIdentity: string;
  tradingAccountSubscriptionId: number;
}) {
  const digest = crypto
    .createHash('sha256')
    .update(
      `${args.signalIdentity}:${args.tradingAccountSubscriptionId}`,
      'utf8'
    )
    .digest('hex');

  return `ai-entry-tas${args.tradingAccountSubscriptionId}-${digest}`;
}

export function parseSubscriptionKeyFromClientOrderId(
  clientOrderId: string | null | undefined
) {
  if (!clientOrderId) {
    return null;
  }

  const token = clientOrderId
    .split('-')
    .find((part) => part.startsWith(SUBSCRIPTION_KEY_TOKEN_PREFIX));

  if (!token) {
    return null;
  }

  const encoded = token.slice(SUBSCRIPTION_KEY_TOKEN_PREFIX.length);

  if (!encoded || encoded.length % 2 !== 0 || !/^[\da-f]+$/i.test(encoded)) {
    return null;
  }

  return decodeSubscriptionKey(encoded);
}
