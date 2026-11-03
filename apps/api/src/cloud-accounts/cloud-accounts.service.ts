import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type CloudAccount,
  type CloudAccountCreate,
  type CloudAccountListQuery,
  type CloudAccountUpdate,
  fieldsOutsideProvider,
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
  pubsubSubscription: true,
  zones: true,
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
  const aws = row.provider === 'aws';
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.accountId,
    regions: aws ? row.regions : [],
    roleArn: aws ? readOnlyRoleArn(row.accountId) : null,
    externalId: aws && revealExternalId ? row.externalId : null,
    buckets: { cloudtrail: row.cloudtrailBucket, guardduty: row.guarddutyBucket, waf: row.wafBucket },
    pubsubSubscription: row.pubsubSubscription,
    zones: row.zones,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Colunas de bucket a gravar: só as fontes informadas; `null` apaga. */
type BucketColumn = (typeof BUCKET_COLUMN)[LogSource];

type AwsBuckets = Extract<CloudAccountCreate, { provider: 'aws' }>['buckets'];

function bucketData(buckets: AwsBuckets): Partial<Record<BucketColumn, string | null>> {
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

/** Dados próprios de cada provedor no cadastro. Os campos dos outros provedores ficam vazios. */
function providerData(input: CloudAccountCreate): Prisma.CloudAccountUncheckedCreateInput {
  const base = {
    provider: input.provider,
    accountId: input.accountId,
  } as Prisma.CloudAccountUncheckedCreateInput;
  switch (input.provider) {
    case 'aws':
      return { ...base, regions: input.regions, externalId: newExternalId(), ...bucketData(input.buckets) };
    case 'gcp':
      return { ...base, regions: [], pubsubSubscription: input.pubsubSubscription ?? null };
    case 'cloudflare':
      return { ...base, regions: [], zones: input.zones ?? [] };
  }
}

/** Origens de log que identificam o cliente de um alerta: nenhuma pode ser de dois clientes. */
interface LogOrigins {
  buckets?: AwsBuckets;
  pubsubSubscription?: string | null;
  zones?: string[];
}

/**
 * Contas cloud dos clientes (T3.3): AWS, GCP e Cloudflare, pelo escopo da sessão. Nenhuma credencial entra: o
 * schema é estrito; na AWS, a Verax só assume o papel de leitura com o ExternalId gerado aqui.
 *
 * Duas garantias que vinculam os alertas ao cliente certo (T5.2): o ID da conta é único por provedor, e cada
 * origem de log (bucket, assinatura do Pub/Sub, zona do Cloudflare) pertence a um só cliente.
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
    await this.assertOriginsFree(auth, input);
    let row: AccountRow;
    try {
      row = await db.cloudAccount.create({ data: providerData(input), select: accountSelect });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(HttpStatus.CONFLICT, 'Esta conta já está cadastrada');
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
    // Cada campo só existe num provedor: recusar, em vez de ignorar, evita achar que algo foi gravado.
    const foreign = fieldsOutsideProvider(beforeRow.provider, input);
    if (foreign.length > 0) {
      throw new ApiError(HttpStatus.BAD_REQUEST, `Campo que não existe nesta conta: ${foreign.join(', ')}`);
    }
    await this.assertOriginsFree(auth, input);
    const row = await this.prisma.scoped().cloudAccount.update({
      where: { id },
      data: {
        regions: input.regions,
        status: input.status,
        pubsubSubscription: input.pubsubSubscription,
        zones: input.zones,
        ...bucketData(input.buckets),
      },
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
   * Uma origem de log não pode ser de dois clientes: o alerta lido dela seria atribuído a qualquer um.
   * - Bucket: o nome é único no S3, então vale para qualquer fonte (o mesmo bucket como CloudTrail de um cliente e
   *   GuardDuty de outro também é ambíguo).
   * - Assinatura do Pub/Sub: um coletor agregado pode servir vários projetos do mesmo cliente, nunca de dois.
   * - Zona do Cloudflare: o domínio identifica o cliente nos eventos do WAF.
   *
   * A checagem roda sob um lock transacional por origem, para dois cadastros simultâneos não passarem juntos.
   * Responde só "já cadastrado", sem dizer de quem.
   */
  private async assertOriginsFree(auth: RequestAuth, origins: LogOrigins): Promise<void> {
    const tenantId = auth.scopeTenantId as string;
    const checks: { key: string; label: string; where: Prisma.CloudAccountWhereInput }[] = [];
    const buckets = new Set(
      LOG_SOURCES.map((source) => origins.buckets?.[source]).filter((name) => typeof name === 'string'),
    );
    for (const name of buckets) {
      checks.push({
        key: `verax:bucket:${name}`,
        label: `O bucket ${name} já está cadastrado`,
        where: { OR: LOG_SOURCES.map((source) => ({ [BUCKET_COLUMN[source]]: name })) },
      });
    }
    if (origins.pubsubSubscription) {
      const name = origins.pubsubSubscription;
      checks.push({
        key: `verax:pubsub:${name}`,
        label: `A assinatura ${name} já está cadastrada`,
        where: { pubsubSubscription: name },
      });
    }
    for (const zone of origins.zones ?? []) {
      checks.push({
        key: `verax:zone:${zone}`,
        label: `A zona ${zone} já está cadastrada`,
        where: { zones: { has: zone } },
      });
    }
    // Ordem fixa dos locks: dois cadastros com as mesmas origens não se travam um ao outro.
    checks.sort((a, b) => a.key.localeCompare(b.key));
    const db = this.prisma.db();
    for (const check of checks) {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${check.key}))`;
      const taken = await db.cloudAccount.findFirst({
        where: { tenantId: { not: tenantId }, ...check.where },
        select: { id: true },
      });
      if (taken) {
        throw new ApiError(HttpStatus.CONFLICT, `${check.label} em outro cliente`);
      }
    }
  }
}

function canSeeExternalId(auth: RequestAuth): boolean {
  return hasPermission(auth.role, 'cloud_accounts:write');
}
