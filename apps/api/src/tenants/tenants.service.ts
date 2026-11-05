import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  Paginated,
  Tenant,
  TenantCreate,
  TenantCreated,
  TenantListQuery,
  TenantSummary,
  TenantUpdate,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  type ConfirmationNotice,
  ESCALATION_SELECT,
  escalationContactCreate,
  escalationContactUpdate,
  latestConfirmation,
  queueEscalationConfirmation,
  restartEscalationConfirmation,
  toEscalationContact,
} from '../escalation/escalation-contact-store.js';
import { UsersService } from '../users/users.service.js';

const tenantSelect = {
  ...ESCALATION_SELECT,
  name: true,
  cnpj: true,
  plan: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.TenantSelect;

type TenantRow = Prisma.TenantGetPayload<{ select: typeof tenantSelect }>;

/** O cadastro como a API devolve, com o estado do contato de escalonamento e o último e-mail de confirmação dele. */
export function toTenant(row: TenantRow, confirmation: ConfirmationNotice | null): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    cnpj: row.cnpj,
    plan: row.plan,
    escalationContact: toEscalationContact(row, confirmation),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Os campos cadastrais da alteração. O contato de escalonamento tem regra própria (`escalationContactUpdate`). */
function toData(input: TenantUpdate): Prisma.TenantUpdateInput {
  return {
    name: input.name,
    cnpj: input.cnpj,
    plan: input.plan,
    ...('status' in input ? { status: input.status } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const NOT_FOUND = 'Cliente não encontrado';
const CNPJ_TAKEN = 'Já existe um cliente com este CNPJ';

/**
 * Cadastro de clientes (T3.1). Operação global da Verax: só `admin_verax` chega aqui (permissões
 * `tenants:*`), sem escopo de cliente. Cada registro de auditoria entra na trilha do próprio cliente.
 *
 * O contato de escalonamento (D8) segue as regras de `escalation/escalation-contact-store.ts`: endereço novo volta a
 * aguardar a confirmação, e o e-mail dela entra na fila de saída, na mesma transação da requisição.
 */
@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly users: UsersService,
  ) {}

  async list(query: TenantListQuery): Promise<Paginated<TenantSummary>> {
    const where: Prisma.TenantWhereInput = query.status ? { status: query.status } : {};
    const [items, total] = await Promise.all([
      this.prisma.db().tenant.findMany({
        where,
        select: { id: true, name: true, status: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      this.prisma.db().tenant.count({ where }),
    ]);
    return toPaginated(items, total, query);
  }

  async get(id: string): Promise<Tenant> {
    return this.toFullTenant(await this.find(id));
  }

  /**
   * O cliente nasce com o primeiro administrador (`admin_cliente`), criado na mesma transação da requisição com uma
   * senha temporária, devolvida uma vez a quem cadastrou (nunca gravada em texto, nem na auditoria, nem relida). Se
   * a conta não puder ser criada (e-mail já usado), o cliente também não é.
   */
  async create(input: TenantCreate): Promise<TenantCreated> {
    const { firstAdmin, escalationContact, ...fields } = input;
    let row: TenantRow;
    try {
      row = await this.prisma.db().tenant.create({
        data: { ...fields, ...escalationContactCreate(escalationContact) },
        select: tenantSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(HttpStatus.CONFLICT, CNPJ_TAKEN);
      throw error;
    }
    // O contato nasce aguardando a confirmação: o e-mail dela entra na fila junto com o cadastro.
    await queueEscalationConfirmation(this.prisma.forTenant(row.id), row.escalationGeneration, new Date());
    const tenant = await this.toFullTenant(row);
    const { user, ...temporary } = await this.users.provision(tenant.id, {
      ...firstAdmin,
      role: 'admin_cliente',
    });
    // Dois registros na trilha do cliente novo: o cadastro e a conta do administrador.
    this.audit.describe({
      action: 'tenant.create',
      resourceType: 'tenant',
      resourceId: tenant.id,
      tenantId: tenant.id,
      after: tenant,
    });
    this.audit.also({
      action: 'user.create',
      resourceType: 'user',
      resourceId: user.id,
      tenantId: tenant.id,
      after: user,
    });
    return { tenant, firstAdmin: { id: user.id, name: user.name, email: user.email, ...temporary } };
  }

  async update(id: string, input: TenantUpdate): Promise<Tenant> {
    const found = await this.find(id);
    const before = await this.toFullTenant(found);
    const contact = input.escalationContact ? escalationContactUpdate(found, input.escalationContact) : null;
    let row: TenantRow;
    try {
      row = await this.prisma.db().tenant.update({
        where: { id },
        data: { ...toData(input), ...contact?.data },
        select: tenantSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ApiError(HttpStatus.CONFLICT, CNPJ_TAKEN);
      throw error;
    }
    if (contact?.restart) {
      await queueEscalationConfirmation(this.prisma.forTenant(id), row.escalationGeneration, new Date());
    }
    if (before.status === 'active' && row.status === 'inactive') await this.revokeAccess(id);
    const after = await this.toFullTenant(row);
    this.audit.describe({
      action:
        row.status === before.status
          ? 'tenant.update'
          : `tenant.${row.status === 'active' ? 'reactivate' : 'deactivate'}`,
      resourceType: 'tenant',
      resourceId: id,
      tenantId: id,
      before,
      after,
    });
    return after;
  }

  /**
   * Pede de novo a confirmação do contato de escalonamento (D8), com o mesmo endereço: o e-mail não chegou, o link
   * venceu, ou o contato se descadastrou e pediu para voltar. Os links anteriores deixam de valer.
   */
  async requestEscalationConfirmation(id: string): Promise<Tenant> {
    await this.find(id);
    const db = this.prisma.forTenant(id);
    const { before } = await restartEscalationConfirmation(db, id, new Date());
    const tenant = await this.toFullTenant(await this.find(id));
    this.audit.describe({
      action: 'escalation_contact.resend',
      resourceType: 'tenant',
      resourceId: id,
      tenantId: id,
      before: toEscalationContact(before, await latestConfirmation(db, before.escalationGeneration)),
      after: tenant.escalationContact,
    });
    return tenant;
  }

  /** Exclusão lógica: o cliente fica inativo, e ninguém dele continua logado. */
  async deactivate(id: string): Promise<void> {
    const before = await this.toFullTenant(await this.find(id));
    const row = await this.prisma
      .db()
      .tenant.update({ where: { id }, data: { status: 'inactive' }, select: tenantSelect });
    await this.revokeAccess(id);
    this.audit.describe({
      action: 'tenant.deactivate',
      resourceType: 'tenant',
      resourceId: id,
      tenantId: id,
      before,
      after: await this.toFullTenant(row),
    });
  }

  /** O cadastro com o último pedido de confirmação do contato, lido pelo escopo do próprio cliente. */
  private async toFullTenant(row: TenantRow): Promise<Tenant> {
    const confirmation =
      row.escalationState === null
        ? null
        : await latestConfirmation(this.prisma.forTenant(row.id), row.escalationGeneration);
    return toTenant(row, confirmation);
  }

  private async find(id: string): Promise<TenantRow> {
    const row = await this.prisma.db().tenant.findUnique({ where: { id }, select: tenantSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }

  /**
   * As sessões dos usuários do cliente caem, e as seleções de `admin_verax` nele são limpas. O guard já
   * recusaria essas sessões na próxima requisição; apagar agora as tira também das listagens de sessão.
   */
  private async revokeAccess(tenantId: string): Promise<void> {
    await this.prisma.db().session.deleteMany({ where: { user: { tenantId } } });
    await this.prisma
      .db()
      .session.updateMany({ where: { activeTenantId: tenantId }, data: { activeTenantId: null } });
  }
}
