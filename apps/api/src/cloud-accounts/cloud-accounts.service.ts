import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AWS_READER_AUDIENCE,
  awsReaderRoleArn,
  type CloudAccount,
  type CloudAccountCreate,
  type CloudAccountListQuery,
  type CloudAccountUpdate,
  credentialStatus,
  fieldsOutsideProvider,
  isAwsCollectionErrorCode,
  isAwsConnectionWarningCode,
  LOG_SOURCES,
  type LogBuckets,
  type LogSource,
  mergeLogBuckets,
  type Paginated,
  sameLogBucketNames,
} from '@verax/shared';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { lockCredential } from '../credentials/credential-rekey.js';
import { Prisma } from '../generated/prisma/client.js';
import { PlanService } from '../plan/plan.service.js';

const accountSelect = {
  id: true,
  tenantId: true,
  provider: true,
  accountId: true,
  regions: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  pubsubSubscription: true,
  sinkWriterIdentity: true,
  zones: true,
  lastEventAt: true,
  connection: true,
  connectionError: true,
  collectionError: true,
  lastCollectedAt: true,
  checkRequestedAt: true,
  ingestFrom: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  // Do cofre, só os metadados: nunca o texto cifrado nem a versão da chave do nó.
  credential: {
    select: { kind: true, keyIdSuffix: true, issuedAt: true, expiresAt: true, verifiedAt: true },
  },
} as const satisfies Prisma.CloudAccountSelect;

type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof accountSelect }>;

const BUCKET_COLUMN = {
  cloudtrail: 'cloudtrailBucket',
  guardduty: 'guarddutyBucket',
  waf: 'wafBucket',
} as const satisfies Record<LogSource, keyof AccountRow>;

/** O que vem da configuração do nó, igual para todas as contas. Nada disso é segredo. */
interface NodeFacts {
  /** Começo do nome dos tópicos do nó (`GCP_SINK_TOPIC_PREFIX`). */
  sinkTopicPrefix?: string | undefined;
  /** IPs de saída do nó (`NODE_EGRESS_IPS`). */
  egressIps: readonly string[];
  /** ID único da conta de serviço do nó no Google (`NODE_SA_UNIQUE_ID`); null quando o nó não informa. */
  serviceAccountId: string | null;
  /** Audience do token do nó (`AWS_WEB_IDENTITY_AUDIENCE`, ou o padrão do template). */
  audience: string;
}

/** Os buckets de log gravados na conta, por fonte. */
function bucketsOf(row: Pick<AccountRow, (typeof BUCKET_COLUMN)[LogSource]>): LogBuckets {
  return { cloudtrail: row.cloudtrailBucket, guardduty: row.guarddutyBucket, waf: row.wafBucket };
}

/** O dia de uma coluna `DATE` (o Prisma a devolve como meia-noite UTC): `AAAA-MM-DD`. */
function isoDate(day: Date | null): string | null {
  return day === null ? null : day.toISOString().slice(0, 10);
}

/**
 * Como a conta sai da API. Com o prefixo dos tópicos do nó, o projeto da GCP ganha o tópico do comando do sink; sem
 * ele (ambiente local), o tópico fica null. A conta AWS leva os três valores do nó que a pilha do papel de leitura pede
 * (o ID da conta de serviço, o audience e os IPs de saída) e o ARN do papel, derivado do ID; a do Cloudflare, os IPs de
 * saída, o filtro de IP recomendado para o token. Nenhum ExternalId: o papel não tem.
 */
