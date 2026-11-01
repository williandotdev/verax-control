import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Models com dado de cliente (coluna `tenantId`). Todo acesso a eles numa requisição de usuário passa pelo
 * escopo do cliente. O meta-teste lê o `schema.prisma` e falha se um model com `tenantId` ficar fora daqui.
 */
export const TENANT_SCOPED_MODELS = ['user', 'auditLog'] as const;
export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const SCOPED = new Set<string>(TENANT_SCOPED_MODELS);

/** Operações que filtram por `where`. */
const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);
const KNOWN_OPERATIONS = new Set([...WHERE_OPERATIONS, ...CREATE_OPERATIONS, 'upsert']);

/** SQL cru escapa do filtro; dentro do escopo do cliente ele não existe. */
const BLOCKED_CLIENT_METHODS = new Set([
  '$queryRaw',
  '$queryRawUnsafe',
  '$executeRaw',
  '$executeRawUnsafe',
  '$queryRawTyped',
  '$runCommandRaw',
]);

export class TenantScopeViolation extends Error {}

type Args = Record<string, unknown>;

function assertTenantNotChanged(data: unknown, tenantId: string): void {
  if (typeof data !== 'object' || data === null) return;
  const record = data as Record<string, unknown>;
  if ('tenant' in record) throw new TenantScopeViolation('relação com cliente não pode vir na escrita');
  if ('tenantId' in record && record['tenantId'] !== tenantId) {
    throw new TenantScopeViolation('tentativa de gravar dado em outro cliente');
  }
}

function withTenant(data: unknown, tenantId: string): Record<string, unknown> {
  assertTenantNotChanged(data, tenantId);
  return { ...(data as Record<string, unknown>), tenantId };
}

/** Acrescenta o filtro do cliente a cada operação. O `tenantId` vindo da chamada é sempre sobrescrito. */
export function scopeArgs(operation: string, args: Args | undefined, tenantId: string): Args {
  if (!KNOWN_OPERATIONS.has(operation)) {
    throw new TenantScopeViolation(`operação ${operation} não suportada no escopo do cliente`);
  }
  const scoped: Args = { ...(args ?? {}) };

  if (WHERE_OPERATIONS.has(operation) || operation === 'upsert') {
    scoped['where'] = { ...(scoped['where'] ?? {}), tenantId };
  }
  if (operation.startsWith('update') || operation === 'upsert') {
    const update = operation === 'upsert' ? scoped['update'] : scoped['data'];
    // Alterar dado de um cliente nunca pode mover o registro para outro.
    assertTenantNotChanged(update, tenantId);
  }
  if (operation === 'create') scoped['data'] = withTenant(scoped['data'], tenantId);
  if (operation === 'createMany' || operation === 'createManyAndReturn') {
    const rows = Array.isArray(scoped['data']) ? scoped['data'] : [scoped['data']];
    scoped['data'] = rows.map((row) => withTenant(row, tenantId));
  }
  if (operation === 'upsert') scoped['create'] = withTenant(scoped['create'], tenantId);
  return scoped;
}

function scopeDelegate(delegate: object, tenantId: string): object {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (args?: Args) =>
        (value as (args: Args) => unknown).call(target, scopeArgs(property, args, tenantId));
    },
  });
}

/**
 * Cliente do banco restrito a um cliente da Verax (T2.5, regra 4). Funciona sobre o cliente base ou sobre a
 * transação da requisição. Models fora de `TENANT_SCOPED_MODELS` passam sem filtro (ex.: `tenant`).
 */
export function scopeToTenant(db: Prisma.TransactionClient, tenantId: string): Prisma.TransactionClient {
  if (!tenantId) throw new TenantScopeViolation('escopo sem cliente');
  return new Proxy(db, {
    get(target, property, receiver) {
      if (typeof property === 'string' && BLOCKED_CLIENT_METHODS.has(property)) {
        throw new TenantScopeViolation(`${property} não é permitido no escopo do cliente`);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (
        typeof property === 'string' &&
        SCOPED.has(property) &&
        typeof value === 'object' &&
        value !== null
      ) {
        return scopeDelegate(value, tenantId);
      }
      return value;
    },
  });
}
