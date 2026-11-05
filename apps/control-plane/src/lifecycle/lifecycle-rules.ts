import type { AuditContext, TenantChange } from '../tenants/tenant-store.js';
import {
  billingModeOf,
  type DeletionRequester,
  type LifecycleRunKind,
  type Tenant,
  type TenantRecord,
  type TenantState,
} from '../tenants/tenant.schema.js';
import { cancelTenant, neverProvisioned } from '../webhook/billing-rules.js';

/**
 * As regras do ciclo de vida depois da venda (plano §4d, CP-11), puras como as do webhook (`billing-rules.ts`): recebem
 * o cliente relido dentro da transação e o instante (do `tick`, nunca lido aqui) e devolvem a mudança, ou `undefined`.
 *
 * Linha do tempo de uma renovação não paga (D0 = `invoice.payment_failed`, CP-04):
 * - D+7: `graceUntil` vencido → `suspended` (`grace_expired`), a VM para; `unpaidSince` = o vencimento da carência;
 * - D+37: 30 dias suspenso sem pagar → a assinatura é cancelada na Stripe e o cliente vai a `canceled`, com
 *   `deleteAfter` (+30) e `cryptoDestroyAfter` (+97) contados dali;
 * - `deleteAfter` vencido → Exclusão 1 (`deleted`); `cryptoDestroyAfter` vencido → Exclusão 2.
 *
 * Nenhuma regra daqui exclui um cliente que não esteja `canceled`: a exclusão só existe a partir desse estado.
 */

const DAY_MS = 24 * 60 * 60_000;
/** Suspenso por falta de pagamento por 30 dias: a assinatura é cancelada (plano §4d, D+37). */
export const UNPAID_CANCEL_AFTER_MS = 30 * DAY_MS;

/** Estados em que a VM do cliente fica parada (plano §4b): suspenso e cancelado. */
export const NODE_STOPPED_STATES: readonly TenantState[] = ['suspended', 'canceled'];
/** Estados em que a VM do cliente fica ligada. `past_due` mantém o nó no ar (carência). */
export const NODE_RUNNING_STATES: readonly TenantState[] = [
  'waiting_customer_connection',
  'active',
  'past_due',
];

/**
 * O cliente pode ter VM: o `apply` do Terraform já começou (a versão presa, CP-07) ou a VM foi registrada. Sem isso não
 * há o que parar nem ligar (e o subdomínio de quem nunca provisionou pode ser de outro cliente agora, CP-04).
 */
export function mayHaveNode(tenant: Tenant): boolean {
  return (
    !neverProvisioned(tenant) &&
    (tenant.resources?.instanceName !== undefined || tenant.provisioning?.nodeVersionPinnedAt !== undefined)
  );
}

/**
 * Algum recurso fora do Firestore pode existir (túnel, site, estado do Terraform): o cliente entrou em `provisioning`
 * alguma vez. Quem nunca provisionou (boleto vencido no 1.º ciclo) é excluído só no Firestore, sem chamada externa.
 */
export function mayHaveExternalResources(tenant: Tenant): boolean {
  return !neverProvisioned(tenant);
}

/** A carência de 7 dias venceu: `past_due` → `suspended` (`grace_expired`), plano §4d (D+7). */
export function graceExpiredChange(
  tenant: TenantRecord,
  now: Date,
  audit: AuditContext,
): TenantChange | undefined {
  const graceUntil = tenant.billing?.graceUntil;
  if (tenant.state !== 'past_due' || graceUntil === undefined || graceUntil.getTime() > now.getTime()) {
    return undefined;
  }
  // Contrato direto: nada de relógio da Stripe; só o responsável suspende.
  if (billingModeOf(tenant) === 'contract') return undefined;
  return {
    to: 'suspended',
    reason: 'grace_expired',
    audit,
    mutate: (current) => ({
      ...current,
      billing: {
        ...current.billing,
        suspendedReason: 'grace_expired',
        // Os 30 dias até o cancelamento contam do fim da carência (o prazo, não a hora em que o `tick` passou).
        unpaidSince: current.billing?.unpaidSince ?? graceUntil,
      },
    }),
  };
}

