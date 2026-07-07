export interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  enabled: boolean;
  emailVerifiedAt: Date | null;
  invitedAt: Date | null;
  setupCompletedAt: Date | null;
  pendingSetup: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserTradingAccountAccess {
  id: number;
  tradingAccountId: number;
  displayName: string;
  role: string;
  canView: boolean;
  canPauseTrading: boolean;
  canResumeTrading: boolean;
  canEditRiskSettings: boolean;
  canEditStrategySettings: boolean;
  canEditCredentials: boolean;
  canManageAccess: boolean;
}

export interface AdminUserInviteAccessAssignment {
  tradingAccountId: number;
  role: "OWNER" | "MANAGER" | "VIEWER";
}

export interface CreateAdminUserInvitationInput {
  email: string;
  name?: string | null;
  role: "owner" | "account_manager" | "account_viewer";
  enabled: boolean;
  tradingAccountAccess: AdminUserInviteAccessAssignment[];
}

export interface AdminUserSetupLink {
  adminUserId: number;
  setupToken: string;
  setupPath: string;
  expiresAt: string;
}

export interface CreateAdminUserInvitationResponse {
  adminUser: AdminUser;
  setupLink: AdminUserSetupLink;
}
