import type { UserRole } from '../../generated/prisma/client.js';

/**
 * Identidade autenticada da requisição, montada pelo `SessionGuard` a partir da sessão. O `tenantId` vem
 * sempre da sessão, nunca do corpo ou da URL (regra 4).
 */
export interface RequestAuth {
  sessionId: string;
  userId: string;
  email: string;
  role: UserRole;
  /** Cliente ao qual o usuário pertence (null para admin_verax). */
  tenantId: string | null;
  /** Cliente selecionado na sessão por um admin_verax (POST /v1/session/tenant). */
  activeTenantId: string | null;
  /**
   * Cliente cujos dados a requisição pode acessar: o próprio, para papéis de cliente; o selecionado, para
   * admin_verax. Null quando admin_verax ainda não escolheu um cliente.
   */
  scopeTenantId: string | null;
  /** MFA cadastrado e confirmado. Sem ele, só as rotas `@AllowWithoutMfa` respondem. */
  mfaEnabled: boolean;
  /** Entrou com a senha temporária: só as rotas `@AllowWithTemporaryPassword` (e a troca de senha) respondem. */
  mustChangePassword: boolean;
}

declare module 'express' {
  interface Request {
    auth?: RequestAuth;
  }
}
