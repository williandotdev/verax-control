import { randomUUID } from 'node:crypto';
import { isCloudflareBlockingError } from '@verax/shared';
import { z } from 'zod';
import { type ActiveException, matchingException } from '../alerts/exception-match.js';
import { FindingStore, LastEvents, SyncLease } from '../alerts/finding-store.js';
import { type CollectorCursor, CollectorCursors, type CursorKey } from '../collectors/collector-cursor.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import {
  type CheckedCredential,
  CredentialRejected,
  type CredentialRejectionReason,
  CredentialSourceUnavailable,
} from '../credentials/credential-check.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import { lockCredential } from '../credentials/credential-rekey.js';
import {
  CloudflareToken,
  CredentialVaultError,
  credentialBinding,
  open,
} from '../credentials/credential-vault.js';
import type { Prisma } from '../generated/prisma/client.js';
import { IncidentGrouping } from '../incidents/incident-grouping.js';
import { UsageMeter } from '../usage/usage-meter.js';
import { cloudflareEventId, invalidEntryId, isCloudflareAccountId, parseAuditEntry } from './audit-entry.js';
import { CloudflareApiError, CloudflareClient } from './cloudflare.client.js';
import { detect, toCloudflareFindingDraft } from './cloudflare-rules.js';
import { CloudflareTokenCheck } from './cloudflare-token-check.js';

export const CLOUDFLARE_SYNC = 'cloudflare';
/** Fluxos do cursor de cada conta: a auditoria e a conferência de hora em hora (token e zonas). */
export const CLOUDFLARE_AUDIT_STREAM = 'cloudflare_audit';
export const CLOUDFLARE_CHECK_STREAM = 'cloudflare_check';

/** Intervalo da auditoria de cada conta (o laço do worker continua no `SYNC_INTERVAL_SECONDS`). */
export const CLOUDFLARE_AUDIT_INTERVAL_MS = 5 * 60 * 1000;
/** Intervalo da conferência do token (`tokens/verify`) e das zonas cadastradas. */
export const CLOUDFLARE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** Sobreposição da janela: o que chegou atrasado à auditoria é lido de novo (e a chave única não duplica). */
export const CLOUDFLARE_OVERLAP_MS = 10 * 60 * 1000;
/** A janela termina um minuto antes de agora: o que acabou de acontecer pode ainda não estar na auditoria. */
export const CLOUDFLARE_SETTLE_MS = 60 * 1000;
/** A primeira leitura de uma conta pega os últimos 7 dias. */
export const CLOUDFLARE_FIRST_READ_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * O mais longe que uma leitura volta: depois de uma parada longa (conta desativada e reativada, token parado), a
 * coleta recomeça dos últimos 30 dias, em vez de despejar meses de achados antigos.
 */
export const CLOUDFLARE_MAX_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
export const CLOUDFLARE_PAGE_SIZE = 500;
/** Página menor, para quando a de 500 passar do teto de bytes do cliente. */
const SMALL_PAGE_SIZE = 50;
export const CLOUDFLARE_MAX_PAGES = 20;
/** Espera depois de um 429 sem `retry-after`: o Cloudflare bloqueia o token por 5 minutos. */
const RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;
/** Tamanho da coluna `CollectorCursor.continuation`. */
const CONTINUATION_MAX = 2048;

/**
 * Erros da conferência de hora em hora que deixam a conexão em erro mesmo com a auditoria lida: uma zona cadastrada
 * que não existe na conta e o token sem `Zone Read` (sem ele, a conferência das zonas não roda).
 */
const CHECK_ERRORS: ReadonlySet<string> = new Set(['zone_not_found', 'zones_forbidden']);

/** O motivo da recusa na conferência do token vira o erro de conexão que para a coleta. */
const REJECTION_ERRORS: Record<CredentialRejectionReason, string> = {
  invalid: 'credential_rejected',
  not_yet_valid: 'credential_rejected',
  inactive: 'credential_disabled',
  expired: 'credential_expired',
  no_account_access: 'credential_forbidden',
};

/** Erro do próprio coletor, guardado só pelo código (o nome do erro, como os da API). */
class CloudflareSyncError extends Error {
  constructor(readonly code: string) {
    super(`coletor do Cloudflare: ${code}`);
    this.name = code;
  }
}

