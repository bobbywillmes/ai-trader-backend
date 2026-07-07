export type AdminUser = {
  id: number;
  email: string;
  role: string;
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminAccess = {
  role: string;
  permissions: string[];
  accessibleTradingAccountIds: number[] | null;
};

export type LoginResponse = {
  ok: true;
  token: string;
  tokenType: 'Bearer';
  adminUser: AdminUser;
  access: AdminAccess;
};

export type MeResponse = {
  ok: true;
  adminUser: AdminUser;
  access: AdminAccess;
};

export type SetupAccountAdminUser = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  enabled: boolean;
};

export type SetupAccountTokenResponse = {
  ok: true;
  adminUser: SetupAccountAdminUser;
  expiresAt: string;
};

export type CompleteSetupAccountResponse = {
  ok: true;
  adminUser: SetupAccountAdminUser;
  setupCompletedAt: string;
};
