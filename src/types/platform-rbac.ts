import { PlatformRole } from '@prisma/client';

export { PlatformRole };

export enum PlatformPermission {
  SYSTEM_SETTINGS_READ = 'system.settings.read',
  SYSTEM_SETTINGS_WRITE = 'system.settings.write',
  SYSTEM_SECURITY_READ = 'system.security.read',
  SYSTEM_SECURITY_WRITE = 'system.security.write',
  TRADING_ACCOUNT_READ = 'tradingAccount.read',
  TRADING_ACCOUNT_WRITE = 'tradingAccount.write',
  TRADING_ACCOUNT_RISK_WRITE = 'tradingAccount.risk.write',
  SUBSCRIPTION_READ = 'subscription.read',
  SUBSCRIPTION_WRITE = 'subscription.write',
  STRATEGY_READ = 'strategy.read',
  STRATEGY_WRITE = 'strategy.write',
  EXIT_PROFILE_READ = 'exitProfile.read',
  EXIT_PROFILE_WRITE = 'exitProfile.write',
  REPORTS_READ = 'reports.read',
  SYSTEM_EVENTS_READ = 'systemEvents.read',
}

export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, PlatformPermission[]> = {
  [PlatformRole.SYSTEM_OWNER]: Object.values(PlatformPermission),
  [PlatformRole.OPERATOR]: [
    PlatformPermission.TRADING_ACCOUNT_READ,
    PlatformPermission.TRADING_ACCOUNT_WRITE,
    PlatformPermission.TRADING_ACCOUNT_RISK_WRITE,
    PlatformPermission.SUBSCRIPTION_READ,
    PlatformPermission.SUBSCRIPTION_WRITE,
    PlatformPermission.STRATEGY_READ,
    PlatformPermission.EXIT_PROFILE_READ,
    PlatformPermission.REPORTS_READ,
  ],
  [PlatformRole.ACCOUNT_USER]: [
    PlatformPermission.TRADING_ACCOUNT_READ,
    PlatformPermission.SUBSCRIPTION_READ,
    PlatformPermission.STRATEGY_READ,
    PlatformPermission.EXIT_PROFILE_READ,
    PlatformPermission.REPORTS_READ,
    PlatformPermission.SYSTEM_EVENTS_READ,
  ],
};

export function isSystemOwnerRole(role: PlatformRole | string): boolean {
  return role === PlatformRole.SYSTEM_OWNER;
}

export function getPlatformPermissionsForRole(
  role: PlatformRole | string,
): PlatformPermission[] {
  const validRole = Object.values(PlatformRole).includes(role as PlatformRole)
    ? (role as PlatformRole)
    : PlatformRole.ACCOUNT_USER;

  return PLATFORM_ROLE_PERMISSIONS[validRole];
}

export function platformRoleHasPermission(
  role: PlatformRole | string,
  permission: PlatformPermission | string,
): boolean {
  return getPlatformPermissionsForRole(role).includes(permission as PlatformPermission);
}
