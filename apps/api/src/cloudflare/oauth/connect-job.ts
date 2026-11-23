import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';
import {
  CLOUDFLARE_OAUTH_MAX_ACCOUNTS,
  type CloudflareOauthAccount,
  type CloudflareOauthAttemptError,
  cloudflareOauthConfigSchema,
  compareCloudflareScopes,
} from '@verax/shared';
import {
  CredentialVaultError,
  openCloudflareOauthCode,
  openCloudflareOauthTokens,
  openCloudflareOauthVerifier,
} from '@verax/vault-envelope';
import { SyncLease } from '../../alerts/finding-store.js';
import { AuditService } from '../../common/audit/audit.service.js';
import { errorKind } from '../../common/logger/error-kind.js';
import { forgetLiveSecret, registerLiveSecret } from '../../common/logger/sanitize.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { VaultKeyring } from '../../credentials/credential-keys.js';
import { lockGrant } from '../../credentials/credential-rekey.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { TenantPlans } from '../../plan/tenant-plan.js';
import type { CloudflareBearer } from '../cloudflare-bearer.js';
import { CloudflareApiError, type CloudflareClient, type ReachableAccount } from '../cloudflare.client.js';
import { GRANT_INTENT_HOLD_MS } from './cloudflare-grants.js';
import { createGrant, releaseGrantIfUnused, sealGrant, type SealedGrant } from './grant-store.js';
import { linkAccounts, LinkRefused, LinkStale } from './link-accounts.js';
import {
  CloudflareOAuthError,
  type CloudflareOAuthConnection,
  type ExchangedTokens,
} from './oauth-tokens.js';

export const CLOUDFLARE_CONNECT_TASK = 'cloudflare-oauth';
/** Uma execução olha o banco a cada 5 s por 30 s: o cliente espera pouco, e o log ganha uma linha por execução. */
export const CLOUDFLARE_CONNECT_POLL_MS = 5_000;
export const CLOUDFLARE_CONNECT_WATCH_MS = 30_000;
/** O orçamento de uma execução: a troca, as provas de até 50 contas e as revogações. */
export const CLOUDFLARE_CONNECT_BUDGET_MS = 3 * 60 * 1000;

/** Quanto o cliente tem para escolher as contas, contado da descoberta delas. */
export const CLOUDFLARE_CHOOSE_TTL_MS = 15 * 60 * 1000;
/** Depois disto esperando, a concessão que o Cloudflare não revogou é apagada só no nó. */
export const CLOUDFLARE_REVOKE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

const ATTEMPTS_PER_PASS = 10;
const REVOCATIONS_PER_PASS = 20;
const PROBE_WINDOW_MS = 60 * 60 * 1000;
/** A espera entre as tentativas de um passo que falhou por fora (a origem, o banco): 5, 10, 20... até 60 s. */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;
const RATE_LIMIT_WAIT_MS = 60_000;
/** A espera entre as tentativas de revogar: 1, 2, 4... minutos, até 1 h. */
const REVOKE_RETRY_BASE_MS = 60_000;
const REVOKE_RETRY_MAX_MS = 60 * 60 * 1000;
/** As tentativas de gravar os tokens de uma troca já feita (a primeira é na hora). */
const SAVE_DELAYS_MS: readonly number[] = [0, 250, 1_000, 2_000];

/** O que a tarefa loga (o pino do worker; um dublê nos testes). Só ids do banco, contagens e códigos. */
export interface ConnectLogger {
  warn(fields: object, message: string): void;
}

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface CloudflareConnectReport {
  status: 'done' | 'locked';
  exchanged: number;
  /** Tentativas que esperam o cliente escolher as contas. */
  choosing: number;
  linked: number;
  failed: number;
  /** Passos adiados (a origem fora do ar, o limite de requisições). */
  postponed: number;
  revoked: number;
  revokeFailed: number;
  /** Concessões que o Cloudflare não revogou em 24 h, apagadas só no nó. */
  abandoned: number;
}

export interface CloudflareConnectOptions {
  oauth: CloudflareOAuthConnection;
  client: CloudflareClient;
  logger: ConnectLogger;
  audit?: AuditService;
  /** Nome da concessão do banco (um worker por vez); os testes usam um por arquivo. */
  name?: string;
  leaseMs?: number;
  /** Só estes clientes (os testes, que dividem o banco). */
  tenantIds?: readonly string[];
  saveDelaysMs?: readonly number[];
  now?: () => Date;
}

