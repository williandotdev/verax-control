import { z } from 'zod';
import { withPagination } from './pagination.js';

/** Papéis que um usuário de cliente pode ter. `admin_verax` nunca é atribuído por esta gestão. */
export const TENANT_ROLES = ['admin_cliente', 'analista_cliente', 'leitura'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Convite (T3.2): o cliente vem da sessão; o usuário define a senha pelo link e cadastra o MFA no primeiro login. */
export const userInviteSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(TENANT_ROLES),
});
export type UserInvite = z.infer<typeof userInviteSchema>;

/** Troca de papel e (re)ativação. Ninguém altera o próprio acesso. */
export const userUpdateSchema = z
  .strictObject({
    role: z.enum(TENANT_ROLES).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type UserUpdate = z.infer<typeof userUpdateSchema>;

export const userListQuerySchema = withPagination({ status: z.enum(USER_STATUSES).optional() });
export type UserListQuery = z.infer<typeof userListQuerySchema>;

export const userSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  email: z.string(),
  role: z.enum(TENANT_ROLES),
  status: z.enum(USER_STATUSES),
  mfaEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;
