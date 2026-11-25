import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type AwsSourceState,
  hasCodeOverlap,
  hasPermission,
  isTrustedExpiryValid,
  type VolumeAllowance,
  WEB_ESTIMATE_REQUEST_INTERVAL_MS,
  WEB_HEALTH_WINDOW_MS,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_LIMIT,
  webLoadBalancerSchema,
  type WebLogsErrorCode,
  type WebLogSource,
  type WebLogSourceList,
  type WebLogSourceListQuery,
  type WebRoute,
  type WebRouteCreate,
  type WebRouteKind,
  type WebRouteList,
  type WebRouteMethod,
  type WebRouteUpdate,
  webObservationSchema,
  type WebSourceHealth,
  webSourceHealthSchema,
  type WebSourceMode,
  type WebSourceSettings,
  type WebSourceSettingsUpdate,
  type WebTrustedKind,
  type WebTrustedSource,
  type WebTrustedSourceCreate,
  type WebTrustedSourceList,
  type WebTrustedSourceUpdate,
} from '@verax/shared';
import { parseLoadBalancerArn } from '../../aws/discovery/catalogue.js';
import { lockAwsOnboarding } from '../../aws/discovery/discovery-runs.js';
import { entersRole } from '../../aws/onboarding/account-access.js';
import { isAuthorizedRow, sourceDetails } from '../../aws/onboarding/onboarding-view.js';
import { AuditContext } from '../../common/audit/audit-context.service.js';
import type { RequestAuth } from '../../common/auth/request-auth.js';
import { ApiError } from '../../common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../../common/http/pagination.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PlanService } from '../../plan/plan.service.js';
import { SLOT_MS } from '../limits.js';
import { observedSince } from '../observed-since.js';
import { ENGINE_STATE_VERSION, readWebEngineView, type WebEngineView } from '../store/web-engine-state.js';
import type { WebLogObjectStatus } from '../store/web-object-ledger.js';
import { ESTIMATE_SELECT, type EstimateRow, toEstimate } from './estimate.js';

const SOURCE_NOT_FOUND = 'Balanceador não encontrado';

/** O tipo das fontes daqui: só as descobertas, de um balanceador. */
const BALANCER = { kind: 'elb_logs', origin: 'discovered' } as const;

const SOURCE_SELECT = {
  id: true,
  cloudAccountId: true,
  region: true,
  name: true,
  details: true,
  availability: true,
  permission: true,
  missingSince: true,
  authorizedAt: true,
  revokedAt: true,
  state: true,
} as const satisfies Prisma.AwsSourceSelect;
type SourceRow = Prisma.AwsSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

const SETTINGS_SELECT = {
  sourceId: true,
  mode: true,
  observeUntil: true,
  thresholdMultiplier: true,
  updatedAt: true,
  updatedBy: true,
} as const satisfies Prisma.WebSourceSettingsSelect;
type SettingsRow = Prisma.WebSourceSettingsGetPayload<{ select: typeof SETTINGS_SELECT }>;

const TRUSTED_SELECT = {
  id: true,
  sourceId: true,
  cidr: true,
  kind: true,
  reason: true,
  expiresAt: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} as const satisfies Prisma.WebTrustedSourceSelect;
type TrustedRow = Prisma.WebTrustedSourceGetPayload<{ select: typeof TRUSTED_SELECT }>;

const ROUTE_SELECT = {
  id: true,
  sourceId: true,
  host: true,
  method: true,
  path: true,
  kind: true,
  failureCodes: true,
  successCodes: true,
  multiplier: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
} as const satisfies Prisma.WebRouteSelect;
type RouteRow = Prisma.WebRouteGetPayload<{ select: typeof ROUTE_SELECT }>;

function toSettings(row: SettingsRow): WebSourceSettings {
  return {
    mode: row.mode as WebSourceMode,
    observeUntil: row.observeUntil?.toISOString() ?? null,
    thresholdMultiplier: row.thresholdMultiplier,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy,
  };
}

