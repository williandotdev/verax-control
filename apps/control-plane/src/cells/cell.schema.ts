import {
  CELL_COMMAND_KINDS,
  CELL_GENERATION_MAX,
  CELL_REFUSAL_CODES,
  CELL_REPORT_KINDS,
  cellIdSchema,
  isPubsubTopicName,
} from '@verax/shared';
import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';

/** `projects/<projeto>/subscriptions/<id>`, o mesmo subconjunto das regras da GCP do lado da célula. */
const subscriptionNameSchema = z
  .string()
  .max(320)
  .regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._-]{2,254}$/, {
    error: 'assinatura inválida',
  });
const topicNameSchema = z.string().max(320).refine(isPubsubTopicName, { error: 'tópico inválido' });

/** Os estados de uma célula no registro (§5.4): só `open` recebe cliente novo (a escolha da célula é do CE-15). */
export const CELL_STATES = ['open', 'draining', 'closed'] as const;

const capacitySchema = z.strictObject({
  maxContractedGbPerDay: z.number().int().min(0).max(1_000_000),
  maxTenants: z.number().int().min(0).max(10_000),
  maxAwsAccounts: z.number().int().min(0).max(100_000),
});

/**
 * Documento `cells/{cellId}` (CE-06; §5.4 do desenho): o registro de cada célula, gravado pelo responsável (no console,
 * CE-15). Aqui ficam os nomes do canal que o plano de controle confere e usa (a saída `cell` do ambiente da célula): o
 * tópico de comandos (onde só o cp-worker publica), a assinatura push dos relatórios e a conta que assina o token dela
 * (a entrega em `POST /internal/cells/:cellId/reports` só vale com as duas desta célula). A capacidade, a reserva e as medições são da escolha da célula (CE-15) e chegam
 * opcionais. Estrito, como o documento do cliente.
 */
export const cellSchema = z.strictObject({
  state: z.enum(CELL_STATES),
  region: z.string().regex(/^[a-z]+-[a-z]+[0-9]$/),
  project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  natIps: z.array(z.ipv4()).min(1).max(4),
  tunnelId: z.string().max(64).optional(),
  commandsTopic: topicNameSchema,
  reportsSubscription: subscriptionNameSchema,
  /**
   * A conta que assina o token de cada entrega push desta célula (`vxc-<célula>-push`, do ambiente da célula): a rota
   * dos relatórios só aceita esta célula com o token desta conta.
   */
  pushServiceAccount: z
    .string()
    .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/, {
      error: 'conta de serviço inválida',
    }),
  release: z.string().max(64).optional(),
  capacity: capacitySchema.optional(),
  reserved: capacitySchema.optional(),
  measured: z
    .strictObject({
      p95DailyGb: z.number().min(0).max(1_000_000),
      cpuP95: z.number().min(0).max(100),
      wodleLagP95: z
        .number()
        .int()
        .min(0)
        .max(31 * 24 * 3600),
      at: z.date(),
    })
    .optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Cell = z.infer<typeof cellSchema>;
export interface CellRecord extends Cell {
  id: string;
}

/** O que aconteceu com um relatório recebido. */
export const CELL_REPORT_OUTCOMES = ['applied', 'ignored', 'stored', 'refused'] as const;
export type CellReportOutcome = (typeof CELL_REPORT_OUTCOMES)[number];

/**
 * Por que um relatório entregue pela assinatura certa foi recusado (confirmado ao Pub/Sub, sem efeito):
 * - `invalid_report`: fora do contrato (o JSON, um campo a mais, outra versão);
 * - `cell_mismatch`: o relatório diz ser de outra célula;
 * - `foreign_tenant`: o cliente citado não existe ou não está nesta célula (a célula só fala dos próprios clientes);
 * - `generation_unknown`: o `tenant.applied` de uma geração que o plano de controle nunca mandou.
 */
export const CELL_REPORT_REFUSALS = [
  'invalid_report',
  'cell_mismatch',
  'foreign_tenant',
  'generation_unknown',
] as const;
export type CellReportRefusal = (typeof CELL_REPORT_REFUSALS)[number];

/**
 * Documento `cellReports/{cellId}_{reportId}` (CE-06): a idempotência da entrega (o Pub/Sub entrega ao menos uma vez) e
 * o registro do que chegou. Os tipos que ainda não têm tratamento (`usage.daily`, `export.ready`, `tenant.purged`,
 * `franchise.requested`, `gcp_source.request`, `cell.status`, `command.refused`) ficam aqui inteiros, `stored`, para os
 * PRs que os tratam (CE-08, CE-09, CE-15, CE-16, CE-19). O relatório só leva ids e agregados, nunca dado pessoal. Vida de
 * 90 dias (TTL em `expiresAt`).
 */
export const cellReportRecordSchema = z.strictObject({
  cellId: cellIdSchema,
  reportId: z.uuid(),
  kind: z.enum(CELL_REPORT_KINDS).optional(),
  tenantId: z.string().regex(ULID_PATTERN).optional(),
  outcome: z.enum(CELL_REPORT_OUTCOMES),
  code: z.enum(CELL_REPORT_REFUSALS).optional(),
  /** O relatório como chegou (só os `stored`, que um PR seguinte vai tratar). */
  report: z.record(z.string(), z.unknown()).optional(),
  messageId: z.string().max(256),
  receivedAt: z.date(),
  expiresAt: z.date(),
});
export type CellReportRecord = z.infer<typeof cellReportRecordSchema>;

/** Retenção dos relatórios recebidos. */
export const CELL_REPORT_RETENTION_DAYS = 90;

/**
 * `tenants/{id}.placement` (CE-06; a escolha é do CE-15): onde o cliente roda. Só os clientes da célula têm o campo, e
 * ele nunca muda sozinho. É por ele que o plano de controle confere que um relatório cita só os clientes daquela célula.
 */
export const tenantPlacementSchema = z.strictObject({
  kind: z.literal('cell'),
  cellId: cellIdSchema,
});
export type TenantPlacement = z.infer<typeof tenantPlacementSchema>;

/**
 * `tenants/{id}.cell` (CE-06): o canal de um cliente da célula. `desiredGeneration` é a última geração do `tenant.upsert`
 * mandada; `appliedGeneration`, a maior que a célula disse ter aplicado (o provisionamento espera por ela, CE-15). Os
 * agregados do `tenant.status` substituem, na célula, os guest attributes do nó dedicado (a ativação os lê).
 */
export const tenantCellChannelSchema = z.strictObject({
  desiredGeneration: z.number().int().min(0).max(CELL_GENERATION_MAX),
  lastCommandId: z.string().regex(ULID_PATTERN).optional(),
  lastCommandKind: z.enum(CELL_COMMAND_KINDS).optional(),
  appliedGeneration: z.number().int().min(1).max(CELL_GENERATION_MAX).optional(),
  appliedAt: z.date().optional(),
  accountsConnected: z.number().int().min(0).max(10_000).optional(),
  lastEventAt: z.date().nullable().optional(),
  /** O `emittedAt` do último `tenant.status` aplicado: um mais velho que chega depois não volta o estado. */
  statusReportedAt: z.date().optional(),
  /** A última recusa de comando relatada pela célula (o código do contrato), para o console e o provisionamento. */
  lastRefusal: z
    .strictObject({
      commandId: z.string().regex(ULID_PATTERN),
      command: z.enum(CELL_COMMAND_KINDS),
      code: z.enum(CELL_REFUSAL_CODES),
      at: z.date(),
    })
    .optional(),
});
export type TenantCellChannel = z.infer<typeof tenantCellChannelSchema>;
