import { Inject, Injectable } from '@nestjs/common';
import { type CellReport, cellReportTenantId, parseCellReportJson } from '@verax/shared';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentStore,
  type DocumentTransaction,
  parseDocument,
} from '../firestore/document-store.js';
import { type Tenant, tenantSchema } from '../tenants/tenant.schema.js';
import {
  CELL_REPORT_RETENTION_DAYS,
  type CellRecord,
  type CellReportOutcome,
  type CellReportRefusal,
  cellReportRecordSchema,
} from './cell.schema.js';
import { CellStore } from './cell-store.js';

/**
 * O corpo de uma entrega push do Pub/Sub (https://cloud.google.com/pubsub/docs/push). Não é estrito: o Pub/Sub pode
 * acrescentar campos (`deliveryAttempt`, `publishTime`). O que importa vem conferido: a assinatura e a mensagem.
 */
export const pushEnvelopeSchema = z.object({
  subscription: z.string().max(320),
  message: z.object({
    data: z.string().max(400_000),
    messageId: z.string().min(1).max(256),
  }),
});
export type PushEnvelope = z.infer<typeof pushEnvelopeSchema>;

/** Por que a entrega em si foi recusada (não chega a ser lida): o Pub/Sub repete, e o log diz o motivo. */
export type CellDeliveryRefusal = 'cell_unknown' | 'push_account_mismatch' | 'subscription_mismatch';

export type CellDeliveryResult =
  | { delivered: false; reason: CellDeliveryRefusal }
  | { delivered: true; outcome: CellReportOutcome | 'duplicate'; code?: CellReportRefusal };

/** O teto de um texto base64 que decodifica dentro do teto do contrato. */
const MAX_BASE64 = 400_000;

/**
 * Recebe os relatórios das células (CE-06), entregues pela assinatura push de cada uma em
 * `POST /internal/cells/:cellId/reports` (a guarda `cell-push` já conferiu o token OIDC de uma das contas de push).
 *
 * As conferências, nesta ordem:
 * 1. A célula está no registro, o token é o da conta de push DELA (`cells/{id}.pushServiceAccount`) e a entrega veio da
 *    assinatura dela (`cells/{id}.reportsSubscription`). Senão, 403 sem ler o relatório: a conta de push de uma célula
 *    não fala pela rota de outra (e o IAM do tópico prova que só a VM daquela célula publicou nele).
 * 2. O relatório é do contrato (estrito) e diz ser desta célula.
 * 3. Todo cliente citado tem `placement.cellId` igual a esta célula: **uma célula comprometida só mente sobre os
 *    próprios clientes**. Um relatório sobre cliente de outra célula, ou que não existe, é recusado e auditado.
 * 4. Idempotência: `cellReports/{célula}_{reportId}` é criado na mesma transação do efeito; a repetição não muda nada.
 *
 * Os passos 2 e 3 recusam confirmando a entrega (200): repetir não mudaria o resultado, e a mensagem não pode ficar
 * voltando por 7 dias. A recusa fica registrada (`cellReports` e a auditoria `cell.report_refused`), e o log leva só a
 * célula, o tipo, o código e os ids, nunca o relatório.
 *
 * Tratados aqui: `tenant.applied` (a geração aplicada, só até a mandada), `tenant.status` (os agregados, só o mais novo)
 * e `command.refused` (a última recusa, para o console e o provisionamento). Os outros ficam guardados inteiros
 * (`stored`) para os PRs que os tratam.
 */
