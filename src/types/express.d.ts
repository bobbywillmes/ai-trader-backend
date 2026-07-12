import type { User, UserSession } from '@prisma/client';

type AuthenticatedUser = Pick<
  User,
  'id' | 'email' | 'platformRole' | 'enabled' | 'createdAt' | 'updatedAt'
> &
  Partial<Pick<User, 'name' | 'passwordHash'>>;

declare global {
  namespace Express {
    interface Locals {
      user?: AuthenticatedUser;
      userSession?: UserSession & { user: User };
      isStaticAdminKey?: boolean;
      authorizedTradingAccountId?: number;
    }
  }
}

export {};