interface AttemptRow {
  id: string;
  tenantId: string;
  userId: string;
  status: string;
  verifierCiphertext: string | null;
  codeCiphertext: string | null;
  cloudAccountId: string | null;
  grantId: string | null;
  config: Prisma.JsonValue;
  accounts: Prisma.JsonValue;
  accountIdRequired: boolean;
  chosenAccountIds: string[];
  expiresAt: Date;
}

const ATTEMPT_SELECT = {
  id: true,
  tenantId: true,
  userId: true,
  status: true,
  verifierCiphertext: true,
  codeCiphertext: true,
  cloudAccountId: true,
  grantId: true,
  config: true,
  accounts: true,
  accountIdRequired: true,
  chosenAccountIds: true,
  expiresAt: true,
} as const satisfies Prisma.CloudflareConnectAttemptSelect;

/** A origem não respondeu: o passo é tentado de novo enquanto a tentativa vale. */
class StepPostponed extends Error {
  constructor(
    readonly code: string,
    readonly waitMs: number | undefined,
  ) {
    super(`conexão do Cloudflare adiada: ${code}`);
    this.name = 'StepPostponed';
  }
}

const HIDDEN = '[acesso do Cloudflare por OAuth]';

/** O acesso recém-emitido, só para as provas: esta tarefa não renova (quem renova é o coletor). */
class ProbeBearer implements CloudflareBearer {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  value(): string {
    return this.#value;
  }
  toJSON(): string {
    return HIDDEN;
  }
  toString(): string {
    return HIDDEN;
  }
  [inspect.custom](): string {
    return HIDDEN;
  }
}

/** A recusa diz que o acesso não serve para isto; o resto (rede, 5xx, limite, formato) não prova nada. */
function isRefusal(error: CloudflareApiError): boolean {
  return (
    error.code === 'credential_rejected' ||
    error.code === 'credential_forbidden' ||
    error.code === 'bad_request' ||
    (error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429)
  );
}

function postponed(error: CloudflareApiError): StepPostponed {
  return new StepPostponed(
    error.code,
    error.code === 'rate_limited' ? (error.retryAfterMs ?? RATE_LIMIT_WAIT_MS) : undefined,
  );
}

/**
 * A conexão do Cloudflare por OAuth, do lado do worker (CF-4; a tarefa `cloudflare-oauth`). A API só guarda cifrados o
 * código e o verificador; aqui, no único processo com as chaves privadas:
 *
 * 1. **Troca:** o código vira os tokens, direto com o Cloudflare. Na mesma transação, a concessão nasce e é amarrada à
 *    tentativa aberta. Se os tokens não servem (sem renovação, escopo a menos ou a mais) ou a tentativa venceu no meio, a
 *    concessão nasce esperando a revogação: nenhum token emitido fica sem dono.
 * 2. **Descoberta:** as contas da autorização, cada uma provada com a leitura da auditoria. Uma só: é ligada. Mais de uma:
 *    o cliente escolhe no painel. Na reconexão ou migração, só a conta pedida (e as que dividiam a concessão dela).
 * 3. **Ligação** (`linkAccounts`): de novo provada a conta escolhida, numa transação com tudo ou nada. O token colado só
 *    sai do cofre aqui.
 * 4. **Revogação:** as concessões `revoking`, de qualquer origem, são revogadas no Cloudflare e apagadas. Sem resposta em
 *    24 h, saem só do nó, com registro na trilha (o cliente revoga em Connected Applications).
 *
 * Um worker por vez (`SyncLease`). Nada de código, verificador ou token vai para log, trilha ou resposta; o logger os
 * oculta enquanto estão na memória.
 */
