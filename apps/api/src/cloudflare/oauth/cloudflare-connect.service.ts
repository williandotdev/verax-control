import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type CloudflareConnectOptions,
  CLOUDFLARE_OAUTH_ATTEMPT_TTL_MS,
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  CLOUDFLARE_OAUTH_ISSUER,
  CLOUDFLARE_OAUTH_REFUSED_CODE,
  type CloudflareOauthAccount,
  cloudflareOauthAccountSchema,
  type CloudflareOauthAttempt,
  type CloudflareOauthAttemptError,
  type CloudflareOauthCallbackError,
  type CloudflareOauthChoose,
  type CloudflareOauthComplete,
  type CloudflareOauthCompleted,
  type CloudflareOauthStart,
  type CloudflareOauthStarted,
  PLAN_SEAT_LIMIT,
} from '@verax/shared';
import { sealCloudflareOauthCode, sealCloudflareOauthVerifier } from '@verax/vault-envelope';
import { AuditContext } from '../../common/audit/audit-context.service.js';
import type { RequestAuth } from '../../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { ApiError, CommittedApiError } from '../../common/http/api-error.js';
import { forgetLiveSecret, registerLiveSecret } from '../../common/logger/sanitize.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { VaultPublicKey } from '../../credentials/credential-keys.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { countSeats, PlanLimitReached } from '../../plan/plan-limits.js';
import { PlanService } from '../../plan/plan.service.js';
import { CloudflareOauthSettings } from './oauth-settings.js';

/** Quanto o worker tem para trocar o código (ou ligar as contas escolhidas), contado do pedido do painel. */
export const CLOUDFLARE_OAUTH_WORK_TTL_MS = 5 * 60 * 1000;
/** Tentativas começadas por hora, por usuário e no cliente inteiro. */
export const CONNECT_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
export const CONNECT_ATTEMPTS_PER_USER = 10;
export const CONNECT_ATTEMPTS_PER_TENANT = 30;

const RESOURCE_TYPE = 'cloudflare_oauth';

/** Por que o retorno foi recusado: só na trilha. A resposta é sempre a mesma. */
type RefusalReason = 'unknown' | 'other_user' | 'other_session' | 'expired' | 'repeated' | 'issuer';

const CALLBACK_FAILURES: Readonly<Record<CloudflareOauthCallbackError, CloudflareOauthAttemptError>> = {
  access_denied: 'oauth_denied',
  invalid_request: 'oauth_client_rejected',
  invalid_scope: 'oauth_client_rejected',
  unauthorized_client: 'oauth_client_rejected',
  unsupported_response_type: 'oauth_client_rejected',
  server_error: 'source_unavailable',
  temporarily_unavailable: 'source_unavailable',
  other: 'internal_error',
};

const ATTEMPT_SELECT = {
  id: true,
  userId: true,
  sessionId: true,
  status: true,
  errorCode: true,
  accounts: true,
  accountIdRequired: true,
  chosenAccountIds: true,
  discoveredAt: true,
  grantId: true,
  expiresAt: true,
} as const satisfies Prisma.CloudflareConnectAttemptSelect;
type AttemptRow = Prisma.CloudflareConnectAttemptGetPayload<{ select: typeof ATTEMPT_SELECT }>;

export function hashState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

/**
 * "Conectar com Cloudflare" do lado da API do nó (CF-4; o contrato e o fluxo estão em `packages/shared`,
 * `cloudflare-oauth.ts`). A API começa e conclui a tentativa; quem troca o código, guarda os tokens e liga as contas é o
 * worker (`connect-job.ts`). Nenhum token passa por aqui, e o verificador e o código só ficam cifrados com a chave pública
 * do cofre: a API não os reabre.
 *
 * O retorno só vale para quem começou: o mesmo cliente, o mesmo usuário e a mesma sessão, uma vez, no prazo e com o emissor
 * do Cloudflare. É o que impede que alguém mande a outra pessoa o próprio link de autorização e receba o acesso dela.
 * Qualquer recusa responde igual (400 `CLOUDFLARE_OAUTH_REFUSED`); o motivo vai só à trilha, por código.
 */
