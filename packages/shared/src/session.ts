import { z } from 'zod';
import { PERMISSIONS, type Permission, ROLES } from './permissions.js';

const permissionNames = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];

/** Resposta de `GET /v1/me`: a identidade da sessão, validada pelo painel antes de usar. */
export const meSchema = z.strictObject({
  userId: z.string().min(1),
  email: z.email(),
  role: z.enum(ROLES),
  /** Cliente ao qual o usuário pertence (null para admin_verax). */
  tenantId: z.uuid().nullable(),
  /** Cliente selecionado na sessão por um admin_verax. */
  activeTenantId: z.uuid().nullable(),
  /** Cliente cujos dados a sessão enxerga. */
  scopeTenantId: z.uuid().nullable(),
  mfaEnabled: z.boolean(),
  /** Entrou com a senha temporária: precisa trocá-la antes de tudo (depois, o MFA). */
  mustChangePassword: z.boolean(),
  permissions: z.array(z.enum(permissionNames)),
});
export type Me = z.infer<typeof meSchema>;

export const switchTenantResponseSchema = z.strictObject({ activeTenantId: z.uuid() });

/** Resposta de `GET /v1/auth/client-config`: o que o painel precisa saber antes do login. Nada aqui é segredo. */
export const authClientConfigSchema = z.strictObject({
  /** Chave do site do Cloudflare Turnstile; `null` com o desafio desligado (os formulários funcionam sem ele). */
  turnstileSiteKey: z.string().min(1).nullable(),
});
export type AuthClientConfig = z.infer<typeof authClientConfigSchema>;
