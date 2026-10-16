const RETIRED_MUTATION_OPTIONS = ['--apply', '--confirmation'] as const;

export type HistoricalOrderLifecycleCliDependencies = {
  diagnose(tradingAccountId: number): Promise<unknown>;
  close(): Promise<void>;
};

function option(argv: string[], name: string) {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function parseHistoricalOrderLifecycleArgs(argv: string[]) {
  const retiredOption = argv.find((value) =>
    RETIRED_MUTATION_OPTIONS.some(
      (name) => value === name || value.startsWith(`${name}=`)
    )
  );
  if (retiredOption) {
    throw new Error(
      `${retiredOption.split('=')[0]} is no longer supported. Historical lifecycle diagnosis is read-only; use the authorized Lifecycle Repair Workbench for repairs.`
    );
  }

  const parsed = Number(option(argv, 'trading-account-id'));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('--trading-account-id=<positive integer> is required.');
  }
  return { tradingAccountId: parsed };
}

async function loadDependencies(): Promise<HistoricalOrderLifecycleCliDependencies> {
  const [{ prisma }, diagnostic, workflowLock] = await Promise.all([
    import('../db/prisma.js'),
    import('./historical-order-lifecycle-diagnostic.service.js'),
    import('./trading-account-workflow-lock.service.js'),
  ]);
  return {
    diagnose: (tradingAccountId) =>
      diagnostic.diagnoseHistoricalOrderLifecycle({ tradingAccountId }),
    close: async () => {
      await prisma.$disconnect();
      await workflowLock.closeTradingAccountWorkflowLockPool();
    },
  };
}

export async function runHistoricalOrderLifecycleCli(
  argv: string[],
  dependencyLoader: () => Promise<HistoricalOrderLifecycleCliDependencies> =
    loadDependencies
) {
  // Validate retired mutation arguments before importing modules that can
  // initialize database pools or broker clients.
  const args = parseHistoricalOrderLifecycleArgs(argv);
  const dependencies = await dependencyLoader();
  try {
    return await dependencies.diagnose(args.tradingAccountId);
  } finally {
    await dependencies.close();
  }
}
