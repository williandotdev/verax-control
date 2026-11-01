import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '../../generated/prisma/client.js';
import type { RequestAuth } from '../auth/request-auth.js';

/** O que um service informa sobre a operação para a trilha de auditoria. */
export interface AuditDetails {
  /** Nome semântico da ação (ex.: `tenant.deactivate`). Sem ele, vale `MÉTODO /rota`. */
  action?: string;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Estado da requisição visível em qualquer ponto da cadeia assíncrona do handler, sem passar parâmetros:
 * a identidade (de onde sai o cliente do escopo, T2.5) e, nas escritas, a transação e a auditoria.
 */
export interface RequestStore {
  auth?: RequestAuth;
  tx?: Prisma.TransactionClient;
  audit?: AuditDetails;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();
