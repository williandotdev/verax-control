import { createHash } from 'node:crypto';
import {
  NODE_SYNC_INTERVAL_SECONDS,
  NODE_SYNC_JITTER_SECONDS,
  NODE_SYNC_MAX_SOURCES,
  NODE_SYNC_MAX_USERS,
  NODE_SYNC_POLL_MIN_SECONDS,
  NODE_SYNC_PROTOCOL,
  NODE_SYNC_REQUEST_MAX_BYTES,
  NODE_SYNC_SOURCE_CODES,
  NODE_SYNC_USER_CODES,
  type NodePlatform,
  type NodeSyncCapability,
  type NodeSyncCredentialReport,
  type NodeSyncRequest,
  type NodeSyncResponse,
  type NodeSyncSourceCode,
  type NodeSyncSourceReport,
  type NodeSyncUserCode,
  type NodeSyncUserReport,
  type NodeSyncVaultKey,
} from '@verax/shared';
import { publicKeyFingerprint } from '@verax/vault-envelope';
import { accountSelect, type NodeFacts, toAccount } from '../cloud-accounts/cloud-account-data.js';
import type { ControlPlaneSyncConfig } from '../common/config/control-plane-sync.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import type { TenantPlans } from '../plan/tenant-plan.js';
import { applySource, type SyncLogger } from './apply-source.js';
import { applyUser } from './apply-user.js';
import type { SourceCredentialChecks } from './credential-checks.js';
import { clockSkewExceeded, type NodeSyncResult, postNodeSync } from './node-sync-client.js';

export const CONTROL_PLANE_SYNC_TASK = 'control-plane-sync';
/**
 * O agendador acorda a tarefa a cada 15 s; ela só chama o plano de controle quando a próxima chamada chegou (a cada
 * 5 min ±30 s, ou o `pollAfterSeconds` da resposta, ou a espera depois de uma falha).
 */
export const CONTROL_PLANE_SYNC_TICK_MS = 15_000;
/** Duas chamadas de até 20 s, a conferência das credenciais na origem e as transações de cada fonte. */
export const CONTROL_PLANE_SYNC_BUDGET_MS = 60_000;
/** Depois de aplicar alguma coisa, mais uma chamada na mesma execução, para contar logo; nunca mais de duas. */
export const MAX_ROUND_TRIPS = 2;
/**
 * O que este nó sabe aplicar: as fontes de log e os usuários do cliente. Os usuários vão anunciados mesmo com
 * `CONTROL_PLANE_USERS=false`: o nó recusa cada pedido com `users_disabled`, e o console mostra o motivo.
 */
export const CONTROL_PLANE_SYNC_CAPABILITIES = [
  'log_sources',
  'users',
] as const satisfies readonly NodeSyncCapability[];

/** As esperas depois de uma falha: o nó não reconhecido (1 h), o cliente não apto (6 h) e as que passam sozinhas. */
export const UNAUTHENTICATED_RETRY_MS = 60 * 60 * 1000;
export const NOT_FOUND_RETRY_MS = 6 * 60 * 60 * 1000;
export const FAILURE_RETRY_BASE_MS = 60 * 1000;
export const FAILURE_RETRY_MAX_MS = 30 * 60 * 1000;
const RATE_LIMIT_MAX_MS = 60 * 60 * 1000;

/** O lock transacional que serializa o começo de cada execução (e a sequência) entre réplicas do worker. */
const LOCK_NAME = 'verax:control-plane-sync';
const SYNC_ROW_ID = 'node';
const MAX_INT = 2_147_483_647;
const KEY_ID_SUFFIX = /^[A-Za-z0-9_-]{4}$/;

type AnyReport = NodeSyncSourceReport | NodeSyncUserReport;

/**
 * Um relato (de fonte ou de pedido de usuário) que pode ir no pedido, com o que o nó guarda do último aceito pelo
 * plano de controle.
 */
export interface ReportCandidate<R extends AnyReport = NodeSyncSourceReport> {
  report: R;
  /** SHA-256 do JSON do relato. */
  hash: string;
  /** O tamanho do JSON do relato, em bytes. */
  bytes: number;
  /** Há o item (`log_source` ou `user`) onde guardar o último relato aceito. */
  tracked: boolean;
  reportedHash: string | null;
  reportedAt: Date | null;
}

