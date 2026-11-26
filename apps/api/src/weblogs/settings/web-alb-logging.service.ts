import { HttpStatus, Injectable } from '@nestjs/common';
import {
  type WebAlbLogging,
  type WebAlbLoggingAction,
  type WebAlbLoggingFailure,
  type WebAlbLoggingStatus,
  type WebLogsErrorCode,
} from '@verax/shared';
import { parseLoadBalancerArn } from '../../aws/discovery/catalogue.js';
import { lockAwsOnboarding } from '../../aws/discovery/discovery-runs.js';
import { entersRole } from '../../aws/onboarding/account-access.js';
import { isAuthorizedRow, sourceDetails } from '../../aws/onboarding/onboarding-view.js';
import { AuditContext } from '../../common/audit/audit-context.service.js';
import type { RequestAuth } from '../../common/auth/request-auth.js';
import { ApiError } from '../../common/http/api-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

const SOURCE_NOT_FOUND = 'Balanceador não encontrado';
/** As fontes daqui: só as descobertas, de um balanceador. */
const BALANCER = { kind: 'elb_logs', origin: 'discovered' } as const;

const SOURCE_SELECT = {
  id: true,
  cloudAccountId: true,
  details: true,
  availability: true,
  missingSince: true,
  authorizedAt: true,
  revokedAt: true,
} as const satisfies Prisma.AwsSourceSelect;

const LOGGING_SELECT = {
  sourceId: true,
  pending: true,
  requestedAt: true,
  requestedBy: true,
  lastAction: true,
  status: true,
  errorCode: true,
  completedAt: true,
  enabledByVerax: true,
  bucket: true,
  prefix: true,
  enabledAt: true,
  enabledBy: true,
  previousEnabled: true,
  previousBucket: true,
  previousPrefix: true,
  disabledAt: true,
  disabledBy: true,
} as const satisfies Prisma.WebAlbLoggingSelect;
type LoggingRow = Prisma.WebAlbLoggingGetPayload<{ select: typeof LOGGING_SELECT }>;

const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

function toLogging(sourceId: string, row: LoggingRow | null): WebAlbLogging {
  return {
    sourceId,
    pending: (row?.pending ?? null) as WebAlbLoggingAction | null,
    requestedAt: iso(row?.requestedAt ?? null),
    lastAction: (row?.lastAction ?? null) as WebAlbLoggingAction | null,
    status: (row?.status ?? null) as WebAlbLoggingStatus | null,
    errorCode: (row?.errorCode ?? null) as WebAlbLoggingFailure | null,
    completedAt: iso(row?.completedAt ?? null),
    enabledByVerax: row?.enabledByVerax ?? false,
    bucket: row?.bucket ?? null,
    enabledAt: iso(row?.enabledAt ?? null),
    enabledBy: row?.enabledBy ?? null,
    disabledAt: iso(row?.disabledAt ?? null),
    disabledBy: row?.disabledBy ?? null,
    previous:
      row?.previousEnabled == null
        ? null
        : { enabled: row.previousEnabled, bucket: row.previousBucket, prefix: row.previousPrefix },
  };
}

function refusal(status: HttpStatus, message: string, code: WebLogsErrorCode): ApiError {
  return new ApiError(status, message, code);
}

/**
 * O log de acesso de um ALB ligado pelo painel (`/v1/web-logs/sources/:id/access-logs`), pelo escopo da sessão. Só o pedido
 * e a leitura do que o worker gravou: quem fala com a AWS é a tarefa `web-logs-alb-logging`
 * (`weblogs/alb-logging/web-alb-logging-job.ts`), que confere os atributos de novo antes de mudar qualquer coisa.
 *
 * - Todos leem (`cloud_accounts:read`); administradores pedem (`cloud_accounts:write`). Todo pedido entra na trilha do
 *   cliente, na área da conta, com o antes e o depois; o resultado do worker também (ator sistema).
 * - Ligar: um ALB que a descoberta vê com o log desligado (`no_destination`), de conta conectada, sem outro pedido pendente.
 * - Desligar: só o que a Verax ligou (`enabledByVerax`), e com a autorização do balanceador já retirada (sem ela, a leitura
 *   pararia com aviso de arquivo faltando).
 */
