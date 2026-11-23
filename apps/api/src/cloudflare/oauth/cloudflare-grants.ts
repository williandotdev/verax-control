import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';
import { CLOUDFLARE_OAUTH_CLIENT_ERROR, compareCloudflareScopes } from '@verax/shared';
import {
  CredentialVaultError,
  type CloudflareOauthTokens as GrantTokens,
  openCloudflareOauthTokens,
  sealCloudflareOauthTokens,
} from '@verax/vault-envelope';
import { errorKind } from '../../common/logger/error-kind.js';
import { forgetLiveSecret, registerLiveSecret } from '../../common/logger/sanitize.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { VaultKeyring } from '../../credentials/credential-keys.js';
import { lockGrant } from '../../credentials/credential-rekey.js';
import type { BearerRenewal, CloudflareBearer } from '../cloudflare-bearer.js';
import { CloudflareOAuthError, type CloudflareOAuthTokens, type RefreshedTokens } from './oauth-tokens.js';

/** Renova com menos disto de vida, ou com menos de um quinto do prazo, o que for menor. */
export const GRANT_RENEW_BEFORE_MS = 10 * 60 * 1000;
const GRANT_RENEW_FRACTION = 0.2;
/** Sem renovação, o acesso ainda serve até faltar isto (um pedido em curso não vence no meio). */
const ACCESS_SKEW_MS = 30 * 1000;
/**
 * Uma intenção de renovar mais nova que isto é de outro worker em curso: ninguém usa o mesmo token de renovação ao mesmo
 * tempo. Mais velha, é de um worker que caiu no meio. Maior que o pior caso de uma renovação (o pedido e a gravação).
 */
export const GRANT_INTENT_HOLD_MS = 45 * 1000;
/** Esperas depois de uma renovação que falhou: passageira (dobra até o teto) e o app recusado (problema da Verax). */
const RENEW_BACKOFF_MS = 60 * 1000;
const RENEW_BACKOFF_MAX_MS = 60 * 60 * 1000;
export const GRANT_CLIENT_REJECTED_WAIT_MS = 60 * 60 * 1000;
const RENEW_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
/** As tentativas de gravar uma renovação já feita (a primeira é na hora). */
const SAVE_DELAYS_MS: readonly number[] = [0, 250, 1_000, 2_000];

/** Os códigos que a renovação deixa na concessão e na conexão da conta. */
export const GRANT_UNAVAILABLE_ERROR = 'oauth_refresh_unavailable';

/** Qual concessão, e de quem: sempre da linha do banco, pelo escopo do cliente. */
export interface GrantRef {
  readonly tenantId: string;
  readonly grantId: string;
}

/** O acesso de uma concessão, para ler agora. */
export type GrantOutcome =
  | { kind: 'ready'; consentedAt: Date; bearer: GrantBearer }
  /** A autorização acabou: só o cliente conectando de novo. */
  | { kind: 'reconnect'; consentedAt: Date }
  /** O envelope não abre neste worker. */
  | { kind: 'unreadable'; consentedAt: Date }
  /** O acesso venceu e a renovação não pôde ser feita agora. */
  | { kind: 'waiting'; consentedAt: Date; code: string; retryAt: Date }
  /** Sem a concessão, ou ela está sendo revogada. */
  | { kind: 'gone' };

/** Contagens das renovações, para o relatório da execução. */
export interface GrantCounters {
  renewed: number;
  /** O Cloudflare recusou o app da Verax (vai para o log do agendador: é nosso). */
  appRejected: number;
  failed: number;
}

interface GrantRow {
  clientId: string;
  ciphertext: string;
  accessExpiresAt: Date;
  scopes: string[];
  generation: number;
  consentedAt: Date;
  lastRefreshAt: Date | null;
  status: string;
}

type Renewal =
  | { kind: 'renewed'; row: GrantRow; tokens: GrantTokens }
  | { kind: 'reconnect' }
  | { kind: 'gone' }
  | { kind: 'unreadable' }
  | { kind: 'failed'; code: string; retryAt: Date };

