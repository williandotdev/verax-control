import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { cellSchema } from '../src/cells/cell.schema.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { parseDocument } from '../src/firestore/document-store.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { tenantSchema } from '../src/tenants/tenant.schema.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { FakeFleetCloud, fleetRelease } from './support/fake-fleet-cloud.js';
import { LogCapture } from './support/log-capture.js';

const WORKER_URL = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';
const CONSOLE = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const OWNER = 'responsavel@exemplo.example';
const START = new Date('2026-11-16T12:00:00.000Z');

/**
 * A frota pelo app inteiro do cp-worker: a guarda das rotas (só o responsável e o console, com quem agiu), a revisão,
 * a rodada nova com a confirmação e a auditoria, a volta do motor pela fila (`/internal/steps/fleet.tick`) e as
 * operações do responsável. Um app por arquivo.
 */
describe('cp-worker: atualização da frota', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const google = new TestGoogleIdentity();
  const queue = new MemoryStepQueue();
  const cloud = new FakeFleetCloud();
  const tenants = new TenantStore(documents, clock, new AuditService(documents, clock));
  let app: NestExpressApplication;
  let tenantId = '';

  beforeAll(async () => {
    app = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      idTokenKeys: google,
      stepQueue: queue,
      fleetCloud: cloud,
      capture,
      env: {
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        ADMIN_SA_EMAIL: CONSOLE,
        RELEASE_BUCKET: 'releases-demo',
      },
    });
    await app.listen(0, '127.0.0.1');
    cloud.releases.set('node-v1.3.0', fleetRelease('node-v1.3.0'));
    cloud.releases.set('node-v1.2.9', 'no_panel');
    cloud.releases.set('node-v1.2.8', 'invalid');
    await documents.runTransaction((tx) => {
      tx.set(
        COLLECTIONS.cells,
        'sp1',
        cellSchema.parse({
          state: 'open',
          region: 'southamerica-east1',
          project: 'projeto-do-no-verax',
          natIps: ['203.0.113.10'],
          commandsTopic: 'projects/projeto-do-no-verax/topics/vxc-sp1-commands',
          reportsSubscription: 'projects/projeto-do-no-verax/subscriptions/vxc-sp1-reports-push',
          pushServiceAccount: 'vxc-sp1-push@projeto-do-no-verax.iam.gserviceaccount.com',
          node: { zone: 'southamerica-east1-b', instance: 'verax-celula' },
          staffPanel: { project: 'projeto-paineis', siteId: 'verax-control-verax', slug: 'verax' },
          createdAt: START,
          updatedAt: START,
        }),
      );
      return Promise.resolve();
    });
    const tenant = await tenantIn(tenants, 'cliente-demo-a', 'active');
    tenantId = tenant.id;
    await documents.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.tenants, tenant.id);
      const current = parseDocument(tenantSchema, COLLECTIONS.tenants, tenant.id, data ?? {});
      tx.set(
        COLLECTIONS.tenants,
        tenant.id,
        tenantSchema.parse({
          ...current,
          resources: {
            nodesProject: 'projeto-exemplo-nos',
            zone: 'southamerica-east1-b',
            instanceName: 'vx-cliente-demo-a',
            firebaseProject: 'projeto-paineis',
            siteId: 'vxc-cliente-demo-a-a1b2c3',
          },
        }),
      );
    });
  });

  afterAll(async () => {
    await app.close();
  });

  function bearer(email: string): string {
    return `Bearer ${google.token({ email, aud: WORKER_URL })}`;
  }

  function post(path: string, body: Record<string, unknown>, email = OWNER) {
    return request(app.getHttpServer()).post(path).set('Authorization', bearer(email)).send(body);
  }

  it('só o responsável e o console (dizendo quem agiu) chamam as rotas da frota', async () => {
    expect((await request(app.getHttpServer()).post('/internal/fleet/plan').send({})).status).toBe(401);
    expect((await post('/internal/fleet/plan', { release: 'node-v1.3.0' }, INVOKER)).status).toBe(403);
    const anonymous = await post('/internal/fleet/plan', { release: 'node-v1.3.0' }, CONSOLE);
    expect(anonymous.status).toBe(403);
    expect(anonymous.body).toMatchObject({ code: 'actor_not_owner' });
    const fromConsole = await post('/internal/fleet/plan', { release: 'node-v1.3.0', actor: OWNER }, CONSOLE);
    expect(fromConsole.status).toBe(200);
    // A volta do motor é das tasks (e do responsável, para destravar à mão), nunca do console.
    expect((await post('/internal/steps/fleet.tick', { tenantId, runId: tenantId }, CONSOLE)).status).toBe(
      403,
    );
  });

  it('as versões do bucket, conferidas: a sem o painel e a inválida aparecem com o motivo', async () => {
    const response = await post('/internal/fleet/releases', {});
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      releases: [
        { release: 'node-v1.3.0', commit: 'a'.repeat(40), status: 'ok' },
        { release: 'node-v1.2.9', status: 'panel_missing' },
        { release: 'node-v1.2.8', status: 'invalid' },
      ],
    });
  });

  it('a revisão: a canária, os dedicados e os sites de cada um; a versão sem o painel é recusada', async () => {
    const refused = await post('/internal/fleet/plan', { release: 'node-v1.2.9' });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'panel_bundle_missing' });
    expect((await post('/internal/fleet/plan', { release: 'node-v9.9.9' })).body).toMatchObject({
      code: 'release_manifest_missing',
    });
    const plan = await post('/internal/fleet/plan', { release: 'node-v1.3.0' });
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ release: { release: 'node-v1.3.0', commit: 'a'.repeat(40) } });
    expect((plan.body as { nodes: unknown }).nodes).toEqual([
      { key: 'cell-sp1', kind: 'cell', wave: 0, label: 'sp1', instance: 'verax-celula', panels: ['verax'] },
      {
        key: `tenant-${tenantId}`,
        kind: 'dedicated',
        wave: 2,
        label: 'cliente-demo-a',
        instance: 'vx-cliente-demo-a',
        panels: ['cliente-demo-a'],
      },
    ]);
    expect(plan.body).not.toHaveProperty('activeRolloutId');
  });

  let rolloutId = '';

  it('a rodada nova: a confirmação, uma por vez, a auditoria e a primeira volta na fila', async () => {
    const mismatch = await post('/internal/fleet/rollouts', {
      release: 'node-v1.3.0',
      confirmRelease: 'node-v1.3.1',
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toMatchObject({ code: 'confirmation_mismatch' });
    expect((await post('/internal/fleet/rollouts', { release: 'node-v1.3.0', concurrency: 9 })).status).toBe(
      400,
    );

    const created = await post(
      '/internal/fleet/rollouts',
      {
        release: 'node-v1.3.0',
        confirmRelease: 'node-v1.3.0',
        concurrency: 2,
        window: '02:00-05:00',
        actor: OWNER,
      },
      CONSOLE,
    );
    expect(created.status).toBe(201);
    rolloutId = (created.body as { rollout: { id: string } }).rollout.id;
    expect((created.body as { rollout: unknown }).rollout).toMatchObject({
      state: 'running',
      concurrency: 2,
      window: '02:00-05:00',
      createdBy: `owner:${OWNER}`,
      totals: { nodes: 2, pending: 2 },
    });
    expect(queue.tasks.at(-1)).toMatchObject({ queue: 'lifecycle', step: 'fleet.tick', runId: rolloutId });
    const again = await post('/internal/fleet/rollouts', {
      release: 'node-v1.3.0',
      confirmRelease: 'node-v1.3.0',
    });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'rollout_active' });
    const audit = await documents.query(COLLECTIONS.auditLog);
    expect(audit.find((doc) => doc.data.action === 'rollout.created')?.data).toMatchObject({
      actor: `owner:${OWNER}`,
      details: { rolloutId, release: 'node-v1.3.0', nodes: 2 },
    });
  });

  it('a volta do motor pela fila pede a versão à canária primeiro, com a janela', async () => {
    const tick = await post('/internal/steps/fleet.tick', { tenantId: rolloutId, runId: rolloutId }, INVOKER);
    expect(tick.status).toBe(200);
    expect(tick.body).toMatchObject({ outcome: 'continuing' });
    expect([...cloud.requests.keys()]).toEqual(['verax-celula']);
    expect(cloud.requests.get('verax-celula')).toMatchObject({
      release: 'node-v1.3.0',
      window: '02:00-05:00',
    });
    // A mesma entrega de novo não pede nada a mais.
    const again = await post(
      '/internal/steps/fleet.tick',
      { tenantId: rolloutId, runId: rolloutId },
      INVOKER,
    );
    expect(again.body).toMatchObject({ outcome: 'stale_tick' });
    expect(cloud.events.filter((event) => event.startsWith('request:'))).toHaveLength(1);
  });

  it('parar, retomar, pular e abortar, com as recusas do estado', async () => {
    expect((await post(`/internal/fleet/rollouts/${rolloutId}/resume`, {})).body).toMatchObject({
      code: 'rollout_not_paused',
    });
    const paused = await post(`/internal/fleet/rollouts/${rolloutId}/pause`, {});
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ rollout: { state: 'paused' } });
    const busy = await post(`/internal/fleet/rollouts/${rolloutId}/nodes/cell-sp1/skip`, {});
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: 'node_in_flight' });
    const skipped = await post(`/internal/fleet/rollouts/${rolloutId}/nodes/tenant-${tenantId}/skip`, {});
    expect(skipped.status).toBe(200);
    expect(skipped.body).toMatchObject({ node: { state: 'skipped' } });
    expect((await post(`/internal/fleet/rollouts/${rolloutId}/resume`, {})).body).toMatchObject({
      rollout: { state: 'running' },
    });
    expect((await post(`/internal/fleet/rollouts/${rolloutId}/abort`, {})).body).toMatchObject({
      rollout: { state: 'aborted' },
    });
    expect((await post(`/internal/fleet/rollouts/${rolloutId}/explode`, {})).status).toBe(404);
    expect((await post('/internal/fleet/rollouts/nao-e-ulid/pause', {})).status).toBe(404);
    const actions = (await documents.query(COLLECTIONS.auditLog)).map((doc) => doc.data.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'rollout.paused',
        'rollout.node_skipped',
        'rollout.resumed',
        'rollout.aborted',
      ]),
    );
    // Abortada, outra rodada pode começar.
    const next = await post('/internal/fleet/plan', { release: 'node-v1.3.0' });
    expect(next.body).not.toHaveProperty('activeRolloutId');
  });

  it('nenhum e-mail ou dado de cliente nos logs da frota', () => {
    const fleetLines = capture.lines.filter((line) => line.includes('"event":"rollout'));
    expect(fleetLines.length).toBeGreaterThan(0);
    expect(fleetLines.join(' ')).not.toContain(OWNER);
  });
});
