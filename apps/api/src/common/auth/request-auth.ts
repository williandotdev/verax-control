/**
 * Identidade autenticada da requisição. Preenchida pela autenticação (E2) a partir da sessão; até lá,
 * toda requisição é anônima. O `tenantId` vem sempre da sessão, nunca do corpo ou da URL (regra 4).
 */
export interface RequestAuth {
  userId: string;
  tenantId: string | null;
  role: string;
}

declare module 'express' {
  interface Request {
    auth?: RequestAuth;
  }
}
