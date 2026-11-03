import { z } from 'zod';
import { withPagination } from './pagination.js';

/** Papéis que um usuário de cliente pode ter. `admin_verax` nunca é atribuído por esta gestão. */
export const TENANT_ROLES = ['admin_cliente', 'analista_cliente', 'leitura'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/** `invited` é de contas criadas pelo convite por e-mail, antes da senha temporária; contas novas já nascem `active`. */
export const USER_STATUSES = ['invited', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Validade da senha temporária: depois disso, o login com ela não abre sessão, e o administrador gera outra. */
export const TEMPORARY_PASSWORD_HOURS = 72;

/** Código da API para a sessão com senha temporária: ela só alcança a troca de senha. */
export const PASSWORD_CHANGE_REQUIRED_CODE = 'PASSWORD_CHANGE_REQUIRED';

/**
 * Novo usuário (T3.2): o cliente vem da sessão. A conta nasce com uma senha temporária, mostrada uma vez a quem criou;
 * no primeiro login, a pessoa troca a senha e cadastra o MFA.
 */
export const userCreateSchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
  role: z.enum(TENANT_ROLES),
});
export type UserCreate = z.infer<typeof userCreateSchema>;

/** Senha temporária, devolvida só na resposta que a gera (nunca gravada em texto, nunca relida). */
export const temporaryPasswordSchema = z.strictObject({
  temporaryPassword: z.string().min(16).max(64),
  expiresAt: z.iso.datetime(),
});
export type TemporaryPassword = z.infer<typeof temporaryPasswordSchema>;

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
  /** Ainda com a senha temporária (não entrou nem trocou). */
  mustChangePassword: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type User = z.infer<typeof userSchema>;

export const userCreatedSchema = z.strictObject({
  user: userSchema,
  ...temporaryPasswordSchema.shape,
});
export type UserCreated = z.infer<typeof userCreatedSchema>;
