import { TENANT_LIFECYCLE_STATUSES, type TenantLifecycleStatus, type TenantStatus } from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** O estado é do ciclo de vida da contratação (CE-02): só o sistema grava (`tenant-lifecycle.ts`). */
export function isLifecycleStatus(status: TenantStatus): status is TenantLifecycleStatus {
  return (TENANT_LIFECYCLE_STATUSES as readonly TenantStatus[]).includes(status);
}

/**
 * As contas que a coleta lê: só as de cliente `active` (CE-02) e sem a coleta pausada na célula (CE-05,
 * `tenant.collection_pause`). O cliente suspenso, cancelado, em expurgo ou desativado sai do Wazuh, da GCP, do
 * Cloudflare, das conferências da AWS e do inventário; os dados dele ficam. A pausa tira só a coleta: o acesso e o estado
 * continuam. No nó dedicado não há linha de estado da célula, e a condição da pausa sempre passa. A atribuição de um
 * alerta que já estava a caminho continua pelo cadastro (a conta segue sendo do cliente).
 */
export const COLLECTING_TENANT = {
  tenant: {
    is: {
      status: 'active',
      OR: [{ cellState: { is: null } }, { cellState: { is: { collectionPausedAt: null } } }],
    },
  },
} as const satisfies Prisma.CloudAccountWhereInput;

/** O que a coleta lê do cliente para decidir em memória (a mesma regra de `COLLECTING_TENANT`). */
export const COLLECTING_TENANT_SELECT = {
  status: true,
  cellState: { select: { collectionPausedAt: true } },
} as const satisfies Prisma.TenantSelect;

/** O cliente é coletado: `active` e sem a coleta pausada (a mesma regra de `COLLECTING_TENANT`, em memória). */
export function isCollectingTenant(tenant: {
  status: TenantStatus;
  cellState: { collectionPausedAt: Date | null } | null;
}): boolean {
  return tenant.status === 'active' && (tenant.cellState?.collectionPausedAt ?? null) === null;
}
