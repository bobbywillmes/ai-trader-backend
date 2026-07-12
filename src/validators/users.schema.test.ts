import { describe, expect, it } from 'vitest';
import { PlatformRole } from '@prisma/client';
import { createUserInvitationSchema, updateUserSchema } from './users.schema.js';

describe('users validators', () => {
  it('defaults invitations to account users with no memberships', () => {
    expect(createUserInvitationSchema.parse({ email: 'USER@EXAMPLE.COM' })).toEqual({
      email: 'user@example.com', platformRole: PlatformRole.ACCOUNT_USER, enabled: true, tradingAccountIds: [],
    });
  });

  it('rejects invalid platform roles and empty updates', () => {
    expect(() => createUserInvitationSchema.parse({ email: 'a@b.com', platformRole: 'owner' })).toThrow();
    expect(() => updateUserSchema.parse({})).toThrow();
  });
});
