import { describe, expect, it } from 'vitest';
import type { CellRecord } from '../cells/cell.schema.js';
import { newUlid } from '../common/ulid.js';
import type { TenantRecord, TenantState } from '../tenants/tenant.schema.js';
import { mergeReleaseMetadata, RELEASE_METADATA_KEYS } from './fleet-cloud.js';
import { buildFleetPlan } from './fleet-plan.js';
import { compareReleasesDesc } from './fleet.service.js';

const AT = new Date('2026-11-16T12:00:00.000Z');
const HOSTS = { apiDomainPrefix: 'api-', zoneName: 'veraxsistemas.com.br' };
let sequence = 0;

function cell(id: string, extra: Partial<CellRecord> = {}): CellRecord {
  return {
    id,
    state: 'open',
    region: 'southamerica-east1',
    project: 'projeto-do-no-verax',
    natIps: ['203.0.113.10'],
    commandsTopic: `projects/projeto-do-no-verax/topics/vxc-${id}-commands`,
    reportsSubscription: `projects/projeto-exemplo/subscriptions/vxc-${id}-reports-push`,
    pushServiceAccount: `vxc-${id}-push@projeto-do-no-verax.iam.gserviceaccount.com`,
    node: { zone: 'southamerica-east1-b', instance: `verax-${id}` },
    createdAt: AT,
    updatedAt: AT,
    ...extra,
  };
}

/** Só os campos que o plano lê (o resto do documento não importa aqui). */
function tenant(slug: string, state: TenantState, extra: Partial<TenantRecord> = {}): TenantRecord {
  sequence += 1;
  return {
    id: newUlid(AT.getTime() + sequence),
    slug,
    state,
    resources: {
      nodesProject: 'projeto-exemplo-nos',
      zone: 'southamerica-east1-b',
      instanceName: `vx-${slug}`,
      firebaseProject: 'projeto-paineis',
      siteId: `vxc-${slug}-a1b2c3`,
    },
    ...extra,
  } as TenantRecord;
}

describe('plano da frota', () => {
  it('a célula com o painel da equipe é a canária; as outras células depois; os dedicados por último', () => {
    const staff = { project: 'projeto-paineis', siteId: 'verax-control-verax', slug: 'verax' };
    const placed = tenant('cliente-demo-b', 'active', {
      placement: { kind: 'cell', cellId: 'sp1' },
      resources: { firebaseProject: 'projeto-paineis', siteId: 'vxc-cliente-demo-b-a1b2c3' },
    });
    const inSp2 = tenant('cliente-demo-h', 'active', { placement: { kind: 'cell', cellId: 'sp2' } });
    const plan = buildFleetPlan(
      [cell('sp4'), cell('sp2'), cell('sp1', { staffPanel: staff })],
      [
        inSp2,
        tenant('cliente-demo-c', 'past_due'),
        tenant('cliente-demo-a', 'active'),
        placed,
        tenant('cliente-demo-d', 'suspended'),
        tenant('cliente-demo-e', 'active', { lifecycle: { nodeStoppedAt: AT } }),
        tenant('cliente-demo-f', 'waiting_customer_connection', { resources: {} }),
        tenant('cliente-demo-g', 'active', { hosting: 'customer' }),
      ],
      HOSTS,
    );
    expect(plan.nodes.map((node) => [node.label, node.wave])).toEqual([
      ['sp1', 0],
      ['sp2', 1],
      ['cliente-demo-a', 2],
      ['cliente-demo-c', 2],
    ]);
    const canary = plan.nodes[0];
    expect(canary?.target).toEqual({
      project: 'projeto-do-no-verax',
      zone: 'southamerica-east1-b',
      instance: 'verax-sp1',
    });
    // O painel da equipe e o de cada cliente da célula andam com ela; a API conferida é a da equipe.
    expect(canary?.panels.map((panel) => panel.slug)).toEqual(['verax', 'cliente-demo-b']);
    expect(canary?.apiOrigin).toBe('https://api-verax.veraxsistemas.com.br');
    // A célula sem a equipe confere a API de um cliente dela.
    expect(plan.nodes[1]?.apiOrigin).toBe('https://api-cliente-demo-h.veraxsistemas.com.br');
    expect(plan.nodes[1]?.panels.map((panel) => panel.slug)).toEqual(['cliente-demo-h']);
    expect(plan.nodes[2]?.apiOrigin).toBe('https://api-cliente-demo-a.veraxsistemas.com.br');
    expect(plan.nodes[2]?.key).toMatch(/^tenant-[0-9A-Z]{26}$/);
    // A célula sem ninguém (sem painel da equipe nem cliente) não tem API para conferir: fica fora.
    expect(plan.excluded.map((entry) => [entry.label, entry.reason])).toEqual([
      ['sp4', 'cell_without_address'],
      ['cliente-demo-d', 'tenant_stopped'],
      ['cliente-demo-e', 'tenant_stopped'],
      ['cliente-demo-f', 'tenant_without_node'],
    ]);
  });

  it('célula fechada ou sem a VM no registro fica fora', () => {
    const staff = { project: 'projeto-paineis', siteId: 'verax-control-verax', slug: 'verax' };
    const plan = buildFleetPlan(
      [
        cell('sp1', { state: 'closed', staffPanel: staff }),
        cell('sp3', { node: undefined, staffPanel: staff }),
      ],
      [],
      HOSTS,
    );
    expect(plan.nodes).toEqual([]);
    expect(plan.excluded.map((entry) => entry.reason)).toEqual(['cell_closed', 'cell_without_node']);
  });
});

describe('pedido de versão nos metadados', () => {
  it('troca só as chaves do pedido, mantém as outras e tira a janela quando a rodada não tem', () => {
    const items = [
      { key: 'enable-oslogin', value: 'TRUE' },
      { key: 'startup-script', value: '#!/bin/bash' },
      { key: RELEASE_METADATA_KEYS.release, value: 'node-v1.2.3' },
      { key: RELEASE_METADATA_KEYS.window, value: '02:00-05:00' },
    ];
    const merged = mergeReleaseMetadata(items, {
      release: 'node-v1.3.0',
      packageSha256: 'a'.repeat(64),
      request: '01JD0000000000000000000000-1',
      intent: 'upgrade',
    });
    expect(merged).toEqual([
      { key: 'enable-oslogin', value: 'TRUE' },
      { key: 'startup-script', value: '#!/bin/bash' },
      { key: 'verax-node-release', value: 'node-v1.3.0' },
      { key: 'verax-node-release-sha256', value: 'a'.repeat(64) },
      { key: 'verax-node-release-request', value: '01JD0000000000000000000000-1' },
      { key: 'verax-node-release-intent', value: 'upgrade' },
    ]);
    expect(
      mergeReleaseMetadata(items, {
        release: 'node-v1.3.0',
        packageSha256: 'a'.repeat(64),
        request: 'r-1',
        intent: 'rollback',
        window: '23:00-02:00',
      }).at(-1),
    ).toEqual({ key: 'verax-update-window', value: '23:00-02:00' });
  });

  it('as versões da mais nova para a mais antiga, pelos números', () => {
    expect(['node-v1.2.3', 'node-v1.10.0', 'node-v1.9.9', 'node-v2.0.0'].sort(compareReleasesDesc)).toEqual([
      'node-v2.0.0',
      'node-v1.10.0',
      'node-v1.9.9',
      'node-v1.2.3',
    ]);
  });
});