export interface CloudflareAuditSyncOptions {
  /** Nome da concessão em `SyncState` (os testes usam um por caso). */
  name?: string;
  owner?: string;
  leaseMs?: number;
  client?: CloudflareClient;
  tokenCheck?: CloudflareTokenCheck;
  auditIntervalMs?: number;
  checkIntervalMs?: number;
  pageSize?: number;
  maxPages?: number;
  /** Só os testes, que dividem o banco: restringe a execução às contas destes clientes. */
  tenantIds?: readonly string[];
  groupingWindowMinutes?: number;
  grouping?: IncidentGrouping;
}

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem nome com "token"). */
export interface CloudflareSyncReport {
  status: 'done' | 'locked';
  /** Contas do Cloudflare ativas e com token guardado. */
  accounts: number;
  /** Nenhum dos fluxos da conta estava na hora. */
  notDue: number;
  /** Coleta parada até o token ser trocado (recusado, vencido, desativado, sem acesso). Nenhuma chamada. */
  blocked: number;
  /** O token guardado não abriu no worker (versão da chave ausente, texto adulterado). Nenhuma chamada. */
  unreadable: number;
  /** Contas com falha nesta execução (a da origem vira erro de conexão; a interna fica no estado do sync). */
  failedAccounts: number;
  pages: number;
  read: number;
  created: number;
  duplicates: number;
  unowned: number;
  /** Entradas fora do formato (recusadas pelo zod), na fila sem dono; as outras do lote seguem. */
  invalid: number;
  excepted: number;
  /** Entradas válidas da conta que nenhuma regra considerou suspeitas. */
  ignored: number;
  /** Entradas de zonas fora da lista cadastrada (lista vazia é todas). */
  outOfScope: number;
  incidentsOpened: number;
  incidentsJoined: number;
}

interface AccountRow {
  id: string;
  tenantId: string;
  accountId: string;
  zones: string[];
  connection: 'waiting' | 'connected' | 'error';
  connectionError: string | null;
}

interface RunContext {
  now: Date;
  report: CloudflareSyncReport;
  exceptions: ReadonlyMap<string, ActiveException[]>;
  protectedItems: ReadonlyMap<string, ReadonlySet<string>>;
  lastEvents: LastEvents;
  signal: AbortSignal | undefined;
}

/** A leitura da conta que está em curso: a conta, o texto cifrado do token aberto (a "versão" dele) e o token. */
interface Session {
  account: AccountRow;
  ciphertext: string;
  token: CloudflareToken;
}

type CheckOutcome =
  | { kind: 'blocked'; code: string }
  | { kind: 'rate_limited'; retryAt: Date }
  | { kind: 'unavailable' }
  | { kind: 'done'; checkError: string | null };

type ConnectionData = Pick<
  Prisma.CloudAccountUpdateManyMutationInput,
  'connection' | 'connectionError' | 'lastCollectedAt'
>;

const errorState = (code: string): ConnectionData => ({ connection: 'error', connectionError: code });

/** A continuação de uma leitura cortada no teto de páginas: o cursor do Cloudflare e a janela em que ele vale. */
const continuationSchema = z.strictObject({
  c: z.string().min(1).max(CONTINUATION_MAX),
  s: z.iso.datetime(),
  b: z.iso.datetime(),
});

interface AuditWindow {
  since: Date;
  before: Date;
  cursor: string | null;
  /** A janela veio de uma continuação gravada (e o cursor dela pode ter vencido). */
  resumed: boolean;
}

function encodeContinuation(cursor: string, window: AuditWindow): string | null {
  const text = JSON.stringify({ c: cursor, s: window.since.toISOString(), b: window.before.toISOString() });
  return text.length <= CONTINUATION_MAX ? text : null;
}

function decodeContinuation(text: string | null): AuditWindow | null {
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = continuationSchema.safeParse(json);
  if (!parsed.success) return null;
  return {
    since: new Date(parsed.data.s),
    before: new Date(parsed.data.b),
    cursor: parsed.data.c,
    resumed: true,
  };
}