export class CloudflareConnectJob {
  private readonly lease: SyncLease;
  private readonly audit: AuditService;
  private readonly saveDelaysMs: readonly number[];
  private readonly now: () => Date;
  /** As esperas de cada tentativa e de cada revogação, na memória: numa partida nova, tudo é tentado já. */
  private readonly waits = new Map<string, { until: number; failures: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    private readonly plans: TenantPlans,
    private readonly options: CloudflareConnectOptions,
  ) {
    this.lease = new SyncLease(
      prisma,
      options.name ?? CLOUDFLARE_CONNECT_TASK,
      randomUUID(),
      options.leaseMs ?? CLOUDFLARE_CONNECT_BUDGET_MS,
    );
    this.audit = options.audit ?? new AuditService();
    this.saveDelaysMs = options.saveDelaysMs ?? SAVE_DELAYS_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** A execução do agendador: passadas a cada 5 s por 30 s, para o cliente não esperar e o log não encher. */
  async watch(signal: AbortSignal): Promise<CloudflareConnectReport> {
    const until = Date.now() + CLOUDFLARE_CONNECT_WATCH_MS;
    const total = emptyReport();
    for (;;) {
      const report = await this.runOnce(signal);
      total.status = report.status;
      for (const key of COUNTERS) total[key] += report[key];
      if (Date.now() >= until) return total;
      try {
        await sleep(CLOUDFLARE_CONNECT_POLL_MS, undefined, { signal });
      } catch {
        // A parada do worker entre duas passadas: nada ficou no meio.
        return total;
      }
    }
  }

  async runOnce(signal?: AbortSignal): Promise<CloudflareConnectReport> {
    const report = emptyReport();
    if (!(await this.lease.acquire(this.now()))) return { ...report, status: 'locked' };
    try {
      await this.attempts(report, signal);
      await this.revocations(report, signal);
      return report;
    } finally {
      await this.lease.release();
    }
  }

  private get scope() {
    return this.options.tenantIds === undefined ? {} : { tenantId: { in: [...this.options.tenantIds] } };
  }

  // Tentativas

  private async attempts(report: CloudflareConnectReport, signal?: AbortSignal): Promise<void> {
    // Busca de sistema, entre todos os clientes do nó: só as chaves. O conteúdo é lido pelo escopo do cliente.
    const rows = await this.prisma.cloudflareConnectAttempt.findMany({
      where: {
        ...this.scope,
        expiresAt: { gt: this.now() },
        OR: [
          { status: 'code_received' },
          { status: 'choosing', discoveredAt: null },
          { status: 'choosing', chosenAccountIds: { isEmpty: false } },
        ],
      },
      select: { id: true, tenantId: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ATTEMPTS_PER_PASS,
    });
    for (const { id, tenantId } of rows) {
      signal?.throwIfAborted();
      if (this.waiting(id)) continue;
      if (!(await this.lease.renew())) return;
      try {
        await this.step(tenantId, id, report, signal);
        this.waits.delete(id);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof LinkRefused) {
          await this.fail(tenantId, id, error.code, report);
        } else if (error instanceof LinkStale) {
          // Venceu, foi excluída ou já terminou: a faxina cuida da concessão.
          continue;
        } else {
          report.postponed += 1;
          const code = error instanceof StepPostponed ? error.code : errorKind(error);
          this.options.logger.warn({ attemptId: id, error: code }, 'conexão do Cloudflare: passo adiado');
          this.postpone(
            id,
            RETRY_BASE_MS,
            RETRY_MAX_MS,
            error instanceof StepPostponed ? error.waitMs : undefined,
          );
        }
      }
    }
  }

  private load(tenantId: string, id: string): Promise<AttemptRow | null> {
    return this.prisma
      .forTenant(tenantId)
      .cloudflareConnectAttempt.findUnique({ where: { id }, select: ATTEMPT_SELECT });
  }

  private async step(
    tenantId: string,
    id: string,
    report: CloudflareConnectReport,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempt = await this.load(tenantId, id);
    if (attempt?.status === 'code_received') {
      if (!(await this.exchange(attempt, report))) return;
      attempt = await this.load(tenantId, id);
    }
    if (attempt === null || attempt.status !== 'choosing' || attempt.grantId === null) return;
    await (attempt.chosenAccountIds.length > 0
      ? this.linkChosen(attempt, attempt.grantId, report, signal)
      : this.discover(attempt, attempt.grantId, report, signal));
  }

  /** Verdadeiro quando a tentativa segue para a descoberta. */
  private async exchange(attempt: AttemptRow, report: CloudflareConnectReport): Promise<boolean> {
    const { tenantId, id } = attempt;
    const binding = { tenantId, subjectId: id };
    const config = cloudflareOauthConfigSchema.safeParse(attempt.config);
    if (!config.success || attempt.codeCiphertext === null || attempt.verifierCiphertext === null) {
      await this.fail(tenantId, id, 'internal_error', report);
      return false;
    }
    const { clientId, redirectUri, scopes } = config.data;
    let code: string;
    let verifier: string;
    try {
      code = openCloudflareOauthCode(this.keyring, binding, attempt.codeCiphertext);
      verifier = openCloudflareOauthVerifier(this.keyring, binding, attempt.verifierCiphertext);
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      await this.fail(tenantId, id, 'internal_error', report);
      return false;
    }
    registerLiveSecret(code);
    registerLiveSecret(verifier);
    // Antes do pedido: a validade é contada dele, para nunca parecer maior do que é.
    const requestedAt = this.now();
    let exchanged: ExchangedTokens;
    try {
      exchanged = await this.options.oauth.exchange({ clientId, redirectUri, code, verifier });
    } catch (error) {
      if (!(error instanceof CloudflareOAuthError)) throw error;
      switch (error.failure) {
        case 'grant_rejected':
          await this.fail(tenantId, id, 'oauth_code_rejected', report);
          return false;
        case 'client_rejected':
          await this.fail(tenantId, id, 'oauth_client_rejected', report);
          return false;
        case 'unavailable':
          // Sem resposta, o código pode já ter sido usado: a nova tentativa é recusada, e a conexão recomeça.
          throw new StepPostponed(
            error.code,
            error.code === 'rate_limited' ? (error.retryAfterMs ?? RATE_LIMIT_WAIT_MS) : undefined,
          );
      }
    } finally {
      forgetLiveSecret(code);
      forgetLiveSecret(verifier);
    }
    if (exchanged.kind === 'unusable') {
      await this.discard(clientId, exchanged.token);
      await this.fail(tenantId, id, 'internal_error', report);
      return false;
    }

    const { accessToken, refreshToken, expiresInSeconds, scope } = exchanged;
    registerLiveSecret(accessToken);
    if (refreshToken !== null) registerLiveSecret(refreshToken);
    try {
      const refused = refusalOf(scopes, scope, refreshToken);
      let sealed: SealedGrant;
      try {
        sealed = sealGrant(
          this.keyring.publicKey(),
          { tenantId, clientId, scopes, consentedAt: requestedAt, consentedBy: attempt.userId },
          {
            accessToken,
            // Sem renovação, a concessão só existe para ser revogada: pelo próprio token de acesso.
            refreshToken: refreshToken ?? accessToken,
            accessExpiresAt: new Date(requestedAt.getTime() + expiresInSeconds * 1000),
          },
        );
      } catch (error) {
        if (!(error instanceof CredentialVaultError)) throw error;
        await this.discard(clientId, refreshToken ?? accessToken);
        await this.fail(tenantId, id, 'internal_error', report);
        return false;
      }
      let kept: boolean;
      try {
        kept = await this.persist(attempt, sealed, refused);
      } catch (error) {
        // O banco não voltou: os tokens não têm onde ficar, e o código já foi usado.
        await this.discard(clientId, refreshToken ?? accessToken);
        throw error;
      }
      report.exchanged += 1;
      if (refused !== null) report.failed += 1;
      return kept;
    } finally {
      forgetLiveSecret(accessToken);
      if (refreshToken !== null) forgetLiveSecret(refreshToken);
    }
  }

  /**
   * Grava o resultado da troca, tentando de novo e sem o sinal da parada. Verdadeiro quando a tentativa ficou com a
   * concessão em uso. A tentativa que não está mais aberta (venceu, foi apagada com a conta) deixa a concessão esperando a
   * revogação.
   */
  private async persist(
    attempt: AttemptRow,
    sealed: SealedGrant,
    refused: CloudflareOauthAttemptError | null,
  ): Promise<boolean> {
    let failure: unknown;
    for (const delay of this.saveDelaysMs) {
      if (delay > 0) await sleep(delay);
      try {
        return await this.persistOnce(attempt, sealed, refused);
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  private persistOnce(
    { id, tenantId }: AttemptRow,
    sealed: SealedGrant,
    refused: CloudflareOauthAttemptError | null,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const db = scopeToTenant(tx, tenantId);
      // Uma gravação anterior que confirmou sem a resposta chegar: vale o que ela deixou.
      const saved = await db.cloudflareGrant.findUnique({
        where: { id: sealed.id },
        select: { status: true },
      });
      if (saved !== null) return saved.status === 'active';
      await createGrant(tx, sealed, refused === null ? 'active' : 'revoking', now);
      const cleared = { verifierCiphertext: null, codeCiphertext: null };
      const { count } = await db.cloudflareConnectAttempt.updateMany({
        where: { id, status: 'code_received', expiresAt: { gt: now } },
        data:
          refused === null
            ? { ...cleared, status: 'choosing', grantId: sealed.id }
            : { ...cleared, status: 'failed', errorCode: refused },
      });
      if (refused !== null) {
        if (count === 1) await this.auditFailure(tx, tenantId, id, refused);
        return false;
      }
      if (count === 1) return true;
      await db.cloudflareGrant.updateMany({
        where: { id: sealed.id },
        data: { status: 'revoking', revokeRequestedAt: now },
      });
      return false;
    });
  }

  /** Revoga na hora um token que não tem onde ficar guardado. Só uma tentativa: sem guardá-lo, não há outra. */
  private async discard(clientId: string, leftover: string | null): Promise<void> {
    if (leftover === null) return;
    registerLiveSecret(leftover);
    try {
      await this.options.oauth.revoke(clientId, leftover);
    } catch (error) {
      this.options.logger.warn(
        { error: errorKind(error) },
        'conexão do Cloudflare: um acesso que não pôde ser guardado também não pôde ser revogado',
      );
    } finally {
      forgetLiveSecret(leftover);
    }
  }

  // Descoberta e escolha

  private async discover(
    attempt: AttemptRow,
    grantId: string,
    report: CloudflareConnectReport,
    signal?: AbortSignal,
  ): Promise<void> {
    const proved = await this.withAccess(attempt, grantId, async (bearer) =>
      attempt.cloudAccountId === null
        ? this.proveListed(attempt.tenantId, bearer, signal)
        : this.proveTarget(attempt.tenantId, attempt.cloudAccountId, bearer, signal),
    );
    const usable = proved.accounts.filter(isUsable);
    if (proved.link !== null) {
      await this.link(attempt, grantId, proved.link, report);
      return;
    }
    if (!proved.accountIdRequired && usable.length === 0) throw new LinkRefused('oauth_no_account');
    await this.offer(attempt, proved.accounts, proved.accountIdRequired, report);
  }

  /** O cliente escolhe: a lista fica na tentativa, e o prazo recomeça. */
  private async offer(
    attempt: AttemptRow,
    accounts: readonly CloudflareOauthAccount[],
    accountIdRequired: boolean,
    report: CloudflareConnectReport,
  ): Promise<void> {
    const now = this.now();
    const { count } = await this.prisma.forTenant(attempt.tenantId).cloudflareConnectAttempt.updateMany({
      where: { id: attempt.id, status: 'choosing', grantId: attempt.grantId, expiresAt: { gt: now } },
      data: {
        accounts: accounts.map((account) => ({ ...account })),
        accountIdRequired,
        chosenAccountIds: [],
        discoveredAt: now,
        expiresAt: new Date(now.getTime() + CLOUDFLARE_CHOOSE_TTL_MS),
      },
    });
    if (count === 1) report.choosing += 1;
  }

  private async linkChosen(
    attempt: AttemptRow,
    grantId: string,
    report: CloudflareConnectReport,
    signal?: AbortSignal,
  ): Promise<void> {
    const names = new Map(knownAccounts(attempt.accounts).map((account) => [account.accountId, account]));
    const chosen = attempt.chosenAccountIds.slice(0, CLOUDFLARE_OAUTH_MAX_ACCOUNTS);
    const proved = await this.withAccess(attempt, grantId, (bearer) =>
      this.proveAll(
        attempt.tenantId,
        bearer,
        chosen.map((accountId) => ({ id: accountId, name: names.get(accountId)?.name ?? null })),
        signal,
      ),
    );
    if (proved.some((account) => account.state === 'unavailable')) {
      throw new StepPostponed('source_unavailable', undefined);
    }
    if (proved.every(isUsable)) {
      await this.link(attempt, grantId, chosen, report);
      return;
    }
    // Uma escolhida não é lida por esta autorização: o cliente vê qual e escolhe de novo, dentro do prazo.
    // Com o ID digitado, a lista é só a da última escolha: ela não cresce a cada engano.
    if (attempt.accountIdRequired) names.clear();
    for (const account of proved) names.set(account.accountId, account);
    await this.offer(attempt, [...names.values()], attempt.accountIdRequired, report);
  }

  private async link(
    attempt: AttemptRow,
    grantId: string,
    accountIds: readonly string[],
    report: CloudflareConnectReport,
  ): Promise<void> {
    await linkAccounts(
      { prisma: this.prisma, plans: this.plans, audit: this.audit },
      { tenantId: attempt.tenantId, attemptId: attempt.id, grantId, accountIds },
      this.now(),
    );
    report.linked += accountIds.length;
  }

  /** Abre o acesso da concessão só enquanto as provas rodam. */
  private async withAccess<T>(
    attempt: AttemptRow,
    grantId: string,
    run: (bearer: CloudflareBearer) => Promise<T>,
  ): Promise<T> {
    const { tenantId } = attempt;
    const grant = await this.prisma
      .forTenant(tenantId)
      .cloudflareGrant.findUnique({ where: { id: grantId }, select: { ciphertext: true, status: true } });
    if (grant?.status !== 'active') throw new LinkStale();
    let accessToken: string;
    try {
      ({ accessToken } = openCloudflareOauthTokens(
        this.keyring,
        { tenantId, subjectId: grantId },
        grant.ciphertext,
      ));
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      throw new LinkRefused('internal_error');
    }
    registerLiveSecret(accessToken);
    try {
      return await run(new ProbeBearer(accessToken));
    } finally {
      // Antes da ligação: depois dela, o coletor abre o mesmo acesso e o mantém oculto.
      forgetLiveSecret(accessToken);
    }
  }

  /** As contas que a autorização alcança, provadas. Sem lista nenhuma, o cliente digita o ID. */
  private async proveListed(
    tenantId: string,
    bearer: CloudflareBearer,
    signal?: AbortSignal,
  ): Promise<Discovery> {
    const reachable = await this.reachable(bearer, signal);
    if (reachable === null) return { accounts: [], accountIdRequired: true, link: null };
    const accounts = await this.proveAll(tenantId, bearer, reachable, signal);
    const usable = accounts.filter(isUsable);
    // Nenhuma serve, mas alguma não respondeu: ainda não se sabe.
    if (usable.length === 0 && accounts.some((account) => account.state === 'unavailable')) {
      throw new StepPostponed('source_unavailable', undefined);
    }
    const [only] = accounts;
    const single = accounts.length === 1 && only !== undefined && isUsable(only);
    return { accounts, accountIdRequired: false, link: single ? [only.accountId] : null };
  }

  /**
   * A reconexão ou a migração de uma conta cadastrada: só ela, e as que dividiam a concessão dela e também são lidas por
   * esta autorização. As demais ficam como estão.
   */
  private async proveTarget(
    tenantId: string,
    cloudAccountId: string,
    bearer: CloudflareBearer,
    signal?: AbortSignal,
  ): Promise<Discovery> {
    const db = this.prisma.forTenant(tenantId);
    const target = await db.cloudAccount.findUnique({
      where: { id: cloudAccountId },
      select: { accountId: true, cloudflareGrantId: true },
    });
    if (target === null) throw new LinkStale();
    const state = await this.probe(bearer, target.accountId, signal);
    if (state === 'unavailable') throw new StepPostponed('source_unavailable', undefined);
    if (state === 'forbidden') {
      const reachable = await this.reachable(bearer, signal);
      const listed = reachable?.some((account) => account.id === target.accountId) ?? true;
      throw new LinkRefused(listed ? 'oauth_no_account' : 'oauth_account_mismatch');
    }
    const link = [target.accountId];
    if (target.cloudflareGrantId !== null) {
      const siblings = await db.cloudAccount.findMany({
        where: {
          cloudflareGrantId: target.cloudflareGrantId,
          provider: 'cloudflare',
          status: 'active',
          id: { not: cloudAccountId },
        },
        select: { accountId: true },
        orderBy: { id: 'asc' },
        take: CLOUDFLARE_OAUTH_MAX_ACCOUNTS - 1,
      });
      for (const { accountId } of siblings) {
        const sibling = await this.probe(bearer, accountId, signal);
        if (sibling === 'unavailable') throw new StepPostponed('source_unavailable', undefined);
        if (sibling === 'ok') link.push(accountId);
      }
    }
    return { accounts: [], accountIdRequired: false, link };
  }

  /** Null quando o Cloudflare não lista as contas para este acesso. */
  private async reachable(
    bearer: CloudflareBearer,
    signal?: AbortSignal,
  ): Promise<ReachableAccount[] | null> {
    for (const list of [
      () => this.options.client.accounts(bearer, signal),
      () => this.options.client.zoneAccounts(bearer, signal),
    ]) {
      try {
        const found = await list();
        if (found.length > 0) return found;
      } catch (error) {
        if (!(error instanceof CloudflareApiError)) throw error;
        if (!isRefusal(error)) throw postponed(error);
      }
    }
    return null;
  }

  private async proveAll(
    tenantId: string,
    bearer: CloudflareBearer,
    candidates: readonly ReachableAccount[],
    signal?: AbortSignal,
  ): Promise<CloudflareOauthAccount[]> {
    // A conta é única no nó inteiro: a de outro cliente nunca é oferecida nem identificada como tal.
    const known = new Map(
      (
        await this.prisma.cloudAccount.findMany({
          where: { provider: 'cloudflare', accountId: { in: candidates.map(({ id }) => id) } },
          select: { accountId: true, tenantId: true },
        })
      ).map((row) => [row.accountId, row.tenantId]),
    );
    const accounts: CloudflareOauthAccount[] = [];
    for (const { id, name } of candidates) {
      signal?.throwIfAborted();
      const owner = known.get(id);
      const proof =
        owner !== undefined && owner !== tenantId ? 'forbidden' : await this.probe(bearer, id, signal);
      const state = proof !== 'ok' ? proof : owner === undefined ? 'available' : 'registered';
      accounts.push({ accountId: id, name, state });
    }
    return accounts;
  }

  /** A leitura de prova: uma entrada da auditoria da última hora, o que a coleta precisa. */
  private async probe(
    bearer: CloudflareBearer,
    accountId: string,
    signal?: AbortSignal,
  ): Promise<'ok' | 'forbidden' | 'unavailable'> {
    const now = this.now();
    try {
      await this.options.client.auditPage(
        bearer,
        accountId,
        { since: new Date(now.getTime() - PROBE_WINDOW_MS), before: now, limit: 1 },
        signal,
      );
      return 'ok';
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      // O limite é do acesso inteiro: as outras contas também esperam.
      if (error.code === 'rate_limited') throw postponed(error);
      return isRefusal(error) ? 'forbidden' : 'unavailable';
    }
  }

  // Fim da tentativa

  /** A tentativa falhou; a concessão dela, que nenhuma conta usa, vai para a revogação na mesma transação. */
  private async fail(
    tenantId: string,
    id: string,
    code: CloudflareOauthAttemptError,
    report: CloudflareConnectReport,
  ): Promise<void> {
    const failed = await this.prisma.$transaction(async (tx) => {
      const now = this.now();
      const db = scopeToTenant(tx, tenantId);
      const row = await db.cloudflareConnectAttempt.findUnique({ where: { id }, select: { grantId: true } });
      if (row === null) return false;
      if (row.grantId !== null) await lockGrant(tx, row.grantId);
      const { count } = await db.cloudflareConnectAttempt.updateMany({
        where: { id, status: { in: ['code_received', 'choosing'] }, grantId: row.grantId },
        data: {
          status: 'failed',
          errorCode: code,
          verifierCiphertext: null,
          codeCiphertext: null,
          // A linha da concessão some ao ser revogada, e levaria a tentativa junto: o painel ainda a lê.
          grantId: null,
          chosenAccountIds: [],
        },
      });
      if (count !== 1) return false;
      if (row.grantId !== null) await releaseGrantIfUnused(tx, tenantId, row.grantId, now);
      await this.auditFailure(tx, tenantId, id, code);
      return true;
    });
    if (failed) report.failed += 1;
  }

  private auditFailure(
    tx: Prisma.TransactionClient,
    tenantId: string,
    id: string,
    code: CloudflareOauthAttemptError,
  ): Promise<void> {
    return this.audit.write(tx, {
      actor: { type: 'system', tenantId },
      action: 'cloudflare_oauth.failed',
      outcome: 'failure',
      resourceType: 'cloudflare_oauth',
      resourceId: id,
      after: { errorCode: code },
    });
  }

  // Revogação

  private async revocations(report: CloudflareConnectReport, signal?: AbortSignal): Promise<void> {
    const now = this.now();
    const rows = await this.prisma.cloudflareGrant.findMany({
      where: { ...this.scope, status: 'revoking', cloudAccounts: { none: {} } },
      select: {
        id: true,
        tenantId: true,
        clientId: true,
        ciphertext: true,
        generation: true,
        refreshStartedAt: true,
        revokeRequestedAt: true,
      },
      orderBy: [{ revokeRequestedAt: 'asc' }, { id: 'asc' }],
      take: REVOCATIONS_PER_PASS,
    });
    for (const grant of rows) {
      signal?.throwIfAborted();
      const requestedAt = grant.revokeRequestedAt ?? now;
      const giveUp = now.getTime() - requestedAt.getTime() >= CLOUDFLARE_REVOKE_GIVE_UP_MS;
      if (!giveUp && this.waiting(grant.id)) continue;
      // Uma renovação em curso vai gravar outro token: espera ela terminar.
      const renewing = grant.refreshStartedAt;
      if (renewing !== null && Math.abs(now.getTime() - renewing.getTime()) < GRANT_INTENT_HOLD_MS) continue;
      if (!(await this.lease.renew())) return;
      const error = await this.revoke(grant);
      if (error === null) {
        if (await this.remove(grant, 'cloudflare_grant.revoke', 'success', null)) report.revoked += 1;
        this.waits.delete(grant.id);
        continue;
      }
      report.revokeFailed += 1;
      this.options.logger.warn(
        { grantId: grant.id, error: error.code },
        'conexão do Cloudflare: a revogação não foi confirmada',
      );
      if (giveUp) {
        if (await this.remove(grant, 'cloudflare_grant.abandon', 'failure', error.code))
          report.abandoned += 1;
        this.waits.delete(grant.id);
        continue;
      }
      this.postpone(grant.id, REVOKE_RETRY_BASE_MS, REVOKE_RETRY_MAX_MS, error.waitMs);
    }
  }

  private async revoke(grant: {
    id: string;
    tenantId: string;
    clientId: string;
    ciphertext: string;
  }): Promise<{ code: string; waitMs: number | undefined } | null> {
    let refreshToken: string;
    try {
      ({ refreshToken } = openCloudflareOauthTokens(
        this.keyring,
        { tenantId: grant.tenantId, subjectId: grant.id },
        grant.ciphertext,
      ));
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      return { code: 'oauth_unreadable', waitMs: REVOKE_RETRY_MAX_MS };
    }
    registerLiveSecret(refreshToken);
    try {
      await this.options.oauth.revoke(grant.clientId, refreshToken);
      return null;
    } catch (error) {
      if (!(error instanceof CloudflareOAuthError)) throw error;
      // O token que o Cloudflare diz que já não vale está revogado.
      if (error.failure === 'grant_rejected') return null;
      return { code: error.code, waitMs: error.retryAfterMs };
    } finally {
      forgetLiveSecret(refreshToken);
    }
  }

  /** Apaga a linha só se ela ainda é a revogada: um token novo gravado no meio é revogado na próxima passada. */
  private remove(
    grant: { id: string; tenantId: string; generation: number },
    action: string,
    outcome: 'success' | 'failure',
    errorCode: string | null,
  ): Promise<boolean> {
    const { id, tenantId, generation } = grant;
    return this.prisma.$transaction(async (tx) => {
      await lockGrant(tx, id);
      const db = scopeToTenant(tx, tenantId);
      const where = { id, generation, status: 'revoking', cloudAccounts: { none: {} } };
      if ((await db.cloudflareGrant.count({ where })) !== 1) return false;
      // A tentativa terminada fica até o prazo dela: só perde a referência (`done` só existe com a concessão, e sai).
      await db.cloudflareConnectAttempt.updateMany({
        where: { grantId: id, status: { in: ['failed', 'expired'] } },
        data: { grantId: null },
      });
      const { count } = await db.cloudflareGrant.deleteMany({ where });
      if (count !== 1) return false;
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId },
        action,
        outcome,
        resourceType: 'cloudflare_grant',
        resourceId: id,
        ...(errorCode !== null && { after: { errorCode } }),
      });
      return true;
    });
  }

  // Esperas

  private waiting(id: string): boolean {
    const wait = this.waits.get(id);
    return wait !== undefined && wait.until > this.now().getTime();
  }

  private postpone(id: string, baseMs: number, maxMs: number, waitMs: number | undefined): void {
    const now = this.now().getTime();
    const failures = (this.waits.get(id)?.failures ?? 0) + 1;
    const delay = waitMs ?? Math.min(maxMs, baseMs * 2 ** Math.min(failures - 1, 10));
    this.waits.set(id, { until: now + delay, failures });
    // O que já saiu do banco não fica na memória para sempre.
    if (this.waits.size > 1_000) {
      for (const [key, wait] of this.waits) if (wait.until < now) this.waits.delete(key);
    }
  }
}

