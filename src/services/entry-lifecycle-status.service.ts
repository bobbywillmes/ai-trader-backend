import type { Prisma } from '@prisma/client';

export const UNRESOLVED_ORDER_INTENT_STATUSES = [
  'received',
  'pending',
  'submitting',
  'submitted',
] as const;

export const BROKER_ACTIVE_ENTRY_STATUSES = [
  'received',
  'pending',
  'submitting',
  'submitted',
  'new',
  'accepted',
  'pending_new',
  'accepted_for_bidding',
  'held',
  'pending_cancel',
  'pending_replace',
  'partially_filled',
  'stopped',
  'suspended',
] as const;

export const TERMINAL_ENTRY_ORDER_STATUSES = [
  'filled',
  'canceled',
  'cancelled',
  'expired',
  'rejected',
  'replaced',
  'done_for_day',
  'calculated',
] as const;

export const CLAIM_STATUSES = [
  'ENTRY_PENDING',
  'ENTRY_SUBMITTING',
  'BROKER_ORDER_ACTIVE',
  'PARTIALLY_FILLED',
  'FILLED_AWAITING_POSITION',
  'POSITION_OPEN',
  'POSITION_CLOSING',
  'ADMISSION_BLOCKED',
  'UNRESOLVED',
  'RELEASED',
] as const;

export type EntryExposureClaimStatus = typeof CLAIM_STATUSES[number];

const transitions: Record<EntryExposureClaimStatus, ReadonlySet<EntryExposureClaimStatus>> = {
  ENTRY_PENDING: new Set(['ENTRY_SUBMITTING', 'ADMISSION_BLOCKED', 'UNRESOLVED', 'RELEASED']),
  ENTRY_SUBMITTING: new Set(['BROKER_ORDER_ACTIVE', 'UNRESOLVED', 'RELEASED']),
  BROKER_ORDER_ACTIVE: new Set(['PARTIALLY_FILLED', 'FILLED_AWAITING_POSITION', 'POSITION_OPEN', 'UNRESOLVED', 'RELEASED']),
  PARTIALLY_FILLED: new Set(['FILLED_AWAITING_POSITION', 'POSITION_OPEN', 'UNRESOLVED', 'RELEASED']),
  FILLED_AWAITING_POSITION: new Set(['POSITION_OPEN', 'UNRESOLVED', 'RELEASED']),
  POSITION_OPEN: new Set(['POSITION_CLOSING', 'UNRESOLVED', 'RELEASED']),
  POSITION_CLOSING: new Set(['POSITION_OPEN', 'UNRESOLVED', 'RELEASED']),
  ADMISSION_BLOCKED: new Set(['UNRESOLVED', 'RELEASED']),
  UNRESOLVED: new Set(),
  RELEASED: new Set(),
};

export function isEntryExposureClaimStatus(value: string): value is EntryExposureClaimStatus {
  return (CLAIM_STATUSES as readonly string[]).includes(value);
}

export function canTransitionEntryExposureClaim(from: string, to: string) {
  return from === to ||
    (isEntryExposureClaimStatus(from) && isEntryExposureClaimStatus(to) && transitions[from].has(to));
}

export function isBuyIntent(intent: { side: string; rawRequestJson?: Prisma.JsonValue }) {
  return intent.side.trim().toLowerCase() === 'buy';
}

export function isSellIntent(intent: { side: string; rawRequestJson?: Prisma.JsonValue }) {
  return intent.side.trim().toLowerCase() === 'sell';
}
