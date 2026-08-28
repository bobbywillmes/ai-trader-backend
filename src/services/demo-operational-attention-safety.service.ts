export function assertDemoOperationalAttentionSafety(args: { nodeEnv: string; deploymentRole: string; accountEnvironment: string; accountId: number }) {
  if (args.nodeEnv === 'production') throw new Error('Demo attention is refused in production.');
  if (args.deploymentRole === 'PRODUCTION_EXECUTOR') throw new Error('Demo attention is refused in production-executor mode.');
  if (args.accountEnvironment !== 'PAPER') throw new Error('Demo attention requires an explicit PAPER account.');
  if (!Number.isInteger(args.accountId) || args.accountId <= 0) throw new Error('A positive PAPER account ID is required.');
}