@Injectable()
export class CloudflareConnectService {
  private readonly publicKey: VaultPublicKey | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly plan: PlanService,
    private readonly settings: CloudflareOauthSettings,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'credentialsPublicKey'>,
  ) {
    this.publicKey = config.credentialsPublicKey;
  }

  /** Desligado, 404: o painel mostra o token colado. */
  async options(): Promise<CloudflareConnectOptions> {
    await this.enabled();
    return { mode: 'oauth' };
  }

  async start(auth: RequestAuth, input: CloudflareOauthStart): Promise<CloudflareOauthStarted> {
    const { config, slug, publicKey } = await this.enabled();
    const tenantId = auth.scopeTenantId as string;
    const id = randomUUID();
    this.audit.describe({ action: 'cloudflare_oauth.start', resourceType: RESOURCE_TYPE, resourceId: id });
    await this.assertAttemptsLeft(tenantId, auth.userId);
    if (input.cloudAccountId !== undefined) await this.assertConnectable(input.cloudAccountId);

    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const state = `${slug}.${nonce}`;
    registerLiveSecret(verifier);
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + CLOUDFLARE_OAUTH_ATTEMPT_TTL_MS);
      await this.prisma.scoped().cloudflareConnectAttempt.create({
        data: {
          id,
          tenantId,
          userId: auth.userId,
          sessionId: auth.sessionId,
          stateHash: hashState(state),
          verifierCiphertext: sealCloudflareOauthVerifier(publicKey, { tenantId, subjectId: id }, verifier),
          cloudAccountId: input.cloudAccountId ?? null,
          config: { ...config, scopes: [...config.scopes] },
          expiresAt,
        },
        select: { id: true },
      });
      this.audit.describe({
        after: { cloudAccountId: input.cloudAccountId ?? null, scopes: config.scopes },
      });
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        scope: config.scopes.join(' '),
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      });
      return {
        attemptId: id,
        authorizeUrl: `${CLOUDFLARE_OAUTH_AUTHORIZE_URL}?${query.toString()}`,
        expiresAt: expiresAt.toISOString(),
      };
    } finally {
      forgetLiveSecret(verifier);
    }
  }

  async complete(auth: RequestAuth, input: CloudflareOauthComplete): Promise<CloudflareOauthCompleted> {
    const { publicKey } = await this.enabled();
    const tenantId = auth.scopeTenantId as string;
    this.audit.describe({ action: 'cloudflare_oauth.complete', resourceType: RESOURCE_TYPE });
    const db = this.prisma.scoped();
    const attempt = await db.cloudflareConnectAttempt.findUnique({
      where: { stateHash: hashState(input.state) },
      select: { id: true, userId: true, sessionId: true, status: true, expiresAt: true },
    });
    const now = new Date();
    const reason = refusalReason(attempt, auth, now);
    if (attempt === null || reason !== null) throw this.refused(reason ?? 'unknown');
    this.audit.describe({ resourceId: attempt.id });
    const open = {
      id: attempt.id,
      userId: auth.userId,
      sessionId: auth.sessionId,
      status: 'started',
      expiresAt: { gt: now },
    };

    if ('error' in input) {
      const errorCode = CALLBACK_FAILURES[input.error];
      const { count } = await db.cloudflareConnectAttempt.updateMany({
        where: open,
        data: { status: 'failed', errorCode, verifierCiphertext: null, consumedAt: now },
      });
      if (count !== 1) throw this.refused('repeated');
      this.audit.describe({ after: { status: 'failed', errorCode } });
      return { attemptId: attempt.id };
    }

    // O emissor errado gasta a tentativa: uma resposta que não é do Cloudflare não deixa outra chance ao mesmo `state`.
    if (input.iss !== CLOUDFLARE_OAUTH_ISSUER) {
      await db.cloudflareConnectAttempt.updateMany({
        where: open,
        data: {
          status: 'failed',
          errorCode: 'oauth_code_rejected',
          verifierCiphertext: null,
          consumedAt: now,
        },
      });
      throw this.refused('issuer');
    }
    registerLiveSecret(input.code);
    try {
      const codeCiphertext = sealCloudflareOauthCode(
        publicKey,
        { tenantId, subjectId: attempt.id },
        input.code,
      );
      // Uma escrita só, condicional: de dois retornos ao mesmo tempo, um passa.
      const { count } = await db.cloudflareConnectAttempt.updateMany({
        where: open,
        data: {
          status: 'code_received',
          codeCiphertext,
          consumedAt: now,
          expiresAt: new Date(now.getTime() + CLOUDFLARE_OAUTH_WORK_TTL_MS),
        },
      });
      if (count !== 1) throw this.refused('repeated');
    } finally {
      forgetLiveSecret(input.code);
    }
    this.audit.describe({ after: { status: 'code_received' } });
    return { attemptId: attempt.id };
  }

  async attempt(auth: RequestAuth, id: string): Promise<CloudflareOauthAttempt> {
    await this.enabled();
    const row = await this.own(auth, id);
    const cloudAccountIds =
      row.status === 'done' && row.grantId !== null
        ? (
            await this.prisma.scoped().cloudAccount.findMany({
              where: { cloudflareGrantId: row.grantId },
              select: { id: true },
              orderBy: { id: 'asc' },
            })
          ).map((account) => account.id)
        : [];
    return toAttempt(row, cloudAccountIds, new Date());
  }

  /** O cliente escolheu as contas: o worker prova cada uma de novo e as liga. */
  async choose(auth: RequestAuth, id: string, input: CloudflareOauthChoose): Promise<CloudflareOauthAttempt> {
    await this.enabled();
    const tenantId = auth.scopeTenantId as string;
    this.audit.describe({ action: 'cloudflare_oauth.choose', resourceType: RESOURCE_TYPE, resourceId: id });
    const row = await this.own(auth, id);
    const now = new Date();
    if (!isChoosing(row, now)) throw notChoosing();
    const offered = accountsOf(row.accounts);
    const usable = new Map(offered.filter(isUsable).map((account) => [account.accountId, account.state]));
    if (!row.accountIdRequired && input.accountIds.some((accountId) => !usable.has(accountId))) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Escolha só contas da lista que podem ser monitoradas.',
        'CLOUDFLARE_OAUTH_ACCOUNT_NOT_OFFERED',
      );
    }
    const db = this.prisma.scoped();
    const registered = await db.cloudAccount.findMany({
      where: { provider: 'cloudflare', accountId: { in: input.accountIds } },
      select: { accountId: true, status: true },
    });
    if (registered.some((account) => account.status !== 'active')) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Uma das contas escolhidas está desativada. Reative o monitoramento dela antes de conectar.',
        'CLOUD_ACCOUNT_INACTIVE',
      );
    }
    // Conferência antecipada, para o cliente poder escolher menos contas; quem garante a vaga é o worker, sob o lock.
    await this.assertSeats(tenantId, input.accountIds.length - registered.length);
    const { count } = await db.cloudflareConnectAttempt.updateMany({
      where: {
        id,
        userId: auth.userId,
        sessionId: auth.sessionId,
        status: 'choosing',
        discoveredAt: { not: null },
        chosenAccountIds: { isEmpty: true },
        expiresAt: { gt: now },
      },
      data: {
        chosenAccountIds: [...input.accountIds],
        expiresAt: new Date(now.getTime() + CLOUDFLARE_OAUTH_WORK_TTL_MS),
      },
    });
    if (count !== 1) throw notChoosing();
    this.audit.describe({ after: { accountIds: input.accountIds } });
    return this.attempt(auth, id);
  }

  /** O OAuth ligado neste nó, com a chave pública do cofre; desligado, 404 como uma rota que não existe. */
  private async enabled() {
    const node = await this.settings.current();
    if (node === null || this.publicKey === null) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado');
    }
    return { ...node, publicKey: this.publicKey };
  }

  /** A tentativa de quem pergunta: do cliente do escopo e do próprio usuário. */
  private async own(auth: RequestAuth, id: string): Promise<AttemptRow> {
    const row = await this.prisma
      .scoped()
      .cloudflareConnectAttempt.findUnique({ where: { id }, select: ATTEMPT_SELECT });
    if (row === null || row.userId !== auth.userId || row.sessionId !== auth.sessionId) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Conexão não encontrada');
    }
    return row;
  }

  /** A recusa entra na trilha com o motivo, no mesmo commit, e sai sempre igual. */
  private refused(reason: RefusalReason): CommittedApiError {
    this.audit.describe({ action: 'cloudflare_oauth.refused', after: { reason } });
    return new CommittedApiError(
      HttpStatus.BAD_REQUEST,
      'Não foi possível concluir a conexão com o Cloudflare. Comece de novo.',
      CLOUDFLARE_OAUTH_REFUSED_CODE,
    );
  }

  /**
   * O limite de tentativas, contado nas próprias linhas (elas ficam 24 h), sob um lock do cliente: pedidos simultâneos não
   * passam juntos.
   */
  private async assertAttemptsLeft(tenantId: string, userId: string): Promise<void> {
    await this.prisma.db()
      .$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:cloudflare-connect:${tenantId}`}))`;
    const db = this.prisma.scoped();
    const createdAt = { gte: new Date(Date.now() - CONNECT_ATTEMPT_WINDOW_MS) };
    const ofUser = await db.cloudflareConnectAttempt.count({ where: { userId, createdAt } });
    const ofTenant = await db.cloudflareConnectAttempt.count({ where: { createdAt } });
    if (ofUser >= CONNECT_ATTEMPTS_PER_USER || ofTenant >= CONNECT_ATTEMPTS_PER_TENANT) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'Muitas tentativas de conectar. Tente de novo em até uma hora.',
        'CLOUDFLARE_OAUTH_ATTEMPTS_EXCEEDED',
      );
    }
  }

  /** A conta a reconectar ou migrar: do cliente, do Cloudflare e ativa. */
  private async assertConnectable(id: string): Promise<void> {
    const account = await this.prisma
      .scoped()
      .cloudAccount.findUnique({ where: { id }, select: { provider: true, status: true } });
    if (account === null) throw new ApiError(HttpStatus.NOT_FOUND, 'Conta não encontrada');
    if (account.provider !== 'cloudflare') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Só uma conta do Cloudflare é conectada assim.');
    }
    if (account.status !== 'active') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Reative o monitoramento antes de conectar a conta.');
    }
  }

  private async assertSeats(tenantId: string, wanted: number): Promise<void> {
    if (wanted <= 0) return;
    const limit = (await this.plan.planOf(tenantId)).limits[PLAN_SEAT_LIMIT.cloudAccounts];
    if (limit === null) return;
    if ((await countSeats(this.prisma.scoped(), 'cloudAccounts')) + wanted > limit) {
      throw new PlanLimitReached('cloudAccounts', limit);
    }
  }
}

