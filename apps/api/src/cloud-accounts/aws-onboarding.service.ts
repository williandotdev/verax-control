import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  AWS_DISCOVERY_MANUAL_INTERVAL_MS,
  AWS_MAX_AUTHORIZED_LOG_GROUPS,
  AWS_MAX_AUTHORIZED_S3_SOURCES,
  AWS_MAX_AUTHORIZED_WEB_SOURCES,
  AWS_MAX_SOURCES_PER_ACCOUNT,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_RETRY_INTERVAL_MS,
  type AwsConnect,
  type AwsOnboarding,
  type AwsOnboardingErrorCode,
  type AwsSourceFeatures,
  type AwsSourceKind,
  type AwsSourcesAuthorize,
  type AwsWebLogsAcknowledgement,
  isAwsSourceCollectable,
  isAwsTemplateOutdated,
  WEB_OBSERVE_MS,
} from '@verax/shared';
import {
  DISCOVERY_RUN_SELECT,
  lockAwsOnboarding,
  requestAwsDiscovery,
} from '../aws/discovery/discovery-runs.js';
import { entersRole } from '../aws/onboarding/account-access.js';
import {
  lockAwsAccountRow,
  parseChosenCapabilities,
  serializeChosenCapabilities,
} from '../aws/onboarding/chosen-capabilities.js';
import { deriveAwsOnboarding } from '../aws/onboarding/onboarding-state.js';
import {
  accountCapabilities,
  gatedSource,
  isAuthorizedRow,
  runErrors,
  runSummary,
  SOURCE_SELECT,
  sourceFacts,
  type SourceRow,
  toRun,
  toSource,
} from '../aws/onboarding/onboarding-view.js';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { awsSourceFeatures } from '../common/config/web-logs.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PlanService } from '../plan/plan.service.js';
import {
  type AcknowledgementProblem,
  acknowledgementProblem,
  ESTIMATE_SELECT,
} from '../weblogs/settings/estimate.js';

const NOT_FOUND = 'Conta não encontrada';
const SOURCE_NOT_FOUND = 'Fonte não encontrada';

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  provider: true,
  status: true,
  connection: true,
  connectionError: true,
  collectionError: true,
  checkRequestedAt: true,
  ingestFrom: true,
  awsConnectRequestedAt: true,
  awsTemplateVersion: true,
  awsCapabilities: true,
  awsCapabilitiesCheckedAt: true,
  awsDiscoveredRegions: true,
  awsChosenCapabilities: true,
  updatedAt: true,
} as const satisfies Prisma.CloudAccountSelect;
type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** O que a trilha guarda do "Conectar": a conexão, os dois pedidos e a escolha das autorizações, antes e depois. */
function connectState(row: AccountRow) {
  return {
    connection: row.connection,
    connectionError: row.connectionError,
    checkRequestedAt: row.checkRequestedAt?.toISOString() ?? null,
    awsConnectRequestedAt: row.awsConnectRequestedAt?.toISOString() ?? null,
    chosenCapabilities: parseChosenCapabilities(row.awsChosenCapabilities),
  };
}

/** O que a trilha guarda de uma fonte: o que identifica a fonte e a autorização dela. Nenhum conteúdo de log. */
function sourceState(row: SourceRow) {
  return {
    id: row.id,
    kind: row.kind,
    region: row.region,
    resourceId: row.resourceId,
    state: row.state,
    authorizedAt: row.authorizedAt?.toISOString() ?? null,
    authorizedBy: row.authorizedBy,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    collectFrom: row.collectFrom?.toISOString().slice(0, 10) ?? null,
  };
}

/** A fonte é de um balanceador, lida pelo worker (os ataques web)? */
function isWebSource(row: Pick<SourceRow, 'kind'>): boolean {
  return AWS_SOURCE_KIND_INFO[row.kind as AwsSourceKind].feature === 'webLogs';
}

const ACKNOWLEDGEMENT_MESSAGES: Readonly<Record<AcknowledgementProblem, string>> = {
  WEB_LOGS_ESTIMATE_REQUIRED: 'Peça a estimativa de volume deste balanceador antes de autorizá-lo.',
  WEB_LOGS_ESTIMATE_CHANGED: 'A estimativa de volume deste balanceador mudou. Confira de novo.',
  WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED: 'Confirme a estimativa de volume deste balanceador para autorizá-lo.',
};

