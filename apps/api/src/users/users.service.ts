import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type {
  Paginated,
  TemporaryPassword,
  User,
  UserCreate,
  UserCreated,
  UserListQuery,
  UserUpdate,
} from '@verax/shared';
import { AUTH } from '../auth/auth.constants.js';
import type { Auth } from '../auth/auth.factory.js';
import { setTemporaryPassword } from '../auth/temporary-password.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PlanService } from '../plan/plan.service.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  twoFactorEnabled: true,
  mustChangePassword: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof userSelect }>;

function toUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    // O escopo do cliente só alcança usuários de cliente; admin_verax não tem cliente.
    role: row.role as User['role'],
    status: row.status,
    mfaEnabled: row.twoFactorEnabled,
    mustChangePassword: row.mustChangePassword,
    createdAt: row.createdAt.toISOString(),
  };
}

const NOT_FOUND = 'Usuário não encontrado';
const SELF = 'Você não pode alterar o próprio acesso';
const EMAIL_TAKEN = 'Já existe um usuário com este e-mail';

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Usuários do cliente (T3.2). Tudo pelo escopo da sessão: `admin_cliente` gerencia o próprio cliente, e
 * `admin_verax`, o cliente selecionado. Ninguém altera o próprio papel, status, MFA ou senha por aqui.
 *
 * A conta nasce com uma senha temporária, devolvida uma vez a quem criou (nunca gravada em texto nem na auditoria);
 * no primeiro login, a pessoa troca a senha e cadastra o MFA.
 *
 * Criar e reativar um usuário pedem vaga no plano do nó (fase 2, PR-18): contam os convidados e os ativos do cliente,
 * desativar libera a vaga, e a equipe da Verax (`admin_verax`) nunca conta.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly plan: PlanService,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async list(query: UserListQuery): Promise<Paginated<User>> {
    const where: Prisma.UserWhereInput = query.status ? { status: query.status } : {};
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.user.findMany({
        where,
        select: userSelect,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.user.count({ where }),
    ]);
    return toPaginated(rows.map(toUser), total, query);
  }

  async get(id: string): Promise<User> {
    return toUser(await this.find(id));
  }

  async create(auth: RequestAuth, input: UserCreate): Promise<UserCreated> {
    this.prisma.scoped(); // exige um cliente no escopo e marca a trilha de auditoria dele
    const created = await this.provision(auth.scopeTenantId as string, input);
    this.audit.describe({
      action: 'user.create',
      resourceType: 'user',
      resourceId: created.user.id,
      after: created.user,
    });
    return created;
  }

  /**
   * Conta nova no cliente informado, com a senha temporária: o caminho comum do cadastro de usuários e do primeiro
   * administrador de um cliente recém-criado (`TenantsService`, na mesma requisição). O cliente nunca vem do
   * usuário: é o da sessão ou o que a Verax acabou de criar. Quem chama descreve a auditoria.
   */
  async provision(tenantId: string, input: UserCreate): Promise<UserCreated> {
    await this.plan.assertWithinPlan('users', tenantId, { action: 'user.create' });
    const email = input.email.trim().toLowerCase();
    // O e-mail é único na plataforma inteira.
    if (await this.prisma.db().user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ApiError(HttpStatus.CONFLICT, EMAIL_TAKEN);
    }
    // Nasce sem acesso (`invited`) e só fica ativa junto com a senha temporária. As duas gravações entram na
    // transação da requisição: ou a conta nasce pronta para o primeiro login, ou não nasce.
    let id: string;
    try {
      ({ id } = await provisionUser(this.auth, {
        email,
        name: input.name,
        role: input.role,
        tenantId,
        status: 'invited',
      }));
    } catch (error) {
      // Outra requisição confirmou o mesmo e-mail entre a checagem acima e a gravação: a mesma resposta.
      if (isUniqueViolation(error)) throw new ApiError(HttpStatus.CONFLICT, EMAIL_TAKEN);
      throw error;
    }
    const temporary = await setTemporaryPassword(this.auth, this.prisma, { id, email });
    const row = await this.prisma
      .forTenant(tenantId)
      .user.findUniqueOrThrow({ where: { id }, select: userSelect });
    return { user: toUser(row), ...temporary };
  }

  async update(auth: RequestAuth, id: string, input: UserUpdate): Promise<User> {
    const before = toUser(await this.find(id));
    if (id === auth.userId) throw new ApiError(HttpStatus.FORBIDDEN, SELF);
    if (input.status === 'active' && before.status === 'invited') {
      throw new ApiError(HttpStatus.CONFLICT, 'Conta ainda sem senha: gere uma senha temporária');
    }
    // Reativar ocupa de novo uma vaga do plano; quem já está ativo não pede outra.
    if (input.status === 'active' && before.status === 'disabled') {
      await this.plan.assertWithinPlan('users', auth.scopeTenantId as string, {
        action: 'user.update',
        resourceId: id,
      });
    }
    const row = await this.prisma.scoped().user.update({
      where: { id },
      data: { role: input.role, status: input.status },
      select: userSelect,
    });
    if (row.status === 'disabled') await this.revokeSessions(id);
    const after = toUser(row);
    this.audit.describe({ action: 'user.update', resourceType: 'user', resourceId: id, before, after });
    return after;
  }

  /** Desativa (exclusão lógica): o usuário perde as sessões na hora e não entra mais. */
  async deactivate(auth: RequestAuth, id: string): Promise<void> {
    const before = toUser(await this.find(id));
    if (id === auth.userId) throw new ApiError(HttpStatus.FORBIDDEN, SELF);
    const row = await this.prisma
      .scoped()
      .user.update({ where: { id }, data: { status: 'disabled' }, select: userSelect });
    await this.revokeSessions(id);
    this.audit.describe({
      action: 'user.deactivate',
      resourceType: 'user',
      resourceId: id,
      before,
      after: toUser(row),
    });
  }

  /**
   * Senha temporária nova (quem esqueceu a senha, ou não entrou a tempo): a anterior deixa de valer, as sessões caem,
   * e no próximo login a pessoa troca a senha. O MFA já cadastrado continua valendo.
   */
  async temporaryPassword(auth: RequestAuth, id: string): Promise<TemporaryPassword> {
    const before = toUser(await this.find(id));
    if (id === auth.userId) throw new ApiError(HttpStatus.FORBIDDEN, SELF);
    if (before.status === 'disabled') {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Usuário desativado: reative antes de gerar uma senha temporária',
      );
    }
    const temporary = await setTemporaryPassword(this.auth, this.prisma, { id, email: before.email });
    const after = toUser(await this.find(id));
    this.audit.describe({
      action: 'user.temporary_password',
      resourceType: 'user',
      resourceId: id,
      before,
      after,
    });
    return temporary;
  }

  /**
   * Para quem perdeu o autenticador: apaga o TOTP e os códigos de recuperação e derruba as sessões. No
   * próximo login, com a senha, o usuário cadastra um autenticador novo antes de alcançar qualquer dado.
   */
  async resetMfa(auth: RequestAuth, id: string): Promise<void> {
    const before = toUser(await this.find(id));
    if (id === auth.userId) throw new ApiError(HttpStatus.FORBIDDEN, SELF);
    await this.prisma.db().twoFactor.deleteMany({ where: { userId: id } });
    const row = await this.prisma
      .scoped()
      .user.update({ where: { id }, data: { twoFactorEnabled: false }, select: userSelect });
    await this.revokeSessions(id);
    this.audit.describe({
      action: 'user.reset_mfa',
      resourceType: 'user',
      resourceId: id,
      before,
      after: toUser(row),
    });
  }

  private async find(id: string): Promise<UserRow> {
    const row = await this.prisma.scoped().user.findUnique({ where: { id }, select: userSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }

  private async revokeSessions(userId: string): Promise<void> {
    await this.prisma.db().session.deleteMany({ where: { userId } });
  }
}
