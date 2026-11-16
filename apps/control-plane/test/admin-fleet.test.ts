import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpWorkerFleetClient } from '../src/admin/worker-fleet-client.js';
import { cellSchema } from '../src/cells/cell.schema.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryStepQueue } from '../src/queue/memory-step-queue.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { FakeFleetCloud, fleetRelease } from './support/fake-fleet-cloud.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-16T12:00:00.000Z');
const WORKER_URL = 'https://cp-worker-111111111111.southamerica-east1.run.app';
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const ADMIN_SA = 'cp-admin@projeto-exemplo.iam.gserviceaccount.com';
const INVOKER = 'cp-invoker@projeto-exemplo.iam.gserviceaccount.com';

/**
 * A frota pelo console do responsável: a sessão do login próprio no cp-admin, o cliente HTTP até o cp-worker local (com
 * quem agiu no corpo, nunca o cookie), as rodadas lidas do Firestore e as recusas do worker com a mensagem do console.
 */
describe('console: atualização da frota', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const queue = new MemoryStepQueue();
  const google = new TestGoogleIdentity();
  const cloud = new FakeFleetCloud();
  const workerBodies: { path: string; body: Record<string, unknown>; cookie?: string }[] = [];
  let worker: NestExpressApplication;
  let admin: NestExpressApplication;
  let workerPort = 0;
  let ownerCookie = '';
  let strangerCookie = '';

  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    workerBodies.push({
      path: url.pathname,
      body: JSON.parse(raw) as Record<string, unknown>,
      cookie: headers.cookie,
    });
    return fetch(new URL(url.pathname, `http://127.0.0.1:${workerPort}`), init);
  };

  function send(path: string, body: unknown, cookie: string | null = ownerCookie): request.Test {
    const test = request(admin.getHttpServer()).post(path).set('Content-Type', 'application/json');
    return (cookie === null ? test : test.set('Cookie', cookie)).send(JSON.stringify(body));
  }

  function read(path: string, cookie: string | null = ownerCookie): request.Test {
    const test = request(admin.getHttpServer()).get(path);
    return cookie === null ? test : test.set('Cookie', cookie);
  }

  beforeAll(async () => {
    worker = await createApp({
      role: 'worker',
      clock,
      documentStore: documents,
      stepQueue: queue,
      idTokenKeys: google,
      fleetCloud: cloud,
      capture,
      env: {
        WORKER_URL,
        WORKER_SA_EMAIL: INVOKER,
        SCHEDULER_SA_EMAIL: INVOKER,
        OWNER_PRINCIPALS: OWNER,
        ADMIN_SA_EMAIL: ADMIN_SA,
        RELEASE_BUCKET: 'releases-demo',
      },
    });
    await worker.listen(0, '127.0.0.1');
    workerPort = (worker.getHttpServer().address() as AddressInfo).port;
    admin = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      clock,
      documentStore: documents,
      capture,
      adminSecrets: new MemoryAdminSecrets(),
      workerFleetClient: new HttpWorkerFleetClient(
        WORKER_URL,
        { get: (audience: string) => Promise.resolve(google.token({ email: ADMIN_SA, aud: audience })) },
        localFetch,
      ),
      env: { ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo', OWNER_PRINCIPALS: OWNER, WORKER_URL },
    });
    await admin.listen(0, '127.0.0.1');
    cloud.releases.set('node-v1.3.0', fleetRelease('node-v1.3.0'));
    cloud.releases.set('node-v1.2.9', 'no_panel');
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
  });

  afterAll(async () => {
    await admin.close();
    await worker.close();
  });

  beforeEach(async () => {
    workerBodies.length = 0;
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    strangerCookie = await seedOwnerSession(documents, clock, STRANGER);
  });

  it('as rotas da frota exigem a sessão de um responsável', async () => {
    await read('/v1/admin/fleet/rollouts', null).expect(401);
    await read('/v1/admin/fleet/releases', strangerCookie).expect(403);
    await send('/v1/admin/fleet/plan', { release: 'node-v1.3.0' }, null).expect(401);
    await send('/v1/admin/fleet/rollouts', { release: 'node-v1.3.0' }, strangerCookie).expect(403);
    expect(workerBodies).toHaveLength(0);
  });

  it('versões, versão de cada nó e a revisão vêm do worker, com quem agiu e sem o cookie', async () => {
    const releases = await read('/v1/admin/fleet/releases').expect(200);
    expect(releases.body).toEqual({
      releases: [
        { release: 'node-v1.3.0', commit: 'a'.repeat(40), status: 'ok' },
        { release: 'node-v1.2.9', status: 'panel_missing' },
      ],
    });
    cloud.attributes.set('verax-celula', new Map([['ready', 'node-v1.2.3']]));
    cloud.siteReleases.set('verax-control-verax', 'node-v1.2.3');
    const inventory = await read('/v1/admin/fleet/inventory').expect(200);
    expect(inventory.body).toMatchObject({
      nodes: [
        {
          key: 'cell-sp1',
          wave: 0,
          version: 'node-v1.2.3',
          panels: [{ slug: 'verax', release: 'node-v1.2.3' }],
        },
      ],
    });
    const plan = await send('/v1/admin/fleet/plan', { release: 'node-v1.3.0' }).expect(200);
    expect(plan.body).toMatchObject({
      nodes: [{ key: 'cell-sp1', instance: 'verax-celula', panels: ['verax'] }],
    });
    const refused = await send('/v1/admin/fleet/plan', { release: 'node-v1.2.9' }).expect(422);
    expect(refused.body).toMatchObject({ code: 'panel_bundle_missing' });
    expect(workerBodies.every((call) => call.body.actor === OWNER && call.cookie === undefined)).toBe(true);
  });

  it('a rodada nova, a lista, o detalhe e as operações', async () => {
    await send('/v1/admin/fleet/rollouts', { release: 'node-v1.3.0', confirmRelease: 'node-v1.3.0' }).expect(
      400,
    );
    const mismatch = await send('/v1/admin/fleet/rollouts', {
      release: 'node-v1.3.0',
      confirmRelease: 'node-v1.3.1',
      concurrency: 1,
    }).expect(400);
    expect(mismatch.body).toMatchObject({ code: 'confirmation_mismatch' });
    const created = await send('/v1/admin/fleet/rollouts', {
      release: 'node-v1.3.0',
      confirmRelease: 'node-v1.3.0',
      concurrency: 2,
      window: '02:00-05:00',
    }).expect(201);
    const id = (created.body as { rollout: { id: string } }).rollout.id;
    expect(created.body).toMatchObject({
      rollout: { state: 'running', release: 'node-v1.3.0', createdBy: OWNER, window: '02:00-05:00' },
    });
    const list = await read('/v1/admin/fleet/rollouts').expect(200);
    expect(list.body).toMatchObject({
      rollouts: [{ id, state: 'running', totals: { nodes: 1, pending: 1 } }],
    });
    const detail = await read(`/v1/admin/fleet/rollouts/${id}`).expect(200);
    expect(detail.body).toMatchObject({
      nodes: [{ key: 'cell-sp1', state: 'pending', wave: 0, instance: 'verax-celula', panels: ['verax'] }],
    });
    await read('/v1/admin/fleet/rollouts/nao-existe').expect(404);
    const paused = await send(`/v1/admin/fleet/rollouts/${id}/pause`, {}).expect(200);
    expect(paused.body).toMatchObject({ rollout: { state: 'paused' } });
    const skipped = await send(`/v1/admin/fleet/rollouts/${id}/nodes/cell-sp1/skip`, {}).expect(200);
    expect(skipped.body).toMatchObject({ nodes: [{ key: 'cell-sp1', state: 'skipped' }] });
    const notPaused = await send(`/v1/admin/fleet/rollouts/${id}/pause`, {}).expect(409);
    expect(notPaused.body).toMatchObject({ code: 'rollout_not_running' });
    await send(`/v1/admin/fleet/rollouts/${id}/abort`, {}).expect(200);
    await send(`/v1/admin/fleet/rollouts/${id}/explode`, {}).expect(404);
    const audit = await documents.query(COLLECTIONS.auditLog);
    expect(
      audit.filter((doc) => String(doc.data.action).startsWith('rollout.')).map((doc) => doc.data.actor),
    ).toEqual(expect.arrayContaining([`owner:${OWNER}`]));
  });
});