interface Backoff {
  until: number;
  failures: number;
  code: string;
}

/** Uma renovação feita no Cloudflare e ainda não gravada: só o envelope, já cifrado. */
interface Unsaved {
  ref: GrantRef;
  generation: number;
  ciphertext: string;
  keyVersion: number;
  accessExpiresAt: Date;
  refreshedAt: Date;
}

const HIDDEN = '[acesso do Cloudflare por OAuth]';

/**
 * O acesso de uma concessão durante a leitura de uma conta. Se o Cloudflare o recusa (401), o cliente chama `renew`, que
 * renova uma vez: a segunda recusa na mesma leitura vale. Só uma renovação que deu certo (ou a autorização que acabou)
 * prova a recusa; depois de uma que não pôde ser feita, a resposta continua sendo essa, sem novo pedido ao Cloudflare.
 */
export class GrantBearer implements CloudflareBearer {
  #value: string;
  #generation: number;
  #outcome: BearerRenewal | null = null;
  readonly #renewFrom: (generation: number) => Promise<Renewal>;

  constructor(value: string, generation: number, renewFrom: (generation: number) => Promise<Renewal>) {
    this.#value = value;
    this.#generation = generation;
    this.#renewFrom = renewFrom;
  }

  value(): string {
    return this.#value;
  }

  /** A geração do acesso em uso (a recusa só vale para ela). */
  get generation(): number {
    return this.#generation;
  }

