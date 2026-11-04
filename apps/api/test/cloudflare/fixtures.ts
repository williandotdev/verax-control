import { randomBytes } from 'node:crypto';

/**
 * Entradas da auditoria v2 do Cloudflare no formato da resposta oficial de `GET /accounts/{account_id}/logs/audit`
 * (`account`, `action`, `actor`, `raw`, `resource`, `zone`), com valores fictícios gerados na hora: nenhuma conta,
 * zona, token ou pessoa real (regra 10 do `CLAUDE.md`). E-mails em `exemplo.com.br`, IPs das faixas de documentação.
 */

export const hex = (bytes: number) => randomBytes(bytes).toString('hex');

export interface AuditFixture {
  id?: string;
  accountId: string;
  time?: string;
  type?: string;
  description?: string;
  result?: string;
  method?: string;
  uri?: string;
  statusCode?: number;
  actor?: Partial<{
    id: string;
    context: string;
    email: string | null;
    ip_address: string;
    token_id: string;
    token_name: string;
    type: string;
  }>;
  product?: string;
  resourceType?: string;
  resourceId?: string;
  request?: unknown;
  response?: unknown;
  /** `null` tira a zona (ação da conta). */
  zone?: { id: string; name: string } | null;
}

/** Tipo da ação pelo método, como a auditoria registra. */
function actionType(method: string): string {
  switch (method) {
    case 'POST':
      return 'create';
    case 'DELETE':
      return 'delete';
    case 'GET':
      return 'view';
    default:
      return 'update';
  }
}

export function auditLogEntry(fixture: AuditFixture): Record<string, unknown> {
  const method = fixture.method ?? 'POST';
  const zone = fixture.zone === undefined ? { id: hex(16), name: 'loja.exemplo.com.br' } : fixture.zone;
  return {
    id: fixture.id ?? hex(16),
    account: { id: fixture.accountId, name: 'Conta fictícia' },
    action: {
      description: fixture.description ?? 'Ação fictícia',
      result: fixture.result ?? 'success',
      time: fixture.time ?? '2026-11-04T12:00:00Z',
      type: fixture.type ?? actionType(method),
    },
    actor: {
      id: hex(16),
      context: 'dash',
      email: 'pessoa@exemplo.com.br',
      ip_address: '203.0.113.10',
      type: 'user',
      ...fixture.actor,
    },
    raw: {
      cf_ray_id: hex(8),
      method,
      status_code: fixture.statusCode ?? 200,
      uri: fixture.uri ?? `/accounts/${fixture.accountId}`,
      user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15',
    },
    resource: {
      id: fixture.resourceId ?? hex(16),
      product: fixture.product ?? 'fictício',
      request: fixture.request ?? {},
      response: fixture.response ?? {},
      scope: {},
      type: fixture.resourceType ?? 'fictício',
    },
    ...(zone !== null && { zone }),
  };
}

/** Atalho: a mesma conta e zona em todas as entradas de um teste. */
export function entryFactory(accountId: string, zone: { id: string; name: string } | null = null) {
  return (fixture: Omit<AuditFixture, 'accountId'>) =>
    auditLogEntry({ ...(zone !== null && { zone }), ...fixture, accountId });
}