/** O dia de hoje em UTC, para a coluna `DATE`: a coleta de uma fonte começa no dia da autorização. */
function utcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function refusal(status: HttpStatus, message: string, code: AwsOnboardingErrorCode): ApiError {
  return new ApiError(status, message, code);
}

/**
 * O onboarding self-service de uma conta AWS (`docs/ARQUITETURA.md`, "Onboarding AWS self-service"), pelo escopo da
 * sessão: o estado da conexão, o "Conectar", a descoberta manual e a autorização das fontes. A API nunca fala com a
 * AWS: grava o pedido, e quem entra no papel é o worker (`aws-check` e `aws-discovery`), o único processo do nó com a
 * identidade.
 *
 * - **Leitura** (`cloud_accounts:read`): o estado e as conferências são derivados na hora (`deriveAwsOnboarding`), do
 *   que está gravado na conta, na descoberta mais recente e nas fontes.
 * - **Escritas** (`cloud_accounts:write`), todas auditadas na trilha do cliente com quem pediu, quando e o quê. As
 *   fontes e a autorização são do cliente também na conta que a Verax cadastrou pelo console: lá, só os campos do
 *   cadastro (regiões, buckets, monitoramento) são do console.
 * - **A autorização** só vale para a fonte que existe, é de um tipo coletado, o papel lê e não repete um bucket do
 *   cadastro anterior; a coleta começa no dia da autorização (sem histórico). As fontes sensíveis (os grupos do
 *   CloudWatch Logs) só entram citadas uma a uma na confirmação. Tudo ou nada: uma fonte recusada recusa o pedido.
 *   O plano não bloqueia fonte nenhuma; os tetos são de quantidade (`AWS_MAX_AUTHORIZED_*`).
 * - **O balanceador** (`elb_logs`), só no nó com os ataques web ligados, leva a ciência da estimativa de volume (D1: os bytes
 *   contam no plano) e começa observando por 72 h (`WebSourceSettings`), também na nova autorização depois de uma retirada.
 *   O plano também não o bloqueia: acima de 20%, o cliente confirma que viu. Retirar a autorização vale sempre, até com os
 *   ataques web desligados.
 * - O lock da conta (`lockAwsOnboarding`) serializa a autorização, a revogação e a gravação da descoberta pelo worker.
 */