/** O que a descoberta achou: a lista para escolher, ou as contas a ligar já. */
interface Discovery {
  accounts: CloudflareOauthAccount[];
  accountIdRequired: boolean;
  link: string[] | null;
}

function isUsable(account: CloudflareOauthAccount): boolean {
  return account.state === 'available' || account.state === 'registered';
}

/** As contas gravadas na tentativa por este worker (o que não está no formato é ignorado). */
function knownAccounts(value: Prisma.JsonValue): CloudflareOauthAccount[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CloudflareOauthAccount & Prisma.JsonObject =>
      typeof item === 'object' && item !== null && 'accountId' in item && 'state' in item,
  );
}

/** Por que os tokens não servem, ou null. A resposta sem os escopos concede os pedidos (RFC 6749, 5.1). */
function refusalOf(
  requested: readonly string[],
  granted: string | null,
  refreshToken: string | null,
): CloudflareOauthAttemptError | null {
  if (granted !== null) {
    const { missing, unexpected } = compareCloudflareScopes(requested, granted);
    if (unexpected.length > 0) return 'oauth_scope_unexpected';
    if (missing.length > 0) return 'oauth_scope_missing';
  }
  return refreshToken === null ? 'oauth_no_refresh' : null;
}

const COUNTERS = [
  'exchanged',
  'choosing',
  'linked',
  'failed',
  'postponed',
  'revoked',
  'revokeFailed',
  'abandoned',
] as const satisfies readonly (keyof CloudflareConnectReport)[];

function emptyReport(): CloudflareConnectReport {
  return {
    status: 'done',
    exchanged: 0,
    choosing: 0,
    linked: 0,
    failed: 0,
    postponed: 0,
    revoked: 0,
    revokeFailed: 0,
    abandoned: 0,
  };
}