function refusalReason(
  attempt: { userId: string; sessionId: string; status: string; expiresAt: Date } | null,
  auth: RequestAuth,
  now: Date,
): RefusalReason | null {
  if (attempt === null) return 'unknown';
  if (attempt.userId !== auth.userId) return 'other_user';
  if (attempt.sessionId !== auth.sessionId) return 'other_session';
  if (attempt.status === 'expired') return 'expired';
  if (attempt.status !== 'started') return 'repeated';
  return attempt.expiresAt <= now ? 'expired' : null;
}

function isUsable(account: CloudflareOauthAccount): boolean {
  return account.state === 'available' || account.state === 'registered';
}

/** O cliente está escolhendo: o worker já descobriu as contas, nada foi escolhido e o prazo vale. */
function isChoosing(row: AttemptRow, now: Date): boolean {
  return (
    row.status === 'choosing' &&
    row.discoveredAt !== null &&
    row.chosenAccountIds.length === 0 &&
    row.expiresAt > now
  );
}

function notChoosing(): ApiError {
  return new ApiError(
    HttpStatus.CONFLICT,
    'Esta conexão não está esperando a escolha das contas.',
    'CLOUDFLARE_OAUTH_NOT_CHOOSING',
  );
}

/** As contas que o worker gravou, conferidas pelo contrato. */
function accountsOf(value: Prisma.JsonValue): CloudflareOauthAccount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const account = cloudflareOauthAccountSchema.safeParse(item);
    return account.success ? [account.data] : [];
  });
}

/**
 * A tentativa como o painel a vê. Enquanto o worker trabalha (descobrindo, ou ligando as escolhidas), ela continua
 * `code_received`; a aberta que passou do prazo já aparece vencida, antes da faxina.
 */
function toAttempt(row: AttemptRow, cloudAccountIds: string[], now: Date): CloudflareOauthAttempt {
  const open = row.status === 'started' || row.status === 'code_received' || row.status === 'choosing';
  const choosing = isChoosing(row, now);
  const status =
    open && row.expiresAt <= now
      ? 'expired'
      : row.status === 'choosing' && !choosing
        ? 'code_received'
        : (row.status as CloudflareOauthAttempt['status']);
  return {
    id: row.id,
    status,
    errorCode: status === 'failed' ? (row.errorCode as CloudflareOauthAttemptError) : null,
    accounts: choosing ? accountsOf(row.accounts) : [],
    accountIdRequired: choosing && row.accountIdRequired,
    cloudAccountIds,
    expiresAt: row.expiresAt.toISOString(),
  };
}
