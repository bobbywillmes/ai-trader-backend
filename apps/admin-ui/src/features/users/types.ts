import type { PlatformRole } from "../auth/types";

export type User = {
  id: number;
  email: string;
  name: string | null;
  platformRole: PlatformRole;
  enabled: boolean;
  emailVerifiedAt: string | null;
  invitedAt: string | null;
  setupCompletedAt: string | null;
  pendingSetup: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TradingAccountMembership = {
  id: number;
  tradingAccountId: number;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateUserInvitationInput = {
  email: string;
  name?: string | null;
  platformRole: PlatformRole;
  enabled: boolean;
  tradingAccountIds: number[];
};

export type UpdateUserInput = {
  name?: string | null;
  platformRole?: PlatformRole;
  enabled?: boolean;
};

export type ReplaceTradingAccountMembershipsInput = {
  tradingAccountIds: number[];
};

export type UserSetupLink = {
  userId: number;
  setupToken: string;
  setupPath: string;
  expiresAt: string;
};

export type CreateUserInvitationResponse = {
  user: User;
  setupLink: UserSetupLink;
};
