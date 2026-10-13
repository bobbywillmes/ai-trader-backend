export async function acceptanceBrokerTransport(): Promise<never> {
  throw new Error('UI_ACCEPTANCE_BROKER_TRANSPORT_BLOCKED_BEFORE_NETWORK');
}
