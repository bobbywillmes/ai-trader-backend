export interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  enabled: boolean;
  emailVerifiedAt: Date | null;
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
