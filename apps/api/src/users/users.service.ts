import { HttpStatus, Injectable } from '@nestjs/common';
import type { Paginated, User, UserInvite, UserListQuery, UserUpdate } from '@verax/shared';
import { InvitationService } from '../auth/invitation.service.js';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const userSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  twoFactorEnabled: true,
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
    createdAt: row.createdAt.toISOString(),
  };
}

const NOT_FOUND = 'Usuário não encontrado';
const SELF = 'Você não pode alterar o próprio acesso';

/**
 * Usuários do cliente (T3.2). Tudo pelo escopo da sessão: `admin_cliente` gerencia o próprio cliente, e
 * `admin_verax`, o cliente selecionado. Ninguém altera o próprio papel, status ou MFA.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly invitations: InvitationService,
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

  async invite(auth: RequestAuth, input: UserInvite): Promise<User> {
    this.prisma.scoped(); // exige um cliente no escopo e marca a trilha de auditoria dele
    const tenantId = auth.scopeTenantId as string;
    const email = input.email.trim().toLowerCase();
    // O e-mail é único na plataforma inteira.
    if (await this.prisma.db().user.findUnique({ where: { email }, select: { id: true } })) {
      throw new ApiError(HttpStatus.CONFLICT, 'Já existe um usuário com este e-mail');
    }
    const { id } = await this.invitations.invite({ email, name: input.name, role: input.role, tenantId });
    const user = await this.get(id);
    this.audit.describe({ action: 'user.invite', resourceType: 'user', resourceId: id, after: user });
    return user;
  }

  async update(auth: RequestAuth, id: string, input: UserUpdate): Promise<User> {
    const before = toUser(await this.find(id));
    if (id === auth.userId) throw new ApiError(HttpStatus.FORBIDDEN, SELF);
    if (input.status === 'active' && before.status === 'invited') {
      throw new ApiError(HttpStatus.CONFLICT, 'Convidado só fica ativo ao definir a senha pelo link');
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

  /** Reenvia o convite. O link anterior continua valendo até expirar ou ser usado. */
  async resendInvitation(id: string): Promise<void> {
    const user = toUser(await this.find(id));
    if (user.status !== 'invited') {
      throw new ApiError(HttpStatus.CONFLICT, 'Só usuário convidado recebe o convite de novo');
    }
    await this.invitations.sendLink(user.email);
    this.audit.describe({ action: 'user.resend_invitation', resourceType: 'user', resourceId: id });
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
