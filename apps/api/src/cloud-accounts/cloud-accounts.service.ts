import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AWS_READER_AUDIENCE,
  type AwsConnect,
  type CloudAccount,
  type CloudAccountCreate,
  type CloudAccountListQuery,
  type CloudAccountUpdate,
  CONSOLE_MANAGED_CODE,
  fieldsOutsideProvider,
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
import {
  type AccountRow,
  accountSelect,
  bucketData,
  bucketsOf,
  type NodeFacts,
  providerData,
  RESET_CONNECTION,
  toAccount,
} from './cloud-account-data.js';
import {
  lockAwsAccountRow,
  parseChosenCapabilities,
  serializeChosenCapabilities,
} from '../aws/onboarding/chosen-capabilities.js';
import { syncLegacyAwsSources } from '../aws/onboarding/legacy-sources.js';
import { assertLogOriginsFree, type LogOrigins } from './log-origins.js';

// A credencial e as tarefas do worker importam daqui desde antes da extração para `cloud-account-data.ts`.
export { RESET_CONNECTION } from './cloud-account-data.js';

const NOT_FOUND = 'Conta não encontrada';

/** O que a trilha guarda do "Verificar": a conexão antes e depois do pedido. */
function checkState(row: Pick<AccountRow, 'connection' | 'connectionError' | 'checkRequestedAt'>) {
  return {
    connection: row.connection,
    connectionError: row.connectionError,
    checkRequestedAt: row.checkRequestedAt?.toISOString() ?? null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Campos do cadastro que, na conta que a Verax cadastrou pelo console (`origin = control_plane`), só o console muda: a
 * fonte (regiões, buckets, assinatura, identidade do sink, zonas) e o monitoramento (desativar e reativar). A credencial
 * e o "Verificar" continuam com o cliente.
 */
const CONSOLE_OWNED_FIELDS = [
  'regions',
  'buckets',
  'pubsubSubscription',
  'sinkWriterIdentity',
  'zones',
  'status',
] as const satisfies readonly (keyof CloudAccountUpdate)[];

/** A recusa do painel na conta do console: 409 com o código que o painel reconhece. */
function consoleManaged(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    'Cadastrada pela Verax: peça a alteração à Verax.',
    CONSOLE_MANAGED_CODE,
  );
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
  /** Célula (CE-01): a recusa de origem repetida não diz se ela está em outro cliente. */
  private readonly sharedCell: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly plan: PlanService,
    @Inject(APP_CONFIG)
    config: Pick<
      AppConfig,
      'GCP_SINK_TOPIC_PREFIX' | 'NODE_EGRESS_IPS' | 'NODE_SA_UNIQUE_ID' | 'AWS_WEB_IDENTITY_AUDIENCE' | 'cell'
    >,
  ) {
    this.sharedCell = config.cell !== null;
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
    // Os buckets do cadastro aparecem como fontes da conta (onboarding self-service), já autorizadas.
    if (input.provider === 'aws') await syncLegacyAwsSources(db, row.id);
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
    // A conta que a Verax cadastrou pelo console: a fonte e o monitoramento só mudam por lá (a sincronização com o plano
    // de controle desfaria a alteração do painel na revisão seguinte).
    if (
      beforeRow.origin === 'control_plane' &&
      CONSOLE_OWNED_FIELDS.some((field) => input[field] !== undefined)
    ) {
      this.audit.describe({ action: 'cloud_account.update', resourceType: 'cloud_account', resourceId: id });
      throw consoleManaged();
    }
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
    // Um bucket que entrou, mudou ou saiu: as fontes da conta acompanham o cadastro.
    if (input.buckets !== undefined) await syncLegacyAwsSources(this.prisma.scoped(), id);
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
    // A conta que a Verax cadastrou pelo console só é removida por lá (a lápide da sincronização).
    if (before.origin === 'control_plane') {
      this.audit.describe({
        action: 'cloud_account.deactivate',
        resourceType: 'cloud_account',
        resourceId: id,
      });
      throw consoleManaged();
    }
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
   *
   * Com as autorizações que o cliente marcou no painel (`capabilities`, depois de atualizar a pilha ou a política do
   * usuário de leitura), a escolha é gravada junto, mesmo com um pedido pendente, com o antes e o depois na trilha. Sem
   * elas, a escolha gravada fica como está.
   *
   * Como no "Conectar" (`AwsOnboardingService.connect`), a linha da conta fica presa enquanto o pedido lê e grava
   * (`lockAwsAccountRow`), e a escolha do pedido é gravada como veio: dois pedidos quase juntos terminam com a escolha
   * do último a ser gravado, e o antes da trilha é o que o pedido anterior deixou.
   */
  async requestAwsCheck(id: string, input: AwsConnect = {}): Promise<CloudAccount> {
    this.audit.describe({
      action: 'cloud_account.aws_verify',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const verifiable = (row: AccountRow): void => {
      if (row.provider !== 'aws') {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'Só uma conta AWS é verificada assim.');
      }
      if (row.status !== 'active') {
        throw new ApiError(HttpStatus.BAD_REQUEST, 'Reative o monitoramento antes de verificar a conta.');
      }
    };
    const account = await this.find(id);
    verifiable(account);
    // Daqui até o fim da transação, só este pedido lê e grava o pedido da verificação e a escolha desta conta.
    await lockAwsAccountRow(this.prisma.db(), account);
    const before = await this.find(id);
    verifiable(before);
    const db = this.prisma.scoped();
    const chosen =
      input.capabilities === undefined ? undefined : serializeChosenCapabilities(input.capabilities);
    // A escolha de antes só é lida quando o pedido traz uma: é o "antes" dela na trilha.
    const stored =
      chosen === undefined
        ? undefined
        : ((await db.cloudAccount.findUnique({ where: { id }, select: { awsChosenCapabilities: true } }))
            ?.awsChosenCapabilities ?? null);
    const pending = before.checkRequestedAt !== null;
    const row =
      pending && chosen === undefined
        ? before
        : await db.cloudAccount.update({
            where: { id },
            data: {
              ...(!pending && { connection: 'waiting', connectionError: null, checkRequestedAt: new Date() }),
              // Gravada como veio, sem comparar com a de antes: a mesma de novo deixa o valor como está.
              ...(chosen !== undefined && { awsChosenCapabilities: chosen }),
            },
            select: accountSelect,
          });
    this.audit.describe({
      before: {
        ...checkState(before),
        ...(stored !== undefined && { chosenCapabilities: parseChosenCapabilities(stored) }),
      },
      after: {
        ...checkState(row),
        ...(chosen !== undefined && { chosenCapabilities: parseChosenCapabilities(chosen) }),
      },
    });
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

  /** As origens de log livres (`assertLogOriginsFree`), na transação da requisição e para o cliente da sessão. */
  private assertOriginsFree(auth: RequestAuth, origins: LogOrigins, exceptId?: string): Promise<void> {
    return assertLogOriginsFree(this.prisma.db(), origins, {
      tenantId: auth.scopeTenantId as string,
      exceptId,
      sharedCell: this.sharedCell,
    });
  }
}
