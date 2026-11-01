import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '../../generated/prisma/client.js';

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
 * Estado de uma requisição de escrita, visível em qualquer ponto da cadeia assíncrona do handler sem
 * precisar passar parâmetros: a transação do banco e os detalhes de auditoria.
 */
export interface RequestStore {
  tx: Prisma.TransactionClient;
  audit: AuditDetails;
}

export const requestContext = new AsyncLocalStorage<RequestStore>();
