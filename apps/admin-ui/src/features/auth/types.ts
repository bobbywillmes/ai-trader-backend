export type AdminUser = {
  id: number;
  email: string;
  role: string;
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LoginResponse = {
  ok: true;
  token: string;
  tokenType: 'Bearer';
  adminUser: AdminUser;
};

export type MeResponse = {
  ok: true;
  adminUser: AdminUser;
};
