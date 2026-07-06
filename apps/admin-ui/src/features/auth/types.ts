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