  async renew(): Promise<BearerRenewal> {
    if (this.#outcome !== null) return this.#outcome === 'unavailable' ? 'unavailable' : 'rejected';
    // Se a renovação lançar (o banco fora), nada ficou provado.
    this.#outcome = 'unavailable';
    this.#outcome = await this.renewOnce();
    return this.#outcome;
  }

  private async renewOnce(): Promise<BearerRenewal> {
    const renewal = await this.#renewFrom(this.#generation);
    if (renewal.kind === 'renewed') {
      this.#value = renewal.tokens.accessToken;
      this.#generation = renewal.row.generation;
      return 'renewed';
    }
    return renewal.kind === 'failed' || renewal.kind === 'unreadable' ? 'unavailable' : 'rejected';
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

export interface CloudflareGrantsOptions {
  saveDelaysMs?: readonly number[];
}

/**
 * As concessões do Cloudflare por OAuth, do lado do worker (CF-3): abre o acesso de cada uma e o renova.
 *
 * A renovação, com o token de renovação possivelmente trocado a cada uso:
 * 1. numa transação curta, sob o lock da concessão (`lockGrant`), grava a intenção (`refreshStartedAt`), só se a geração
 *    é a lida e ninguém mais está renovando;
 * 2. chama o Cloudflare fora de transação, sem repetir e sem o sinal da parada;
 * 3. noutra transação, sob o lock, grava o envelope novo só se a geração ainda é a lida, e a incrementa. O acesso novo
 *    só é usado depois disso. A gravação ignora a parada do worker e é tentada de novo; se o banco não volta, o envelope
 *    fica na memória, e a execução seguinte o grava antes de qualquer outra coisa.
 *
 * Uma queda entre 2 e 3 deixa a intenção gravada: na volta, a renovação é tentada uma vez com o token guardado, e o
 * `invalid_grant` pede a reconexão. Essa janela não tem como ser fechada com um token que muda a cada uso.
 *
 * Enquanto o acesso vale, uma renovação que falha não para a leitura. As esperas entre tentativas ficam na memória do
 * worker: numa partida nova, uma tentativa é feita já. Os tokens que saem de uso saem também da máscara do logger
 * (`forgetLiveSecret`): eles mudam de hora em hora, e o conjunto não pode crescer sem fim.
 */
export class CloudflareGrants {
  private readonly backoff = new Map<string, Backoff>();
  private readonly unsaved = new Map<string, Unsaved>();
  /** Os tokens de cada concessão que o logger está ocultando. */
  private readonly live = new Map<string, readonly string[]>();
  private readonly saveDelaysMs: readonly number[];
  private counters: GrantCounters = { renewed: 0, appRejected: 0, failed: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    private readonly oauth: CloudflareOAuthTokens,
    options: CloudflareGrantsOptions = {},
  ) {
    this.saveDelaysMs = options.saveDelaysMs ?? SAVE_DELAYS_MS;
  }

  /** O acesso para ler agora, renovado antes quando está perto de vencer. */
  async open(ref: GrantRef, clock: () => Date): Promise<GrantOutcome> {
    await this.flush(ref.grantId);
    const row = await this.load(ref);
    if (row === null || row.status === 'revoking') return this.drop(ref);
    const { consentedAt } = row;
    if (row.status !== 'active') {
      this.forget(ref.grantId);
      return { kind: 'reconnect', consentedAt };
    }
    const tokens = this.unseal(ref, row);
    if (tokens === null) return { kind: 'unreadable', consentedAt };
    if (!this.expiring(row, tokens, clock())) return this.ready(ref, row, tokens, clock);
    const renewal = await this.renew(ref, row, tokens, clock);
    switch (renewal.kind) {
      case 'renewed':
        return this.ready(ref, renewal.row, renewal.tokens, clock);
      case 'reconnect':
        return { kind: 'reconnect', consentedAt };
      case 'gone':
        return this.drop(ref);
      case 'unreadable':
        return { kind: 'unreadable', consentedAt };
      case 'failed':
        // O acesso guardado ainda vale: a leitura segue com ele, e a renovação é tentada depois.
        if (tokens.accessExpiresAt.getTime() - ACCESS_SKEW_MS > clock().getTime()) {
          return this.ready(ref, row, tokens, clock);
        }
        return { kind: 'waiting', consentedAt, code: renewal.code, retryAt: renewal.retryAt };
    }
  }

  /** O Cloudflare recusou o acesso mesmo depois de renovado: a autorização acabou (só se nada mudou desde então). */
  async reject(ref: GrantRef, generation: number, code: string): Promise<void> {
    await this.markReconnect(ref, generation, code);
  }

  /** As contagens desde a última chamada. */
  takeCounters(): GrantCounters {
    const counters = this.counters;
    this.counters = { renewed: 0, appRejected: 0, failed: 0 };
    return counters;
  }

  /**
   * Fim da execução: o que ficou por gravar de uma concessão que nenhuma conta usa mais é tentado de novo (a revogação
   * precisa do token atual), e os tokens das que saíram de uso deixam a máscara do logger.
   */
  async prune(inUse: ReadonlySet<string>): Promise<void> {
    for (const grantId of [...this.unsaved.keys()]) {
      // Sem banco, fica na memória para a próxima execução.
      if (!inUse.has(grantId)) await this.flush(grantId).catch(() => undefined);
    }
    for (const grantId of [...this.live.keys()]) {
      if (!inUse.has(grantId) && !this.unsaved.has(grantId)) this.forget(grantId);
    }
    for (const grantId of [...this.backoff.keys()]) {
      if (!inUse.has(grantId)) this.backoff.delete(grantId);
    }
  }

  private ready(ref: GrantRef, row: GrantRow, tokens: GrantTokens, clock: () => Date): GrantOutcome {
    return {
      kind: 'ready',
      consentedAt: row.consentedAt,
      bearer: new GrantBearer(tokens.accessToken, row.generation, (generation) =>
        this.renewFrom(ref, generation, clock),
      ),
    };
  }

  private drop(ref: GrantRef): GrantOutcome {
    this.forget(ref.grantId);
    return { kind: 'gone' };
  }

  private load(ref: GrantRef): Promise<GrantRow | null> {
    return this.prisma.forTenant(ref.tenantId).cloudflareGrant.findUnique({
      where: { id: ref.grantId },
      select: {
        clientId: true,
        ciphertext: true,
        accessExpiresAt: true,
        scopes: true,
        generation: true,
        consentedAt: true,
        lastRefreshAt: true,
        status: true,
      },
    });
  }

  private unseal(ref: GrantRef, row: GrantRow): GrantTokens | null {
    try {
      const binding = { tenantId: ref.tenantId, subjectId: ref.grantId };
      const tokens = openCloudflareOauthTokens(this.keyring, binding, row.ciphertext);
      this.track(ref.grantId, [tokens.accessToken, tokens.refreshToken]);
      return tokens;
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      return null;
    }
  }

  private expiring(row: GrantRow, tokens: GrantTokens, now: Date): boolean {
    const issuedAt = row.lastRefreshAt ?? row.consentedAt;
    const lifetime = Math.max(0, tokens.accessExpiresAt.getTime() - issuedAt.getTime());
    const margin = Math.min(GRANT_RENEW_BEFORE_MS, lifetime * GRANT_RENEW_FRACTION);
    return tokens.accessExpiresAt.getTime() - Math.max(margin, ACCESS_SKEW_MS) <= now.getTime();
  }

  /** Renova o acesso que o Cloudflare recusou. Se outra leitura já o renovou, vale o que ela gravou. */
  private async renewFrom(ref: GrantRef, generation: number, clock: () => Date): Promise<Renewal> {
    const row = await this.load(ref);
    if (row === null || row.status === 'revoking') return { kind: 'gone' };
    if (row.status !== 'active') return { kind: 'reconnect' };
    const tokens = this.unseal(ref, row);
    if (tokens === null) return { kind: 'unreadable' };
    if (row.generation !== generation) return { kind: 'renewed', row, tokens };
    return this.renew(ref, row, tokens, clock);
  }

  private async renew(
    ref: GrantRef,
    row: GrantRow,
    tokens: GrantTokens,
    clock: () => Date,
  ): Promise<Renewal> {
    const waiting = this.backoff.get(ref.grantId);
    if (waiting !== undefined && waiting.until > clock().getTime()) {
      return { kind: 'failed', code: waiting.code, retryAt: new Date(waiting.until) };
    }
    const begun = await this.begin(ref, row.generation, clock());
    if (begun.kind === 'moved') return this.current(ref);
    if (begun.kind !== 'begun') return begun;

    // Antes do pedido: a validade é contada dele, para nunca parecer maior do que é.
    const requestedAt = clock();
    let refreshed: RefreshedTokens;
    try {
      refreshed = await this.oauth.refresh(row.clientId, tokens.refreshToken);
    } catch (error) {
      if (!(error instanceof CloudflareOAuthError)) throw error;
      return this.refreshFailed(ref, row, error, clock());
    }
    return this.accept(ref, row, tokens, refreshed, requestedAt, clock);
  }

  /** A intenção de renovar, gravada antes do pedido. */
  private begin(
    ref: GrantRef,
    generation: number,
    now: Date,
  ): Promise<{ kind: 'begun' } | { kind: 'moved' } | Extract<Renewal, { kind: 'failed' }>> {
    return this.prisma.$transaction(async (tx) => {
      await lockGrant(tx, ref.grantId);
      const db = scopeToTenant(tx, ref.tenantId);
      const current = await db.cloudflareGrant.findUnique({
        where: { id: ref.grantId },
        select: { generation: true, status: true, refreshStartedAt: true },
      });
      if (current?.generation !== generation || current.status !== 'active') return { kind: 'moved' };
      const started = current.refreshStartedAt;
      if (started !== null && Math.abs(now.getTime() - started.getTime()) < GRANT_INTENT_HOLD_MS) {
        const retryAt = new Date(now.getTime() + GRANT_INTENT_HOLD_MS);
        return { kind: 'failed', code: GRANT_UNAVAILABLE_ERROR, retryAt };
      }
      await db.cloudflareGrant.updateMany({
        where: { id: ref.grantId, generation },
        data: { refreshStartedAt: now },
      });
      return { kind: 'begun' };
    });
  }

  /** O que está gravado agora, depois de outra leitura ter mexido na concessão. */
  private async current(ref: GrantRef): Promise<Renewal> {
    const row = await this.load(ref);
    if (row === null || row.status === 'revoking') return { kind: 'gone' };
    if (row.status !== 'active') return { kind: 'reconnect' };
    const tokens = this.unseal(ref, row);
    return tokens === null ? { kind: 'unreadable' } : { kind: 'renewed', row, tokens };
  }

  private async refreshFailed(
    ref: GrantRef,
    row: GrantRow,
    error: CloudflareOAuthError,
    now: Date,
  ): Promise<Renewal> {
    if (error.failure === 'grant_rejected') {
      // Só vale se ninguém renovou no meio: senão a recusa é a do token que já saiu de uso.
      const marked = await this.markReconnect(ref, row.generation, error.code);
      return marked ? { kind: 'reconnect' } : this.current(ref);
    }
    const rejected = error.failure === 'client_rejected';
    if (rejected) this.counters.appRejected += 1;
    else this.counters.failed += 1;
    const failures = (this.backoff.get(ref.grantId)?.failures ?? 0) + 1;
    const wait = rejected
      ? GRANT_CLIENT_REJECTED_WAIT_MS
      : error.code === 'rate_limited'
        ? (error.retryAfterMs ?? RENEW_RATE_LIMIT_WAIT_MS)
        : Math.min(RENEW_BACKOFF_MAX_MS, RENEW_BACKOFF_MS * 2 ** Math.min(failures - 1, 10));
    return this.postpone(ref, row.generation, error, {
      until: now.getTime() + wait,
      failures,
      code: rejected ? CLOUDFLARE_OAUTH_CLIENT_ERROR : GRANT_UNAVAILABLE_ERROR,
    });
  }

  /**
   * Registra a falha (só o código) e a espera. Com a resposta em dúvida, a intenção fica gravada: o token de renovação
   * pode já ter sido trocado do outro lado.
   */
  private async postpone(
    ref: GrantRef,
    generation: number,
    error: CloudflareOAuthError,
    backoff: Backoff,
  ): Promise<Renewal> {
    this.backoff.set(ref.grantId, backoff);
    await this.prisma.$transaction(async (tx) => {
      await lockGrant(tx, ref.grantId);
      await scopeToTenant(tx, ref.tenantId).cloudflareGrant.updateMany({
        where: { id: ref.grantId, generation },
        data: {
          lastErrorKind: errorKind(error),
          ...(!error.ambiguous && { refreshStartedAt: null }),
        },
      });
    });
    return { kind: 'failed', code: backoff.code, retryAt: new Date(backoff.until) };
  }

  private async accept(
    ref: GrantRef,
    row: GrantRow,
    old: GrantTokens,
    refreshed: RefreshedTokens,
    requestedAt: Date,
    clock: () => Date,
  ): Promise<Renewal> {
    const next: GrantTokens = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? old.refreshToken,
      accessExpiresAt: new Date(requestedAt.getTime() + refreshed.expiresInSeconds * 1000),
    };
    // Ocultos no log antes de qualquer gravação, que pode falhar.
    registerLiveSecret(next.accessToken);
    registerLiveSecret(next.refreshToken);
    const unused = [next.accessToken, next.refreshToken].filter(
      (value) => value !== old.accessToken && value !== old.refreshToken,
    );
    if (
      refreshed.scope !== null &&
      compareCloudflareScopes(row.scopes, refreshed.scope).unexpected.length > 0
    ) {
      // Uma renovação nunca amplia a autorização. Se ampliar, o acesso novo não é guardado nem usado.
      for (const value of unused) forgetLiveSecret(value);
      await this.markReconnect(ref, row.generation, 'oauth_scope_unexpected');
      return { kind: 'reconnect' };
    }
    const publicKey = this.keyring.publicKey();
    let ciphertext: string;
    try {
      const binding = { tenantId: ref.tenantId, subjectId: ref.grantId };
      ciphertext = sealCloudflareOauthTokens(publicKey, binding, next);
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      // Não cabe no envelope: nada a fazer além de registrar. O token de renovação pode ter sido trocado.
      for (const value of unused) forgetLiveSecret(value);
      this.counters.failed += 1;
      return this.postpone(
        ref,
        row.generation,
        new CloudflareOAuthError('unavailable', 'oauth_unstorable', true),
        {
          until: clock().getTime() + RENEW_BACKOFF_MAX_MS,
          failures: 1,
          code: GRANT_UNAVAILABLE_ERROR,
        },
      );
    }
    this.unsaved.set(ref.grantId, {
      ref,
      generation: row.generation,
      ciphertext,
      keyVersion: publicKey.version,
      accessExpiresAt: next.accessExpiresAt,
      refreshedAt: requestedAt,
    });
    const saved = await this.save(ref.grantId);
    this.backoff.delete(ref.grantId);
    if (!saved) {
      // Outra leitura mudou a concessão no meio (ou ela sumiu): vale o que está gravado, e o recebido não é usado.
      for (const value of unused) forgetLiveSecret(value);
      return this.current(ref);
    }
    this.counters.renewed += 1;
    return this.current(ref);
  }

  /** Grava a renovação guardada na memória, tentando de novo. Nunca é interrompida pela parada do worker. */
  private async save(grantId: string): Promise<boolean> {
    const pending = this.unsaved.get(grantId);
    if (pending === undefined) return false;
    let failure: unknown;
    for (const delay of this.saveDelaysMs) {
      if (delay > 0) await sleep(delay);
      try {
        const saved = await this.saveOnce(pending);
        this.unsaved.delete(grantId);
        return saved;
      } catch (error) {
        failure = error;
      }
    }
    throw failure;
  }

  private saveOnce({ ref, ...pending }: Unsaved): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockGrant(tx, ref.grantId);
      // Só pela geração, em qualquer situação: a que espera a revogação precisa do token atual para ser revogada.
      const { count } = await scopeToTenant(tx, ref.tenantId).cloudflareGrant.updateMany({
        where: { id: ref.grantId, generation: pending.generation },
        data: {
          ciphertext: pending.ciphertext,
          keyVersion: pending.keyVersion,
          accessExpiresAt: pending.accessExpiresAt,
          generation: pending.generation + 1,
          refreshStartedAt: null,
          lastRefreshAt: pending.refreshedAt,
          lastErrorKind: null,
        },
      });
      return count === 1;
    });
  }

  /** O que uma execução anterior não conseguiu gravar. */
  private async flush(grantId: string): Promise<void> {
    if (this.unsaved.has(grantId) && (await this.save(grantId))) this.counters.renewed += 1;
  }

  /** A concessão espera o cliente conectar de novo; falso se ela mudou no meio. */
  private markReconnect(ref: GrantRef, generation: number, code: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await lockGrant(tx, ref.grantId);
      const { count } = await scopeToTenant(tx, ref.tenantId).cloudflareGrant.updateMany({
        where: { id: ref.grantId, generation, status: 'active' },
        data: { status: 'reconnect', refreshStartedAt: null, lastErrorKind: code },
      });
      if (count === 1) this.forget(ref.grantId);
      return count === 1;
    });
  }

  /** O logger passa a ocultar os tokens de agora e deixa de guardar os que saíram de uso. */
  private track(grantId: string, values: readonly string[]): void {
    for (const value of this.live.get(grantId) ?? []) {
      if (!values.includes(value)) forgetLiveSecret(value);
    }
    for (const value of values) registerLiveSecret(value);
    this.live.set(grantId, values);
  }

  private forget(grantId: string): void {
    for (const value of this.live.get(grantId) ?? []) forgetLiveSecret(value);
    this.live.delete(grantId);
  }
}
