import {
  CONTROL_PLANE_AUDIT_ACTOR_ID,
  type CloudAccountCreate,
  credentialKindAllowed,
  LOG_SOURCES,
  type LogBuckets,
  type NodePlatform,
  type NodeSyncDesiredCredential,
  type NodeSyncDesiredSource,
  type NodeSyncSourceCode,
  type NodeSyncUserCode,
  sameLogBucketNames,
} from '@verax/shared';
import {
  type AccountRow,
  accountSelect,
  BUCKET_COLUMN,
  bucketsOf,
  type NodeFacts,
  providerData,
  RESET_CONNECTION,
  toAccount,
} from '../cloud-accounts/cloud-account-data.js';
import { assertLogOriginsFree, LogOriginTaken, type LogOrigins } from '../cloud-accounts/log-origins.js';
import { type AuditEntry, AuditService } from '../common/audit/audit.service.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import { CredentialRejected, CredentialSourceUnavailable } from '../credentials/credential-check.js';
import { lockCredential } from '../credentials/credential-rekey.js';
import {
  credentialBinding,
  CredentialVaultError,
  envelopeVersion,
  open,
  releaseSecret,
  type VaultSecret,
} from '../credentials/credential-vault.js';
import { Prisma, type ControlPlaneItemKind } from '../generated/prisma/client.js';
import { assertWithinPlan, lockPlanSeats, lockSeatRow, PlanLimitReached } from '../plan/plan-limits.js';
import type { TenantPlans } from '../plan/tenant-plan.js';
import type { SourceCredentialChecks } from './credential-checks.js';

/** A vaga do plano que faltou, ou o plano que ainda não chegou, é tentada de novo a cada hora (com a mesma revisão). */
export const PLAN_RETRY_MS = 60 * 60 * 1000;
/** A origem fora do ar: 1, 2, 4... minutos, até 30, com a mesma revisão. */
export const SOURCE_RETRY_BASE_MS = 60 * 1000;
export const SOURCE_RETRY_MAX_MS = 30 * 60 * 1000;
/** Uma transação da sincronização: os locks das vagas e das origens, poucas leituras e a gravação. */
const TRANSACTION_TIMEOUT_MS = 15_000;