type ReportKind = 'log_source' | 'user';

/** O pedido montado e os relatos que foram nele (para marcar como aceitos depois do 200). */
interface BuiltRequest {
  request: NodeSyncRequest;
  reported: { kind: ReportKind; id: string; hash: string; changed: boolean }[];
  /** Relatos que ficaram de fora pelo limite de tamanho (vão primeiro nas chamadas seguintes). */
  omitted: number;
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');

/** O id do item do relato: o da fonte ou o do pedido de usuário. */
const reportId = (report: AnyReport): string => ('requestId' in report ? report.requestId : report.id);

/**
 * Os relatos que cabem no pedido: o corpo inteiro até `maxBytes` (o limite da rota no `cp-public`, que responde 413
 * acima dele) e no máximo `maxItems` (`NODE_SYNC_MAX_SOURCES` ou `NODE_SYNC_MAX_USERS`). Vão antes os que mudaram desde o último aceito e, dentro de cada
 * grupo, os aceitos há mais tempo (o nunca aceito primeiro): os que ficam de fora numa chamada vão na seguinte, em vez
 * de ficar sempre o mesmo pedaço de fora. Deixar um relato de fora é seguro: o plano de controle só atualiza o relato
 * das fontes que vieram no pedido, e trata a que não veio como pendente.
 */
export function selectReports<R extends AnyReport>(
  candidates: readonly ReportCandidate<R>[],
  baseBytes: number,
  maxBytes: number,
  maxItems: number = NODE_SYNC_MAX_SOURCES,
): { selected: ReportCandidate<R>[]; omitted: number } {
  const changed = (candidate: ReportCandidate<R>) => candidate.hash !== candidate.reportedHash;
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(changed(b)) - Number(changed(a)) ||
      (a.reportedAt?.getTime() ?? -1) - (b.reportedAt?.getTime() ?? -1) ||
      reportId(a.report).localeCompare(reportId(b.report)),
  );
  const selected: ReportCandidate<R>[] = [];
  let total = baseBytes;
  for (const candidate of ordered) {
    if (selected.length >= maxItems) break;
    // A vírgula entre os itens: o primeiro não tem.
    const cost = candidate.bytes + (selected.length === 0 ? 0 : 1);
    if (total + cost > maxBytes) continue;
    selected.push(candidate);
    total += cost;
  }
  selected.sort((a, b) => reportId(a.report).localeCompare(reportId(b.report)));
  return { selected, omitted: candidates.length - selected.length };
}