function toTrusted(row: TrustedRow, now: Date): WebTrustedSource {
  return {
    ...row,
    kind: row.kind as WebTrustedKind,
    expiresAt: row.expiresAt.toISOString(),
    active: row.expiresAt > now,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRoute(row: RouteRow): WebRoute {
  return {
    ...row,
    method: row.method as WebRouteMethod,
    kind: row.kind as WebRouteKind,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function refusal(status: HttpStatus, message: string, code: WebLogsErrorCode): ApiError {
  return new ApiError(status, message, code);
}

/**
 * O que a memória do motor diz desta autorização e deste balanceador. O formato de outra versão, o balanceador trocado e o que
 * ficou de uma autorização anterior não dizem nada do de agora; o pedaço fora do formato é como se não existisse.
 */
function engineView(
  source: SourceRow,
  settings: SettingsRow | null,
  state: WebEngineView | null,
  since: Date,
): Pick<WebSourceHealth, 'observation' | 'suppressed' | 'notes' | 'stateAt'> {
  const none = { observation: null, suppressed: [], notes: [], stateAt: null };
  if (state === null || state.version !== ENGINE_STATE_VERSION) return none;
  if (!isAuthorizedRow(source) || source.authorizedAt === null) return none;
  if (state.loadBalancer !== parseLoadBalancerArn(sourceDetails(source.details).arn)?.loadBalancer)
    return none;
  if (state.updatedAt < source.authorizedAt) return none;
  const observation = webObservationSchema.safeParse(state.observation);
  const suppressed = webSourceHealthSchema.shape.suppressed.safeParse(state.suppressed);
  const notes = webSourceHealthSchema.shape.notes.safeParse(state.notes);
  return {
    observation:
      observation.success &&
      observation.data.since === observedSince(settings?.observeUntil, source.authorizedAt)
        ? observation.data
        : null,
    suppressed: suppressed.success ? suppressed.data.filter((item) => new Date(item.lastSeenAt) > since) : [],
    notes: notes.success ? notes.data : [],
    stateAt: state.updatedAt.toISOString(),
  };
}

const isDuplicate = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

/**
 * A configuração dos ataques web pelos logs do ALB (`/v1/web-logs`), pelo escopo da sessão: os balanceadores de todas as
 * contas do cliente, o modo e o multiplicador de cada um, o pedido da estimativa, as fontes confiáveis e as rotas declaradas.
 * Só o cadastro: quem lê o S3 e roda o motor é o worker (`collect/`). Nada aqui fala com a AWS.
 *
 * - Todos leem (`cloud_accounts:read`); administradores mudam (`cloud_accounts:write`). A projeção da estimativa contra o
 *   plano só vai para quem lê o plano (`plan:read`).
 * - Toda escrita entra na trilha do cliente com o antes e o depois. O que é de um balanceador fica na área da conta dele; a
 *   fonte confiável de todos os balanceadores, na do cliente.
 * - A autorização do balanceador é a das outras fontes (`cloud-accounts/aws-onboarding.service.ts`), que cria a linha da
 *   configuração. Retirada a autorização, nada daqui é apagado: volta a valer na próxima, com a observação recomeçada.
 */
@Injectable()
export class WebLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly plan: PlanService,
  ) {}

  // --- Balanceadores ---

  /**
   * Os balanceadores do cliente, de todas as contas ou de uma, por região e nome. Em páginas: o teto das fontes é por conta, e
   * com muitas contas uma lista só deixaria alguns de fora sem avisar.
   */
  async sources(auth: RequestAuth, query: WebLogSourceListQuery): Promise<WebLogSourceList> {
    const db = this.prisma.scoped();
    const where = { ...BALANCER, ...(query.cloudAccountId && { cloudAccountId: query.cloudAccountId }) };
    const rows = await db.awsSource.findMany({
      where,
      select: SOURCE_SELECT,
      orderBy: [{ region: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      ...toPrismaPage(query),
    });
    const total = await db.awsSource.count({ where });
    return toPaginated(await this.toSources(auth, rows), total, query);
  }

  async source(auth: RequestAuth, sourceId: string): Promise<WebLogSource> {
    const [item] = await this.toSources(auth, [await this.findSource(sourceId)]);
    return item as WebLogSource;
  }

  /**
   * O modo e o multiplicador de um balanceador autorizado. Ele só passa a alertar depois da observação obrigatória
   * (`observeUntil`, 72 h a partir da autorização); voltar a observar vale a qualquer momento.
   */
  async updateSettings(
    auth: RequestAuth,
    sourceId: string,
    input: WebSourceSettingsUpdate,
  ): Promise<WebLogSource> {
    this.audit.describe({ action: 'web_logs.settings_update', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    // O lock da autorização e da revogação: o estado lido depois dele é o que vale.
    await lockAwsOnboarding(this.prisma.db(), cloudAccountId);
    const source = await this.findSource(sourceId);
    const before = await this.findSettings(sourceId);
    if (!isAuthorizedRow(source) || before === null) {
      throw refusal(HttpStatus.CONFLICT, 'Este balanceador não está autorizado.', 'SOURCE_NOT_AUTHORIZED');
    }
    const starts = input.mode === 'alert' && before.mode !== 'alert';
    if (starts && before.observeUntil !== null && before.observeUntil > new Date()) {
      throw refusal(
        HttpStatus.CONFLICT,
        'A observação deste balanceador ainda não terminou.',
        'WEB_OBSERVATION_PENDING',
      );
    }
    const after = await this.prisma.scoped().webSourceSettings.update({
      where: { sourceId_tenantId: { sourceId, tenantId: this.prisma.scopeTenantId() } },
      data: { mode: input.mode, thresholdMultiplier: input.thresholdMultiplier, updatedBy: auth.userId },
      select: SETTINGS_SELECT,
    });
    this.audit.describe({
      before: { sourceId, ...toSettings(before) },
      after: { sourceId, ...toSettings(after) },
    });
    return this.source(auth, sourceId);
  }

  /**
   * Pede a estimativa de volume de um balanceador, que a tarefa do worker calcula. Um pedido ainda pendente não é renovado;
   * respondido, o seguinte só vale 5 min depois do anterior (429).
   */
  async requestEstimate(auth: RequestAuth, sourceId: string): Promise<WebLogSource> {
    this.audit.describe({ action: 'web_logs.estimate_request', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    await lockAwsOnboarding(this.prisma.db(), cloudAccountId);
    const db = this.prisma.scoped();
    const source = await this.findSource(sourceId);
    const account = await db.cloudAccount.findUnique({
      where: { id: cloudAccountId },
      select: {
        status: true,
        connection: true,
        connectionError: true,
        checkRequestedAt: true,
        ingestFrom: true,
      },
    });
    if (
      account === null ||
      account.status !== 'active' ||
      account.checkRequestedAt !== null ||
      !entersRole(account)
    ) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Conecte a conta antes de estimar o volume.',
        'ACCOUNT_NOT_CONNECTED',
      );
    }
    if (source.availability !== 'available' || source.missingSince !== null) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Este balanceador não está disponível para coleta. Rode a descoberta de novo.',
        'SOURCE_NOT_AVAILABLE',
      );
    }
    if (source.permission !== 'granted') {
      throw refusal(
        HttpStatus.CONFLICT,
        'O Verax ainda não tem permissão para ler este balanceador.',
        'SOURCE_PERMISSION_MISSING',
      );
    }
    const key = { sourceId_tenantId: { sourceId, tenantId: this.prisma.scopeTenantId() } };
    const before = await db.webSourceEstimate.findUnique({ where: key, select: ESTIMATE_SELECT });
    const now = new Date();
    if (before?.requestedAt == null) {
      if (
        before !== null &&
        now.getTime() - before.lastRequestAt.getTime() < WEB_ESTIMATE_REQUEST_INTERVAL_MS
      ) {
        throw refusal(
          HttpStatus.TOO_MANY_REQUESTS,
          'A estimativa deste balanceador acabou de ser pedida. Tente de novo em alguns minutos.',
          'WEB_ESTIMATE_RATE_LIMITED',
        );
      }
      const request = { requestedAt: now, requestedBy: auth.userId, lastRequestAt: now };
      await db.webSourceEstimate.upsert({
        where: key,
        create: { sourceId, ...request } as Prisma.WebSourceEstimateUncheckedCreateInput,
        update: request,
        select: { sourceId: true },
      });
    }
    this.audit.describe({
      before: { sourceId, requestedAt: before?.requestedAt?.toISOString() ?? null },
      after: { sourceId, requestedAt: (before?.requestedAt ?? now).toISOString() },
    });
    return this.source(auth, sourceId);
  }

  // --- A saúde da leitura ---

  /**
   * A leitura das últimas 24 h e o que a observação contou. As contagens são as mesmas da saúde da fonte (o volume pelo horário
   * do tráfego; o recusado e a lacuna, por quando foram tratados). Da memória do motor, só a observação, o calado e as notas, e
   * só se forem desta autorização e deste balanceador: do resumo do dia, que tem endereços, nada é lido.
   */
  async health(sourceId: string, now = new Date()): Promise<WebSourceHealth> {
    const source = await this.findSource(sourceId);
    const db = this.prisma.scoped();
    const since = new Date(now.getTime() - WEB_HEALTH_WINDOW_MS);
    const [groups, settings, state] = await Promise.all([
      db.webLogObject.groupBy({
        by: ['status'],
        where: {
          sourceId,
          OR: [
            { status: { in: ['read', 'late'] }, slotStart: { gte: since } },
            { status: { in: ['quarantined', 'gap'] }, readAt: { gt: since } },
          ],
        },
        _count: { _all: true },
        _sum: { lines: true, bytes: true, malformed: true, oversize: true, foreign: true },
        _min: { slotStart: true },
        _max: { slotStart: true },
      }),
      this.findSettings(sourceId),
      readWebEngineView(this.prisma.db(), { sourceId, tenantId: this.prisma.scopeTenantId() }),
    ]);
    const of = (status: WebLogObjectStatus) => groups.find((group) => group.status === status);
    const analysed = groups.filter((group) => group.status === 'read' || group.status === 'late');
    const sum = (field: 'lines' | 'bytes' | 'malformed' | 'oversize' | 'foreign') =>
      analysed.reduce((total, group) => total + Number(group._sum[field] ?? 0), 0);
    const [malformed, oversize, foreign] = [sum('malformed'), sum('oversize'), sum('foreign')];
    const gap = of('gap');
    const [from, to] = [gap?._min.slotStart ?? null, gap?._max.slotStart ?? null];
    return webSourceHealthSchema.parse({
      sourceId,
      since: since.toISOString(),
      objects: {
        read: of('read')?._count._all ?? 0,
        late: of('late')?._count._all ?? 0,
        quarantined: of('quarantined')?._count._all ?? 0,
        gap: gap?._count._all ?? 0,
      },
      lines: {
        analysed: Math.max(0, sum('lines') - malformed - oversize - foreign),
        malformed,
        oversize,
        foreign,
      },
      bytes: sum('bytes'),
      gap:
        from === null || to === null
          ? null
          : // O `slotStart` é o começo do intervalo de 5 minutos: a lacuna vai até o fim do último.
            { from: from.toISOString(), to: new Date(to.getTime() + SLOT_MS).toISOString() },
      ...engineView(source, settings, state, since),
    });
  }

  // --- Fontes confiáveis ---

  async trustedSources(now = new Date()): Promise<WebTrustedSourceList> {
    const rows = await this.prisma.scoped().webTrustedSource.findMany({
      select: TRUSTED_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: WEB_TRUSTED_LIMIT,
    });
    return { items: rows.map((row) => toTrusted(row, now)), limit: WEB_TRUSTED_LIMIT };
  }

  /**
   * O teto é do cliente inteiro, somadas as faixas de todos os balanceadores e as de cada um: nenhum motor recebe mais do que
   * aceita (`MAX_TRUSTED`), e nenhuma faixa cadastrada fica sem valer. A vencida conta: ela ainda está na lista.
   */
  async createTrusted(auth: RequestAuth, input: WebTrustedSourceCreate): Promise<WebTrustedSource> {
    this.audit.describe({ action: 'web_logs.trusted_source_create' });
    await this.describeTrusted(input.sourceId);
    const now = new Date();
    const expiresAt = this.expiryOf(input.expiresAt, now);
    await this.lockTenant();
    const db = this.prisma.scoped();
    if ((await db.webTrustedSource.count()) >= WEB_TRUSTED_LIMIT) {
      throw refusal(
        HttpStatus.CONFLICT,
        `O limite é de ${WEB_TRUSTED_LIMIT} fontes confiáveis.`,
        'WEB_TRUSTED_LIMIT_REACHED',
      );
    }
    let row: TrustedRow;
    try {
      row = await db.webTrustedSource.create({
        data: {
          sourceId: input.sourceId,
          cidr: input.cidr,
          kind: input.kind,
          reason: input.reason,
          expiresAt,
          // Quem criou vem da sessão, nunca do corpo.
          createdBy: auth.userId,
          updatedBy: auth.userId,
        } as Prisma.WebTrustedSourceUncheckedCreateInput,
        select: TRUSTED_SELECT,
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      throw refusal(HttpStatus.CONFLICT, 'Esta faixa já é uma fonte confiável ali.', 'WEB_TRUSTED_DUPLICATE');
    }
    const trusted = toTrusted(row, now);
    this.audit.describe({ after: trusted });
    return trusted;
  }

  async updateTrusted(
    auth: RequestAuth,
    id: string,
    input: WebTrustedSourceUpdate,
  ): Promise<WebTrustedSource> {
    this.audit.describe({ action: 'web_logs.trusted_source_update' });
    const now = new Date();
    const before = toTrusted(await this.findTrusted(id), now);
    await this.describeTrusted(before.sourceId);
    const row = await this.prisma.scoped().webTrustedSource.update({
      where: { id },
      data: {
        kind: input.kind,
        reason: input.reason,
        ...(input.expiresAt !== undefined && { expiresAt: this.expiryOf(input.expiresAt, now) }),
        updatedBy: auth.userId,
      },
      select: TRUSTED_SELECT,
    });
    const after = toTrusted(row, now);
    this.audit.describe({ before, after });
    return after;
  }

  /** Remove a fonte confiável; ela inteira fica na auditoria como estado anterior. */
  async removeTrusted(id: string): Promise<void> {
    this.audit.describe({ action: 'web_logs.trusted_source_delete' });
    const before = toTrusted(await this.findTrusted(id), new Date());
    await this.describeTrusted(before.sourceId);
    await this.prisma.scoped().webTrustedSource.delete({ where: { id }, select: { id: true } });
    this.audit.describe({ before });
  }

  // --- Rotas declaradas ---

  async routes(sourceId: string): Promise<WebRouteList> {
    await this.findSource(sourceId);
    const rows = await this.prisma.scoped().webRoute.findMany({
      where: { sourceId },
      select: ROUTE_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: WEB_ROUTES_LIMIT,
    });
    return { items: rows.map(toRoute), limit: WEB_ROUTES_LIMIT };
  }

  async createRoute(auth: RequestAuth, sourceId: string, input: WebRouteCreate): Promise<WebRoute> {
    this.audit.describe({ action: 'web_logs.route_create', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    await this.lockTenant();
    const db = this.prisma.scoped();
    if ((await db.webRoute.count({ where: { sourceId } })) >= WEB_ROUTES_LIMIT) {
      throw refusal(
        HttpStatus.CONFLICT,
        `O limite é de ${WEB_ROUTES_LIMIT} rotas por balanceador.`,
        'WEB_ROUTE_LIMIT_REACHED',
      );
    }
    let row: RouteRow;
    try {
      row = await db.webRoute.create({
        data: {
          sourceId,
          host: input.host,
          method: input.method,
          path: input.path,
          kind: input.kind,
          failureCodes: input.failureCodes,
          successCodes: input.successCodes,
          multiplier: input.multiplier,
          createdBy: auth.userId,
          updatedBy: auth.userId,
        } as Prisma.WebRouteUncheckedCreateInput,
        select: ROUTE_SELECT,
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      throw refusal(HttpStatus.CONFLICT, 'Esta rota já está declarada.', 'WEB_ROUTE_DUPLICATE');
    }
    const route = toRoute(row);
    this.audit.describe({ after: route });
    return route;
  }

  async updateRoute(
    auth: RequestAuth,
    sourceId: string,
    id: string,
    input: WebRouteUpdate,
  ): Promise<WebRoute> {
    this.audit.describe({ action: 'web_logs.route_update', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    // Duas alterações ao mesmo tempo, uma em cada lista, não deixam o mesmo código nas duas.
    await this.lockTenant();
    const before = toRoute(await this.findRoute(sourceId, id));
    const failureCodes = input.failureCodes ?? before.failureCodes;
    const successCodes = input.successCodes ?? before.successCodes;
    if (hasCodeOverlap(failureCodes, successCodes)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'O mesmo código não pode ser falha e sucesso.');
    }
    const row = await this.prisma.scoped().webRoute.update({
      where: { id },
      data: {
        kind: input.kind,
        failureCodes,
        successCodes,
        multiplier: input.multiplier,
        updatedBy: auth.userId,
      },
      select: ROUTE_SELECT,
    });
    const after = toRoute(row);
    this.audit.describe({ before, after });
    return after;
  }

  async removeRoute(sourceId: string, id: string): Promise<void> {
    this.audit.describe({ action: 'web_logs.route_delete', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    const before = toRoute(await this.findRoute(sourceId, id));
    await this.prisma.scoped().webRoute.delete({ where: { id }, select: { id: true } });
    this.audit.describe({ before });
  }

  // --- Leitura ---

  private async findSource(id: string): Promise<SourceRow> {
    const row = await this.prisma
      .scoped()
      .awsSource.findFirst({ where: { id, ...BALANCER }, select: SOURCE_SELECT });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, SOURCE_NOT_FOUND);
    return row;
  }

  private findSettings(sourceId: string): Promise<SettingsRow | null> {
    return this.prisma.scoped().webSourceSettings.findFirst({ where: { sourceId }, select: SETTINGS_SELECT });
  }

  private async findTrusted(id: string): Promise<TrustedRow> {
    const row = await this.prisma
      .scoped()
      .webTrustedSource.findUnique({ where: { id }, select: TRUSTED_SELECT });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'Fonte confiável não encontrada');
    return row;
  }

  private async findRoute(sourceId: string, id: string): Promise<RouteRow> {
    const row = await this.prisma
      .scoped()
      .webRoute.findFirst({ where: { id, sourceId }, select: ROUTE_SELECT });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, 'Rota não encontrada');
    return row;
  }

  private expiryOf(value: string, now: Date): Date {
    const expiresAt = new Date(value);
    if (isTrustedExpiryValid(expiresAt, now)) return expiresAt;
    throw refusal(
      HttpStatus.BAD_REQUEST,
      'A validade precisa ser no futuro, em até 365 dias.',
      'WEB_TRUSTED_EXPIRY_INVALID',
    );
  }

  /**
   * De quem é a fonte confiável na trilha: da conta do balanceador ou, sem um, do cliente. O balanceador que não existe (ou é
   * de outro cliente) é 404.
   */
  private async describeTrusted(sourceId: string | null): Promise<void> {
    if (sourceId === null) {
      this.audit.describe({ resourceType: 'tenant', resourceId: this.prisma.scopeTenantId() });
      return;
    }
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceType: 'cloud_account', resourceId: cloudAccountId });
  }

  /** O lock da configuração do cliente: dois pedidos ao mesmo tempo não passam os dois pelo teto. */
  private async lockTenant(): Promise<void> {
    const tenantId = this.prisma.scopeTenantId();
    await this.prisma.db()
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:web-logs:${tenantId}`}))`;
  }

  private async toSources(auth: RequestAuth, rows: readonly SourceRow[]): Promise<WebLogSource[]> {
    if (rows.length === 0) return [];
    const db = this.prisma.scoped();
    const sourceId = { in: rows.map((row) => row.id) };
    const [accounts, settings, estimates, allowance] = await Promise.all([
      db.cloudAccount.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.cloudAccountId))] } },
        select: { id: true, accountId: true },
      }),
      db.webSourceSettings.findMany({ where: { sourceId }, select: SETTINGS_SELECT }),
      db.webSourceEstimate.findMany({ where: { sourceId }, select: ESTIMATE_SELECT }),
      this.allowanceFor(auth),
    ]);
    const accountIds = new Map(accounts.map((account) => [account.id, account.accountId]));
    const settingsOf = new Map(settings.map((row) => [row.sourceId, row]));
    const estimateOf = new Map<string, EstimateRow>(estimates.map((row) => [row.sourceId, row]));
    const now = new Date();
    return rows.flatMap((row): WebLogSource[] => {
      const accountId = accountIds.get(row.cloudAccountId);
      // A conta apagada entre as duas leituras leva as fontes junto.
      if (accountId === undefined) return [];
      const details = sourceDetails(row.details);
      const balancer = webLoadBalancerSchema.safeParse(parseLoadBalancerArn(details.arn)?.loadBalancer);
      const own = settingsOf.get(row.id);
      const estimate = estimateOf.get(row.id);
      return [
        {
          id: row.id,
          cloudAccountId: row.cloudAccountId,
          accountId,
          region: row.region,
          name: row.name,
          loadBalancer: balancer.success ? balancer.data : null,
          internetFacing: details.internetFacing ?? null,
          state: row.state as AwsSourceState,
          authorized: isAuthorizedRow(row),
          settings: own === undefined ? null : toSettings(own),
          estimate: estimate === undefined ? null : toEstimate(estimate, allowance, now),
        },
      ];
    });
  }

  /** O volume do plano, só para quem o lê: a porcentagem diria o tamanho dele. */
  private allowanceFor(auth: RequestAuth): Promise<VolumeAllowance | null> {
    return hasPermission(auth.role, 'plan:read')
      ? this.plan.volumeAllowance(this.prisma.scopeTenantId())
      : Promise.resolve(null);
  }
}
