import {
  type CellCommand,
  type CellRefusalCode,
  parseCellCommandJson,
  tenantCollectionPauseCommandSchema,
  type tenantExportCommandSchema,
  type tenantPurgeCommandSchema,
  type tenantUpsertCommandSchema,
} from '@verax/shared';
import type { z } from 'zod';
import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { PubsubMessage, PubsubReader } from '../gcp/pubsub.client.js';
import type { Prisma } from '../generated/prisma/client.js';
import { writeTenantPlan } from '../plan/tenant-plan.js';
import { assignTenantHost, TenantHostConflict } from '../tenants/tenant-host.js';
import { applyTenantLifecycleStatus, TenantTransitionRefused } from '../tenants/tenant-lifecycle.js';
import type { CellReportOutbox } from './cell-report-outbox.js';
import { recordTenantExport, storedDesiredOf, type TenantExportResult } from './cell-tenant-state.js';
import { TenantCloudIdentityConflict, writeTenantCloudIdentity } from './tenant-cloud-identity.js';

/** Nome da tarefa do worker que lê os comandos do plano de controle. */
export const CELL_COMMANDS_TASK = 'cell-commands';
/** A cada 10 s (§5.1 do desenho): o provisionamento espera o `tenant.applied` em minutos, não em horas. */
export const CELL_COMMANDS_INTERVAL_MS = 10_000;

/** Quem age na trilha do cliente quando o comando vem do plano de controle. */
export const CONTROL_PLANE_ACTOR = 'control-plane';

const PULL_SIZE = 10;
const MAX_PULLS = 10;

type UpsertCommand = z.infer<typeof tenantUpsertCommandSchema>;
type ExportCommand = z.infer<typeof tenantExportCommandSchema>;
type PurgeCommand = z.infer<typeof tenantPurgeCommandSchema>;
type PauseCommand = z.infer<typeof tenantCollectionPauseCommandSchema>;

/** Os dados do cliente para o exportador: o id daqui, o do plano de controle e o pedido. */
export interface TenantExportRequest {
  tenantId: string;
  controlPlaneId: string;
  exportId: string;
}

/**
 * Quem grava a exportação do cliente no bucket de exportações da célula (§3.7: NDJSON compactado de cada tabela do
 * cliente, sem segredo). Vem no CE-16; até lá a célula recusa o pedido com `export_unavailable`. Depois de devolver, o
 * canal registra a exportação e o `export.ready` numa transação (`recordTenantExport`).
 */
export interface TenantExporter {
  exportTenant(request: TenantExportRequest, signal: AbortSignal): Promise<TenantExportResult>;
}

/**
 * Quem apaga os dados do cliente do banco da célula (§3.7, D+1: a função `verax_purge_tenant`, em lotes, e por fim a
 * linha do cliente). Vem no CE-16; até lá a célula recusa com `purge_unavailable`. O canal só o chama depois das
 * guardas e com o cliente já em `purging`; o `tenant.purged` sai depois que ele devolve.
 */
export interface TenantPurger {
  purgeTenant(tenantId: string, signal: AbortSignal): Promise<void>;
}

/**
 * Avisos da célula ao host depois que um cliente nasce (o sinal sem segredo que leva o host a criar o primeiro
 * administrador e escrever a senha no cofre do cliente, §5.1). O worker nunca vê a senha. A ligação com o host é do
 * pacote do nó em modo célula (CE-04); sem ela, nada é avisado.
 */
export interface CellTenantHooks {
  tenantCreated(tenant: { tenantId: string; slug: string }): Promise<void>;
}

/** O comando foi lido e não será aplicado: vai o `command.refused` com o código, e a mensagem é confirmada. */
export class CellCommandRefused extends Error {
  constructor(readonly code: CellRefusalCode) {
    super(`comando recusado: ${code}`);
  }
}