/** A espera da falha `failures` (1, 2, 3...) que passa sozinha: 1, 2, 4... minutos, até 30. */
export function failureRetryDelayMs(failures: number): number {
  return Math.min(FAILURE_RETRY_MAX_MS, FAILURE_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** O cliente do banco do nó: um só (o nó dedicado), nenhum ainda, ou mais de um (nada é aplicado). */
type NodeTenant = { kind: 'none' } | { kind: 'single'; id: string } | { kind: 'ambiguous' };

/** O relatório de uma execução (vai para o log do agendador): contagens e o código, nunca dado de cliente. */
export interface ControlPlaneSyncReport {
  /** A próxima chamada ainda não chegou: nada foi feito. */
  due: boolean;
  roundTrips: number;
  /** Fontes que mudaram o nó (conta ou credencial). */
  changed: number;
  failed: number;
  /** Pedidos de usuário com resultado nesta execução: a conta criada, ou a recusa (o código vai no relato). */
  usersCreated: number;
  usersFailed: number;
  /** O código da falha da chamada, quando houve. */
  error: string | null;
}

export interface ControlPlaneSyncOptions {
  config: ControlPlaneSyncConfig;
  platform: NodePlatform;
  /** As chaves do cofre (null: o nó sem o cofre, que informa `vaultKey: null` e recusa as credenciais). */
  keyring: VaultKeyring | null;
  /** O ID da conta de serviço (nó da GCP), os IPs de saída e o audience da AWS, que o nó informa e as contas mostram. */
  node: NodeFacts;
  plans: TenantPlans;
  checks: SourceCredentialChecks;
  logger: SyncLogger;
  /** O token do Google para o audience da rota (só no nó da GCP; `aws/web-identity.ts`, `fetchNodeSyncToken`). */
  idToken?: (audience: string, signal: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  random?: () => number;
  /**
   * Os ids dos clientes do banco do nó, até dois (o nó dedicado tem um). Por padrão, a tabela inteira; os testes, que
   * dividem o banco com outros arquivos, passam os deles.
   */
  tenants?: () => Promise<string[]>;
  /** O maior corpo do pedido, em bytes (`NODE_SYNC_REQUEST_MAX_BYTES`; os testes usam um menor). */
  requestMaxBytes?: number;
}

/** A chave pública corrente do cofre, como o plano de controle a usa para cifrar para este nó. */
export function vaultKeyOf(keyring: VaultKeyring | null): NodeSyncVaultKey | null {
  if (keyring === null) return null;
  const { version, key } = keyring.publicKey();
  const pem = key.export({ type: 'spki', format: 'pem' }).toString();
  return {
    version,
    publicKey: Buffer.from(pem, 'utf8').toString('base64'),
    fingerprint: publicKeyFingerprint(key),
  };
}

function isSourceCode(code: string | null): code is NodeSyncSourceCode {
  return code !== null && (NODE_SYNC_SOURCE_CODES as readonly string[]).includes(code);
}

function isUserCode(code: string | null): code is NodeSyncUserCode {
  return code !== null && (NODE_SYNC_USER_CODES as readonly string[]).includes(code);
}

/**
 * O relato com a impressão digital e o tamanho do JSON dele (o limite do pedido usa o tamanho; a marca do último aceito,
 * a impressão digital). A impressão digital só serve para saber se o relato mudou: quem chama passa o texto dela (o
 * JSON do relato de fonte; no de usuário, os campos um a um, com os booleanos como 0 ou 1).
 */
function candidateOf<R extends AnyReport>(
  report: R,
  item: { reportedHash: string | null; reportedAt: Date | null } | undefined,
  fingerprint: string,
): ReportCandidate<R> {
  const json = JSON.stringify(report);
  return {
    report,
    hash: createHash('sha256').update(fingerprint).digest('hex'),
    bytes: Buffer.byteLength(json, 'utf8'),
    tracked: item !== undefined,
    reportedHash: item?.reportedHash ?? null,
    reportedAt: item?.reportedAt ?? null,
  };
}

/**
 * Sincronização do nó dedicado com o plano de controle (a tarefa `control-plane-sync` do worker; o contrato está em
 * `packages/shared/src/node-sync.ts`, e o desenho em `docs/ARQUITETURA.md`, "Sincronização com o plano de controle").
 *
 * Cada execução, quando a próxima chamada chegou:
 * 1. reserva a chamada sob o lock transacional `verax:control-plane-sync` (a sequência cresce, e a próxima chamada fica
 *    adiada pelo orçamento, para outra réplica não chamar junto);
 * 2. acha o cliente do nó: um só (o nó dedicado); com mais de um, informa `tenant_ambiguous` e não aplica nada;
 * 3. monta o pedido (o commit, a plataforma, a chave pública do cofre e a impressão digital dela, o ID da conta de
 *    serviço, os IPs de saída, o audience da AWS, o que aconteceu com cada fonte do console (as contas `control_plane`
 *    e os itens de `ControlPlaneSyncItem`) e com cada pedido de usuário (as contas com `controlPlaneRequestId`, com a
 *    situação de agora, e os pedidos recusados)) e chama `POST /v1/node-sync` com o token do Google (nó da GCP) ou a chave
 *    do nó (VM própria), sem seguir redirecionamento, em até 20 s, lendo no máximo 1 MB da resposta e conferindo-a
 *    pelo contrato estrito;
 * 4. aplica cada fonte numa transação própria (`apply-source.ts`) e depois cada usuário pedido (`apply-user.ts`); se
 *    algo mudou (ou um pedido de usuário teve resultado), chama mais uma vez para contar logo (no máximo duas chamadas);
 * 5. marca a próxima chamada: o `pollAfterSeconds` da resposta (5 min ±30 s por padrão) ou, depois de uma falha, 1 h
 *    (nó não reconhecido), 6 h (cliente não apto), o `Retry-After` (429) ou 1, 2, 4... minutos até 30 (o plano de
 *    controle fora do ar, a resposta fora do contrato).
 *
 * Nada de segredo vai para o log: só ids de fonte, contagens e códigos. O token e a chave do nó só vão no cabeçalho.
 */
export class ControlPlaneSync {
  private readonly now: () => Date;
  private readonly random: () => number;
  /** A próxima chamada, como foi gravada (evita ler o banco a cada 15 s); null antes da primeira leitura. */
  private nextAt: Date | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: ControlPlaneSyncOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  async runOnce(signal: AbortSignal): Promise<ControlPlaneSyncReport> {
    const report: ControlPlaneSyncReport = {
      due: false,
      roundTrips: 0,
      changed: 0,
      failed: 0,
      usersCreated: 0,
      usersFailed: 0,
      error: null,
    };
    if (this.nextAt !== null && this.now() < this.nextAt) return report;
    let sequence = await this.claim(true);
    if (sequence === null) return report;
    report.due = true;
    try {
      const tenant = await this.nodeTenant();
      let lastResponse: NodeSyncResponse | null = null;
      while (report.roundTrips < MAX_ROUND_TRIPS) {
        signal.throwIfAborted();
        report.roundTrips += 1;
        const credential = await this.credential(signal);
        if (credential === null) {
          report.error = 'metadata_unavailable';
          await this.schedule({ ok: false, code: 'metadata_unavailable' });
          return report;
        }
        const built = await this.request(sequence, tenant);
        if (built.omitted > 0) {
          this.options.logger.warn(
            {
              reported: built.request.sources.length,
              reportedUsers: built.request.users.length,
              omitted: built.omitted,
            },
            'sincronização com o plano de controle: relatos de fora pelo limite do pedido; vão nas chamadas seguintes',
          );
        }
        const result = await postNodeSync(built.request, signal, {
          url: this.options.config.url,
          credential,
          ...(this.options.fetch !== undefined && { fetch: this.options.fetch }),
          now: () => this.now().getTime(),
        });
        if (!result.ok) {
          if (result.code === 'stale_sequence' && report.roundTrips < MAX_ROUND_TRIPS) {
            this.options.logger.warn(
              { sentSequence: sequence, acceptedSequence: result.acceptedSequence ?? null },
              'sincronização com o plano de controle: sequência recusada (stale_sequence); a sequência do nó avança',
            );
            sequence = await this.claim(false, Math.max(sequence, result.acceptedSequence ?? 0));
            if (sequence === null) return report;
            continue;
          }
          report.error = result.code;
          await this.schedule(this.logFailure(result));
          return report;
        }
        lastResponse = result.response;
        if (tenant.kind === 'single') await this.markReported(tenant.id, built.reported);
        let changed = 0;
        if (tenant.kind === 'single') {
          for (const source of result.response.sources ?? []) {
            signal.throwIfAborted();
            const outcome = await applySource(
              {
                prisma: this.prisma,
                tenantId: tenant.id,
                platform: this.options.platform,
                keyring: this.options.keyring,
                plans: this.options.plans,
                checks: this.options.checks,
                node: this.options.node,
                logger: this.options.logger,
                now: this.now,
              },
              source,
            );
            if (outcome.changed) changed += 1;
            if (outcome.failed) report.failed += 1;
          }
        }
        // Os usuários depois das fontes, cada pedido numa transação própria (`apply-user.ts`).
        let decided = 0;
        if (tenant.kind === 'single') {
          for (const user of result.response.users ?? []) {
            signal.throwIfAborted();
            const outcome = await applyUser(
              {
                prisma: this.prisma,
                tenantId: tenant.id,
                keyring: this.options.keyring,
                plans: this.options.plans,
                enabled: this.options.config.users,
                logger: this.options.logger,
                now: this.now,
              },
              user,
            );
            if (outcome === 'created') report.usersCreated += 1;
            if (outcome === 'failed') report.usersFailed += 1;
            if (outcome !== 'unchanged') decided += 1;
          }
        }
        report.changed += changed;
        // Uma conta criada ou um pedido recusado também pedem a segunda chamada: o console mostra o resultado logo, e o
        // plano de controle apaga o envelope.
        if ((changed === 0 && decided === 0) || report.roundTrips >= MAX_ROUND_TRIPS) break;
        sequence = await this.claim(false);
        if (sequence === null) return report;
      }
      if (lastResponse !== null) await this.schedule({ ok: true, response: lastResponse });
      return report;
    } catch (error) {
      if (signal.aborted) throw error;
      this.options.logger.error(
        { error: errorKind(error) },
        'sincronização com o plano de controle: falha inesperada na execução',
      );
      report.error = 'internal_error';
      await this.schedule({ ok: false, code: 'internal_error' });
      return report;
    }
  }

  /**
   * Reserva uma chamada: sob o lock transacional, confere se ela chegou (só na primeira da execução), avança a sequência
   * e adia a próxima pelo orçamento. A sequência é a maior entre a anterior mais um, a aceita mais um e o relógio em ms:
   * um banco que voltou de um backup não repete uma sequência já usada (enquanto o relógio não voltar).
   */
  private claim(checkDue: boolean, floor = 0): Promise<number | null> {
    const now = this.now();
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`;
      const row = await tx.controlPlaneSync.upsert({
        where: { id: SYNC_ROW_ID },
        create: { id: SYNC_ROW_ID },
        update: {},
      });
      if (checkDue && row.nextAttemptAt !== null && row.nextAttemptAt > now) {
        this.nextAt = row.nextAttemptAt;
        return null;
      }
      const sequence = Math.max(Number(row.sequence) + 1, floor + 1, now.getTime());
      const lease = new Date(now.getTime() + CONTROL_PLANE_SYNC_BUDGET_MS);
      await tx.controlPlaneSync.update({
        where: { id: SYNC_ROW_ID },
        data: { sequence: BigInt(sequence), lastAttemptAt: now, nextAttemptAt: lease },
      });
      this.nextAt = lease;
      return sequence;
    });
  }

  /** O token do Google ou a chave do nó; sem o metadata, null (a próxima chamada tenta de novo). */
  private async credential(signal: AbortSignal): Promise<string | null> {
    const { credential, url } = this.options.config;
    if (credential.kind === 'node_key') return credential.key.value();
    if (this.options.idToken === undefined) return null;
    try {
      return await this.options.idToken(url, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      this.options.logger.warn(
        { error: errorKind(error) },
        'sincronização com o plano de controle: o metadata não deu o token do nó; tenta na próxima chamada',
      );
      return null;
    }
  }

  private async nodeTenant(): Promise<NodeTenant> {
    const tenants =
      this.options.tenants !== undefined
        ? await this.options.tenants()
        : (
            await this.prisma.tenant.findMany({
              select: { id: true },
              orderBy: { createdAt: 'asc' },
              take: 2,
            })
          ).map((tenant) => tenant.id);
    if (tenants.length > 1) {
      this.options.logger.error(
        {},
        'sincronização com o plano de controle: o banco do nó tem mais de um cliente; nada do console é aplicado',
      );
      return { kind: 'ambiguous' };
    }
    const [tenant] = tenants;
    return tenant === undefined ? { kind: 'none' } : { kind: 'single', id: tenant };
  }

  /**
   * O pedido inteiro (conferido pelo contrato antes de sair, `postNodeSync`), com os relatos que cabem no limite de
   * tamanho do corpo (`selectReports`).
   */
  private async request(sequence: number, tenant: NodeTenant): Promise<BuiltRequest> {
    const { config, platform, node } = this.options;
    const base: NodeSyncRequest = {
      protocol: NODE_SYNC_PROTOCOL,
      sequence,
      sentAt: this.now().toISOString(),
      capabilities: [...CONTROL_PLANE_SYNC_CAPABILITIES],
      node: {
        commit: config.commit,
        platform,
        mode: 'dedicated',
        tenantId: tenant.kind === 'single' ? tenant.id.toLowerCase() : null,
        vaultKey: vaultKeyOf(this.options.keyring),
        serviceAccountId: platform === 'gcp' ? node.serviceAccountId : null,
        egressIps: [...node.egressIps],
        audience: node.audience,
        error: tenant.kind === 'ambiguous' ? 'tenant_ambiguous' : null,
      },
      sources: [],
      users: [],
    };
    if (tenant.kind !== 'single') return { request: base, reported: [], omitted: 0 };
    const maxBytes = this.options.requestMaxBytes ?? NODE_SYNC_REQUEST_MAX_BYTES;
    // Os relatos dos usuários vão primeiro, com a mesma régua e o teto deles: são pequenos (perto de 150 bytes; os
    // `NODE_SYNC_MAX_USERS`, cerca de 30 KiB, um oitavo do limite) e são o que faz o plano de controle mostrar o
    // resultado e apagar o envelope. As fontes ficam com o que sobra do limite.
    const users = selectReports(
      await this.userReports(tenant.id),
      jsonBytes(base),
      maxBytes,
      NODE_SYNC_MAX_USERS,
    );
    const withUsers: NodeSyncRequest = {
      ...base,
      users: users.selected.map((candidate) => candidate.report),
    };
    const sources = selectReports(await this.sourceReports(tenant.id), jsonBytes(withUsers), maxBytes);
    const tracked = <R extends AnyReport>(kind: ReportKind, selected: ReportCandidate<R>[]) =>
      selected
        .filter((candidate) => candidate.tracked)
        .map((candidate) => ({
          kind,
          id: reportId(candidate.report),
          hash: candidate.hash,
          changed: candidate.hash !== candidate.reportedHash,
        }));
    return {
      request: { ...withUsers, sources: sources.selected.map((candidate) => candidate.report) },
      reported: [...tracked('log_source', sources.selected), ...tracked('user', users.selected)],
      omitted: sources.omitted + users.omitted,
    };
  }

  /**
   * Os relatos que o plano de controle aceitou (200): o hash e o instante nos que mudaram, um a um; só o instante nos
   * outros, de uma vez por tipo. Só o item (da fonte ou do pedido de usuário) do cliente do nó.
   */
  private async markReported(tenantId: string, reported: BuiltRequest['reported']): Promise<void> {
    if (reported.length === 0) return;
    const now = this.now();
    const changed = reported.filter((item) => item.changed);
    const unchanged = (kind: ReportKind) =>
      reported.filter((item) => item.kind === kind && !item.changed).map((item) => item.id);
    await this.prisma.$transaction([
      ...(['log_source', 'user'] as const).map((kind) =>
        this.prisma.controlPlaneSyncItem.updateMany({
          where: { kind, tenantId, itemId: { in: unchanged(kind) }, reportedHash: { not: null } },
          data: { reportedAt: now },
        }),
      ),
      ...changed.map((item) =>
        this.prisma.controlPlaneSyncItem.updateMany({
          where: { kind: item.kind, tenantId, itemId: item.id },
          data: { reportedHash: item.hash, reportedAt: now },
        }),
      ),
    ]);
  }

  /**
   * O que aconteceu com cada pedido de usuário do console: a conta criada, com a situação de agora (ativa ou não, o
   * MFA, ainda na senha temporária), também nas chamadas seguintes; e o pedido recusado, com o código. Só o cliente do
   * nó; a senha nunca entra.
   */
  private async userReports(tenantId: string): Promise<ReportCandidate<NodeSyncUserReport>[]> {
    const db = scopeToTenant(this.prisma, tenantId);
    const [users, items] = await Promise.all([
      db.user.findMany({
        where: { controlPlaneRequestId: { not: null } },
        select: {
          controlPlaneRequestId: true,
          status: true,
          twoFactorEnabled: true,
          mustChangePassword: true,
        },
      }),
      db.controlPlaneSyncItem.findMany({ where: { kind: 'user' } }),
    ]);
    const itemsById = new Map(items.map((item) => [item.itemId, item]));
    const usersById = new Map(
      users.flatMap((user) =>
        user.controlPlaneRequestId === null ? [] : [[user.controlPlaneRequestId, user] as const],
      ),
    );
    const reports: ReportCandidate<NodeSyncUserReport>[] = [];
    for (const requestId of [...new Set([...itemsById.keys(), ...usersById.keys()])].sort()) {
      const item = itemsById.get(requestId);
      const user = usersById.get(requestId);
      let report: NodeSyncUserReport;
      let fingerprint: string;
      if (user !== undefined) {
        report = {
          requestId,
          outcome: 'created',
          code: null,
          user: {
            status: user.status,
            mfaEnabled: user.twoFactorEnabled,
            mustChangePassword: user.mustChangePassword,
          },
        };
        fingerprint = [
          'created',
          requestId,
          user.status,
          user.twoFactorEnabled ? 1 : 0,
          user.mustChangePassword ? 1 : 0,
        ].join('|');
      } else if (item?.outcome === 'failed') {
        report = {
          requestId,
          outcome: 'failed',
          code: isUserCode(item.code) ? item.code : 'internal_error',
          user: null,
        };
        fingerprint = ['failed', requestId, report.code].join('|');
      } else {
        // O item diz criada, mas a conta não está mais no cliente: não há situação para contar.
        continue;
      }
      reports.push(candidateOf(report, item, fingerprint));
    }
    return reports;
  }

  /**
   * O que aconteceu com cada fonte do console: as contas `control_plane` (a situação delas) e os resultados de
   * `ControlPlaneSyncItem` (a última revisão processada, o código da falha, a credencial). Só o cliente do nó.
   */
  private async sourceReports(tenantId: string): Promise<ReportCandidate[]> {
    const db = scopeToTenant(this.prisma, tenantId);
    const [accounts, items] = await Promise.all([
      db.cloudAccount.findMany({ where: { origin: 'control_plane' }, select: accountSelect }),
      db.controlPlaneSyncItem.findMany({ where: { kind: { in: ['log_source', 'log_source_credential'] } } }),
    ]);
    const sourceItems = new Map(
      items.filter((item) => item.kind === 'log_source').map((item) => [item.itemId, item]),
    );
    const credentialItems = new Map(
      items.filter((item) => item.kind === 'log_source_credential').map((item) => [item.itemId, item]),
    );
    const rows = new Map(accounts.map((row) => [row.id, row]));
    const credentials = new Map(
      (
        await db.cloudCredential.findMany({
          where: { cloudAccountId: { in: [...rows.keys()] } },
          select: {
            cloudAccountId: true,
            kind: true,
            keyIdSuffix: true,
            expiresAt: true,
            verifiedAt: true,
            origin: true,
            controlPlaneRevision: true,
          },
        })
      ).map((row) => [row.cloudAccountId, row]),
    );
    const ids = [...new Set([...sourceItems.keys(), ...rows.keys()])].sort();
    const reports: ReportCandidate[] = [];
    for (const id of ids) {
      const item = sourceItems.get(id);
      const row = rows.get(id);
      const revision = item?.revision ?? row?.controlPlaneRevision ?? null;
      if (revision === null) continue;
      let outcome: NodeSyncSourceReport['outcome'];
      let code: NodeSyncSourceCode | null = null;
      if (item !== undefined) {
        outcome = item.outcome === 'failed' || item.outcome === 'removed' ? item.outcome : 'applied';
        if (outcome === 'failed') code = isSourceCode(item.code) ? item.code : 'internal_error';
      } else {
        outcome = row?.status === 'inactive' ? 'removed' : 'applied';
      }
      const account = row === undefined ? null : toAccount(row, this.options.node);
      const credential = credentials.get(id);
      const credentialItem = credentialItems.get(id);
      let credentialReport: NodeSyncCredentialReport | null = null;
      const consoleRevision =
        credential?.origin === 'control_plane' ? (credential.controlPlaneRevision ?? 0) : 0;
      const metadata = credential
        ? {
            kind: credential.kind,
            keyIdSuffix: KEY_ID_SUFFIX.test(credential.keyIdSuffix) ? credential.keyIdSuffix : null,
            expiresAt: credential.expiresAt?.toISOString() ?? null,
            verifiedAt: credential.verifiedAt.toISOString(),
          }
        : { kind: null, keyIdSuffix: null, expiresAt: null, verifiedAt: null };
      if (credentialItem?.outcome === 'failed' && credentialItem.revision > consoleRevision) {
        credentialReport = {
          revision: credentialItem.revision,
          outcome: 'failed',
          code: isSourceCode(credentialItem.code) ? credentialItem.code : 'internal_error',
          ...metadata,
        };
      } else if (credential !== undefined) {
        credentialReport = {
          // A colada no painel vai sem revisão: é a do cliente, e vale até o console mandar outra.
          revision: credential.origin === 'control_plane' ? credential.controlPlaneRevision : null,
          outcome: 'applied',
          code: null,
          ...metadata,
        };
      }
      const sourceReport: NodeSyncSourceReport = {
        id,
        revision,
        outcome,
        code,
        credential: credentialReport,
        account:
          account === null
            ? null
            : {
                status: account.status,
                connection: account.connection,
                connectionError: account.connectionError,
                collectionError: account.collectionError ?? null,
                ingestFrom: account.ingestFrom,
                lastEventAt: account.lastEventAt ?? null,
                lastCollectedAt: account.lastCollectedAt,
                checkRequestedAt: account.checkRequestedAt,
              },
      };
      reports.push(candidateOf(sourceReport, item, JSON.stringify(sourceReport)));
    }
    return reports;
  }

  /** No log, o código e o que ajuda a resolver; devolve o resultado para marcar a espera. */
  private logFailure(result: Extract<NodeSyncResult, { ok: false }>): Extract<NodeSyncResult, { ok: false }> {
    const { logger } = this.options;
    switch (result.code) {
      case 'unauthenticated':
        logger.error(
          { code: 'control_plane_unauthenticated', status: result.status },
          'sincronização com o plano de controle: o plano de controle não reconheceu o nó; tenta de novo em 1 h',
        );
        break;
      case 'not_found':
        logger.warn(
          { code: result.code, status: result.status },
          'sincronização com o plano de controle: o cliente ainda não está apto; tenta de novo em 6 h',
        );
        break;
      case 'bad_request':
        if (clockSkewExceeded(result.clockSkewMs)) {
          logger.error(
            { code: 'clock_skew', clockSkewMs: result.clockSkewMs },
            'sincronização com o plano de controle: o relógio do nó está fora dos 10 min aceitos; acerte o NTP da VM',
          );
        } else {
          logger.error(
            { code: result.code, status: result.status },
            'sincronização com o plano de controle: o plano de controle recusou o pedido',
          );
        }
        break;
      default:
        logger.warn(
          { code: result.code, status: result.status ?? null },
          'sincronização com o plano de controle: a chamada falhou; tenta de novo com espera crescente',
        );
    }
    return result;
  }

  /** Grava a próxima chamada e o estado da última. */
  private async schedule(
    result:
      { ok: true; response: NodeSyncResponse } | { ok: false; code: string; retryAfterSeconds?: number },
  ): Promise<void> {
    const now = this.now();
    const row = await this.prisma.controlPlaneSync.findUnique({ where: { id: SYNC_ROW_ID } });
    let nextAttemptAt: Date;
    if (result.ok) {
      const base = result.response.pollAfterSeconds;
      const jitter = (this.random() * 2 - 1) * NODE_SYNC_JITTER_SECONDS;
      const seconds = Math.max(NODE_SYNC_POLL_MIN_SECONDS, base + jitter);
      nextAttemptAt = new Date(now.getTime() + Math.round(seconds * 1000));
      const generation = result.response.generation <= MAX_INT ? result.response.generation : null;
      await this.prisma.controlPlaneSync.update({
        where: { id: SYNC_ROW_ID },
        data: { nextAttemptAt, failures: 0, lastErrorCode: null, lastSuccessAt: now, generation },
      });
    } else {
      const failures = (row?.failures ?? 0) + 1;
      let delay: number;
      switch (result.code) {
        case 'unauthenticated':
          delay = UNAUTHENTICATED_RETRY_MS;
          break;
        case 'not_found':
          delay = NOT_FOUND_RETRY_MS;
          break;
        case 'rate_limited':
          delay = Math.min(
            RATE_LIMIT_MAX_MS,
            Math.max(FAILURE_RETRY_BASE_MS, (result.retryAfterSeconds ?? 0) * 1000),
          );
          break;
        case 'metadata_unavailable':
          // Sem o token, a chamada nem saiu: a próxima no intervalo de sempre.
          delay = NODE_SYNC_INTERVAL_SECONDS * 1000;
          break;
        default:
          delay = failureRetryDelayMs(failures);
      }
      nextAttemptAt = new Date(now.getTime() + delay);
      await this.prisma.controlPlaneSync.update({
        where: { id: SYNC_ROW_ID },
        data: { nextAttemptAt, failures, lastErrorCode: result.code },
      });
    }
    this.nextAt = nextAttemptAt;
  }
}