/**
 * O fim dos 30 dias suspenso por falta de pagamento (D+37), ou `undefined` se o cliente não está nesse caminho. Um
 * suspenso por `fraud_review` nunca é cancelado pelo relógio: a decisão é humana (CP-04).
 */
export function unpaidCancelDueAt(tenant: Tenant): Date | undefined {
  const since = tenant.billing?.unpaidSince;
  const reason = tenant.billing?.suspendedReason;
  if (tenant.state !== 'suspended' || since === undefined) return undefined;
  if (reason !== 'unpaid' && reason !== 'grace_expired') return undefined;
  if (billingModeOf(tenant) === 'contract') return undefined;
  return new Date(since.getTime() + UNPAID_CANCEL_AFTER_MS);
}

/** Cancela quem passou 30 dias suspenso sem pagar (a assinatura já foi cancelada na Stripe por quem chama). */
export function unpaidCancelChange(
  tenant: TenantRecord,
  now: Date,
  audit: AuditContext,
): TenantChange | undefined {
  const due = unpaidCancelDueAt(tenant);
  if (due === undefined || due.getTime() > now.getTime()) return undefined;
  return cancelTenant(tenant, { at: due, audit }, 'unpaid_30_days');
}

/**
 * Pode começar a Exclusão 1? Só um cliente `canceled`: pelo relógio, com `deleteAfter` vencido; pelo responsável
 * (`delete-now`), a qualquer momento depois do cancelamento. Nenhum outro estado, nunca.
 */
export function canStartDeletion(tenant: Tenant, now: Date, by: DeletionRequester): boolean {
  if (tenant.state !== 'canceled') return false;
  if (by === 'owner') return true;
  const deleteAfter = tenant.lifecycle?.deleteAfter;
  return deleteAfter !== undefined && deleteAfter.getTime() <= now.getTime();
}

/** Pode começar a Exclusão 2? A Exclusão 1 terminou, nada em andamento e `cryptoDestroyAfter` vencido. */
export function canStartCryptoDestroy(tenant: Tenant, now: Date): boolean {
  const lifecycle = tenant.lifecycle;
  return (
    tenant.state === 'deleted' &&
    lifecycle?.deletedAt !== undefined &&
    lifecycle.purgedAt === undefined &&
    lifecycle.run === undefined &&
    lifecycle.cryptoDestroyAfter !== undefined &&
    lifecycle.cryptoDestroyAfter.getTime() <= now.getTime()
  );
}

function earliest(a: Date | undefined, b: Date): Date {
  return a === undefined || a.getTime() > b.getTime() ? b : a;
}

/**
 * `canceled` → `deleted` com a execução da Exclusão 1 no primeiro passo. O `delete-now` adianta `deleteAfter` para
 * agora; os dois caminhos fecham a janela da exportação. `cryptoDestroyAfter` não muda: os backups saem pela retenção
 * do bucket, contada do último backup (o cancelamento), e não da exclusão.
 */
export function startDeletionChange(
  tenant: TenantRecord,
  now: Date,
  by: DeletionRequester,
  run: { runId: string; firstStep: string },
  audit: AuditContext,
): TenantChange | undefined {
  if (!canStartDeletion(tenant, now, by)) return undefined;
  return {
    to: 'deleted',
    reason: by === 'owner' ? 'deletion_requested_by_owner' : 'deletion_scheduled',
    audit,
    mutate: (current) => ({
      ...current,
      lifecycle: {
        ...current.lifecycle,
        deleteAfter:
          by === 'owner' ? earliest(current.lifecycle?.deleteAfter, now) : current.lifecycle?.deleteAfter,
        exportUntil: earliest(current.lifecycle?.exportUntil, now),
        deletionRequestedAt: now,
        deletionRequestedBy: by,
        run: { kind: 'delete', runId: run.runId, step: run.firstStep, startedAt: now },
      },
    }),
  };
}