@Injectable()
export class CellReportsService {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cells: CellStore,
    private readonly audit: AuditService,
    @InjectPinoLogger(CellReportsService.name) private readonly logger: PinoLogger,
  ) {}

  /** `caller` é o e-mail do token que a guarda conferiu (uma das contas de push). */
  async receive(cellId: string, push: PushEnvelope, caller: string | undefined): Promise<CellDeliveryResult> {
    const cell = await this.cells.get(cellId);
    if (cell === undefined) {
      this.logger.warn(
        { event: 'cell_report_refused', reason: 'cell_unknown' },
        'entrega de célula fora do registro',
      );
      return { delivered: false, reason: 'cell_unknown' };
    }
    if (caller === undefined || caller !== cell.pushServiceAccount.toLowerCase()) {
      this.logger.warn(
        { event: 'cell_report_refused', cellId, reason: 'push_account_mismatch' },
        'entrega com a conta de push de outra célula',
      );
      return { delivered: false, reason: 'push_account_mismatch' };
    }
    if (push.subscription !== cell.reportsSubscription) {
      this.logger.warn(
        { event: 'cell_report_refused', cellId, reason: 'subscription_mismatch' },
        'entrega de outra assinatura',
      );
      return { delivered: false, reason: 'subscription_mismatch' };
    }
    const { messageId, data } = push.message;
    const text =
      data.length <= MAX_BASE64 && /^[A-Za-z0-9+/]*={0,2}$/.test(data)
        ? Buffer.from(data, 'base64').toString('utf8')
        : '';
    const parsed = parseCellReportJson(text);
    if (!parsed.ok) {
      this.logger.warn(
        {
          event: 'cell_report_refused',
          cellId,
          code: 'invalid_report',
          reason: parsed.reason,
          issues: parsed.issues,
        },
        'relatório fora do contrato',
      );
      await this.refuseUnread(cell, messageId, 'invalid_report');
      return { delivered: true, outcome: 'refused', code: 'invalid_report' };
    }
    return this.apply(cell, parsed.value, messageId);
  }

  /** Registra a recusa de uma entrega que nem chegou a ser um relatório (sem id): só a auditoria. */
  private async refuseUnread(cell: CellRecord, messageId: string, code: CellReportRefusal): Promise<void> {
    await this.audit.write({
      actor: 'system',
      action: 'cell.report_refused',
      details: { cellId: cell.id, code, messageId },
    });
  }

  private async apply(cell: CellRecord, report: CellReport, messageId: string): Promise<CellDeliveryResult> {
    const tenantId = cellReportTenantId(report);
    const recordId = `${cell.id}_${report.reportId}`;
    const result = await this.store.runTransaction(async (tx): Promise<CellDeliveryResult> => {
      if ((await tx.get(COLLECTIONS.cellReports, recordId)) !== undefined) {
        return { delivered: true, outcome: 'duplicate' };
      }
      const tenantData = tenantId === null ? undefined : await tx.get(COLLECTIONS.tenants, tenantId);
      const tenant =
        tenantData === undefined || tenantId === null
          ? undefined
          : parseDocument(tenantSchema, COLLECTIONS.tenants, tenantId, tenantData);
      const now = this.clock.now();
      let decision: { outcome: CellReportOutcome; code?: CellReportRefusal; tenant?: Tenant };
      if (report.cellId !== cell.id) {
        decision = { outcome: 'refused', code: 'cell_mismatch' };
      } else if (tenantId !== null && tenant?.placement?.cellId !== cell.id) {
        decision = { outcome: 'refused', code: 'foreign_tenant' };
      } else {
        decision = this.decide(report, tenant, now);
      }
      if (decision.tenant !== undefined && tenantId !== null) {
        tx.set(COLLECTIONS.tenants, tenantId, tenantSchema.parse({ ...decision.tenant, updatedAt: now }));
      }
      this.record(tx, recordId, cell.id, report, messageId, decision, now);
      if (decision.outcome === 'refused') {
        this.audit.record(tx, {
          actor: 'system',
          action: 'cell.report_refused',
          // Na trilha do cliente só quando ele é desta célula; o cliente citado por outra célula não ganha registro dela.
          ...(decision.code !== 'foreign_tenant' && decision.code !== 'cell_mismatch' && tenantId !== null
            ? { tenantId }
            : {}),
          details: { cellId: cell.id, kind: report.kind, code: decision.code, reportId: report.reportId },
        });
      }
      return {
        delivered: true,
        outcome: decision.outcome,
        ...(decision.code !== undefined && { code: decision.code }),
      };
    });
    const level = result.delivered && result.outcome === 'refused' ? 'warn' : 'info';
    this.logger[level](
      {
        event: 'cell_report',
        cellId: cell.id,
        kind: report.kind,
        reportId: report.reportId,
        ...(tenantId !== null && { tenantId }),
        ...(result.delivered && { outcome: result.outcome }),
        ...(result.delivered && result.code !== undefined && { code: result.code }),
      },
      'relatório da célula',
    );
    return result;
  }

  /** O efeito de um relatório de cliente desta célula (ou do `cell.status`), sem gravar nada. */
  private decide(
    report: CellReport,
    tenant: Tenant | undefined,
    now: Date,
  ): { outcome: CellReportOutcome; code?: CellReportRefusal; tenant?: Tenant } {
    if (tenant === undefined) return { outcome: 'stored' };
    const channel = tenant.cell ?? { desiredGeneration: 0 };
    switch (report.kind) {
      case 'tenant.applied': {
        // Uma geração que o plano de controle nunca mandou: a célula está mentindo ou fora de sincronia.
        if (report.generation > channel.desiredGeneration)
          return { outcome: 'refused', code: 'generation_unknown' };
        if (channel.appliedGeneration !== undefined && channel.appliedGeneration >= report.generation) {
          return { outcome: 'ignored' };
        }
        return {
          outcome: 'applied',
          tenant: { ...tenant, cell: { ...channel, appliedGeneration: report.generation, appliedAt: now } },
        };
      }
      case 'tenant.status': {
        const emittedAt = new Date(report.emittedAt);
        if (channel.statusReportedAt !== undefined && channel.statusReportedAt >= emittedAt) {
          return { outcome: 'ignored' };
        }
        return {
          outcome: 'applied',
          tenant: {
            ...tenant,
            cell: {
              ...channel,
              accountsConnected: report.accountsConnected,
              lastEventAt: report.lastEventAt === null ? null : new Date(report.lastEventAt),
              statusReportedAt: emittedAt,
            },
          },
        };
      }
      case 'command.refused':
        return {
          outcome: 'applied',
          tenant: {
            ...tenant,
            cell: {
              ...channel,
              lastRefusal: {
                commandId: report.commandId,
                command: report.command,
                code: report.code,
                at: now,
              },
            },
          },
        };
      default:
        return { outcome: 'stored' };
    }
  }

  private record(
    tx: DocumentTransaction,
    recordId: string,
    cellId: string,
    report: CellReport,
    messageId: string,
    decision: { outcome: CellReportOutcome; code?: CellReportRefusal },
    now: Date,
  ): void {
    const tenantId = cellReportTenantId(report);
    tx.create(
      COLLECTIONS.cellReports,
      recordId,
      cellReportRecordSchema.parse({
        cellId,
        reportId: report.reportId,
        kind: report.kind,
        ...(tenantId !== null && { tenantId }),
        outcome: decision.outcome,
        ...(decision.code !== undefined && { code: decision.code }),
        ...(decision.outcome === 'stored' && { report: { ...report } }),
        messageId,
        receivedAt: now,
        expiresAt: new Date(now.getTime() + CELL_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000),
      }),
    );
  }
}
