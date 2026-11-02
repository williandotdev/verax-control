import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CloudAccount,
  type CloudAccountCreate,
  type CloudAccountListQuery,
  type CloudAccountUpdate,
  hasPermission,
  LOG_SOURCES,
  type LogSource,
  type Paginated,
  readOnlyRoleArn,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

const accountSelect = {
  id: true,
  tenantId: true,
  provider: true,
  accountId: true,
  regions: true,
  externalId: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.CloudAccountSelect;

type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof accountSelect }>;

const BUCKET_COLUMN = {
  cloudtrail: 'cloudtrailBucket',
  guardduty: 'guarddutyBucket',
  waf: 'wafBucket',
} as const satisfies Record<LogSource, keyof AccountRow>;

/** O ExternalId sai do CSPRNG: 256 bits em base64url (43 caracteres, no formato que a AWS aceita). */
function newExternalId(): string {
  return randomBytes(32).toString('base64url');
}

function toAccount(row: AccountRow, revealExternalId: boolean): CloudAccount {
  return {
    id: row.id,
    provider: 'aws',
    accountId: row.accountId,
    regions: row.regions,
    roleArn: readOnlyRoleArn(row.accountId),
    externalId: revealExternalId ? row.externalId : null,
    buckets: { cloudtrail: row.cloudtrailBucket, guardduty: row.guarddutyBucket, waf: row.wafBucket },
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Colunas de bucket a gravar: só as fontes informadas; `null` apaga. */
type BucketColumn = (typeof BUCKET_COLUMN)[LogSource];

function bucketData(buckets: CloudAccountCreate['buckets']): Partial<Record<BucketColumn, string | null>> {
  const data: Partial<Record<BucketColumn, string | null>> = {};
  for (const source of LOG_SOURCES) {
    const value = buckets?.[source];
    if (value !== undefined) data[BUCKET_COLUMN[source]] = value;
  }
  return data;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const NOT_FOUND = 'Conta não encontrada';

/**
 * Contas AWS dos clientes (T3.3), pelo escopo da sessão. Nenhuma credencial entra: o schema é estrito, e a
 * Verax só assume o papel de leitura com o ExternalId gerado aqui.
 *
 * Duas garantias que vinculam os alertas ao cliente certo (T5.2): o ID da conta é único na plataforma, e
 * cada bucket de log pertence a um só cliente.
 */
@Injectable()
export class CloudAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async list(auth: RequestAuth, query: CloudAccountListQuery): Promise<Paginated<CloudAccount>> {
    const where: Prisma.CloudAccountWhereInput = query.status ? { status: query.status } : {};
    const db = this.prisma.scoped();
    const [rows, total] = await Promise.all([
      db.cloudAccount.findMany({
        where,
        select: accountSelect,
        orderBy: [{ accountId: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.cloudAccount.count({ where }),
    ]);
    return toPaginated(
      rows.map((row) => toAccount(row, canSeeExternalId(auth))),
      total,
      query,
    );
  }

  async get(auth: RequestAuth, id: string): Promise<CloudAccount> {
    return toAccount(await this.find(id), canSeeExternalId(auth));
  }

  async create(auth: RequestAuth, input: CloudAccountCreate): Promise<CloudAccount> {
    const db = this.prisma.scoped();
    await this.assertBucketsFree(auth, input.buckets);
    let row: AccountRow;
    try {
      row = await db.cloudAccount.create({
        data: {
          provider: input.provider,
          accountId: input.accountId,
          regions: input.regions,
          externalId: newExternalId(),
          ...bucketData(input.buckets),
        } as Prisma.CloudAccountUncheckedCreateInput,
        select: accountSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(HttpStatus.CONFLICT, 'Esta conta AWS já está cadastrada');
      }
      throw error;
    }
    const account = toAccount(row, true);
    // O ExternalId não vai para a auditoria: quem lê a trilha não precisa dele.
    this.audit.describe({
      action: 'cloud_account.create',
      resourceType: 'cloud_account',
      resourceId: row.id,
      after: { ...account, externalId: undefined },
    });
    return account;
  }

  async update(auth: RequestAuth, id: string, input: CloudAccountUpdate): Promise<CloudAccount> {
    const beforeRow = await this.find(id);
    await this.assertBucketsFree(auth, input.buckets);
    const row = await this.prisma.scoped().cloudAccount.update({
      where: { id },
      data: { regions: input.regions, status: input.status, ...bucketData(input.buckets) },
      select: accountSelect,
    });
    const after = toAccount(row, true);
    this.audit.describe({
      action: 'cloud_account.update',
      resourceType: 'cloud_account',
      resourceId: id,
      before: { ...toAccount(beforeRow, false), externalId: undefined },
      after: { ...after, externalId: undefined },
    });
    return after;
  }

  /** Exclusão lógica: a conta deixa de ser lida e de receber alertas, mas o ID continua do cliente. */
  async deactivate(id: string): Promise<void> {
    const before = await this.find(id);
    const row = await this.prisma
      .scoped()
      .cloudAccount.update({ where: { id }, data: { status: 'inactive' }, select: accountSelect });
    this.audit.describe({
      action: 'cloud_account.deactivate',
      resourceType: 'cloud_account',
      resourceId: id,
      before: { ...toAccount(before, false), externalId: undefined },
      after: { ...toAccount(row, false), externalId: undefined },
    });
  }

  private async find(id: string): Promise<AccountRow> {
    const row = await this.prisma.scoped().cloudAccount.findUnique({ where: { id }, select: accountSelect });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    return row;
  }

  /**
   * Um bucket de log não pode ser de dois clientes: o alerta lido dele seria atribuído a qualquer um. A
   * checagem roda sob um lock transacional por bucket, para dois cadastros simultâneos não passarem juntos.
   * Responde só "já cadastrado", sem dizer de quem.
   */
  private async assertBucketsFree(auth: RequestAuth, buckets: CloudAccountCreate['buckets']): Promise<void> {
    const tenantId = auth.scopeTenantId as string;
    const requested = LOG_SOURCES.flatMap((source) => {
      const name = buckets?.[source];
      return typeof name === 'string' ? [{ source, name }] : [];
    }).sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`));
    const db = this.prisma.db();
    for (const { source, name } of requested) {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:bucket:${source}:${name}`}))`;
      const taken = await db.cloudAccount.findFirst({
        where: { tenantId: { not: tenantId }, [BUCKET_COLUMN[source]]: name },
        select: { id: true },
      });
      if (taken)
        throw new ApiError(HttpStatus.CONFLICT, `O bucket ${name} já está cadastrado em outro cliente`);
    }
  }
}

function canSeeExternalId(auth: RequestAuth): boolean {
  return hasPermission(auth.role, 'cloud_accounts:write');
}
