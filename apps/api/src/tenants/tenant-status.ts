import { TENANT_LIFECYCLE_STATUSES, type TenantLifecycleStatus, type TenantStatus } from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** O estado é do ciclo de vida da contratação (CE-02): só o sistema grava (`tenant-lifecycle.ts`). */
export function isLifecycleStatus(status: TenantStatus): status is TenantLifecycleStatus {
  return (TENANT_LIFECYCLE_STATUSES as readonly TenantStatus[]).includes(status);
}

/**
 * As contas que a coleta lê: só as de cliente `active` (CE-02). O cliente suspenso, cancelado, em expurgo ou desativado
 * sai do Wazuh, da GCP, do Cloudflare, das conferências da AWS e do inventário; os dados dele ficam. A atribuição de um
 * alerta que já estava a caminho continua pelo cadastro (a conta segue sendo do cliente).
 */
export const COLLECTING_TENANT = {
  tenant: { is: { status: 'active' } },
} as const satisfies Prisma.CloudAccountWhereInput;