@Injectable()
export class WebAlbLoggingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
  ) {}

  async state(sourceId: string): Promise<WebAlbLogging> {
    await this.findSource(sourceId);
    return toLogging(sourceId, await this.findLogging(sourceId));
  }

  async requestEnable(auth: RequestAuth, sourceId: string): Promise<WebAlbLogging> {
    this.audit.describe({ action: 'web_logs.alb_logging_enable', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    await lockAwsOnboarding(this.prisma.db(), cloudAccountId);
    const source = await this.findSource(sourceId);
    await this.assertConnected(cloudAccountId);
    if (parseLoadBalancerArn(sourceDetails(source.details).arn)?.type !== 'app') {
      throw refusal(
        HttpStatus.CONFLICT,
        'Só o log de um balanceador de aplicação (ALB) pode ser ligado pelo painel.',
        'WEB_ALB_LOGGING_NOT_ALB',
      );
    }
    if (source.missingSince !== null) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Este balanceador não foi encontrado na última descoberta. Rode a descoberta de novo.',
        'SOURCE_NOT_AVAILABLE',
      );
    }
    const before = await this.findLogging(sourceId);
    this.assertNotPending(before);
    if (source.availability !== 'no_destination' || (before?.enabledByVerax ?? false)) {
      throw refusal(
        HttpStatus.CONFLICT,
        'O log de acesso deste balanceador já está ligado.',
        'WEB_ALB_LOGGING_ALREADY_ON',
      );
    }
    return this.request(auth, sourceId, 'enable', before);
  }

  async requestDisable(auth: RequestAuth, sourceId: string): Promise<WebAlbLogging> {
    this.audit.describe({ action: 'web_logs.alb_logging_disable', resourceType: 'cloud_account' });
    const { cloudAccountId } = await this.findSource(sourceId);
    this.audit.describe({ resourceId: cloudAccountId });
    await lockAwsOnboarding(this.prisma.db(), cloudAccountId);
    const source = await this.findSource(sourceId);
    await this.assertConnected(cloudAccountId);
    const before = await this.findLogging(sourceId);
    this.assertNotPending(before);
    if (before === null || !before.enabledByVerax) {
      throw refusal(
        HttpStatus.CONFLICT,
        'O Verax só desliga o log que ele mesmo ligou. Este, desligue no console da AWS.',
        'WEB_ALB_LOGGING_NOT_VERAX',
      );
    }
    if (isAuthorizedRow(source)) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Retire a autorização deste balanceador antes de desligar o log dele.',
        'WEB_ALB_LOGGING_SOURCE_AUTHORIZED',
      );
    }
    return this.request(auth, sourceId, 'disable', before);
  }

  private async request(
    auth: RequestAuth,
    sourceId: string,
    action: WebAlbLoggingAction,
    before: LoggingRow | null,
  ): Promise<WebAlbLogging> {
    const now = new Date();
    const request = { pending: action, requestedAt: now, requestedBy: auth.userId };
    const after = await this.prisma.scoped().webAlbLogging.upsert({
      where: { sourceId_tenantId: { sourceId, tenantId: this.prisma.scopeTenantId() } },
      create: { sourceId, ...request } as Prisma.WebAlbLoggingUncheckedCreateInput,
      update: request,
      select: LOGGING_SELECT,
    });
    this.audit.describe({
      before: toLogging(sourceId, before),
      after: toLogging(sourceId, after),
    });
    return toLogging(sourceId, after);
  }

  private assertNotPending(row: LoggingRow | null): void {
    if (row?.pending != null) {
      throw refusal(
        HttpStatus.CONFLICT,
        'Já há um pedido para o log deste balanceador. Aguarde a resposta.',
        'WEB_ALB_LOGGING_PENDING',
      );
    }
  }

  private async assertConnected(cloudAccountId: string): Promise<void> {
    const account = await this.prisma.scoped().cloudAccount.findUnique({
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
      throw refusal(HttpStatus.CONFLICT, 'Conecte a conta antes de ligar o log.', 'ACCOUNT_NOT_CONNECTED');
    }
  }

  private async findSource(id: string) {
    const row = await this.prisma
      .scoped()
      .awsSource.findFirst({ where: { id, ...BALANCER }, select: SOURCE_SELECT });
    if (!row) throw new ApiError(HttpStatus.NOT_FOUND, SOURCE_NOT_FOUND);
    return row;
  }

  private findLogging(sourceId: string): Promise<LoggingRow | null> {
    return this.prisma.scoped().webAlbLogging.findFirst({ where: { sourceId }, select: LOGGING_SELECT });
  }
}
