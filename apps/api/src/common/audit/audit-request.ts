import type { Request } from 'express';
import type { AuditDetails } from '../context/request-context.js';
import type { AuditActor, AuditEntry } from './audit.service.js';

/** Métodos auditados: toda escrita, inclusive as recusadas. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type RequestEntry = Omit<AuditEntry, 'outcome' | 'statusCode'>;

function resolveActor(request: Request): AuditActor {
  const auth = request.auth;
  if (!auth) return { type: 'anonymous' };
  // Usuário de cliente: a trilha do próprio cliente. admin_verax: nenhuma, até a operação tocar dados de um
  // cliente (ver `withDetails`). Selecionar um cliente na sessão não basta: uma operação global da Verax
  // feita com o cliente A selecionado não pode aparecer na trilha de A.
  return { type: 'user', id: auth.userId, tenantId: auth.role === 'admin_verax' ? null : auth.tenantId };
}

function routeOf(request: Request): string {
  const route = (request.route as { path?: unknown } | undefined)?.path;
  return typeof route === 'string' ? route : request.path;
}

/** Junta ao registro o que o service informou; o cliente informado vale no lugar do padrão. */
export function withDetails(entry: RequestEntry, details: AuditDetails): RequestEntry {
  const { tenantId, ...rest } = details;
  return { ...entry, ...rest, actor: tenantId === undefined ? entry.actor : { ...entry.actor, tenantId } };
}

/** Quem, o quê e de onde: a parte do registro de auditoria que vem da própria requisição. */
export function requestEntry(request: Request & { id?: unknown }): RequestEntry {
  return {
    actor: resolveActor(request),
    action: `${request.method} ${routeOf(request)}`,
    resourceId: typeof request.params['id'] === 'string' ? request.params['id'] : undefined,
    ip: request.ip,
    userAgent: request.get('user-agent'),
    requestId: typeof request.id === 'string' ? request.id : undefined,
  };
}
