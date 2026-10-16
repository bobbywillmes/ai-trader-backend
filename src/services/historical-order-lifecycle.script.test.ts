import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  parseHistoricalOrderLifecycleArgs,
  runHistoricalOrderLifecycleCli,
} from './historical-order-lifecycle-cli.service.js';

describe('historical order lifecycle diagnostic CLI', () => {
  it('supports normal read-only diagnostic invocation', async () => {
    const diagnose = vi.fn().mockResolvedValue({ candidates: [] });
    const close = vi.fn().mockResolvedValue(undefined);

    await expect(
      runHistoricalOrderLifecycleCli(
        ['--trading-account-id=17'],
        async () => ({ diagnose, close })
      )
    ).resolves.toEqual({ candidates: [] });
    expect(diagnose).toHaveBeenCalledWith(17);
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects --apply even with the former confirmation phrase before loading database or broker dependencies', async () => {
    const dependencyLoader = vi.fn();

    await expect(
      runHistoricalOrderLifecycleCli(
        [
          '--trading-account-id=17',
          '--apply',
          '--confirmation=REPAIR HISTORICAL ORDER LIFECYCLE',
        ],
        dependencyLoader
      )
    ).rejects.toThrow('--apply is no longer supported');
    expect(dependencyLoader).not.toHaveBeenCalled();
  });

  it('rejects the retired confirmation option on its own', () => {
    expect(() =>
      parseHistoricalOrderLifecycleArgs([
        '--trading-account-id=17',
        '--confirmation=REPAIR HISTORICAL ORDER LIFECYCLE',
      ])
    ).toThrow('--confirmation is no longer supported');
  });

  it('exposes no supported package path to the retired mutation service', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve('package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    const script = readFileSync(
      resolve('scripts/historical-order-lifecycle.ts'),
      'utf8'
    );

    expect(packageJson.scripts['diagnose:historical-order-lifecycle']).toBe(
      'tsx scripts/historical-order-lifecycle.ts'
    );
    expect(script).toContain('historical-order-lifecycle-cli.service');
    expect(script).not.toContain('historical-order-lifecycle-repair.service');
    expect(script).not.toContain('repairHistoricalOrderLifecycle');
  });
});
