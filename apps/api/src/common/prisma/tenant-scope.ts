import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Models com dado de cliente (coluna `tenantId`). Todo acesso a eles numa requisição de usuário passa pelo
 * escopo do cliente. O meta-teste lê o `schema.prisma` e falha se um model com `tenantId` ficar fora daqui.
 */
export const TENANT_SCOPED_MODELS = ['user', 'auditLog', 'cloudAccount'] as const;
export type TenantScopedModel = (typeof TENANT_SCOPED_MODELS)[number];

const SCOPED = new Set<string>(TENANT_SCOPED_MODELS);

/** O próprio cliente: no escopo, o model `tenant` só alcança a linha do cliente da sessão, sem criar. */
const TENANT_ROOT_MODEL = 'tenant';

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

/**
 * Restringe o model `tenant` ao cliente da sessão. O filtro entra num `AND`, sem trocar o `id` pedido: pedir
 * outro cliente dá "não encontrado", nunca o próprio no lugar dele.
 */
export function scopeTenantRootArgs(operation: string, args: Args | undefined, tenantId: string): Args {
  if (!WHERE_OPERATIONS.has(operation)) {
    throw new TenantScopeViolation(`operação ${operation} não permitida no cadastro do cliente`);
  }
  const scoped: Args = { ...(args ?? {}) };
  const where = (scoped['where'] ?? {}) as Args;
  const and = where['AND'] === undefined ? [] : Array.isArray(where['AND']) ? where['AND'] : [where['AND']];
  scoped['where'] = { ...where, AND: [...(and as unknown[]), { id: tenantId }] };
  const data = scoped['data'];
  if (typeof data === 'object' && data !== null && 'id' in data) {
    throw new TenantScopeViolation('o id do cliente não muda');
  }
  return scoped;
}

type Scoper = (operation: string, args: Args | undefined) => Args;

function scopeDelegate(delegate: object, scope: Scoper): object {
  return new Proxy(delegate, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (args?: Args) => (value as (args: Args) => unknown).call(target, scope(property, args));
    },
  });
}

/**
 * Cliente do banco restrito a um cliente da Verax (T2.5, regra 4). Funciona sobre o cliente base ou sobre a
 * transação da requisição. Só existem nele:
 * - os models de `TENANT_SCOPED_MODELS`, filtrados por `tenantId`;
 * - o model `tenant`, restrito à linha do próprio cliente.
 *
 * Os demais models (sessões, contas, tokens) e os métodos `$` (SQL cru, transações, extensões) escapariam do
 * filtro: no escopo do cliente, acessá-los lança `TenantScopeViolation`. Quem precisa deles usa `db()`.
 */
export function scopeToTenant(db: Prisma.TransactionClient, tenantId: string): Prisma.TransactionClient {
  if (!tenantId) throw new TenantScopeViolation('escopo sem cliente');
  return new Proxy(db, {
    get(target, property, receiver) {
      if (typeof property !== 'string') return Reflect.get(target, property, receiver) as unknown;
      if (property.startsWith('$')) {
        throw new TenantScopeViolation(`${property} não é permitido no escopo do cliente`);
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'object' || value === null) return value;
      if (SCOPED.has(property)) {
        return scopeDelegate(value, (operation, args) => scopeArgs(operation, args, tenantId));
      }
      if (property === TENANT_ROOT_MODEL) {
        return scopeDelegate(value, (operation, args) => scopeTenantRootArgs(operation, args, tenantId));
      }
      throw new TenantScopeViolation(`${property} não existe no escopo do cliente`);
    },
  });
}