/** Uma execução nova da exclusão (a Exclusão 2 no `tick`, ou a repetição de uma que parou, pelo `delete-now`). */
export function startRunChange(
  tenant: TenantRecord,
  kind: LifecycleRunKind,
  now: Date,
  run: { runId: string; firstStep: string },
  reason: string,
  audit: AuditContext,
): TenantChange | undefined {
  if (tenant.state !== 'deleted' || tenant.lifecycle?.purgedAt !== undefined) return undefined;
  const current = tenant.lifecycle?.run;
  // Uma execução em andamento (sem erro) nunca é substituída: a repetição do pedido não abre outra.
  if (current !== undefined && current.lastError === undefined) return undefined;
  if (kind === 'crypto_destroy' && tenant.lifecycle?.deletedAt === undefined) return undefined;
  return {
    reason,
    audit,
    mutate: (t) => ({
      ...t,
      lifecycle: {
        ...t.lifecycle,
        run: { kind, runId: run.runId, step: run.firstStep, startedAt: now },
      },
    }),
  };
}

/**
 * O fim da Exclusão 1: o cliente perde o e-mail do admin, o acesso e os recursos que a Exclusão 2 não usa (plano §3).
 * Ficam o projeto dos nós, o prefixo, o bucket de backups e o do estado, até a Exclusão 2.
 */
export function afterDeletion(tenant: Tenant, now: Date, recordSent: boolean): Tenant {
  const { adminEmail: _email, access: _access, resources, ...rest } = tenant;
  const kept =
    resources === undefined
      ? undefined
      : {
          nodesProject: resources.nodesProject,
          namePrefix: resources.namePrefix,
          backupsBucket: resources.backupsBucket,
          tfstatePrefix: resources.tfstatePrefix,
        };
  const { run: _run, ...lifecycle } = tenant.lifecycle ?? {};
  return {
    ...rest,
    ...(kept === undefined ? {} : { resources: kept }),
    lifecycle: {
      ...lifecycle,
      deletedAt: lifecycle.deletedAt ?? now,
      ...(recordSent ? { deletionRecordSentAt: now } : {}),
    },
  };
}

/**
 * O registro mínimo depois da Exclusão 2 (plano §3): ficam `slug`, `company`, `stripe.customerId`, `lifecycle` (os
 * carimbos da exclusão) e as faturas (subcoleção, 5 anos). Também ficam, por serem exigidos pelo formato do documento e
 * não terem dado pessoal, o que foi vendido (`configuration`, `limits`, `pricing`, `priceId`) e o aceite dos textos
 * legais (`consent`: versões, data e a sessão do Checkout), a prova do contrato que as faturas cobram. Saem o resto da
 * Stripe, a cobrança, o provisionamento, os recursos, o acesso e o e-mail.
 */
export function minimalRecord(tenant: Tenant, now: Date): Tenant {
  const {
    adminEmail: _email,
    access: _access,
    resources: _resources,
    provisioning: _provisioning,
    billing: _billing,
    stripe,
    ...rest
  } = tenant;
  // O prazo da Exclusão 2 sai com ela: o `tick` consulta `cryptoDestroyAfter` vencido, e um cliente já terminado
  // nunca mais pode ocupar a página dessa consulta. Ficam os carimbos do que aconteceu.
  const { run: _run, cryptoDestroyAfter: _done, ...lifecycle } = tenant.lifecycle ?? {};
  const mode = tenant.billing?.mode;
  return {
    ...rest,
    ...(mode === undefined ? {} : { billing: { mode } }),
    ...(stripe === undefined
      ? {}
      : {
          stripe: {
            livemode: stripe.livemode,
            ...(stripe.customerId === undefined ? {} : { customerId: stripe.customerId }),
          },
        }),
    lifecycle: {
      ...lifecycle,
      cryptoDestroyedAt: lifecycle.cryptoDestroyedAt ?? now,
      backupsBucketDeletedAt: lifecycle.backupsBucketDeletedAt ?? now,
      purgedAt: now,
    },
  };
}