/**
 * Coletor da auditoria do Cloudflare (fase 2, PR-12), no worker. O token de cada conta vem do cofre do nó: só o worker
 * tem as chaves privadas e abre o token, na memória, a cada execução (o invólucro o registra como segredo vivo, e o
 * logger o oculta em qualquer linha). A API nunca decifra.
 *
 * Uma concessão (`SyncState('cloudflare')`) deixa um worker por vez. Cada execução, para cada conta do Cloudflare
 * ativa e com token guardado (cada uma pelo escopo do próprio cliente):
 * 1. **Coleta parada:** se a última leitura acabou num erro que para a coleta (`CLOUDFLARE_BLOCKING_ERRORS`: token
 *    recusado, sem acesso, vencido, desativado), nada é chamado. A troca do token no painel recomeça a conexão, e a
 *    coleta volta sozinha. Um token com validade vencida (`expiresAt`) para sem chamar o Cloudflare.
 * 2. **Conferência de hora em hora** (fluxo `cloudflare_check`): o `tokens/verify` e a leitura de prova da auditoria
 *    (a mesma do painel), que atualizam a última conferência e a validade do token, e, com zonas cadastradas, a lista
 *    das zonas da conta (`Zone Read`): uma zona cadastrada que não existe deixa a conexão em erro (`zone_not_found`).
 * 3. **Auditoria** (fluxo `cloudflare_audit`, a cada 5 min): `since = cursor - 10 min` (a primeira leitura, 7 dias),
 *    `before = agora - 1 min`, em ordem crescente, 500 por página, seguindo o `cursor` da resposta, no máximo 20
 *    páginas. Cada página processada é gravada antes do pedido da seguinte (a continuação: o cursor do Cloudflare e a
 *    janela), então uma execução cortada no meio (orçamento de tempo, parada do worker) não perde as páginas lidas, e
 *    a próxima segue dela, sem reler a sobreposição. Lida a janela inteira, o cursor vai para o `before`.
 * 4. Cada entrada passa pelo zod. A inválida vai para a fila sem dono (`invalid_alert`) e as outras seguem; a de
 *    outra conta (`account.id` diferente) também (`source_mismatch`). A da conta vira atividade dela (`lastEventAt`)
 *    e, se uma regra casa, achado do cliente da conta, com a exceção e o incidente na mesma transação. A chave
 *    `cf/<conta>/<id>` é única: reler a sobreposição não duplica.
 * 5. Depois de avançar o cursor, o volume lido (os bytes de cada página) vai para o medidor de uso (`cloudflare`).
 *
 * Estado da conexão (o cartão em Contas cloud): a leitura bem-sucedida conecta a conta, mesmo sem evento (o
 * Cloudflare é lido por API); falha da origem fica em erro com o código (`rate_limited`, `timeout`, `http_503`...), e
 * o cursor recua. O 429 (limite do token inteiro) adia os dois fluxos da conta até o `retry-after`, venha da
 * auditoria ou da conferência. Toda escrita da conexão confere, sob o lock da credencial, que o token
 * guardado ainda é o que foi usado: um token trocado no meio da leitura nunca herda o erro do anterior.
 */