export type CellCommandOutcome =
  | { outcome: 'applied'; created?: boolean }
  | { outcome: 'duplicate' }
  | { outcome: 'stale' }
  | { outcome: 'refused'; code: CellRefusalCode };

export interface CellCommandsReport {
  received: number;
  applied: number;
  duplicate: number;
  stale: number;
  refused: number;
  invalid: number;
  foreign: number;
}

/** O que o consumidor usa do logger (o pino do worker; um dublê nos testes). Só códigos e ids, nunca o comando. */
export interface CellCommandsLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface CellCommandsOptions {
  cellId: string;
  /** `projects/<projeto>/subscriptions/<id>`: a assinatura de comandos da célula (só a VM da célula lê). */
  subscription: string;
  reader: PubsubReader;
  outbox: CellReportOutbox;
  logger: CellCommandsLogger;
  exporter?: TenantExporter | null;
  purger?: TenantPurger | null;
  hooks?: CellTenantHooks | null;
  audit?: AuditService;
  now?: () => Date;
}

/** O id do cliente daqui e o estado do canal dele, pelo id do plano de controle (null: a célula não o conhece). */
async function cellTenantOf(db: Prisma.TransactionClient, controlPlaneId: string) {
  return db.cellTenantState.findUnique({
    where: { controlPlaneId },
    select: {
      tenantId: true,
      generation: true,
      exportId: true,
      exportReadyAt: true,
      exportObject: true,
      exportSha256: true,
      exportBytes: true,
      collectionPausedAt: true,
      tenant: { select: { status: true, name: true, host: { select: { slug: true } } } },
    },
  });
}

/**
 * Trava os comandos de um cliente até o fim da transação: duas réplicas do worker nunca aplicam o mesmo cliente ao mesmo
 * tempo (a segunda espera e então vê a geração já aplicada).
 */
async function lockControlPlaneTenant(tx: Prisma.TransactionClient, controlPlaneId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:cell-tenant:${controlPlaneId}`}))`;
}

/**
 * Tarefa `cell-commands` (CE-05; só na célula): lê a assinatura de comandos do plano de controle e aplica cada um.
 *
 * - **Estrito.** A mensagem que não é do contrato (JSON inválido, campo a mais, outra versão) ou que é de outra célula é
 *   confirmada e descartada, com o motivo no log (só os caminhos dos campos, nunca os valores): repetir não a tornaria
 *   válida, e ela não pode travar a fila do cliente.
 * - **Uma transação por comando.** O `tenant.upsert` aplica o estado desejado inteiro (o cliente, o endereço, o plano,
 *   o estado, a identidade na nuvem e o resto do estado da célula) só pelas escritas de sistema (`assignTenantHost`,
 *   `writeTenantPlan`, `applyTenantLifecycleStatus`, `writeTenantCloudIdentity`), e grava o `tenant.applied` na caixa de
 *   saída na mesma transação; só então a mensagem é confirmada. Uma falha do banco desfaz tudo e a mensagem volta.
 * - **Geração.** Uma geração menor ou igual à aplicada não muda nada (a repetida devolve o `tenant.applied` de novo, para
 *   o plano de controle que perdeu o primeiro).
 * - **Recusa.** Um comando válido que não pode ser aplicado (subdomínio de outro cliente, transição fora da tabela,
 *   expurgo sem exportação) vira o relatório `command.refused`, e nada dele fica.
 *
 * As mensagens de cada cliente chegam em ordem (a chave de ordenação é o cliente); a execução para na primeira falha
 * do banco, sem confirmar o resto do lote, para não passar à frente de um comando do mesmo cliente.
 */
