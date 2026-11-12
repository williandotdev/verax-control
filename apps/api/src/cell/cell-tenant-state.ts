import {
  type CellTenantState as CellDesiredState,
  cellBilledCycleSchema,
  cellBillingPeriodSchema,
  cellFranchiseEntrySchema,
  cellGcpSourceSchema,
  cellUnitPricesSchema,
} from '@verax/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import type { CellReportOutbox } from './cell-report-outbox.js';

/**
 * O que o `tenant.upsert` guarda em `CellTenantState.desired`: a parte do estado desejado que não tem tabela própria
 * (o subdomínio vai para `TenantHost`, o plano para `TenantPlan`, o estado para `Tenant.status`, a identidade para
 * `TenantCloudIdentity`). Conferido de novo em toda leitura, como um documento do Firestore no plano de controle.
 *
 * Quem lê: o contador da franquia no painel (CE-10: a franquia agendada, o ciclo, o último ciclo cobrado e os preços do
 * diálogo), a medição (CE-09: o ciclo), o painel "Conectar AWS" (CE-11: os IPs da célula) e as fontes da GCP (CE-08).
 */
export const cellStoredDesiredSchema = z.strictObject({
  franchiseSchedule: z.array(cellFranchiseEntrySchema).max(400),
  billingPeriod: cellBillingPeriodSchema.nullable(),
  natIps: z.array(z.ipv4()).min(1).max(4),
  gcpSources: z.array(cellGcpSourceSchema).max(100),
  lastBilledCycle: cellBilledCycleSchema.nullable(),
  unitPrices: cellUnitPricesSchema.nullable(),
});
export type CellStoredDesired = z.infer<typeof cellStoredDesiredSchema>;

/** A parte guardada em `desired` do estado desejado de um comando. */
export function storedDesiredOf(state: CellDesiredState): CellStoredDesired {
  return cellStoredDesiredSchema.parse({
    franchiseSchedule: state.franchiseSchedule,
    billingPeriod: state.billingPeriod,
    natIps: state.natIps,
    gcpSources: state.gcpSources,
    lastBilledCycle: state.lastBilledCycle,
    unitPrices: state.unitPrices,
  });
}

/** O estado da célula de um cliente, como as outras partes da célula o leem. */
export interface CellTenantView {
  controlPlaneId: string;
  generation: number;
  appliedAt: Date;
  desired: CellStoredDesired;
  collectionPausedAt: Date | null;
}

/**
 * O estado da célula de um cliente (null fora da célula ou antes do primeiro comando). Lê pelo cliente base ou pelo
 * escopo do cliente (só leitura): o painel do cliente vê o próprio estado.
 */
export async function readCellTenantState(
  db: Pick<Prisma.TransactionClient, 'cellTenantState'>,
  tenantId: string,
): Promise<CellTenantView | null> {
  const row = await db.cellTenantState.findUnique({
    where: { tenantId },
    select: {
      controlPlaneId: true,
      generation: true,
      appliedAt: true,
      desired: true,
      collectionPausedAt: true,
    },
  });
  if (row === null) return null;
  return { ...row, desired: cellStoredDesiredSchema.parse(row.desired) };
}

/** A exportação de um cliente, como o bucket de exportações da célula a guardou. */
export interface TenantExportResult {
  exportId: string;
  /** O objeto no bucket: `<célula>/<cliente do plano de controle>/<arquivo>.tar.gz`. */
  object: string;
  sha256: string;
  bytes: number;
}

/**
 * Registra a exportação gravada (é o que libera o `tenant.purge`) e, na mesma transação, o relatório `export.ready`. É
 * a fronteira entre o canal e o exportador (CE-16): o exportador grava o arquivo no bucket e, só depois, chama isto.
 */
export async function recordTenantExport(
  db: Prisma.TransactionClient,
  outbox: CellReportOutbox,
  tenantId: string,
  result: TenantExportResult,
  at: Date,
): Promise<void> {
  await db.cellTenantState.update({
    where: { tenantId },
    data: {
      exportId: result.exportId,
      exportReadyAt: at,
      exportObject: result.object,
      exportSha256: result.sha256,
      exportBytes: BigInt(result.bytes),
    },
    select: { tenantId: true },
  });
  await outbox.enqueueForTenant(db, tenantId, {
    kind: 'export.ready',
    exportId: result.exportId,
    object: result.object,
    sha256: result.sha256,
    bytes: result.bytes,
  });
}