@Injectable()
export class AwsOnboardingService {
  private readonly credentialMode: AwsOnboarding['credentialMode'];
  /** Célula compartilhada: a descoberta ainda não roda lá (a coleta da AWS na célula não foi construída). */
  private readonly sharedCell: boolean;
  /** O que este nó tem ligado e muda o que ele coleta. */
  private readonly features: AwsSourceFeatures;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly plan: PlanService,
    @Inject(APP_CONFIG)
    config: Pick<AppConfig, 'NODE_PLATFORM' | 'cell' | 'NODE_MODE' | 'AWS_WEB_LOGS_ENABLED'>,
  ) {
    this.credentialMode = config.NODE_PLATFORM === 'vm' ? 'access_key' : 'role';
    this.sharedCell = config.cell !== null;
    this.features = awsSourceFeatures(config);
  }

  async get(id: string): Promise<AwsOnboarding> {
    return this.view(await this.find(id));
  }

  /**
   * "Conectar com AWS": grava o pedido do "Conectar" e o da verificação com o mesmo horário, e volta a conexão para
   * "aguardando". A tarefa `aws-check` passa a tentar a entrada no papel por até 60 min (o cliente está criando a
   * pilha) e, na primeira que der certo, lê as tags do papel e pede a descoberta. Um "Conectar" ainda pendente não é
   * renovado: clicar de novo não adia o fim da janela.
   *
   * Com as autorizações que o cliente marcou no painel (`capabilities`), a escolha é gravada junto, também no pedido
   * ainda pendente (o cliente mudou as caixas enquanto esperava a pilha e baixou o arquivo de novo): é o que a tela
   * devolve depois de recarregada. Sem elas, a escolha gravada fica como está. A escolha nunca dá permissão: o que o
   * papel pode ler vem das tags dele.
   *
   * A escolha do pedido é a verdade: é gravada como veio (na ordem do catálogo), com a linha da conta presa
   * (`lockAwsAccountRow`), e nunca decidida por uma leitura de antes. Dois pedidos quase juntos terminam com a escolha
   * de um dos dois, a do último a ser gravado; o mesmo pedido de novo não muda nada; e a resposta de cada um traz o que
   * ficou gravado depois dele. O antes e o depois da trilha são lidos com a linha presa: só mostram mudança quando o
   * valor gravado mudou.
   */
  async connect(id: string, input: AwsConnect = {}): Promise<AwsOnboarding> {
    this.audit.describe({
      action: 'cloud_account.aws_connect',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const inactive = 'Reative o monitoramento antes de conectar a conta.';
    const account = await this.find(id);
    this.assertActive(account, inactive);
    // Daqui até o fim da transação, só este pedido lê e grava o "Conectar" e a escolha desta conta.
    await lockAwsAccountRow(this.prisma.db(), account);
    const before = await this.find(id);
    this.assertActive(before, inactive);
    const pendingConnect =
      before.checkRequestedAt !== null &&
      before.awsConnectRequestedAt !== null &&
      before.checkRequestedAt.getTime() === before.awsConnectRequestedAt.getTime();
    const now = new Date();
    const chosen =
      input.capabilities === undefined ? undefined : serializeChosenCapabilities(input.capabilities);
    const row =
      pendingConnect && chosen === undefined
        ? before
        : await this.prisma.scoped().cloudAccount.update({
            where: { id },
            data: {
              ...(!pendingConnect && {
                connection: 'waiting',
                connectionError: null,
                checkRequestedAt: now,
                awsConnectRequestedAt: now,
              }),
              // Gravada como veio, sem comparar com a de antes: a mesma de novo deixa o valor como está.
              ...(chosen !== undefined && { awsChosenCapabilities: chosen }),
            },
            select: ACCOUNT_SELECT,
          });
    this.audit.describe({ before: connectState(before), after: connectState(row) });
    return this.view(row);
  }

  /**
   * A descoberta manual: grava o pedido, que a tarefa `aws-discovery` executa. Com outra pendente ou em curso, não cria
   * nada (a resposta mostra a que existe); a menos de 5 min da última manual, 429.
   */
  async requestDiscovery(auth: RequestAuth, id: string): Promise<AwsOnboarding> {
    this.audit.describe({
      action: 'cloud_account.aws_discovery_request',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const account = await this.find(id);
    this.assertActive(account, 'Reative o monitoramento antes de descobrir as fontes.');
    this.assertDiscovers(account);
    const tx = this.prisma.db();
    await lockAwsOnboarding(tx, id);
    const db = this.prisma.scoped();
    const now = new Date();
    const active = await db.awsDiscoveryRun.count({
      where: { cloudAccountId: id, status: { in: ['pending', 'running'] } },
    });
    if (active === 0) {
      const lastManual = await db.awsDiscoveryRun.findFirst({
        where: { cloudAccountId: id, trigger: 'manual' },
        orderBy: { requestedAt: 'desc' },
        select: { requestedAt: true },
      });
      if (
        lastManual !== null &&
        now.getTime() - lastManual.requestedAt.getTime() < AWS_DISCOVERY_MANUAL_INTERVAL_MS
      ) {
        throw refusal(
          HttpStatus.TOO_MANY_REQUESTS,
          'A descoberta acabou de rodar. Tente de novo em alguns minutos.',
          'DISCOVERY_RATE_LIMITED',
        );
      }
    }
    const { run, created } = await requestAwsDiscovery(tx, {
      tenantId: account.tenantId,
      cloudAccountId: id,
      trigger: 'manual',
      requestedBy: auth.userId,
      now,
    });
    this.audit.describe({ after: { runId: run.id, trigger: run.trigger, status: run.status, created } });
    return this.view(account);
  }

  async authorize(auth: RequestAuth, id: string, input: AwsSourcesAuthorize): Promise<AwsOnboarding> {
    this.audit.describe({
      action: 'cloud_account.aws_source_authorized',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const account = await this.find(id);
    this.assertActive(account, 'Reative o monitoramento antes de autorizar uma fonte.');
    await lockAwsOnboarding(this.prisma.db(), id);
    const db = this.prisma.scoped();
    const rows = await db.awsSource.findMany({
      where: { cloudAccountId: id, id: { in: input.sourceIds } },
      select: SOURCE_SELECT,
      orderBy: { id: 'asc' },
    });
    // Uma fonte de outra conta (ou de outro cliente) é como se não existisse.
    if (rows.length !== input.sourceIds.length) throw new ApiError(HttpStatus.NOT_FOUND, SOURCE_NOT_FOUND);
    const confirmed = new Set(input.sensitiveSourceIds ?? []);
    // A linha de um bucket do cadastro já nasce autorizada, mas não é daqui que ela muda: o pedido que a cita é recusado.
    for (const row of rows) this.assertNotLegacy(row);
    // A fonte que já está autorizada fica como está (quem autorizou e desde quando não mudam).
    const pending = rows.filter((row) => !isAuthorizedRow(row) || row.state === 'source_missing');
    for (const row of pending) this.assertAuthorizable(row, confirmed);
    await this.assertWithinLimits(id, pending);
    const acknowledgements = new Map((input.webLogs ?? []).map((item) => [item.sourceId, item]));
    if (rows.some((row) => !isWebSource(row) && acknowledgements.has(row.id))) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'A estimativa de volume é só dos balanceadores.');
    }
    const now = new Date();
    const balancers = pending.filter(isWebSource);
    await this.assertAcknowledged(account.tenantId, balancers, acknowledgements, now);

    for (const row of pending) {
      await db.awsSource.update({
        where: { id: row.id },
        data: {
          authorizedAt: now,
          authorizedBy: auth.userId,
          revokedAt: null,
          collectFrom: utcDay(now),
          state: 'authorized',
          stateCode: 'awaiting_collector',
          stateSince: now,
        },
        select: { id: true },
      });
    }
    const observeUntil = new Date(now.getTime() + WEB_OBSERVE_MS);
    for (const row of balancers) await this.observe(auth, row, observeUntil);
    const after = await db.awsSource.findMany({
      where: { cloudAccountId: id, id: { in: input.sourceIds } },
      select: SOURCE_SELECT,
      orderBy: { id: 'asc' },
    });
    const observed = new Set(balancers.map((row) => row.id));
    this.audit.describe({
      before: rows.map(sourceState),
      after: after.map((row) => ({
        ...sourceState(row),
        // O que o cliente viu e confirmou, e até quando o balanceador só observa.
        ...(observed.has(row.id) && {
          estimate: acknowledgements.get(row.id),
          mode: 'observe',
          observeUntil: observeUntil.toISOString(),
        }),
      })),
    });
    return this.view(account);
  }

  /**
   * Tira a autorização de uma fonte: ela sai da coleta, e a linha fica (com quem autorizou e quando). Vale também para o
   * balanceador de um nó que desligou os ataques web: tirar a autorização nunca depende deles. A configuração do balanceador
   * fica; o que saiu da leitura dele (tráfego, objetos, resumo do dia) sai pela retenção.
   */
  async revoke(id: string, sourceId: string): Promise<AwsOnboarding> {
    this.audit.describe({
      action: 'cloud_account.aws_source_revoked',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const account = await this.find(id);
    await lockAwsOnboarding(this.prisma.db(), id);
    const db = this.prisma.scoped();
    const row = await this.findSource(id, sourceId);
    this.assertNotLegacy(row);
    if (!isAuthorizedRow(row)) {
      throw refusal(HttpStatus.CONFLICT, 'Esta fonte não está autorizada.', 'SOURCE_NOT_AUTHORIZED');
    }
    const now = new Date();
    const after = await db.awsSource.update({
      where: { id: sourceId },
      data: { revokedAt: now, state: 'revoked', stateCode: null, stateSince: now },
      select: SOURCE_SELECT,
    });
    this.audit.describe({ before: sourceState(row), after: sourceState(after) });
    return this.view(account);
  }

  /**
   * "Tentar de novo" numa fonte: pede ao worker que confira de novo a permissão dela (depois de o cliente pôr a tag no
   * grupo, atualizar a pilha ou corrigir a política do bucket). Um pedido ainda pendente não é renovado. Respondido o
   * pedido, o seguinte para a mesma fonte só vale 30 s depois dele (429 `SOURCE_RETRY_RATE_LIMITED`): a sondagem de uma
   * fonte que sumiu pede uma descoberta da conta, fora do limite da manual, e este limite (com o de uma execução por vez
   * na conta) contém quantas descobertas o botão consegue pedir.
   */
  async retry(id: string, sourceId: string): Promise<AwsOnboarding> {
    this.audit.describe({
      action: 'cloud_account.aws_source_retry',
      resourceType: 'cloud_account',
      resourceId: id,
    });
    const account = await this.find(id);
    this.assertActive(account, 'Reative o monitoramento antes de conferir uma fonte.');
    // O lock da conta: dois pedidos ao mesmo tempo não passam os dois pelo limite.
    await lockAwsOnboarding(this.prisma.db(), id);
    const row = await this.findSource(id, sourceId);
    this.assertNotLegacy(row);
    this.assertDiscovers(account);
    const now = new Date();
    if (
      row.probeRequestedAt === null &&
      row.lastProbeRequestAt !== null &&
      now.getTime() - row.lastProbeRequestAt.getTime() < AWS_SOURCE_RETRY_INTERVAL_MS
    ) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'Esta fonte acabou de ser conferida. Tente de novo em alguns segundos.',
        'SOURCE_RETRY_RATE_LIMITED',
      );
    }
    const after =
      row.probeRequestedAt !== null
        ? row
        : await this.prisma.scoped().awsSource.update({
            where: { id: sourceId },
            data: { probeRequestedAt: now, lastProbeRequestAt: now },
            select: SOURCE_SELECT,
          });
    this.audit.describe({
      before: { id: row.id, probeRequestedAt: row.probeRequestedAt?.toISOString() ?? null },
      after: { id: after.id, probeRequestedAt: after.probeRequestedAt?.toISOString() ?? null },
    });
    return this.view(account);
  }

  // --- Regras ---

  private assertActive(account: AccountRow, message: string): void {
    if (account.status !== 'active') throw new ApiError(HttpStatus.BAD_REQUEST, message);
  }

  /**
   * Este nó descobre as fontes sozinho? Na célula compartilhada, ainda não (a tarefa `aws-discovery` não roda lá). A
   * resposta diz isso ao painel (`discoveryAvailable`), que deixa de oferecer o que `assertDiscovers` recusaria.
   */
  private get discovers(): boolean {
    return !this.sharedCell;
  }

  /** A descoberta e a sondagem precisam de um nó que as execute e de uma conta em que o nó entra. */
  private assertDiscovers(account: AccountRow): void {
    if (!this.discovers) {
      throw refusal(
        HttpStatus.CONFLICT,
        'A descoberta das fontes ainda não está disponível neste ambiente.',
        'DISCOVERY_UNAVAILABLE',
      );
    }
    if (account.checkRequestedAt !== null || !entersRole(account)) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Conecte a conta antes de descobrir as fontes.',
        'ACCOUNT_NOT_CONNECTED',
      );
    }
  }

  private assertNotLegacy(row: SourceRow): void {
    if (row.origin === 'legacy') {
      throw refusal(
        HttpStatus.CONFLICT,
        'Esta fonte é um bucket do cadastro da conta: altere-o no cadastro.',
        'SOURCE_LEGACY',
      );
    }
  }

  /** A fonte pode ser autorizada? A primeira regra que falha recusa o pedido inteiro. */
  private assertAuthorizable(row: SourceRow, confirmed: ReadonlySet<string>): void {
    this.assertNotLegacy(row);
    if (!isAwsSourceCollectable(row.kind as AwsSourceKind, this.features)) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Este tipo de fonte ainda não é coletado.',
        'SOURCE_NOT_COLLECTABLE',
      );
    }
    if (row.availability !== 'available' || row.missingSince !== null) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Esta fonte não está disponível para coleta. Rode a descoberta de novo.',
        'SOURCE_NOT_AVAILABLE',
      );
    }
    if (row.notes.includes('covered_by_legacy')) {
      throw refusal(
        HttpStatus.CONFLICT,
        'O bucket desta fonte já é lido pelo cadastro da conta.',
        'SOURCE_COVERED_BY_LEGACY',
      );
    }
    if (row.permission !== 'granted') {
      throw refusal(
        HttpStatus.CONFLICT,
        'O Verax ainda não tem permissão para ler esta fonte.',
        'SOURCE_PERMISSION_MISSING',
      );
    }
    if (row.sensitive && !confirmed.has(row.id)) {
      throw refusal(
        HttpStatus.BAD_REQUEST,
        'Confirme cada fonte sensível, uma a uma, para autorizá-la.',
        'SENSITIVE_CONFIRMATION_REQUIRED',
      );
    }
  }

  /** Cada balanceador do pedido leva a ciência da estimativa dele, conferida com a gravada. */
  private async assertAcknowledged(
    tenantId: string,
    balancers: readonly SourceRow[],
    acknowledgements: ReadonlyMap<string, AwsWebLogsAcknowledgement>,
    now: Date,
  ): Promise<void> {
    if (balancers.length === 0) return;
    const estimates = await this.prisma.scoped().webSourceEstimate.findMany({
      where: { sourceId: { in: balancers.map((row) => row.id) } },
      select: ESTIMATE_SELECT,
    });
    const allowance = await this.plan.volumeAllowance(tenantId);
    for (const row of balancers) {
      const problem = acknowledgementProblem(
        estimates.find((estimate) => estimate.sourceId === row.id),
        acknowledgements.get(row.id),
        allowance,
        now,
      );
      if (problem !== null) throw refusal(HttpStatus.CONFLICT, ACKNOWLEDGEMENT_MESSAGES[problem], problem);
    }
  }

  /**
   * O balanceador recém-autorizado só observa (conta, sem abrir achado) até `observeUntil`. Na nova autorização, a observação
   * recomeça, porque o tráfego pode ser outro; o multiplicador, as rotas e as fontes confiáveis de antes continuam.
   */
  private async observe(auth: RequestAuth, row: SourceRow, observeUntil: Date): Promise<void> {
    const start = { mode: 'observe', observeUntil, updatedBy: auth.userId };
    await this.prisma.scoped().webSourceSettings.upsert({
      where: { sourceId_tenantId: { sourceId: row.id, tenantId: row.tenantId } },
      create: { sourceId: row.id, ...start } as Prisma.WebSourceSettingsUncheckedCreateInput,
      update: start,
      select: { sourceId: true },
    });
  }

  /** Os tetos de quantidade da conta: grupos do CloudWatch Logs e fontes lidas de bucket (destas, os balanceadores). */
  private async assertWithinLimits(cloudAccountId: string, adding: readonly SourceRow[]): Promise<void> {
    const groups = adding.filter((row) => row.method === 'cloudwatch').length;
    const buckets = adding.filter((row) => row.method === 's3').length;
    const balancers = adding.filter(isWebSource).length;
    if (groups === 0 && buckets === 0) return;
    const db = this.prisma.scoped();
    const authorized = { cloudAccountId, authorizedAt: { not: null }, revokedAt: null } as const;
    const ids = adding.map((row) => row.id);
    const [currentGroups, currentBuckets, currentBalancers] = await Promise.all([
      db.awsSource.count({ where: { ...authorized, method: 'cloudwatch', id: { notIn: ids } } }),
      db.awsSource.count({ where: { ...authorized, method: 's3', id: { notIn: ids } } }),
      balancers === 0
        ? 0
        : db.awsSource.count({ where: { ...authorized, kind: 'elb_logs', id: { notIn: ids } } }),
    ]);
    if (
      (groups > 0 && currentGroups + groups > AWS_MAX_AUTHORIZED_LOG_GROUPS) ||
      (buckets > 0 && currentBuckets + buckets > AWS_MAX_AUTHORIZED_S3_SOURCES) ||
      (balancers > 0 && currentBalancers + balancers > AWS_MAX_AUTHORIZED_WEB_SOURCES)
    ) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Esta conta já tem o máximo de fontes deste tipo autorizadas.',
        'SOURCE_LIMIT_REACHED',
      );
    }
  }

  // --- Leitura ---

  private async find(id: string): Promise<AccountRow> {
    const row = await this.prisma.scoped().cloudAccount.findUnique({ where: { id }, select: ACCOUNT_SELECT });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    if (row.provider !== 'aws')
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Só uma conta AWS tem fontes da AWS.');
    return row;
  }

  private async findSource(cloudAccountId: string, sourceId: string): Promise<SourceRow> {
    const row = await this.prisma
      .scoped()
      .awsSource.findFirst({ where: { id: sourceId, cloudAccountId }, select: SOURCE_SELECT });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, SOURCE_NOT_FOUND);
    return row;
  }

  /** O estado da conta como a API o devolve: sempre lido de novo, para a resposta de uma escrita já trazer o que mudou. */
  private async view(account: AccountRow): Promise<AwsOnboarding> {
    const db = this.prisma.scoped();
    const current =
      (await db.cloudAccount.findUnique({ where: { id: account.id }, select: ACCOUNT_SELECT })) ?? account;
    const [latest, completed, stored] = await Promise.all([
      db.awsDiscoveryRun.findFirst({
        where: { cloudAccountId: current.id },
        orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
        select: DISCOVERY_RUN_SELECT,
      }),
      db.awsDiscoveryRun.findFirst({
        where: { cloudAccountId: current.id, status: { in: ['succeeded', 'partial'] } },
        orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
        select: { finishedAt: true, summary: true },
      }),
      db.awsSource.findMany({
        where: { cloudAccountId: current.id },
        select: SOURCE_SELECT,
        orderBy: [{ kind: 'asc' }, { region: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        take: AWS_MAX_SOURCES_PER_ACCOUNT,
      }),
    ]);
    // O tipo que depende de uma funcionalidade desligada aqui aparece como no nó que nunca a teve.
    const rows = stored.flatMap((row) => gatedSource(row, this.features) ?? []);
    const derived = deriveAwsOnboarding({
      account: current,
      latestRun:
        latest === null
          ? null
          : {
              status: toRun(latest).status,
              finishedAt: latest.finishedAt,
              firstErrorCode: runErrors(latest.errors)[0]?.code ?? null,
            },
      lastCompletedAt: completed?.finishedAt ?? null,
      // As linhas dos buckets cadastrados entram com a permissão que a conferência da conexão provou.
      sources: rows.map((row) => sourceFacts(row, current)),
    });
    const updatedAt = [
      current.updatedAt,
      latest?.updatedAt,
      ...rows.map((row) => row.updatedAt),
    ].reduce<Date>((latestAt, at) => (at !== undefined && at > latestAt ? at : latestAt), current.updatedAt);
    return {
      cloudAccountId: current.id,
      state: derived.state,
      credentialMode: this.credentialMode,
      connect: {
        requestedAt: current.awsConnectRequestedAt?.toISOString() ?? null,
        waitingUntil: derived.waitingUntil?.toISOString() ?? null,
        capabilities: parseChosenCapabilities(current.awsChosenCapabilities),
      },
      checks: derived.checks,
      template: {
        version: current.awsTemplateVersion,
        capabilities: accountCapabilities(current.awsCapabilities),
        outdated: isAwsTemplateOutdated(current.awsTemplateVersion),
        checkedAt: current.awsCapabilitiesCheckedAt?.toISOString() ?? null,
      },
      discovery: {
        run: latest === null ? null : toRun(latest),
        lastCompletedAt: completed?.finishedAt?.toISOString() ?? null,
        regions: current.awsDiscoveredRegions.slice(0, 64),
      },
      discoveryAvailable: this.discovers,
      infrastructure: completed === null ? null : runSummary(completed.summary),
      sources: rows.map((row) => toSource(row, current, new Date(), this.features)),
      updatedAt: updatedAt.toISOString(),
    };
  }
}
