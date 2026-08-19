import {
  isIsolatedManualAcceptanceEnvironment,
  type ManualAcceptanceEnvironmentInput,
} from '../../src/services/manual-acceptance-environment.js';

type RuntimeSettingsTransaction = {
  setting: {
    upsert(args: unknown): Promise<unknown>;
  };
};

type RuntimeSettingsDb = {
  $transaction<T>(operation: (tx: RuntimeSettingsTransaction) => Promise<T>): Promise<T>;
};

const ACCEPTANCE_RUNTIME_SETTINGS = [
  ['tradingEnabled', 'true'],
  ['killSwitchEnabled', 'false'],
] as const;

export async function enforceManualAcceptanceRuntimeSettings(
  db: RuntimeSettingsDb,
  environment: ManualAcceptanceEnvironmentInput,
) {
  if (!isIsolatedManualAcceptanceEnvironment(environment)) {
    throw new Error(
      'Manual acceptance runtime settings require the exact isolated harness environment.',
    );
  }

  await db.$transaction(async (tx) => {
    for (const [key, value] of ACCEPTANCE_RUNTIME_SETTINGS) {
      await tx.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    }
  });

  return Object.fromEntries(ACCEPTANCE_RUNTIME_SETTINGS);
}
