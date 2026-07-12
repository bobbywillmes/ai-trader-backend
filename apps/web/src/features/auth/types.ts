export type PlatformRole = "SYSTEM_OWNER" | "OPERATOR" | "ACCOUNT_USER";

export type PlatformPermission =
  | "system.settings.read"
  | "system.settings.write"
  | "system.security.read"
  | "system.security.write"
  | "tradingAccount.read"
  | "tradingAccount.write"
  | "tradingAccount.risk.write"
  | "subscription.read"
  | "subscription.write"
  | "strategy.read"
  | "strategy.write"
  | "exitProfile.read"
  | "exitProfile.write"
  | "reports.read"
  | "systemEvents.read";

export type User = {
  id: number;
  email: string;
  name: string | null;
  platformRole: PlatformRole;
  enabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccessMetadata = {
  platformRole: PlatformRole;
  permissions: PlatformPermission[];
  accessibleTradingAccountIds: number[] | null;
};

export type UserSession = {
  id: number;
  userId: number;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
};

export type LoginResponse = {
  ok: true;
  token: string;
  tokenType: 'Bearer';
  user: User;
  access: AccessMetadata;
  session: UserSession;
};

export type MeResponse = {
  ok: true;
  user: User;
  access: AccessMetadata;
  session: UserSession;
};

export type SetupAccountTokenResponse = {
  ok: true;
  user: Pick<User, "id" | "email" | "name" | "platformRole" | "enabled">;
  expiresAt: string;
};

export type CompleteSetupAccountResponse = {
  ok: true;
  user: Pick<User, "id" | "email" | "name" | "platformRole" | "enabled">;
  setupCompletedAt: string;
};