// --- Contrato direto (sem a Stripe): só o responsável suspende, reativa e cancela -------------------------------------

/** Cancelar um contrato direto não pode ser marcado para mais longe que isto (um engano de ano, por exemplo). */
export const MAX_CANCEL_SCHEDULE_MS = 2 * 366 * DAY_MS;

/** Estados de onde o responsável pode cancelar um contrato direto (todos os vivos). */
const CANCELABLE: readonly TenantState[] = [
  'pending',
  'provisioning',
  'provisioning_failed',
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
];

/** Contrato direto cancelado agora pelo responsável: os mesmos prazos de todo cancelamento (D+30 e D+97). */
export function contractCancelChange(
  tenant: TenantRecord,
  now: Date,
  audit: AuditContext,
  reason = 'contract_canceled_by_owner',
): TenantChange | undefined {
  if (billingModeOf(tenant) !== 'contract' || !CANCELABLE.includes(tenant.state)) return undefined;
  return cancelTenant(tenant, { at: now, audit }, reason, (current) => {
    const { cancelScheduledFor: _done, ...lifecycle } = current.lifecycle ?? {};
    return { ...current, lifecycle };
  });
}

/** O cancelamento de um contrato direto marcado para uma data futura (o fim do contrato). */
export function contractScheduleCancelChange(
  tenant: TenantRecord,
  when: Date,
  audit: AuditContext,
): TenantChange | undefined {
  if (billingModeOf(tenant) !== 'contract' || !CANCELABLE.includes(tenant.state)) return undefined;
  return {
    reason: 'contract_cancel_scheduled',
    audit,
    mutate: (current) => ({ ...current, lifecycle: { ...current.lifecycle, cancelScheduledFor: when } }),
  };
}

/** O cancelamento marcado venceu: o `tick` cancela com a data marcada (os prazos contam dela). */
export function scheduledCancelChange(
  tenant: TenantRecord,
  now: Date,
  audit: AuditContext,
): TenantChange | undefined {
  const when = tenant.lifecycle?.cancelScheduledFor;
  if (when === undefined || when.getTime() > now.getTime()) return undefined;
  return contractCancelChange(tenant, when, audit, 'contract_ended');
}

/** O responsável suspende um contrato direto (a VM para; só ele reativa). */
export function contractSuspendChange(tenant: TenantRecord, audit: AuditContext): TenantChange | undefined {
  if (billingModeOf(tenant) !== 'contract') return undefined;
  if (
    tenant.state !== 'active' &&
    tenant.state !== 'waiting_customer_connection' &&
    tenant.state !== 'past_due'
  ) {
    return undefined;
  }
  return {
    to: 'suspended',
    reason: 'contract_suspended_by_owner',
    audit,
    mutate: (current) => ({
      ...current,
      billing: {
        ...current.billing,
        suspendedReason: 'owner',
        resumeState:
          current.state === 'past_due'
            ? current.billing?.resumeState
            : current.state === 'active'
              ? 'active'
              : 'waiting_customer_connection',
      },
    }),
  };
}

/** O responsável reativa um contrato direto que ele suspendeu: volta ao estado de antes e a VM liga. */
export function contractReactivateChange(
  tenant: TenantRecord,
  audit: AuditContext,
): TenantChange | undefined {
  if (billingModeOf(tenant) !== 'contract') return undefined;
  if (tenant.state !== 'suspended' || tenant.billing?.suspendedReason !== 'owner') return undefined;
  return {
    to: tenant.billing.resumeState ?? 'active',
    reason: 'contract_reactivated_by_owner',
    audit,
    mutate: (current) => {
      const { suspendedReason: _reason, resumeState: _resume, ...billing } = current.billing ?? {};
      return { ...current, billing };
    },
  };
}
