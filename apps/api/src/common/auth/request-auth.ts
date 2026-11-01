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
  tenantId: string | null;
  /** MFA cadastrado e confirmado. Sem ele, só as rotas `@AllowWithoutMfa` respondem. */
  mfaEnabled: boolean;
}

declare module 'express' {
  interface Request {
    auth?: RequestAuth;
  }
}
