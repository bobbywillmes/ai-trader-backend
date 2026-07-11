import { describe, expect, it } from 'vitest';
import { PlatformRole } from '@prisma/client';
import {
  PLATFORM_ROLE_PERMISSIONS,
  PlatformPermission,
  getPlatformPermissionsForRole,
  isSystemOwnerRole,
  platformRoleHasPermission,
} from './platform-rbac.js';

describe('platform role permissions', () => {
  it('grants the system owner every platform permission', () => {
    expect(PLATFORM_ROLE_PERMISSIONS[PlatformRole.SYSTEM_OWNER]).toEqual(
      Object.values(PlatformPermission),
    );
  });

  it('preserves the operator permission mapping', () => {
    expect(getPlatformPermissionsForRole(PlatformRole.OPERATOR)).toEqual([
      PlatformPermission.TRADING_ACCOUNT_READ,
      PlatformPermission.TRADING_ACCOUNT_WRITE,
      PlatformPermission.TRADING_ACCOUNT_RISK_WRITE,
      PlatformPermission.SUBSCRIPTION_READ,
      PlatformPermission.SUBSCRIPTION_WRITE,
      PlatformPermission.STRATEGY_READ,
      PlatformPermission.EXIT_PROFILE_READ,
      PlatformPermission.REPORTS_READ,
    ]);
  });

  it('preserves the account user permission mapping', () => {
    expect(getPlatformPermissionsForRole(PlatformRole.ACCOUNT_USER)).toEqual([
      PlatformPermission.TRADING_ACCOUNT_READ,
      PlatformPermission.SUBSCRIPTION_READ,
      PlatformPermission.STRATEGY_READ,
      PlatformPermission.EXIT_PROFILE_READ,
      PlatformPermission.REPORTS_READ,
      PlatformPermission.SYSTEM_EVENTS_READ,
    ]);
  });

  it('does not grant legacy admin owner access', () => {
    expect(isSystemOwnerRole('admin')).toBe(false);
    expect(platformRoleHasPermission('admin', PlatformPermission.SYSTEM_SETTINGS_WRITE)).toBe(false);
  });
});