export class CellCommands {
  private readonly audit: AuditService;
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    private readonly options: CellCommandsOptions,
  ) {
    this.audit = options.audit ?? new AuditService();
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<CellCommandsReport> {
    const report: CellCommandsReport = {
      received: 0,
      applied: 0,
      duplicate: 0,
      stale: 0,
      refused: 0,
      invalid: 0,
      foreign: 0,
    };
    const { reader, subscription } = this.options;
    for (let pull = 0; pull < MAX_PULLS; pull += 1) {
      signal.throwIfAborted();
      const messages = await reader.pull(subscription, PULL_SIZE);
      if (messages.length === 0) break;
      for (const message of messages) {
        report.received += 1;
        const outcome = await this.handle(message, signal);
        report[outcome] += 1;
        await reader.acknowledge(subscription, [message.ackId]);
      }
    }
    return report;
  }

  /** Lê e aplica uma mensagem; devolve a contagem em que ela entra. Erro do banco sobe (a mensagem não é confirmada). */
  private async handle(
    message: PubsubMessage,
    signal: AbortSignal,
  ): Promise<'applied' | 'duplicate' | 'stale' | 'refused' | 'invalid' | 'foreign'> {
    const text = Buffer.from(message.data ?? '', 'base64').toString('utf8');
    const parsed = parseCellCommandJson(text);
    if (!parsed.ok) {
      this.options.logger.warn(
        {
          event: 'cell_command_invalid',
          messageId: message.messageId,
          reason: parsed.reason,
          issues: parsed.issues,
        },
        'comando fora do contrato descartado',
      );
      return 'invalid';
    }
    const command = parsed.value;
    if (command.cellId !== this.options.cellId) {
      this.options.logger.warn(
        { event: 'cell_command_foreign', messageId: message.messageId, commandId: command.commandId },
        'comando de outra célula descartado',
      );
      return 'foreign';
    }
    const result = await this.apply(command, signal);
    this.options.logger.info(
      {
        event: 'cell_command',
        kind: command.kind,
        commandId: command.commandId,
        tenantId: command.tenantId,
        outcome: result.outcome,
        ...(result.outcome === 'refused' && { code: result.code }),
      },
      'comando do plano de controle',
    );
    return result.outcome;
  }

  /** Aplica um comando já conferido pelo contrato (a parte que os testes chamam direto). */
  async apply(
    command: CellCommand,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CellCommandOutcome> {
    try {
      switch (command.kind) {
        case 'tenant.upsert':
          return await this.upsert(command);
        case 'tenant.export':
          return await this.exportTenant(command, signal);
        case 'tenant.purge':
          return await this.purge(command, signal);
        case 'tenant.collection_pause':
          return await this.pause(command);
      }
    } catch (error) {
      const code = refusalCodeOf(error);
      if (code === null) throw error;
      await this.prisma.$transaction((tx) =>
        this.options.outbox.enqueue(tx, {
          kind: 'command.refused',
          tenantId: command.tenantId,
          commandId: command.commandId,
          command: command.kind,
          code,
        }),
      );
      return { outcome: 'refused', code };
    }
  }

  private async upsert(command: UpsertCommand): Promise<CellCommandOutcome> {
    const { state } = command;
    const outcome = await this.prisma.$transaction(async (tx): Promise<CellCommandOutcome> => {
      await lockControlPlaneTenant(tx, command.tenantId);
      const current = await cellTenantOf(tx, command.tenantId);
      if (current !== null && command.generation <= current.generation) {
        if (command.generation < current.generation) return { outcome: 'stale' };
        await this.options.outbox.enqueue(tx, {
          kind: 'tenant.applied',
          tenantId: command.tenantId,
          generation: current.generation,
        });
        return { outcome: 'duplicate' };
      }
      if (current?.tenant.status === 'purging') throw new CellCommandRefused('tenant_purging');
      // O cliente novo nasce `active`; o estado pedido vem pela transição, como qualquer outro (e vai para a trilha).
      const tenantId =
        current?.tenantId ??
        (await tx.tenant.create({ data: { name: state.name }, select: { id: true } })).id;
      if (current !== null && current.tenant.name !== state.name) {
        await tx.tenant.update({ where: { id: tenantId }, data: { name: state.name }, select: { id: true } });
      }
      await assignTenantHost(tx, tenantId, state.slug);
      await writeTenantPlan(tx, tenantId, state.plan, 'control_plane');
      await applyTenantLifecycleStatus(tx, tenantId, state.status, {
        actorId: CONTROL_PLANE_ACTOR,
        audit: this.audit,
      });
      const identityBefore = await writeTenantCloudIdentity(tx, tenantId, state.cloudIdentity);
      const desired = storedDesiredOf(state) as unknown as Prisma.InputJsonValue;
      const appliedAt = this.now();
      await tx.cellTenantState.upsert({
        where: { tenantId },
        create: {
          tenantId,
          controlPlaneId: command.tenantId,
          generation: command.generation,
          appliedAt,
          desired,
        },
        update: { generation: command.generation, appliedAt, desired },
        select: { tenantId: true },
      });
      await this.audit.write(tx, {
        actor: { type: 'system', id: CONTROL_PLANE_ACTOR, tenantId },
        action: 'tenant.cell_state_applied',
        outcome: 'success',
        resourceType: 'tenant',
        resourceId: tenantId,
        before:
          current === null
            ? null
            : { generation: current.generation, cloudIdentity: identityBefore?.saUniqueId },
        after: {
          generation: command.generation,
          status: state.status,
          planId: state.plan.planId,
          cloudIdentity: state.cloudIdentity.saUniqueId,
        },
      });
      await this.options.outbox.enqueue(tx, {
        kind: 'tenant.applied',
        tenantId: command.tenantId,
        generation: command.generation,
      });
      return { outcome: 'applied', created: current === null };
    });
    if (outcome.outcome === 'applied' && outcome.created === true && this.options.hooks) {
      const created = await this.prisma.cellTenantState.findUniqueOrThrow({
        where: { controlPlaneId: command.tenantId },
        select: { tenantId: true },
      });
      await this.options.hooks.tenantCreated({ tenantId: created.tenantId, slug: state.slug });
    }
    return outcome;
  }

  private async exportTenant(command: ExportCommand, signal: AbortSignal): Promise<CellCommandOutcome> {
    const current = await cellTenantOf(this.prisma, command.tenantId);
    if (current === null) throw new CellCommandRefused('tenant_unknown');
    if (current.tenant.status === 'purging') throw new CellCommandRefused('tenant_purging');
    if (current.tenant.status !== 'canceled') throw new CellCommandRefused('export_not_canceled');
    if (
      current.exportId === command.exportId &&
      current.exportObject !== null &&
      current.exportSha256 !== null &&
      current.exportBytes !== null
    ) {
      // O mesmo pedido de novo: o arquivo já está no bucket. Repete o relatório, sem exportar outra vez.
      const repeated = {
        exportId: command.exportId,
        object: current.exportObject,
        sha256: current.exportSha256,
        bytes: Number(current.exportBytes),
      };
      await this.prisma.$transaction((tx) =>
        this.options.outbox.enqueueForTenant(tx, current.tenantId, { kind: 'export.ready', ...repeated }),
      );
      return { outcome: 'duplicate' };
    }
    const exporter = this.options.exporter;
    if (!exporter) throw new CellCommandRefused('export_unavailable');
    const result = await exporter.exportTenant(
      { tenantId: current.tenantId, controlPlaneId: command.tenantId, exportId: command.exportId },
      signal,
    );
    await this.prisma.$transaction(async (tx) => {
      await recordTenantExport(tx, this.options.outbox, current.tenantId, result, this.now());
      await this.audit.write(tx, {
        actor: { type: 'system', id: CONTROL_PLANE_ACTOR, tenantId: current.tenantId },
        action: 'tenant.cell_export',
        outcome: 'success',
        resourceType: 'tenant',
        resourceId: current.tenantId,
        after: { exportId: result.exportId, bytes: result.bytes },
      });
    });
    return { outcome: 'applied' };
  }

  /**
   * As guardas do expurgo (§3.7), nesta ordem: a confirmação é o subdomínio do cliente; o cliente está cancelado (ou já
   * em expurgo, a repetição); a exportação foi gravada. Só então o cliente vai a `purging` (com a trilha) e o expurgador
   * apaga os dados. Sem expurgador (até o CE-16), a recusa vem depois das guardas e o estado não muda.
   */
  private async purge(command: PurgeCommand, signal: AbortSignal): Promise<CellCommandOutcome> {
    const purger = this.options.purger;
    const tenantId = await this.prisma.$transaction(async (tx) => {
      await lockControlPlaneTenant(tx, command.tenantId);
      const current = await cellTenantOf(tx, command.tenantId);
      if (current === null) throw new CellCommandRefused('tenant_unknown');
      if (current.tenant.host?.slug !== command.confirmSlug)
        throw new CellCommandRefused('purge_slug_mismatch');
      const status = current.tenant.status;
      if (status !== 'canceled' && status !== 'purging') throw new CellCommandRefused('purge_not_canceled');
      if (current.exportReadyAt === null) throw new CellCommandRefused('purge_export_missing');
      if (!purger) throw new CellCommandRefused('purge_unavailable');
      await applyTenantLifecycleStatus(tx, current.tenantId, 'purging', {
        actorId: CONTROL_PLANE_ACTOR,
        audit: this.audit,
      });
      return current.tenantId;
    });
    if (!purger) throw new CellCommandRefused('purge_unavailable');
    await purger.purgeTenant(tenantId, signal);
    // A linha do cliente (e o mapa dele) já saiu: o relatório leva o id do plano de controle que veio no comando.
    await this.prisma.$transaction((tx) =>
      this.options.outbox.enqueue(tx, {
        kind: 'tenant.purged',
        tenantId: command.tenantId,
        purgeId: command.purgeId,
      }),
    );
    return { outcome: 'applied' };
  }

  private async pause(command: PauseCommand): Promise<CellCommandOutcome> {
    const valid = tenantCollectionPauseCommandSchema.parse(command);
    return this.prisma.$transaction(async (tx) => {
      await lockControlPlaneTenant(tx, valid.tenantId);
      const current = await cellTenantOf(tx, valid.tenantId);
      if (current === null) throw new CellCommandRefused('tenant_unknown');
      if (current.tenant.status === 'purging') throw new CellCommandRefused('tenant_purging');
      if ((current.collectionPausedAt !== null) === valid.paused) return { outcome: 'duplicate' };
      await tx.cellTenantState.update({
        where: { tenantId: current.tenantId },
        data: valid.paused
          ? { collectionPausedAt: this.now(), collectionPauseReason: valid.reason ?? null }
          : { collectionPausedAt: null, collectionPauseReason: null },
        select: { tenantId: true },
      });
      await this.audit.write(tx, {
        actor: { type: 'system', id: CONTROL_PLANE_ACTOR, tenantId: current.tenantId },
        action: valid.paused ? 'tenant.cell_collection_pause' : 'tenant.cell_collection_resume',
        outcome: 'success',
        resourceType: 'tenant',
        resourceId: current.tenantId,
        before: { paused: !valid.paused },
        after: { paused: valid.paused, ...(valid.reason !== undefined && { reason: valid.reason }) },
      });
      return { outcome: 'applied' };
    });
  }
}

/** O código da recusa de um erro conhecido das escritas de sistema; null para qualquer outro (que sobe). */
function refusalCodeOf(error: unknown): CellRefusalCode | null {
  if (error instanceof CellCommandRefused) return error.code;
  if (error instanceof TenantHostConflict) return 'slug_conflict';
  if (error instanceof TenantCloudIdentityConflict) return 'identity_conflict';
  if (error instanceof TenantTransitionRefused) return 'transition_refused';
  return null;
}
