import { Inject, Injectable } from '@nestjs/common';
import {
  CELL_GENERATION_MAX,
  CELL_PROTOCOL_VERSION,
  type CellCommand,
  type CellTenantState,
  cellMessageJson,
} from '@verax/shared';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import { DOCUMENT_STORE, type DocumentStore, parseDocument } from '../firestore/document-store.js';
import { TenantNotFoundError } from '../tenants/tenant-store.js';
import { tenantSchema } from '../tenants/tenant.schema.js';
import { CELL_COMMAND_SINK, type CellCommandSink } from './cell-pubsub.js';
import { CellStore } from './cell-store.js';

/** O cliente não está numa célula (sem `placement`): o canal não fala com ele. */
export class TenantNotInCellError extends Error {
  constructor() {
    super('o cliente não está numa célula');
    this.name = 'TenantNotInCellError';
  }
}

/** O corpo de um comando pontual (sem o envelope, que o publicador preenche). */
export type CellPointCommand =
  | { kind: 'tenant.export'; exportId: string }
  | { kind: 'tenant.purge'; purgeId: string; confirmSlug: string }
  | { kind: 'tenant.collection_pause'; paused: true; reason: 'runaway_volume' | 'owner' }
  | { kind: 'tenant.collection_pause'; paused: false };

export interface PublishedCommand {
  commandId: string;
  cellId: string;
  generation?: number;
  messageId: string;
}

/**
 * Quem manda comandos às células (CE-06): o `tenant.upsert` com o estado desejado inteiro e os comandos pontuais
 * (`tenant.export`, `tenant.purge`, `tenant.collection_pause`). Os passos do provisionamento e do ciclo de vida na célula
 * (CE-15 e CE-16) chamam daqui; o canal em si não decide nada do cliente.
 *
 * - A célula de destino sai sempre de `tenants/{id}.placement`, nunca de quem chama: um comando nunca vai para outra
 *   célula.
 * - A geração do `tenant.upsert` sobe numa transação do Firestore (`cell.desiredGeneration`), junto com a auditoria,
 *   antes de publicar. Se a publicação falha, a geração fica gasta e a próxima tentativa usa outra maior: a célula só
 *   exige que cresça, não que seja contígua.
 * - O comando é conferido inteiro pelo contrato antes de sair (`cellMessageJson`), e publicado com a chave de
 *   ordenação = o id do cliente (os comandos de um cliente chegam em ordem; os de clientes diferentes, não importa).
 */
@Injectable()
export class CellCommandPublisher {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly cells: CellStore,
    private readonly audit: AuditService,
    @Inject(CELL_COMMAND_SINK) private readonly sink: CellCommandSink,
  ) {}

  /** Manda o estado desejado inteiro, com a próxima geração. `actor` é quem pediu, para a auditoria. */
  async upsert(tenantId: string, state: CellTenantState, actor: string): Promise<PublishedCommand> {
    const commandId = newUlid(this.clock.now().getTime());
    const { cellId, generation } = await this.store.runTransaction(async (tx) => {
      const tenant = await this.readTenant(tx, tenantId);
      if (tenant.placement === undefined) throw new TenantNotInCellError();
      const next = (tenant.cell?.desiredGeneration ?? 0) + 1;
      if (next > CELL_GENERATION_MAX) throw new RangeError('geração do cliente esgotada');
      const now = this.clock.now();
      tx.set(
        COLLECTIONS.tenants,
        tenantId,
        tenantSchema.parse({
          ...tenant,
          cell: {
            ...tenant.cell,
            desiredGeneration: next,
            lastCommandId: commandId,
            lastCommandKind: 'tenant.upsert',
          },
          updatedAt: now,
        }),
      );
      this.audit.record(tx, {
        actor,
        action: 'cell.command_sent',
        tenantId,
        details: { cellId: tenant.placement.cellId, kind: 'tenant.upsert', commandId, generation: next },
      });
      return { cellId: tenant.placement.cellId, generation: next };
    });
    const command: CellCommand = {
      ...this.envelope(commandId, cellId, tenantId),
      kind: 'tenant.upsert',
      generation,
      state,
    };
    const messageId = await this.send(command);
    return { commandId, cellId, generation, messageId };
  }

  /** Publica um comando já montado no tópico de comandos da célula dele (o registro `cells/{id}`). */
  private async send(command: CellCommand): Promise<string> {
    const cell = await this.cells.require(command.cellId);
    const json = cellMessageJson(command);
    return this.sink.publish(cell.commandsTopic, {
      data: Buffer.from(json, 'utf8').toString('base64'),
      orderingKey: command.tenantId,
      attributes: { kind: command.kind, v: String(CELL_PROTOCOL_VERSION) },
    });
  }

  /** Um comando pontual (exportação, expurgo, pausa da coleta), com a trilha antes de publicar. */
  async point(tenantId: string, body: CellPointCommand, actor: string): Promise<PublishedCommand> {
    const commandId = newUlid(this.clock.now().getTime());
    const cellId = await this.store.runTransaction(async (tx) => {
      const tenant = await this.readTenant(tx, tenantId);
      if (tenant.placement === undefined) throw new TenantNotInCellError();
      tx.set(
        COLLECTIONS.tenants,
        tenantId,
        tenantSchema.parse({
          ...tenant,
          cell: {
            desiredGeneration: 0,
            ...tenant.cell,
            lastCommandId: commandId,
            lastCommandKind: body.kind,
          },
          updatedAt: this.clock.now(),
        }),
      );
      this.audit.record(tx, {
        actor,
        action: 'cell.command_sent',
        tenantId,
        details: { cellId: tenant.placement.cellId, kind: body.kind, commandId },
      });
      return tenant.placement.cellId;
    });
    const messageId = await this.send({
      ...this.envelope(commandId, cellId, tenantId),
      ...body,
    });
    return { commandId, cellId, messageId };
  }

  private envelope(commandId: string, cellId: string, tenantId: string) {
    return {
      v: CELL_PROTOCOL_VERSION,
      commandId,
      cellId,
      tenantId,
      issuedAt: this.clock.now().toISOString(),
    } as const;
  }

  private async readTenant(tx: Pick<DocumentStore, 'get'>, tenantId: string) {
    const data = await tx.get(COLLECTIONS.tenants, tenantId);
    if (data === undefined) throw new TenantNotFoundError(tenantId);
    return parseDocument(tenantSchema, COLLECTIONS.tenants, tenantId, data);
  }
}
