import { randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
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
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
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
  sinkWriterIdentity: true,
  zones: true,
  lastEventAt: true,
  connection: true,
  connectionError: true,
  lastCollectedAt: true,
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

/**
 * Como a conta sai da API. `sinkTopicPrefix` é o começo do nome dos tópicos do nó (`GCP_SINK_TOPIC_PREFIX`): com ele,
 * o projeto da GCP ganha o tópico do comando do sink; sem ele (ambiente local), o tópico fica null.
 */
function toAccount(row: AccountRow, revealExternalId: boolean, sinkTopicPrefix?: string): CloudAccount {
  const aws = row.provider === 'aws';
  const gcp = row.provider === 'gcp';
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.accountId,
    regions: aws ? row.regions : [],
    roleArn: aws ? readOnlyRoleArn(row.accountId) : null,
    externalId: aws && revealExternalId ? row.externalId : null,
    buckets: { cloudtrail: row.cloudtrailBucket, guardduty: row.guarddutyBucket, waf: row.wafBucket },
    pubsubSubscription: row.pubsubSubscription,
    sinkTopic: gcp && sinkTopicPrefix ? `${sinkTopicPrefix}${row.accountId}` : null,
    sinkWriterIdentity: gcp ? row.sinkWriterIdentity : null,
    zones: row.zones,
    status: row.status,
    // Gravados pelo coletor da conta: só o worker escreve, nunca o request.
    connection: row.connection,
    connectionError: row.connection === 'error' ? row.connectionError : null,
    lastCollectedAt: row.lastCollectedAt?.toISOString() ?? null,
    // Gravado pelo sync de alertas (T5.3).
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
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

/** A conexão recomeça (outra fonte, conta desativada ou reativada): aguardando, sem erro. A última coleta é história. */
const RESET_CONNECTION = {
  connection: 'waiting',
  connectionError: null,
} as const satisfies Prisma.CloudAccountUpdateInput;

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
      return {
        ...base,
        regions: [],
        pubsubSubscription: input.pubsubSubscription ?? null,
        sinkWriterIdentity: input.sinkWriterIdentity ?? null,
      };
    case 'cloudflare':
      return { ...base, regions: [], zones: input.zones ?? [] };
  }
}

/** Origens de log que identificam o cliente de um alerta: nenhuma pode ser de dois clientes. */
interface LogOrigins {
  buckets?: AwsBuckets;
  pubsubSubscription?: string | null;
  sinkWriterIdentity?: string | null;
  zones?: string[];
}

/**
 * Contas cloud dos clientes (T3.3): AWS, GCP e Cloudflare, pelo escopo da sessão. Nenhuma credencial entra: o
 * schema é estrito; na AWS, a Verax só assume o papel de leitura com o ExternalId gerado aqui.
 *
 * Duas garantias que vinculam os alertas ao cliente certo (T5.2): o ID da conta é único por provedor, e cada
 * origem de log (bucket, assinatura do Pub/Sub, identidade do sink, zona do Cloudflare) pertence a um só cliente.
 */
