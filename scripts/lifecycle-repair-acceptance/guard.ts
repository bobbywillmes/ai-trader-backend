export const LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE = 'ai_trader_lifecycle_repair_acceptance';
export const LIFECYCLE_REPAIR_ACCEPTANCE_SENTINEL = 'I_UNDERSTAND_THIS_IS_DISPOSABLE_LIFECYCLE_REPAIR_DATA';

export function assertLifecycleRepairAcceptanceEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  if (environment.LIFECYCLE_REPAIR_ACCEPTANCE !== LIFECYCLE_REPAIR_ACCEPTANCE_SENTINEL) {
    throw new Error('Lifecycle repair acceptance requires its explicit sentinel.');
  }
  const source = environment.DATABASE_URL ?? '';
  if (!source) throw new Error('DATABASE_URL is required.');
  const url = new URL(source);
  if (url.pathname !== `/${LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE}`) {
    throw new Error(`Lifecycle repair acceptance refuses every database except ${LIFECYCLE_REPAIR_ACCEPTANCE_DATABASE}.`);
  }
  return url;
}