function toAccount(row: AccountRow, node: NodeFacts): CloudAccount {
  const aws = row.provider === 'aws';
  const gcp = row.provider === 'gcp';
  const { credential } = row;
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.accountId,
    regions: aws ? row.regions : [],
    readerRoleArn: aws ? awsReaderRoleArn(row.accountId) : null,
    nodeServiceAccountId: aws ? node.serviceAccountId : null,
    webIdentityAudience: aws ? node.audience : null,
    buckets: bucketsOf(row),
    pubsubSubscription: row.pubsubSubscription,
    sinkTopic: gcp && node.sinkTopicPrefix ? `${node.sinkTopicPrefix}${row.accountId}` : null,
    sinkWriterIdentity: gcp ? row.sinkWriterIdentity : null,
    zones: row.zones,
    keyStatus: credential
      ? {
          kind: credential.kind,
          keyIdSuffix: credential.keyIdSuffix,
          issuedAt: credential.issuedAt?.toISOString() ?? null,
          expiresAt: credential.expiresAt?.toISOString() ?? null,
          verifiedAt: credential.verifiedAt.toISOString(),
          status: credentialStatus(credential.expiresAt),
        }
      : null,
    egressIps: gcp ? [] : [...node.egressIps],
    status: row.status,
    // Gravados pelo coletor da conta: só o worker escreve, nunca o request. O "Verificar" da AWS só pede. Na AWS, uma
    // conta conectada pode ter um aviso que não para a coleta (PR-V5': trilha, export, permissão demais, STS da região).
    connection: row.connection,
    connectionError:
      row.connection === 'error' ||
      (aws && row.connection === 'connected' && isAwsConnectionWarningCode(row.connectionError))
        ? row.connectionError
        : null,
    // AWS: o aviso da coleta pelo Wazuh do nó (PR-V4'), à parte da conexão; só a tarefa wazuh-config o grava.
    collectionError:
      aws && row.status === 'active' && isAwsCollectionErrorCode(row.collectionError)
        ? row.collectionError
        : null,
    checkRequestedAt: aws ? (row.checkRequestedAt?.toISOString() ?? null) : null,
    ingestFrom: aws ? isoDate(row.ingestFrom) : null,
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

/**
 * A conexão recomeça (outra fonte, como a assinatura do Pub/Sub ou a lista de buckets da AWS; credencial nova ou
 * removida; conta desativada ou reativada): aguardando, sem erro e sem "Verificar" pendente (a AWS pede de novo). A
 * última coleta é história.
 */
export const RESET_CONNECTION = {
  connection: 'waiting',
  connectionError: null,
  checkRequestedAt: null,
} as const satisfies Prisma.CloudAccountUpdateInput;

/** O que a trilha guarda do "Verificar": a conexão antes e depois do pedido. */
function checkState(row: Pick<AccountRow, 'connection' | 'connectionError' | 'checkRequestedAt'>) {
  return {
    connection: row.connection,
    connectionError: row.connectionError,
    checkRequestedAt: row.checkRequestedAt?.toISOString() ?? null,
  };
}

/** Dados próprios de cada provedor no cadastro. Os campos dos outros provedores ficam vazios. */
function providerData(input: CloudAccountCreate): Prisma.CloudAccountUncheckedCreateInput {
  const base = {
    provider: input.provider,
    accountId: input.accountId,
  } as Prisma.CloudAccountUncheckedCreateInput;
  switch (input.provider) {
    case 'aws':
      return { ...base, regions: input.regions, ...bucketData(input.buckets) };
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
 * Contas cloud dos clientes (T3.3): AWS, GCP e Cloudflare, pelo escopo da sessão. Nenhuma credencial entra pelo
 * cadastro: o schema é estrito; na AWS, o nó entra no papel de leitura sem chave que o cliente cria com o template
 * (o ARN é derivado do ID da conta, sem chave nem ExternalId), e o "Verificar" pede ao worker que confira. A
 * credencial de leitura do Cloudflare (o token) tem rota própria e vai cifrada para o cofre
 * (`credentials/credential-intake.service.ts`); a conta mostra só os metadados dela (`keyStatus`).
 *
 * Duas garantias que vinculam os alertas ao cliente certo (T5.2): o ID da conta é único por provedor, e cada
 * origem de log (bucket, assinatura do Pub/Sub, identidade do sink, zona do Cloudflare) pertence a um só cliente.
 *
 * Criar e reativar uma conta pedem vaga no plano do nó (fase 2, PR-18): só as contas ativas contam, e desativar libera
 * a vaga. O lock do plano vem antes dos locks das origens, sempre na mesma ordem.
 */
@Injectable()
export class CloudAccountsService {
  private readonly node: NodeFacts;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly plan: PlanService,
    @Inject(APP_CONFIG)
    config: Pick<
      AppConfig,
      'GCP_SINK_TOPIC_PREFIX' | 'NODE_EGRESS_IPS' | 'NODE_SA_UNIQUE_ID' | 'AWS_WEB_IDENTITY_AUDIENCE'
    >,
  ) {
    this.node = {
      sinkTopicPrefix: config.GCP_SINK_TOPIC_PREFIX,
      egressIps: config.NODE_EGRESS_IPS ?? [],
      serviceAccountId: config.NODE_SA_UNIQUE_ID ?? null,
      audience: config.AWS_WEB_IDENTITY_AUDIENCE ?? AWS_READER_AUDIENCE,
    };
  }

  async list(query: CloudAccountListQuery): Promise<Paginated<CloudAccount>> {
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
      rows.map((row) => toAccount(row, this.node)),
      total,
      query,
    );
  }

  async get(id: string): Promise<CloudAccount> {
    return toAccount(await this.find(id), this.node);
  }

  async create(auth: RequestAuth, input: CloudAccountCreate): Promise<CloudAccount> {
    const db = this.prisma.scoped();
    await this.plan.assertWithinPlan('cloudAccounts', auth.scopeTenantId as string, {
      action: 'cloud_account.create',
    });
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
    const account = toAccount(row, this.node);
    this.audit.describe({
      action: 'cloud_account.create',
      resourceType: 'cloud_account',
      resourceId: row.id,
      after: account,
    });
    return account;
  }

  async update(auth: RequestAuth, id: string, input: CloudAccountUpdate): Promise<CloudAccount> {
    // Ativar ou desativar ocupa ou libera uma vaga do plano: o lock vem antes da leitura da conta, e a decisão tomada
    // sobre o status lido vale até a gravação (uma desativação ao mesmo tempo espera, ou já foi confirmada e é lida).
    if (input.status !== undefined) await this.plan.lockSeats('cloudAccounts', auth.scopeTenantId as string);
    const beforeRow = await this.find(id);
    // Cada campo só existe num provedor: recusar, em vez de ignorar, evita achar que algo foi gravado.
    const foreign = fieldsOutsideProvider(beforeRow.provider, input);
    if (foreign.length > 0) {
      throw new ApiError(HttpStatus.BAD_REQUEST, `Campo que não existe nesta conta: ${foreign.join(', ')}`);
    }
    // Reativar ocupa de novo uma vaga do plano; a conta que já está ativa não pede outra.
    if (input.status === 'active' && beforeRow.status !== 'active') {
      await this.plan.assertWithinPlan('cloudAccounts', auth.scopeTenantId as string, {
        action: 'cloud_account.update',
        resourceId: id,
      });
    }
    await this.assertOriginsFree(auth, input, id);
    // Outra assinatura é outra fonte, e a conta desativada ou reativada recomeça: a conexão volta a "aguardando" até
    // o coletor confirmar a leitura de novo. Na AWS, outra lista de buckets também: a pilha do cliente precisa do
    // `LogBucketArns` novo, e o "Conectada" (ou o erro) da verificação anterior era de outra lista. A conexão volta a
    // aguardar, um "Verificar" pendente é descartado (o worker compara o pedido) e nada é pedido à AWS sozinho: o
    // cliente atualiza a pilha e clica em "Verificar". Trocar só a fonte de um bucket (os mesmos nomes) não muda nada
    // disso. O `ingestFrom` fica: é o dia em que o nó entrou no papel pela primeira vez.
    const bucketsChanged =
      input.buckets !== undefined &&
      !sameLogBucketNames(bucketsOf(beforeRow), mergeLogBuckets(bucketsOf(beforeRow), input.buckets));
    const sourceChanged =
      bucketsChanged ||
      (input.pubsubSubscription !== undefined && input.pubsubSubscription !== beforeRow.pubsubSubscription);
    const statusChanged = input.status !== undefined && input.status !== beforeRow.status;
    if (input.status === 'inactive') await this.wipeCredential(id);
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
    const after = toAccount(row, this.node);
    this.audit.describe({
      action: 'cloud_account.update',
      resourceType: 'cloud_account',
      resourceId: id,
      before: toAccount(beforeRow, this.node),
      after,
    });
    return after;
  }

  /**
   * Exclusão lógica: a conta deixa de ser lida e de receber alertas, mas o ID continua do cliente. A conexão volta a
   * "aguardando": parada, a conta não está conectada nem com erro. A credencial do cofre é apagada junto (D-13):
   * reativar pede colar de novo.
   */
  async deactivate(auth: RequestAuth, id: string): Promise<void> {
    // Libera uma vaga do plano: sob o mesmo lock da criação e da reativação, lido e gravado na mesma transação.
    await this.plan.lockSeats('cloudAccounts', auth.scopeTenantId as string);
    const before = await this.find(id);
    await this.wipeCredential(id);
    const row = await this.prisma.scoped().cloudAccount.update({
      where: { id },
      data: { status: 'inactive', ...RESET_CONNECTION },
      select: accountSelect,
    });
    this.audit.describe({
      action: 'cloud_account.deactivate',
      resourceType: 'cloud_account',
      resourceId: id,
      before: toAccount(before, this.node),
      after: toAccount(row, this.node),
    });
  }

  /**
   * "Verificar" a conta AWS (fase 2, PR-V3'): grava o pedido e volta a conexão para "aguardando", sem erro. Quem
   * confere é a tarefa `aws-check` do worker (`aws/aws-check.ts`), o único processo do nó que alcança o metadata da
   * GCP: a API não emite o token do Google nem entra no papel. Um pedido ainda pendente não é renovado: a verificação
   * em curso continua valendo, e clicar de novo não adia a resposta nem gera outra entrada no papel do cliente.
   */
  async requestAwsCheck(id: string): Promise<CloudAccount> {
    this.audit.describe({
      action: 'cloud_account.aws_verify',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const before = await this.find(id);
    if (before.provider !== 'aws') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Só uma conta AWS é verificada assim.');
    }
    if (before.status !== 'active') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Reative o monitoramento antes de verificar a conta.');
    }
    const row =
      before.checkRequestedAt !== null
        ? before
        : await this.prisma.scoped().cloudAccount.update({
            where: { id },
            data: { connection: 'waiting', connectionError: null, checkRequestedAt: new Date() },
            select: accountSelect,
          });
    this.audit.describe({ before: checkState(before), after: checkState(row) });
    return toAccount(row, this.node);
  }

  /**
   * Conta desativada não guarda credencial: a linha do cofre sai na mesma transação, sob o lock da conta (o mesmo da
   * troca pelo painel e da recifragem), com um registro próprio na trilha (`cloud_credential.wipe`, só metadados).
   */
  private async wipeCredential(id: string): Promise<void> {
    await lockCredential(this.prisma.db(), id);
    const db = this.prisma.scoped();
    const credential = await db.cloudCredential.findUnique({
      where: { cloudAccountId: id },
      select: { kind: true, keyIdSuffix: true, expiresAt: true },
    });
    if (!credential) return;
    await db.cloudCredential.delete({ where: { cloudAccountId: id }, select: { cloudAccountId: true } });
    this.audit.also({
      action: 'cloud_credential.wipe',
      resourceType: 'cloud_credential',
      resourceId: id,
      before: {
        kind: credential.kind,
        keyIdSuffix: credential.keyIdSuffix,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
      },
      after: null,
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