@Injectable()
export class CloudAccountsService {
  private readonly sinkTopicPrefix: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'GCP_SINK_TOPIC_PREFIX'>,
  ) {
    this.sinkTopicPrefix = config.GCP_SINK_TOPIC_PREFIX;
  }

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
      rows.map((row) => toAccount(row, canSeeExternalId(auth), this.sinkTopicPrefix)),
      total,
      query,
    );
  }

  async get(auth: RequestAuth, id: string): Promise<CloudAccount> {
    return toAccount(await this.find(id), canSeeExternalId(auth), this.sinkTopicPrefix);
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
    const account = toAccount(row, true, this.sinkTopicPrefix);
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
    await this.assertOriginsFree(auth, input, id);
    // Outra assinatura é outra fonte, e a conta desativada ou reativada recomeça: a conexão volta a "aguardando" até
    // o coletor confirmar a leitura de novo.
    const sourceChanged =
      input.pubsubSubscription !== undefined && input.pubsubSubscription !== beforeRow.pubsubSubscription;
    const statusChanged = input.status !== undefined && input.status !== beforeRow.status;
    const row = await this.prisma.scoped().cloudAccount.update({
      where: { id },
      data: {
        regions: input.regions,
        status: input.status,
        pubsubSubscription: input.pubsubSubscription,
        // A identidade do sink não é a fonte que o nó lê: trocá-la não mexe na conexão.
        sinkWriterIdentity: input.sinkWriterIdentity,
        zones: input.zones,
        ...bucketData(input.buckets),
        ...((sourceChanged || statusChanged) && RESET_CONNECTION),
      },
      select: accountSelect,
    });
    const after = toAccount(row, true, this.sinkTopicPrefix);
    this.audit.describe({
      action: 'cloud_account.update',
      resourceType: 'cloud_account',
      resourceId: id,
      before: { ...toAccount(beforeRow, false, this.sinkTopicPrefix), externalId: undefined },
      after: { ...after, externalId: undefined },
    });
    return after;
  }

  /**
   * Exclusão lógica: a conta deixa de ser lida e de receber alertas, mas o ID continua do cliente. A conexão volta a
   * "aguardando": parada, a conta não está conectada nem com erro.
   */
  async deactivate(id: string): Promise<void> {
    const before = await this.find(id);
    const row = await this.prisma.scoped().cloudAccount.update({
      where: { id },
      data: { status: 'inactive', ...RESET_CONNECTION },
      select: accountSelect,
    });
    this.audit.describe({
      action: 'cloud_account.deactivate',
      resourceType: 'cloud_account',
      resourceId: id,
      before: { ...toAccount(before, false, this.sinkTopicPrefix), externalId: undefined },
      after: { ...toAccount(row, false, this.sinkTopicPrefix), externalId: undefined },
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
   * - Identidade do sink: é o agente do Cloud Logging do projeto do cliente, e quem a tem publica no tópico dele.
   *   Vale para um projeto só: colada em outro cliente, daria a publicação a um projeto que não é dele; colada em
   *   outro projeto do mesmo cliente, daria a um projeto a publicação no tópico de outro (o Terraform do nó recusa
   *   a repetição em `customer_projects` pela mesma razão). Por isso é a única origem que também não se repete
   *   entre as contas do próprio cliente (`exceptId` é a conta que está sendo alterada).
   * - Zona do Cloudflare: o domínio identifica o cliente nos eventos do WAF.
   *
   * A checagem roda sob um lock transacional por origem, para dois cadastros simultâneos não passarem juntos.
   * Responde só "já cadastrado", sem dizer de quem.
   */
  private async assertOriginsFree(auth: RequestAuth, origins: LogOrigins, exceptId?: string): Promise<void> {
    const tenantId = auth.scopeTenantId as string;
    const checks: {
      key: string;
      label: string;
      where: Prisma.CloudAccountWhereInput;
      /** A origem também não pode estar em outra conta do mesmo cliente. */
      onePerAccount?: boolean;
    }[] = [];
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
    if (origins.sinkWriterIdentity) {
      const identity = origins.sinkWriterIdentity;
      checks.push({
        key: `verax:sink:${identity}`,
        label: 'A identidade do sink já está cadastrada',
        where: { sinkWriterIdentity: identity },
        onePerAccount: true,
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
      if (!check.onePerAccount) continue;
      const repeated = await db.cloudAccount.findFirst({
        where: { tenantId, ...check.where, ...(exceptId && { id: { not: exceptId } }) },
        select: { id: true },
      });
      if (repeated) {
        throw new ApiError(HttpStatus.CONFLICT, `${check.label} em outra conta deste cliente`);
      }
    }
  }
}

function canSeeExternalId(auth: RequestAuth): boolean {
  return hasPermission(auth.role, 'cloud_accounts:write');
}