export class CloudflareAuditSync {
  private readonly name: string;
  private readonly client: CloudflareClient;
  private readonly tokenCheck: CloudflareTokenCheck;
  private readonly auditIntervalMs: number;
  private readonly checkIntervalMs: number;
  private readonly pageSize: number;
  private readonly maxPages: number;
  private readonly tenantIds: readonly string[] | undefined;
  private readonly store: FindingStore;
  private readonly lease: SyncLease;
  private readonly cursors: CollectorCursors;

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    options: CloudflareAuditSyncOptions = {},
  ) {
    this.name = options.name ?? CLOUDFLARE_SYNC;
    this.client = options.client ?? new CloudflareClient();
    this.tokenCheck = options.tokenCheck ?? new CloudflareTokenCheck();
    this.auditIntervalMs = options.auditIntervalMs ?? CLOUDFLARE_AUDIT_INTERVAL_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? CLOUDFLARE_CHECK_INTERVAL_MS;
    this.pageSize = options.pageSize ?? CLOUDFLARE_PAGE_SIZE;
    this.maxPages = options.maxPages ?? CLOUDFLARE_MAX_PAGES;
    if (!(this.pageSize >= 1 && this.pageSize <= 1000) || !(this.maxPages >= 1)) {
      throw new RangeError('página da auditoria de 1 a 1000 entradas e ao menos uma página por execução');
    }
    this.tenantIds = options.tenantIds;
    this.store = new FindingStore(
      prisma,
      options.grouping ?? new IncidentGrouping(options.groupingWindowMinutes),
    );
    this.lease = new SyncLease(
      prisma,
      this.name,
      options.owner ?? `worker-${randomUUID()}`,
      options.leaseMs ?? 5 * 60 * 1000,
    );
    this.cursors = new CollectorCursors(prisma);
  }

  async runOnce(now: Date = new Date(), signal?: AbortSignal): Promise<CloudflareSyncReport> {
    const report: CloudflareSyncReport = {
      status: 'done',
      accounts: 0,
      notDue: 0,
      blocked: 0,
      unreadable: 0,
      failedAccounts: 0,
      pages: 0,
      read: 0,
      created: 0,
      duplicates: 0,
      unowned: 0,
      invalid: 0,
      excepted: 0,
      ignored: 0,
      outOfScope: 0,
      incidentsOpened: 0,
      incidentsJoined: 0,
    };
    if (!(await this.lease.acquire(now))) return { ...report, status: 'locked' };
    let firstError: string | null = null;
    try {
      const context: RunContext = {
        now,
        report,
        exceptions: await this.store.activeExceptions(now),
        protectedItems: await this.store.protectedItems(),
        lastEvents: new LastEvents(),
        signal,
      };
      for (const account of await this.accounts()) {
        signal?.throwIfAborted();
        report.accounts += 1;
        try {
          await this.collect(account, context);
        } catch (error) {
          // Parada do worker ou estouro do orçamento: a execução para aqui (a conta é lida de novo depois).
          signal?.throwIfAborted();
          // Uma conta com problema (banco, gravação) não para as outras; a falha da origem já foi tratada.
          report.failedAccounts += 1;
          firstError ??= errorKind(error);
        }
      }
      await context.lastEvents.save(this.prisma, 'cloudflare');
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: now,
          ...(firstError === null && { lastSuccessAt: new Date() }),
          lastError: firstError,
        },
      });
      return report;
    } catch (error) {
      // Só o tipo do erro: a mensagem de um erro do banco pode carregar dado.
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: now, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      await this.lease.release();
    }
  }

  /** Contas do Cloudflare ativas e com token guardado: busca de sistema, só as chaves e o estado da conexão. */
  private accounts(): Promise<AccountRow[]> {
    return this.prisma.cloudAccount.findMany({
      where: {
        provider: 'cloudflare',
        status: 'active',
        credential: { isNot: null },
        ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
      },
      select: {
        id: true,
        tenantId: true,
        accountId: true,
        zones: true,
        connection: true,
        connectionError: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async collect(account: AccountRow, context: RunContext): Promise<void> {
    const { now, report } = context;
    if (account.connection === 'error' && isCloudflareBlockingError(account.connectionError)) {
      report.blocked += 1;
      return;
    }
    const auditKey: CursorKey = { cloudAccountId: account.id, stream: CLOUDFLARE_AUDIT_STREAM };
    const checkKey: CursorKey = { cloudAccountId: account.id, stream: CLOUDFLARE_CHECK_STREAM };
    const audit = await this.cursors.read(auditKey, now);
    const check = await this.cursors.read(checkKey, now);
    const auditDue = audit.nextRunAt.getTime() <= now.getTime();
    const checkDue = check.nextRunAt.getTime() <= now.getTime();
    if (!auditDue && !checkDue) {
      report.notDue += 1;
      return;
    }

    const credential = await this.prisma.forTenant(account.tenantId).cloudCredential.findUnique({
      where: { cloudAccountId: account.id },
      select: { kind: true, ciphertext: true, expiresAt: true },
    });
    if (credential?.kind !== 'cloudflare_api_token') return;
    const { ciphertext } = credential;
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) {
      report.blocked += 1;
      await this.markConnection(account, ciphertext, errorState('credential_expired'));
      return;
    }
    let token: CloudflareToken;
    try {
      const binding = credentialBinding({ ...account, provider: 'cloudflare' }, credential.kind);
      const opened = open(this.keyring, binding, ciphertext);
      if (!(opened instanceof CloudflareToken)) throw new CredentialVaultError('payload_invalid');
      token = opened;
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      report.unreadable += 1;
      await this.markConnection(account, ciphertext, errorState('credential_unreadable'));
      return;
    }
    const session: Session = { account, ciphertext, token };

    let checkError =
      check.lastErrorKind !== null && CHECK_ERRORS.has(check.lastErrorKind) ? check.lastErrorKind : null;
    if (checkDue) {
      const outcome = await this.check(session, checkKey, context);
      if (outcome.kind === 'blocked') {
        report.blocked += 1;
        await this.markConnection(account, ciphertext, errorState(outcome.code));
        return;
      }
      if (outcome.kind === 'rate_limited') {
        // O limite vale para o token inteiro: a auditoria também espera, esteja ou não na hora dela.
        report.failedAccounts += 1;
        await this.cursors.postpone(auditKey, outcome.retryAt);
        await this.markConnection(account, ciphertext, errorState('rate_limited'));
        return;
      }
      if (outcome.kind === 'done') checkError = outcome.checkError;
      if (!auditDue && outcome.kind === 'done') {
        if (checkError !== null) {
          await this.markConnection(account, ciphertext, errorState(checkError));
        } else if (account.connection === 'error' && CHECK_ERRORS.has(account.connectionError ?? '')) {
          // O problema das zonas foi resolvido no cadastro ou no Cloudflare.
          await this.markConnection(account, ciphertext, { connection: 'connected', connectionError: null });
        }
      }
    }
    if (!auditDue) return;

    try {
      await this.readAudit(session, audit, auditKey, context);
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      report.failedAccounts += 1;
      await this.sourceFailed(session, { audit: auditKey, check: checkKey }, error, now);
      return;
    }
    await this.markConnection(
      account,
      ciphertext,
      checkError === null
        ? { connection: 'connected', connectionError: null, lastCollectedAt: now }
        : { ...errorState(checkError), lastCollectedAt: now },
    );
  }

  /**
   * Falha da origem na auditoria: a conexão fica em erro com o código. 401 e 403 param a coleta até o token ser
   * trocado (nenhuma nova tentativa); 429 espera o `retry-after`, na auditoria e na conferência (o limite é do token
   * inteiro); o resto recua o cursor (1 min, dobrando, até 1 h).
   */
  private async sourceFailed(
    session: Session,
    keys: { audit: CursorKey; check: CursorKey },
    error: CloudflareApiError,
    now: Date,
  ): Promise<void> {
    if (isCloudflareBlockingError(error.code)) {
      await this.cursors.fail(keys.audit, error, now, {
        retryAt: new Date(now.getTime() + this.auditIntervalMs),
      });
    } else if (error.code === 'rate_limited') {
      const retryAt = new Date(now.getTime() + (error.retryAfterMs ?? RATE_LIMIT_WAIT_MS));
      await this.cursors.fail(keys.audit, error, now, { retryAt });
      await this.cursors.postpone(keys.check, retryAt);
    } else {
      await this.cursors.fail(keys.audit, error, now);
    }
    await this.markConnection(session.account, session.ciphertext, errorState(error.code));
  }

  /** Conferência de hora em hora: o token (verify e leitura de prova) e, com zonas cadastradas, a lista das zonas. */
  private async check(session: Session, key: CursorKey, context: RunContext): Promise<CheckOutcome> {
    const { account, token } = session;
    const { now } = context;
    let checked: CheckedCredential;
    try {
      checked = await this.tokenCheck.check(token, account.accountId, now);
    } catch (error) {
      if (error instanceof CredentialRejected)
        return { kind: 'blocked', code: REJECTION_ERRORS[error.reason] };
      if (!(error instanceof CredentialSourceUnavailable)) throw error;
      if (error.code === 'http_429') {
        const retryAt = new Date(now.getTime() + RATE_LIMIT_WAIT_MS);
        await this.cursors.fail(key, new CloudflareSyncError('rate_limited'), now, { retryAt });
        return { kind: 'rate_limited', retryAt };
      }
      await this.cursors.fail(key, new CloudflareSyncError(error.code), now);
      return { kind: 'unavailable' };
    }
    await this.refreshCredential(session, checked, now);

    let checkError: string | null = null;
    if (account.zones.length > 0) {
      try {
        const zones = await this.client.zones(token, account.accountId, context.signal);
        const missing = account.zones.some((zone) => !zones.names.has(zone.toLowerCase()));
        // Sem ler todas as páginas, a ausência não está provada.
        if (missing && zones.complete) checkError = 'zone_not_found';
      } catch (error) {
        if (!(error instanceof CloudflareApiError)) throw error;
        if (error.code === 'credential_rejected') return { kind: 'blocked', code: error.code };
        if (error.code === 'rate_limited') {
          const retryAt = new Date(now.getTime() + (error.retryAfterMs ?? RATE_LIMIT_WAIT_MS));
          await this.cursors.fail(key, error, now, { retryAt });
          return { kind: 'rate_limited', retryAt };
        }
        if (error.code !== 'credential_forbidden') {
          await this.cursors.fail(key, error, now);
          return { kind: 'unavailable' };
        }
        // O token não tem Zone Read: a auditoria segue, e a conexão mostra o problema.
        checkError = 'zones_forbidden';
      }
    }
    const nextRunAt = new Date(now.getTime() + this.checkIntervalMs);
    if (checkError === null) {
      await this.cursors.advance(key, { continuation: null, nextRunAt }, now);
    } else {
      await this.cursors.fail(key, new CloudflareSyncError(checkError), now, { retryAt: nextRunAt });
    }
    return { kind: 'done', checkError };
  }

  /** A última conferência e a validade vindas do Cloudflare, só se o token guardado ainda é o conferido. */
  private async refreshCredential(session: Session, checked: CheckedCredential, now: Date): Promise<void> {
    const { account, ciphertext } = session;
    await this.prisma.$transaction(async (tx) => {
      await lockCredential(tx, account.id);
      await scopeToTenant(tx, account.tenantId).cloudCredential.updateMany({
        where: { cloudAccountId: account.id, ciphertext },
        data: { verifiedAt: now, expiresAt: checked.expiresAt },
      });
    });
  }

  /**
   * Estado da conexão da conta, pelo escopo do cliente, sob o lock da credencial (o mesmo da troca pelo painel) e só
   * se o token guardado ainda é o que esta leitura usou. Conta desativada no meio fica como a desativação deixou.
   */
  private async markConnection(account: AccountRow, ciphertext: string, data: ConnectionData): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockCredential(tx, account.id);
      const db = scopeToTenant(tx, account.tenantId);
      const current = await db.cloudCredential.findUnique({
        where: { cloudAccountId: account.id },
        select: { ciphertext: true },
      });
      if (current?.ciphertext !== ciphertext) return;
      await db.cloudAccount.updateMany({
        where: { id: account.id, provider: 'cloudflare', status: 'active' },
        data,
      });
    });
  }

  /** A janela da leitura: a continuação gravada ou uma nova, a partir do cursor. */
  private freshWindow(cursorAt: Date | null, now: Date): AuditWindow {
    const before = new Date(now.getTime() - CLOUDFLARE_SETTLE_MS);
    const floor = now.getTime() - CLOUDFLARE_MAX_LOOKBACK_MS;
    const since =
      cursorAt === null
        ? now.getTime() - CLOUDFLARE_FIRST_READ_MS
        : Math.max(cursorAt.getTime() - CLOUDFLARE_OVERLAP_MS, floor);
    return { since: new Date(since), before, cursor: null, resumed: false };
  }

  private async readAudit(
    session: Session,
    cursor: CollectorCursor,
    key: CursorKey,
    context: RunContext,
  ): Promise<void> {
    const { account, token } = session;
    const { now, report } = context;
    let window = decodeContinuation(cursor.continuation) ?? this.freshWindow(cursor.cursorAt, now);
    if (window.before.getTime() <= window.since.getTime()) {
      await this.cursors.advance(
        key,
        { continuation: null, nextRunAt: new Date(now.getTime() + this.auditIntervalMs) },
        now,
      );
      return;
    }
    const usage = new UsageMeter();
    let next = window.cursor;
    let limit = this.pageSize;
    let pages = 0;
    let newest: Date | null = null;
    for (;;) {
      let page;
      try {
        page = await this.client.auditPage(
          token,
          account.accountId,
          { since: window.since, before: window.before, limit, cursor: next },
          context.signal,
        );
      } catch (error) {
        if (error instanceof CloudflareApiError) {
          // Página grande demais para o teto de bytes: a mesma página, menor.
          if (error.code === 'response_too_large' && limit > SMALL_PAGE_SIZE) {
            limit = SMALL_PAGE_SIZE;
            continue;
          }
          // A continuação gravada não vale mais (cursor vencido): recomeça a janela pelo cursor da conta.
          if (error.code === 'bad_request' && window.resumed && pages === 0) {
            window = this.freshWindow(cursor.cursorAt, now);
            next = null;
            continue;
          }
        }
        throw error;
      }
      pages += 1;
      report.pages += 1;
      usage.add(account.tenantId, 'cloudflare', page.bytes, page.entries.length, now);
      for (const raw of page.entries) {
        const at = await this.process(raw, account, context);
        if (at !== null && (newest === null || at > newest)) newest = at;
      }
      await this.lease.renew();
      const done = page.cursor === null || page.entries.length === 0 || page.cursor === next;
      next = done ? null : page.cursor;
      // Cada página processada inteira fica gravada antes de pedir a seguinte: uma execução cortada no meio (orçamento
      // de tempo, parada do worker, falha da origem numa página adiante) não perde as páginas já lidas.
      // - Janela lida inteira: o cursor vai para o fim dela, e a próxima leitura é no intervalo.
      // - Ainda há página: a continuação (o cursor do Cloudflare e a janela) fica gravada, com a próxima leitura já;
      //   o cursor fica no evento mais recente processado (se a continuação não couber, é dele que recomeça).
      await this.cursors.advance(
        key,
        next === null
          ? {
              cursorAt: window.before,
              continuation: null,
              nextRunAt: new Date(now.getTime() + this.auditIntervalMs),
            }
          : { cursorAt: newest ?? undefined, continuation: encodeContinuation(next, window), nextRunAt: now },
        now,
      );
      // Mede só depois de o cursor andar: uma escrita por cliente e mês, a cada página.
      await usage.flush(this.prisma);
      if (next === null || pages >= this.maxPages) return;
    }
  }

  /** Uma entrada: validação, dono, zona monitorada, regra e gravação. Devolve o horário dela, quando válida. */
  private async process(raw: unknown, account: AccountRow, context: RunContext): Promise<Date | null> {
    const { report, now } = context;
    report.read += 1;
    const parsed = parseAuditEntry(raw);
    if (!parsed.ok) {
      // Fora do formato: na fila sem dono, e o resto do lote segue.
      await this.store.recordUnowned({
        source: 'cloudflare',
        sourceEventId:
          parsed.id === null
            ? invalidEntryId(account.accountId, raw)
            : cloudflareEventId(account.accountId, parsed.id),
        reason: 'invalid_alert',
        accounts: [],
        occurredAt: null,
        ruleId: null,
        ruleLevel: null,
        title: null,
      });
      report.invalid += 1;
      return null;
    }
    const { entry } = parsed;
    const occurredAt = new Date(entry.action.time);
    const owner = entry.account?.id;
    if (owner !== account.accountId) {
      // A leitura é da conta cadastrada, com o token dela; uma entrada que diz ser de outra conta (ou de nenhuma) não é
      // de ninguém: na dúvida, o evento não vira achado.
      const detection = detect(entry);
      await this.store.recordUnowned({
        source: 'cloudflare',
        sourceEventId: cloudflareEventId(account.accountId, entry.id),
        reason: owner === undefined ? 'no_account' : 'source_mismatch',
        accounts: isCloudflareAccountId(owner) ? [owner] : [],
        occurredAt,
        ruleId: detection?.rule.id ?? null,
        ruleLevel: detection?.level ?? null,
        title: detection?.rule.title ?? entry.action.description ?? null,
      });
      report.unowned += 1;
      return occurredAt;
    }
    const zone = entry.zone?.name?.toLowerCase();
    if (zone !== undefined && account.zones.length > 0 && !account.zones.some((name) => name === zone)) {
      report.outOfScope += 1;
      return occurredAt;
    }
    context.lastEvents.see(account.tenantId, account.accountId, occurredAt);
    const detection = detect(entry);
    if (detection === null) {
      report.ignored += 1;
      return occurredAt;
    }
    const draft = toCloudflareFindingDraft(entry, account, detection);
    const exception = matchingException(draft, context.exceptions.get(account.tenantId) ?? [], now);
    const outcome = await this.store.persist(
      draft,
      exception,
      context.protectedItems.get(account.tenantId) ?? new Set(),
      now,
    );
    if (outcome === 'duplicate') {
      report.duplicates += 1;
      return occurredAt;
    }
    report.created += 1;
    if (outcome === 'excepted') report.excepted += 1;
    if (outcome === 'opened') report.incidentsOpened += 1;
    if (outcome === 'joined') report.incidentsJoined += 1;
    return occurredAt;
  }
}