/** A espera da tentativa `attempt` (1, 2, 3...) com a origem fora do ar. */
export function sourceRetryDelayMs(attempt: number): number {
  return Math.min(SOURCE_RETRY_MAX_MS, SOURCE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

/** O que a tarefa loga (o pino do worker; um dublê nos testes). Só ids, contagens e códigos. */
export interface SyncLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** O que aplicar uma fonte precisa: o cliente do nó e o que vem da configuração do worker. */
export interface SourceApplyContext {
  prisma: PrismaService;
  tenantId: string;
  platform: NodePlatform;
  keyring: VaultKeyring | null;
  plans: TenantPlans;
  checks: SourceCredentialChecks;
  /** Os valores do nó que a conta mostra (o `after` da auditoria sai como a API mostra a conta). */
  node: NodeFacts;
  logger: SyncLogger;
  now: () => Date;
}

/** O que mudou no nó com uma fonte (vai para as contagens da execução e decide a segunda chamada). */
export interface SourceApplyResult {
  /** A conta foi criada, alterada, desativada (lápide) ou a credencial foi guardada. */
  changed: boolean;
  /** A fonte ou a credencial falhou nesta passagem. */
  failed: boolean;
}

/** Uma falha conhecida de uma fonte: o código do contrato e, quando passa sozinha, quando tentar de novo. */
class SourceFailure extends Error {
  constructor(
    readonly code: NodeSyncSourceCode,
    readonly retryAt: Date | null = null,
  ) {
    super(`fonte não aplicada: ${code}`);
    this.name = 'SourceFailure';
  }
}

const audit = new AuditService();

type Tx = Prisma.TransactionClient;

/** O registro da trilha, sempre do sistema com o ator do console (a trilha do cliente mostra "Verax (administrativo)"). */
export function auditEntry(tenantId: string, entry: Omit<AuditEntry, 'actor' | 'outcome'>): AuditEntry {
  return {
    actor: { type: 'system', id: CONTROL_PLANE_AUDIT_ACTOR_ID, tenantId },
    outcome: 'success',
    ...entry,
  };
}

/** O resultado de um item, para contar de volta e para saber se tenta de novo. */
export async function recordItem(
  db: Tx,
  item: {
    kind: ControlPlaneItemKind;
    itemId: string;
    tenantId: string;
    revision: number;
    outcome: 'applied' | 'failed' | 'removed' | 'created';
    code?: NodeSyncSourceCode | NodeSyncUserCode | null;
    attempts?: number;
    nextAttemptAt?: Date | null;
  },
): Promise<void> {
  const data = {
    tenantId: item.tenantId,
    revision: item.revision,
    outcome: item.outcome,
    code: item.code ?? null,
    attempts: item.attempts ?? 0,
    nextAttemptAt: item.nextAttemptAt ?? null,
  };
  await db.controlPlaneSyncItem.upsert({
    where: { kind_itemId: { kind: item.kind, itemId: item.itemId } },
    create: { kind: item.kind, itemId: item.itemId, ...data },
    update: data,
  });
}

/** Os buckets do cadastro desejado, por fonte: a fonte que não vem fica sem bucket (o desejado é completo). */
function desiredBuckets(spec: Extract<CloudAccountCreate, { provider: 'aws' }>): LogBuckets {
  return {
    cloudtrail: spec.buckets?.cloudtrail ?? null,
    guardduty: spec.buckets?.guardduty ?? null,
    waf: spec.buckets?.waf ?? null,
  };
}

/** Os campos do cadastro que o console decide, como o desejado completo (o que não vem fica vazio). */
function consoleFields(spec: CloudAccountCreate): Prisma.CloudAccountUpdateInput {
  switch (spec.provider) {
    case 'aws': {
      const buckets = desiredBuckets(spec);
      const data: Prisma.CloudAccountUpdateInput = { regions: spec.regions };
      for (const source of LOG_SOURCES) data[BUCKET_COLUMN[source]] = buckets[source];
      return data;
    }
    case 'gcp':
      return {
        pubsubSubscription: spec.pubsubSubscription ?? null,
        sinkWriterIdentity: spec.sinkWriterIdentity ?? null,
      };
    case 'cloudflare':
      return { zones: spec.zones ?? [] };
  }
}

/** As origens de log do cadastro desejado (a mesma régua do painel, `assertLogOriginsFree`). */
function originsOf(spec: CloudAccountCreate): LogOrigins {
  switch (spec.provider) {
    case 'aws':
      return { buckets: spec.buckets };
    case 'gcp':
      return {
        pubsubSubscription: spec.pubsubSubscription ?? null,
        sinkWriterIdentity: spec.sinkWriterIdentity ?? null,
      };
    case 'cloudflare':
      return { zones: spec.zones ?? [] };
  }
}

/** A vaga do plano do cliente para criar ou reativar a conta, na transação que grava (o lock vem antes de tudo). */
async function assertSeat(tx: Tx, ctx: SourceApplyContext, retryAt: Date): Promise<void> {
  const plan = await ctx.plans.planOf(ctx.tenantId, tx);
  if (plan === null) throw new SourceFailure('tenant_plan_missing', retryAt);
  try {
    await assertWithinPlan(tx, plan, 'cloudAccounts', ctx.tenantId);
  } catch (error) {
    if (error instanceof PlanLimitReached) throw new SourceFailure('plan_limit_reached', retryAt);
    throw error;
  }
}

/**
 * O lock das vagas do cliente antes de ler a conta (criar e reativar ocupam uma vaga; a lápide libera), como no painel:
 * a decisão tomada sobre o status lido vale até a gravação.
 */
async function lockSeats(tx: Tx, ctx: SourceApplyContext): Promise<void> {
  const plan = await ctx.plans.planOf(ctx.tenantId, tx);
  if (plan === null) await lockSeatRow(tx, 'cloudAccounts', ctx.tenantId);
  else await lockPlanSeats(tx, plan, 'cloudAccounts', ctx.tenantId);
}

/** As origens livres; a recusa vira `origin_conflict`. */
async function assertOrigins(tx: Tx, ctx: SourceApplyContext, spec: CloudAccountCreate, exceptId?: string) {
  try {
    await assertLogOriginsFree(tx, originsOf(spec), { tenantId: ctx.tenantId, exceptId, sharedCell: false });
  } catch (error) {
    if (error instanceof LogOriginTaken) throw new SourceFailure('origin_conflict');
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** A conta como a trilha a guarda: como a API a mostra, com a origem. */
function auditState(row: AccountRow, node: NodeFacts) {
  return { ...toAccount(row, node), origin: row.origin };
}

/** A credencial apagada com a conta (a lápide), como o `wipeCredential` do painel. */
async function wipeCredential(tx: Tx, tenantId: string, id: string): Promise<void> {
  await lockCredential(tx, id);
  const db = scopeToTenant(tx, tenantId);
  const credential = await db.cloudCredential.findUnique({
    where: { cloudAccountId: id },
    select: { kind: true, keyIdSuffix: true, expiresAt: true },
  });
  if (!credential) return;
  await db.cloudCredential.delete({ where: { cloudAccountId: id }, select: { cloudAccountId: true } });
  await audit.write(
    tx,
    auditEntry(tenantId, {
      action: 'cloud_credential.wipe',
      resourceType: 'cloud_credential',
      resourceId: id,
      before: {
        kind: credential.kind,
        keyIdSuffix: credential.keyIdSuffix,
        expiresAt: credential.expiresAt?.toISOString() ?? null,
      },
      after: null,
    }),
  );
}

type AccountStep = 'applied' | 'removed' | 'unchanged';

/**
 * A conta desejada, numa transação: criar, alterar (só os campos do console, as mesmas regras do `update` do painel) ou
 * desativar (a lápide, como o `deactivate`). Nunca toca numa conta do painel. Lança `SourceFailure` com o código.
 */
async function applyAccount(
  tx: Tx,
  ctx: SourceApplyContext,
  source: NodeSyncDesiredSource,
): Promise<AccountStep> {
  const { tenantId } = ctx;
  const db = scopeToTenant(tx, tenantId);
  const now = ctx.now();
  const planRetryAt = new Date(now.getTime() + PLAN_RETRY_MS);
  if (source.state === 'removed') {
    // Liberar a vaga: o lock das vagas antes da leitura, como no painel.
    await lockSeats(tx, ctx);
    const before = await db.cloudAccount.findUnique({ where: { id: source.id }, select: accountSelect });
    if (before === null) return 'removed';
    if (before.origin !== 'control_plane') throw new SourceFailure('account_exists_panel');
    await wipeCredential(tx, tenantId, source.id);
    const row = await db.cloudAccount.update({
      where: { id: source.id },
      data: {
        controlPlaneRevision: source.revision,
        ...(before.status === 'active' && { status: 'inactive', ...RESET_CONNECTION }),
      },
      select: accountSelect,
    });
    if (before.status === 'active') {
      await audit.write(
        tx,
        auditEntry(tenantId, {
          action: 'cloud_account.deactivate',
          resourceType: 'cloud_account',
          resourceId: source.id,
          before: auditState(before, ctx.node),
          after: auditState(row, ctx.node),
        }),
      );
    }
    return 'removed';
  }

  const { spec } = source;
  // Criar ou reativar ocupa vaga: o lock das vagas vem antes da leitura da conta e dos locks das origens.
  await lockSeats(tx, ctx);
  const existing = await db.cloudAccount.findUnique({ where: { id: source.id }, select: accountSelect });
  if (existing === null) {
    // A mesma conta do provedor já cadastrada (pelo cliente, ou por outro cadastro do console): nunca é tocada.
    const same = await tx.cloudAccount.findUnique({
      where: { provider_accountId: { provider: spec.provider, accountId: spec.accountId } },
      select: { origin: true },
    });
    if (same !== null) {
      throw new SourceFailure(same.origin === 'panel' ? 'account_exists_panel' : 'origin_conflict');
    }
    await assertSeat(tx, ctx, planRetryAt);
    await assertOrigins(tx, ctx, spec);
    let row: AccountRow;
    try {
      row = await db.cloudAccount.create({
        data: {
          ...providerData(spec),
          id: source.id,
          origin: 'control_plane',
          controlPlaneRevision: source.revision,
        },
        select: accountSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SourceFailure('account_exists_panel');
      throw error;
    }
    await audit.write(
      tx,
      auditEntry(tenantId, {
        action: 'cloud_account.create',
        resourceType: 'cloud_account',
        resourceId: row.id,
        after: auditState(row, ctx.node),
      }),
    );
    return 'applied';
  }

  if (existing.origin !== 'control_plane') throw new SourceFailure('account_exists_panel');
  if (existing.provider !== spec.provider || existing.accountId !== spec.accountId) {
    throw new SourceFailure('immutable_changed');
  }
  if (existing.controlPlaneRevision !== null && source.revision <= existing.controlPlaneRevision)
    return 'unchanged';
  // Reativar (uma revisão ativa depois da lápide) ocupa a vaga de novo.
  const reactivate = existing.status !== 'active';
  if (reactivate) await assertSeat(tx, ctx, planRetryAt);
  await assertOrigins(tx, ctx, spec, existing.id);
  const fields = consoleFields(spec);
  // As regras do `update` do painel: outra lista de buckets, outra assinatura ou a conta reativada recomeçam a
  // conexão; a identidade do sink e as regiões não.
  const sourceChanged =
    (spec.provider === 'aws' && !sameLogBucketNames(bucketsOf(existing), desiredBuckets(spec))) ||
    (spec.provider === 'gcp' && (spec.pubsubSubscription ?? null) !== existing.pubsubSubscription);
  const row = await db.cloudAccount.update({
    where: { id: existing.id },
    data: {
      ...fields,
      controlPlaneRevision: source.revision,
      ...(reactivate && { status: 'active' }),
      ...((sourceChanged || reactivate) && RESET_CONNECTION),
    },
    select: accountSelect,
  });
  const beforeState = auditState(existing, ctx.node);
  const afterState = auditState(row, ctx.node);
  const { updatedAt: _beforeAt, ...beforeCompared } = beforeState;
  const { updatedAt: _afterAt, ...afterCompared } = afterState;
  if (JSON.stringify(beforeCompared) === JSON.stringify(afterCompared)) return 'unchanged';
  await audit.write(
    tx,
    auditEntry(tenantId, {
      action: 'cloud_account.update',
      resourceType: 'cloud_account',
      resourceId: existing.id,
      before: beforeState,
      after: afterState,
    }),
  );
  return 'applied';
}

/** O código de uma falha que não é `SourceFailure`: só o tipo vai para o log. */
function internalFailure(ctx: SourceApplyContext, source: { id: string }, step: string, error: unknown) {
  ctx.logger.error(
    { sourceId: source.id, step, error: errorKind(error) },
    'sincronização com o plano de controle: falha ao aplicar a fonte',
  );
  return new SourceFailure('internal_error');
}

const CREDENTIAL_SUMMARY = { kind: true, keyIdSuffix: true, expiresAt: true } as const;

/**
 * A credencial desejada da fonte, quando a revisão do console é mais nova que a última do console aplicada (uma colada
 * no painel depois dela vale até o console mandar outra). O envelope é aberto com as chaves do cofre (prova a amarração
 * ao cliente, à conta, ao tipo e ao ID no provedor), conferido na origem como no painel e gravado como veio, sem
 * recifrar. O texto claro só passa pela memória do worker.
 */
async function applyCredential(
  ctx: SourceApplyContext,
  source: NodeSyncDesiredSource,
  credential: NodeSyncDesiredCredential,
): Promise<'applied' | 'unchanged'> {
  const { prisma, tenantId } = ctx;
  const db = scopeToTenant(prisma, tenantId);
  const account = await db.cloudAccount.findUnique({
    where: { id: source.id },
    select: {
      id: true,
      tenantId: true,
      provider: true,
      accountId: true,
      status: true,
      origin: true,
      pubsubSubscription: true,
    },
  });
  // Só na conta do console, ativa (a falha da conta já foi contada).
  if (account === null || account.origin !== 'control_plane' || account.status !== 'active')
    return 'unchanged';
  const [item, current] = await Promise.all([
    prisma.controlPlaneSyncItem.findUnique({
      where: { kind_itemId: { kind: 'log_source_credential', itemId: source.id } },
    }),
    db.cloudCredential.findUnique({
      where: { cloudAccountId: source.id },
      select: { origin: true, controlPlaneRevision: true },
    }),
  ]);
  const lastApplied = Math.max(
    item?.outcome === 'applied' ? item.revision : 0,
    current?.origin === 'control_plane' ? (current.controlPlaneRevision ?? 0) : 0,
  );
  if (credential.revision <= lastApplied) return 'unchanged';
  if (item !== null && credential.revision < item.revision) return 'unchanged';
  const now = ctx.now();
  const sameFailed = item !== null && item.revision === credential.revision && item.outcome === 'failed';
  if (sameFailed && (item.nextAttemptAt === null || item.nextAttemptAt > now)) return 'unchanged';
  const attempts = (sameFailed ? item.attempts : 0) + 1;

  const fail = async (code: NodeSyncSourceCode, retryAt: Date | null = null): Promise<never> => {
    await recordItem(prisma, {
      kind: 'log_source_credential',
      itemId: source.id,
      tenantId,
      revision: credential.revision,
      outcome: 'failed',
      code,
      attempts,
      nextAttemptAt: retryAt,
    });
    throw new SourceFailure(code, retryAt);
  };

  const keyring = ctx.keyring;
  if (keyring === null) return fail('vault_disabled');
  if (!credentialKindAllowed(credential.kind, ctx.platform)) return fail('credential_kind_not_allowed');
  // A chave da GCP prova a leitura da assinatura cadastrada: sem ela, não há o que conferir.
  if (credential.kind === 'gcp_service_account_key' && account.pubsubSubscription === null) {
    return fail('invalid_spec');
  }
  let secret: VaultSecret;
  try {
    secret = open(keyring, credentialBinding(account, credential.kind), credential.envelope);
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      ctx.logger.warn(
        { sourceId: source.id, revision: credential.revision, error: error.code },
        'sincronização com o plano de controle: o envelope da credencial não abre neste nó',
      );
      return fail('credential_unreadable');
    }
    throw error;
  }
  let applied = false;
  try {
    let checked;
    try {
      checked = await ctx.checks.check(secret, account);
    } catch (error) {
      if (error instanceof CredentialRejected) {
        ctx.logger.warn(
          {
            sourceId: source.id,
            kind: credential.kind,
            reason: error.reason,
            sourceStatus: error.sourceStatus,
          },
          'sincronização com o plano de controle: a origem recusou a credencial do console',
        );
        return await fail(`credential_rejected_${error.reason}`);
      }
      if (error instanceof CredentialSourceUnavailable) {
        const retryAt = new Date(now.getTime() + sourceRetryDelayMs(attempts));
        ctx.logger.warn(
          { sourceId: source.id, kind: credential.kind, sourceError: error.code, attempts },
          'sincronização com o plano de controle: a origem da credencial não respondeu',
        );
        return await fail('source_unavailable', retryAt);
      }
      throw error;
    }
    const outcome = await prisma.$transaction(
      async (tx) => {
        // O lock da conta: o mesmo da troca pelo painel, da recifragem e da desativação.
        await lockCredential(tx, source.id);
        const scoped = scopeToTenant(tx, tenantId);
        const still = await scoped.cloudAccount.findUnique({
          where: { id: source.id },
          select: { status: true, origin: true },
        });
        if (still === null || still.origin !== 'control_plane' || still.status !== 'active')
          return 'unchanged';
        const before = await scoped.cloudCredential.findUnique({
          where: { cloudAccountId: source.id },
          select: { ...CREDENTIAL_SUMMARY, origin: true, controlPlaneRevision: true },
        });
        if (
          before?.origin === 'control_plane' &&
          before.controlPlaneRevision !== null &&
          before.controlPlaneRevision >= credential.revision
        ) {
          return 'unchanged';
        }
        const data = {
          kind: credential.kind,
          // O envelope como veio: cifrado pelo console com a chave pública deste nó, amarrado a esta conta.
          ciphertext: credential.envelope,
          keyVersion: envelopeVersion(credential.envelope),
          keyIdSuffix: checked.keyIdSuffix,
          issuedAt: checked.issuedAt,
          expiresAt: checked.expiresAt,
          verifiedAt: ctx.now(),
          rotationNoticeAt: null,
          origin: 'control_plane',
          controlPlaneRevision: credential.revision,
        } satisfies Prisma.CloudCredentialUpdateInput;
        const saved = await scoped.cloudCredential.upsert({
          where: { cloudAccountId: source.id },
          create: { cloudAccountId: source.id, tenantId, ...data },
          update: data,
          select: CREDENTIAL_SUMMARY,
        });
        // Credencial nova é leitura nova: a conexão espera a próxima coleta confirmar.
        await scoped.cloudAccount.update({
          where: { id: source.id },
          data: RESET_CONNECTION,
          select: { id: true },
        });
        const summary = (row: typeof saved) => ({
          kind: row.kind,
          keyIdSuffix: row.keyIdSuffix,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        });
        await audit.write(
          tx,
          auditEntry(tenantId, {
            action: before ? 'cloud_credential.rotate' : 'cloud_credential.set',
            resourceType: 'cloud_credential',
            resourceId: source.id,
            before: before ? { ...summary(before), origin: before.origin } : null,
            after: { ...summary(saved), origin: 'control_plane' },
          }),
        );
        await recordItem(tx, {
          kind: 'log_source_credential',
          itemId: source.id,
          tenantId,
          revision: credential.revision,
          outcome: 'applied',
        });
        return 'applied' as const;
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );
    applied = outcome === 'applied';
    return outcome;
  } finally {
    // A credencial guardada continua em uso no worker (os coletores a abrem de novo); a que não foi guardada sai da
    // lista de segredos vivos do logger (`releaseSecret`), como no painel.
    if (!applied) releaseSecret(secret);
  }
}

/**
 * Uma fonte desejada: a conta (numa transação) e depois a credencial (aberta e conferida fora de transação, gravada
 * noutra). Uma revisão já processada não é tentada de novo, a não ser a falha que passa sozinha (a vaga do plano a
 * cada hora, a origem fora do ar com espera crescente). O resultado de cada parte fica em `ControlPlaneSyncItem`.
 */
export async function applySource(
  ctx: SourceApplyContext,
  source: NodeSyncDesiredSource,
): Promise<SourceApplyResult> {
  const { prisma, tenantId } = ctx;
  const now = ctx.now();
  const item = await prisma.controlPlaneSyncItem.findUnique({
    where: { kind_itemId: { kind: 'log_source', itemId: source.id } },
  });
  // Um item de outro cliente (o banco tinha outro cliente antes) não se mistura: a fonte é ignorada.
  if (item !== null && item.tenantId !== tenantId) return { changed: false, failed: false };
  if (item !== null && source.revision < item.revision) return { changed: false, failed: false };
  const sameRevision = item !== null && item.revision === source.revision;
  if (
    sameRevision &&
    item.outcome === 'failed' &&
    (item.nextAttemptAt === null || item.nextAttemptAt > now)
  ) {
    return { changed: false, failed: false };
  }
  let changed = false;
  if (!sameRevision || item.outcome === 'failed') {
    let step: AccountStep;
    try {
      step = await prisma.$transaction(
        async (tx) => {
          const result = await applyAccount(tx, ctx, source);
          await recordItem(tx, {
            kind: 'log_source',
            itemId: source.id,
            tenantId,
            revision: source.revision,
            outcome: result === 'removed' ? 'removed' : 'applied',
          });
          return result;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (error) {
      const failure = error instanceof SourceFailure ? error : internalFailure(ctx, source, 'account', error);
      await recordItem(prisma, {
        kind: 'log_source',
        itemId: source.id,
        tenantId,
        revision: source.revision,
        outcome: 'failed',
        code: failure.code,
        nextAttemptAt: failure.retryAt,
      });
      return { changed: false, failed: true };
    }
    changed = step !== 'unchanged';
  }
  if (source.state !== 'active' || source.credential === null) return { changed, failed: false };
  try {
    const credential = await applyCredential(ctx, source, source.credential);
    return { changed: changed || credential === 'applied', failed: false };
  } catch (error) {
    if (!(error instanceof SourceFailure)) {
      const failure = internalFailure(ctx, source, 'credential', error);
      await recordItem(prisma, {
        kind: 'log_source_credential',
        itemId: source.id,
        tenantId,
        revision: source.credential.revision,
        outcome: 'failed',
        code: failure.code,
      });
    }
    return { changed, failed: true };
  }
}
