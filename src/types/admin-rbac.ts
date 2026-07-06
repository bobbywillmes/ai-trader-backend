/**
 * Admin RBAC: Role-based access control for human Admin UI users.
 * This defines the vocabulary and mappings for admin roles and permissions.
 */

export enum AdminRole {
  OWNER = 'owner',
  ACCOUNT_MANAGER = 'account_manager',
  ACCOUNT_VIEWER = 'account_viewer',
}

export enum AdminPermission {
  // System settings
  SYSTEM_SETTINGS_READ = 'system.settings.read',
  SYSTEM_SETTINGS_WRITE = 'system.settings.write',

  // System security
  SYSTEM_SECURITY_READ = 'system.security.read',
  SYSTEM_SECURITY_WRITE = 'system.security.write',

  // Trading accounts
  TRADING_ACCOUNT_READ = 'tradingAccount.read',
  TRADING_ACCOUNT_WRITE = 'tradingAccount.write',
  TRADING_ACCOUNT_RISK_WRITE = 'tradingAccount.risk.write',

  // Subscriptions
  SUBSCRIPTION_READ = 'subscription.read',
  SUBSCRIPTION_WRITE = 'subscription.write',

  // Strategies
  STRATEGY_READ = 'strategy.read',
  STRATEGY_WRITE = 'strategy.write',

  // Exit profiles
  EXIT_PROFILE_READ = 'exitProfile.read',
  EXIT_PROFILE_WRITE = 'exitProfile.write',

  // Reports
  REPORTS_READ = 'reports.read',

  // System events / audit
  SYSTEM_EVENTS_READ = 'systemEvents.read',
}

/**
 * Maps each admin role to its permitted actions.
 * Owner has all permissions by default.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, AdminPermission[]> = {
  [AdminRole.OWNER]: [
    // Owner has unrestricted access to all permissions
    AdminPermission.SYSTEM_SETTINGS_READ,
    AdminPermission.SYSTEM_SETTINGS_WRITE,
    AdminPermission.SYSTEM_SECURITY_READ,
    AdminPermission.SYSTEM_SECURITY_WRITE,
    AdminPermission.TRADING_ACCOUNT_READ,
    AdminPermission.TRADING_ACCOUNT_WRITE,
    AdminPermission.TRADING_ACCOUNT_RISK_WRITE,
    AdminPermission.SUBSCRIPTION_READ,
    AdminPermission.SUBSCRIPTION_WRITE,
    AdminPermission.STRATEGY_READ,
    AdminPermission.STRATEGY_WRITE,
    AdminPermission.EXIT_PROFILE_READ,
    AdminPermission.EXIT_PROFILE_WRITE,
    AdminPermission.REPORTS_READ,
    AdminPermission.SYSTEM_EVENTS_READ,
  ],

  [AdminRole.ACCOUNT_MANAGER]: [
    // Account managers can read broadly and manage trading accounts they own
    AdminPermission.TRADING_ACCOUNT_READ,
    AdminPermission.TRADING_ACCOUNT_WRITE,
    AdminPermission.TRADING_ACCOUNT_RISK_WRITE,
    AdminPermission.SUBSCRIPTION_READ,
    AdminPermission.SUBSCRIPTION_WRITE,
    AdminPermission.STRATEGY_READ,
    AdminPermission.EXIT_PROFILE_READ,
    AdminPermission.REPORTS_READ,
  ],

  [AdminRole.ACCOUNT_VIEWER]: [
    // Account viewers can only read data
    AdminPermission.TRADING_ACCOUNT_READ,
    AdminPermission.SUBSCRIPTION_READ,
    AdminPermission.STRATEGY_READ,
    AdminPermission.EXIT_PROFILE_READ,
    AdminPermission.REPORTS_READ,
    AdminPermission.SYSTEM_EVENTS_READ,
  ],
};

/**
 * Get all permissions for a given role.
 */
export function getPermissionsForRole(role: AdminRole | string): AdminPermission[] {
  const validRole = Object.values(AdminRole).includes(role as AdminRole)
    ? (role as AdminRole)
    : AdminRole.ACCOUNT_VIEWER;

  return ROLE_PERMISSIONS[validRole] || [];
}

/**
 * Check if a role has a specific permission.
 */
export function roleHasPermission(
  role: AdminRole | string,
  permission: AdminPermission | string,
): boolean {
  const permissions = getPermissionsForRole(role);
  return permissions.includes(permission as AdminPermission);
}
