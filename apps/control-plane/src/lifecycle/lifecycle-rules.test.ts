import { describe, expect, it } from 'vitest';
import { TENANT_STATES, type Tenant, type TenantRecord, type TenantState } from '../tenants/tenant.schema.js';
import { canTransition } from '../tenants/tenant-transitions.js';
import {
  afterDeletion,
  canStartCryptoDestroy,
  canStartDeletion,
  graceExpiredChange,
  mayHaveNode,
  minimalRecord,
  startDeletionChange,
  startRunChange,
  unpaidCancelChange,
  unpaidCancelDueAt,
} from './lifecycle-rules.js';
import { nodePowerAfterTransition } from './node-power-request.js';

const DAY = 24 * 60 * 60_000;
const T0 = new Date('2026-11-05T12:00:00.000Z');
const SYSTEM = { actor: 'system' };
const RUN = { runId: '01JBTESTE0000000000000RVN1', firstStep: 'deletion.terraform' };

function days(n: number): Date {
  return new Date(T0.getTime() + n * DAY);
}

function tenant(state: TenantState, extra: Partial<Tenant> = {}): TenantRecord {
  return {
    id: '01JBTESTE0000000000000TEN1',
    slug: 'cliente-demo-a',
    state,
    stateUpdatedAt: T0,
    configuration: {} as Tenant['configuration'],
    limits: {} as Tenant['limits'],
    pricing: {} as Tenant['pricing'],
    company: { legalName: 'Cliente Demo A Ltda', cnpj: '11222333000181' },
    adminEmail: 'admin@cliente-demo-a.example',
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

describe('regras do ciclo de vida (CP-11)', () => {
  it('D+7: só `past_due` com a carência vencida vai a `suspended`, com unpaidSince no fim da carência', () => {
    const due = tenant('past_due', { billing: { graceUntil: days(7), resumeState: 'active' } });
    expect(graceExpiredChange(due, new Date(days(7).getTime() - 1), SYSTEM)).toBeUndefined();
    const change = graceExpiredChange(due, days(8), SYSTEM);
    expect(change?.to).toBe('suspended');
    const mutated = change?.mutate?.(due);
    expect(mutated?.billing).toMatchObject({ suspendedReason: 'grace_expired', unpaidSince: days(7) });
    expect(graceExpiredChange(tenant('active', { billing: { graceUntil: days(0) } }), days(9), SYSTEM)).toBe(
      undefined,
    );
  });

  it('D+37: 30 dias suspenso por falta de pagamento cancela, contado de unpaidSince; fraude nunca', () => {
    const unpaid = tenant('suspended', {
      billing: { suspendedReason: 'grace_expired', unpaidSince: days(7) },
    });
    expect(unpaidCancelDueAt(unpaid)).toEqual(days(37));
    expect(unpaidCancelChange(unpaid, new Date(days(37).getTime() - 1), SYSTEM)).toBeUndefined();
    const change = unpaidCancelChange(unpaid, days(37), SYSTEM);
    expect(change?.to).toBe('canceled');
    expect(change?.mutate?.(unpaid).lifecycle).toMatchObject({
      canceledAt: days(37),
      deleteAfter: days(67),
      cryptoDestroyAfter: days(134),
    });
    const fraud = tenant('suspended', { billing: { suspendedReason: 'fraud_review', unpaidSince: T0 } });
    expect(unpaidCancelDueAt(fraud)).toBeUndefined();
    expect(unpaidCancelChange(fraud, days(1000), SYSTEM)).toBeUndefined();
    expect(unpaidCancelChange(tenant('active', { billing: { unpaidSince: T0 } }), days(1000), SYSTEM)).toBe(
      undefined,
    );
  });

  it('a exclusão só começa de `canceled`: nenhum outro estado, nem com prazos vencidos, nem pelo responsável', () => {
    const past = { lifecycle: { deleteAfter: T0, cryptoDestroyAfter: T0 } };
    for (const state of TENANT_STATES) {
      const t = tenant(state, past);
      const allowed = state === 'canceled';
      expect(canStartDeletion(t, days(1000), 'schedule')).toBe(allowed);
      expect(canStartDeletion(t, days(1000), 'owner')).toBe(allowed);
      expect(startDeletionChange(t, days(1000), 'owner', RUN, SYSTEM) !== undefined).toBe(allowed);
      // A tabela de transições diz o mesmo: só `canceled` entra em `deleted`.
      expect(canTransition(state, 'deleted')).toBe(allowed);
    }
  });

  it('pelo relógio, só com deleteAfter vencido; o delete-now adianta deleteAfter e fecha a exportação', () => {
    const canceled = tenant('canceled', {
      lifecycle: {
        canceledAt: T0,
        exportUntil: days(30),
        deleteAfter: days(30),
        cryptoDestroyAfter: days(97),
      },
    });
    expect(canStartDeletion(canceled, new Date(days(30).getTime() - 1), 'schedule')).toBe(false);
    expect(canStartDeletion(canceled, days(30), 'schedule')).toBe(true);
    const change = startDeletionChange(canceled, days(5), 'owner', RUN, SYSTEM);
    expect(change?.to).toBe('deleted');
    expect(change?.mutate?.(canceled).lifecycle).toMatchObject({
      deleteAfter: days(5),
      exportUntil: days(5),
      cryptoDestroyAfter: days(97),
      deletionRequestedBy: 'owner',
      run: { kind: 'delete', runId: RUN.runId, step: 'deletion.terraform' },
    });
  });

  it('a Exclusão 2 só depois da 1, sem execução em andamento e com cryptoDestroyAfter vencido', () => {
    const base = { deletedAt: days(30), cryptoDestroyAfter: days(97) };
    expect(canStartCryptoDestroy(tenant('deleted', { lifecycle: base }), days(97))).toBe(true);
    expect(canStartCryptoDestroy(tenant('deleted', { lifecycle: base }), days(96))).toBe(false);
    expect(
      canStartCryptoDestroy(tenant('deleted', { lifecycle: { cryptoDestroyAfter: days(97) } }), days(200)),
    ).toBe(false);
    expect(canStartCryptoDestroy(tenant('canceled', { lifecycle: base }), days(200))).toBe(false);
    const running = {
      ...base,
      run: { kind: 'delete' as const, runId: RUN.runId, step: 'deletion.record', startedAt: T0 },
    };
    expect(canStartCryptoDestroy(tenant('deleted', { lifecycle: running }), days(200))).toBe(false);
    // Uma execução em andamento nunca é substituída; uma que parou com erro, sim.
    expect(startRunChange(tenant('deleted', { lifecycle: running }), 'delete', T0, RUN, 'x', SYSTEM)).toBe(
      undefined,
    );
    const failed = { ...running, run: { ...running.run, lastError: { code: 'cloudflare_denied', at: T0 } } };
    expect(
      startRunChange(tenant('deleted', { lifecycle: failed }), 'delete', T0, RUN, 'x', SYSTEM),
    ).toBeDefined();
  });

  it('depois da Exclusão 1 o cliente perde e-mail, acesso e recursos; depois da 2, vira o registro mínimo', () => {
    const full = tenant('deleted', {
      access: { passwordRevealedAt: T0 },
      resources: {
        nodesProject: 'projeto-dos-nos-demo',
        zone: 'southamerica-east1-b',
        instanceName: 'vx-cliente-demo-a',
        namePrefix: 'vx-cliente-demo-a',
        tunnelId: 'abc',
        backupsBucket: 'projeto-dos-nos-demo-vx-cliente-demo-a-backups',
        tfstatePrefix: 'tenants/cliente-demo-a',
      },
      stripe: { customerId: 'cus_demo', subscriptionId: 'sub_demo', status: 'canceled', livemode: false },
      billing: { paidUntil: T0 },
      provisioning: { runId: RUN.runId, attempts: 0 },
      lifecycle: { run: { kind: 'delete', runId: RUN.runId, step: 'deletion.record', startedAt: T0 } },
    });
    const deleted = afterDeletion(full, days(30), true);
    expect(deleted.adminEmail).toBeUndefined();
    expect(deleted.access).toBeUndefined();
    expect(deleted.resources).toEqual({
      nodesProject: 'projeto-dos-nos-demo',
      namePrefix: 'vx-cliente-demo-a',
      backupsBucket: 'projeto-dos-nos-demo-vx-cliente-demo-a-backups',
      tfstatePrefix: 'tenants/cliente-demo-a',
    });
    expect(deleted.lifecycle).toEqual({ deletedAt: days(30), deletionRecordSentAt: days(30) });
    const minimal = minimalRecord(deleted, days(97));
    expect(Object.keys(minimal).sort()).toEqual(
      [
        'company',
        'configuration',
        'createdAt',
        'id',
        'lifecycle',
        'limits',
        'pricing',
        'slug',
        'state',
        'stateUpdatedAt',
        'stripe',
        'updatedAt',
      ].sort(),
    );
    expect(minimal.stripe).toEqual({ livemode: false, customerId: 'cus_demo' });
    expect(minimal.lifecycle).toMatchObject({ purgedAt: days(97), cryptoDestroyedAt: days(97) });
    // O prazo sai com a Exclusão 2: o `tick` só consulta quem ainda tem trabalho.
    expect(minimal.lifecycle?.cryptoDestroyAfter).toBeUndefined();
  });

  it('a VM acompanha a transição: para ao suspender ou cancelar, liga ao sair da suspensão', () => {
    expect(nodePowerAfterTransition('active', 'suspended')).toBe('node.stop');
    expect(nodePowerAfterTransition('past_due', 'canceled')).toBe('node.stop');
    expect(nodePowerAfterTransition('suspended', 'canceled')).toBeUndefined();
    expect(nodePowerAfterTransition('suspended', 'active')).toBe('node.start');
    expect(nodePowerAfterTransition('suspended', 'waiting_customer_connection')).toBe('node.start');
    expect(nodePowerAfterTransition('active', 'past_due')).toBeUndefined();
    expect(nodePowerAfterTransition('canceled', 'deleted')).toBeUndefined();
    expect(mayHaveNode(tenant('active'))).toBe(false);
    expect(mayHaveNode(tenant('active', { provisioning: { runId: RUN.runId, attempts: 0 } }))).toBe(false);
    expect(
      mayHaveNode(
        tenant('active', { provisioning: { runId: RUN.runId, attempts: 0, nodeVersionPinnedAt: T0 } }),
      ),
    ).toBe(true);
  });
});
