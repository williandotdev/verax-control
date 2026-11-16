import type { PinoLogger } from 'nestjs-pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock, MINUTE_MS } from '../../test/support/fake-clock.js';
import { FakeFleetCloud, fleetRelease } from '../../test/support/fake-fleet-cloud.js';
import { AuditService } from '../audit/audit.service.js';
import { CellStore } from '../cells/cell-store.js';
import { ApiError } from '../common/http/api-error.js';
import { newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import { MemoryStepQueue } from '../queue/memory-step-queue.js';
import { TenantStore } from '../tenants/tenant-store.js';
import type { FleetSettings } from './fleet-settings.js';
import { FleetStore, totalsOf } from './fleet-store.js';
import type { Rollout, RolloutNodeRecord } from './fleet.schema.js';
import { FleetService } from './fleet.service.js';
import { FLEET_TICK_STEP, FLEET_WAITS, RolloutEngine } from './rollout-engine.js';

const START = new Date('2026-11-16T12:00:00.000Z');
const SETTINGS: FleetSettings = {
  releaseBucket: 'releases-demo',
  apiDomainPrefix: 'api-',
  zoneName: 'veraxsistemas.com.br',
};
const OWNER = 'owner:responsavel@exemplo.example';

/** Um logger que guarda as linhas (o primeiro argumento de cada chamada). */
function recordingLogger(lines: Record<string, unknown>[]): PinoLogger {
  const push = (entry: unknown): void => {
    if (typeof entry === 'object' && entry !== null) lines.push(entry as Record<string, unknown>);
  };
  return {
    trace: push,
    debug: push,
    info: push,
    warn: push,
    error: push,
    fatal: push,
  } as unknown as PinoLogger;
}

function site(slug: string): { project: string; siteId: string; slug: string } {
  return { project: 'projeto-paineis', siteId: `vxc-${slug}-a1b2c3`, slug };
}

function node(
  key: string,
  wave: 0 | 1 | 2,
  order: number,
  instance: string,
  label: string,
  panels: string[] = [label],
): RolloutNodeRecord {
  return {
    key,
    kind: key.startsWith('cell-') ? 'cell' : 'dedicated',
    wave,
    order,
    label,
    target: { project: 'projeto-exemplo-nos', zone: 'southamerica-east1-b', instance },
    apiOrigin: `https://api-${label}.veraxsistemas.com.br`,
    panels: panels.map(site),
    state: 'pending',
    attempt: 0,
    healthPolls: 0,
    panelsDone: 0,
    updatedAt: START,
    rev: 0,
  };
}

const TENANT_A = `tenant-${newUlid(START.getTime())}`;
const TENANT_B = `tenant-${newUlid(START.getTime() + 1)}`;
const TENANT_C = `tenant-${newUlid(START.getTime() + 2)}`;

describe('motor da frota (rodadas em ondas)', () => {
  let documents: MemoryDocumentStore;
  let clock: FakeClock;
  let queue: MemoryStepQueue;
  let cloud: FakeFleetCloud;
  let store: FleetStore;
  let engine: RolloutEngine;
  let fleet: FleetService;
  let lines: Record<string, unknown>[];

  beforeEach(() => {
    documents = new MemoryDocumentStore();
    clock = new FakeClock(START);
    queue = new MemoryStepQueue();
    cloud = new FakeFleetCloud();
    lines = [];
    const audit = new AuditService(documents, clock);
    store = new FleetStore(documents, audit, clock);
    engine = new RolloutEngine(store, queue, clock, cloud, SETTINGS, recordingLogger(lines));
    fleet = new FleetService(
      store,
      engine,
      new TenantStore(documents, clock, audit),
      new CellStore(documents),
      clock,
      cloud,
      SETTINGS,
      recordingLogger(lines),
    );
    cloud.releases.set('node-v1.3.0', fleetRelease('node-v1.3.0'));
    cloud.releases.set('node-v1.2.3', fleetRelease('node-v1.2.3', 'c'));
  });

  async function seed(
    nodes: RolloutNodeRecord[],
    options: Partial<Pick<Rollout, 'concurrency' | 'window' | 'intent'>> = {},
  ): Promise<string> {
    const id = newUlid(clock.now().getTime());
    const rollout: Rollout = {
      release: fleetRelease('node-v1.3.0'),
      intent: options.intent ?? 'upgrade',
      state: 'running',
      concurrency: options.concurrency ?? 1,
      ...(options.window === undefined ? {} : { window: options.window }),
      nodeTimeoutMinutes: 60,
      createdBy: OWNER,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      nextTick: 0,
      totals: totalsOf(nodes),
    };
    await store.create(id, rollout, nodes, {
      actor: OWNER,
      action: 'rollout.created',
      details: { rolloutId: id },
    });
    return id;
  }

  /** Uma volta, com o número que a rodada espera agora. */
  async function tick(id: string): Promise<string> {
    const rollout = await store.get(id);
    if (rollout === undefined) throw new Error('rodada sumiu');
    clock.advance(FLEET_WAITS.tickMs);
    return engine.tick(id, rollout.nextTick);
  }

  async function nodeOf(id: string, key: string): Promise<RolloutNodeRecord> {
    const found = (await store.nodes(id)).find((candidate) => candidate.key === key);
    if (found === undefined) throw new Error(`nó ${key} sumiu`);
    return found;
  }

  /** Voltas até o nó chegar ao estado (o host responde `ok` quando recebe o pedido). */
  async function runUntil(id: string, key: string, state: string, hostOk = true, limit = 20): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      const current = await nodeOf(id, key);
      if (current.state === state) return;
      if (hostOk && current.state === 'updating' && current.requestedAt !== undefined) {
        cloud.host(current.target.instance, 'ok');
      }
      await tick(id);
    }
    throw new Error(`o nó ${key} não chegou a ${state}: ${(await nodeOf(id, key)).state}`);
  }

  function requested(): string[] {
    return cloud.events
      .filter((event) => event.startsWith('request:'))
      .map((event) => event.split(':')[1] ?? '');
  }

  it('ondas: a célula da Verax sozinha, depois as outras células, depois os dedicados em lotes', async () => {
    const id = await seed(
      [
        node('cell-sp1', 0, 0, 'verax-celula', 'verax', ['verax', 'cliente-demo-b']),
        node('cell-sp2', 1, 1, 'verax-celula-2', 'cliente-demo-d'),
        node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a'),
        node(TENANT_B, 2, 1, 'vx-cliente-demo-c', 'cliente-demo-c'),
        node(TENANT_C, 2, 2, 'vx-cliente-demo-e', 'cliente-demo-e'),
      ],
      { concurrency: 2 },
    );
    expect(await engine.tick(id, 0)).toBe('continuing');
    expect(requested()).toEqual(['verax-celula']);
    await tick(id);
    expect(requested()).toEqual(['verax-celula']);
    await runUntil(id, 'cell-sp1', 'done');
    await tick(id);
    expect(requested()).toEqual(['verax-celula', 'verax-celula-2']);
    await runUntil(id, 'cell-sp2', 'done');
    await tick(id);
    // Os dedicados: dois de cada vez; o terceiro espera um terminar.
    expect(requested().slice(2)).toEqual(['vx-cliente-demo-a', 'vx-cliente-demo-c']);
    await runUntil(id, TENANT_A, 'done');
    await runUntil(id, TENANT_B, 'done');
    await runUntil(id, TENANT_C, 'done');
    const rollout = await store.get(id);
    expect(rollout?.state).toBe('completed');
    expect(rollout?.totals).toMatchObject({ nodes: 5, done: 5, pending: 0, inFlight: 0 });
    // Concluída: nenhuma volta a mais na fila depois da última.
    const ticks = queue.tasks.filter((task) => task.step === FLEET_TICK_STEP).length;
    expect(await engine.tick(id, rollout?.nextTick ?? 0)).toBe('completed');
    expect(queue.tasks.filter((task) => task.step === FLEET_TICK_STEP)).toHaveLength(ticks);
    expect(lines.some((line) => line.event === 'rollout_completed')).toBe(true);
    const audits = await documents.query(COLLECTIONS.auditLog);
    expect(audits.map((doc) => doc.data.action)).toContain('rollout.completed');
  });

  it('o pedido vai aos metadados com a versão, o SHA-256, o id e a intenção; o painel só sai depois do nó', async () => {
    const id = await seed([node('cell-sp1', 0, 0, 'verax-celula', 'verax', ['verax', 'cliente-demo-b'])]);
    await engine.tick(id, 0);
    expect(cloud.requests.get('verax-celula')).toEqual({
      release: 'node-v1.3.0',
      packageSha256: 'a'.repeat(64),
      request: `${id}-1`,
      intent: 'upgrade',
    });
    // O host ainda instalando: nada de API pública nem de painel.
    cloud.attributes.set(
      'verax-celula',
      new Map([
        ['update-request', `${id}-1`],
        ['update-state', 'installing'],
      ]),
    );
    await tick(id);
    await tick(id);
    expect((await nodeOf(id, 'cell-sp1')).nodeState).toBe('installing');
    expect(
      cloud.events.filter((event) => event.startsWith('health:') || event.startsWith('publish:')),
    ).toEqual([]);
    // Um `ok` de outro pedido (o anterior) não conta.
    cloud.attributes.set(
      'verax-celula',
      new Map([
        ['update-request', 'outro-pedido-1'],
        ['update-state', 'ok'],
        ['update-release', 'node-v1.3.0'],
      ]),
    );
    await tick(id);
    expect((await nodeOf(id, 'cell-sp1')).state).toBe('updating');
    await runUntil(id, 'cell-sp1', 'done');
    const health = cloud.events.indexOf('health:https://api-verax.veraxsistemas.com.br');
    const publishes = cloud.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.startsWith('publish:'));
    expect(health).toBeGreaterThan(0);
    // Cada site com a API do próprio cliente na CSP, depois da conferência do nó.
    expect(publishes.map(({ event }) => event)).toEqual([
      'publish:vxc-verax-a1b2c3:node-v1.3.0:https://api-verax.veraxsistemas.com.br',
      'publish:vxc-cliente-demo-b-a1b2c3:node-v1.3.0:https://api-cliente-demo-b.veraxsistemas.com.br',
    ]);
    expect(publishes.every(({ index }) => index > health)).toBe(true);
    // O bundle sai do bucket uma vez para os dois sites.
    expect(cloud.bundleLoads).toBe(1);
    expect((await nodeOf(id, 'cell-sp1')).panelsDone).toBe(2);
  });

  it('para na primeira falha e não começa mais nenhum nó; retomar tenta de novo com outro pedido', async () => {
    const id = await seed([
      node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a'),
      node(TENANT_B, 2, 1, 'vx-cliente-demo-c', 'cliente-demo-c'),
    ]);
    await engine.tick(id, 0);
    cloud.host('vx-cliente-demo-a', 'rolled_back', 'health_failed');
    expect(await tick(id)).toBe('paused_on_failure');
    const failed = await nodeOf(id, TENANT_A);
    expect(failed.state).toBe('failed');
    expect(failed.errorCode).toBe('node_rolled_back:health_failed');
    const rollout = await store.get(id);
    expect(rollout?.state).toBe('paused_on_failure');
    expect(rollout?.failure).toMatchObject({ nodeKey: TENANT_A, code: 'node_rolled_back:health_failed' });
    expect(lines.find((line) => line.event === 'rollout_failed')).toMatchObject({
      rolloutId: id,
      nodeKey: TENANT_A,
      code: 'node_rolled_back:health_failed',
    });
    // O resto fica como estava: nenhum pedido, nenhum painel, nenhuma volta a mais.
    const tasks = queue.tasks.length;
    expect(await engine.tick(id, rollout?.nextTick ?? 0)).toBe('paused_on_failure');
    expect(requested()).toEqual(['vx-cliente-demo-a']);
    expect(cloud.events.some((event) => event.startsWith('publish:'))).toBe(false);
    expect((await nodeOf(id, TENANT_B)).state).toBe('pending');
    expect(queue.tasks.length).toBe(tasks);

    // Retomar: o nó que falhou volta à fila e recebe um pedido novo (o host nunca repete o mesmo).
    await fleet.act(id, 'resume', OWNER);
    expect(queue.tasks.length).toBe(tasks + 1);
    await tick(id);
    expect(cloud.requests.get('vx-cliente-demo-a')?.request).toBe(`${id}-2`);
    expect((await store.get(id))?.failure).toBeUndefined();
    await runUntil(id, TENANT_A, 'done');
    await runUntil(id, TENANT_B, 'done');
    expect((await store.get(id))?.state).toBe('completed');
  });

  it('prazo do host: sem `ok` em 60 min, `update_timeout`; com janela, um dia a mais', async () => {
    const id = await seed([node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a')]);
    await engine.tick(id, 0);
    clock.advance(59 * MINUTE_MS);
    await tick(id);
    expect((await nodeOf(id, TENANT_A)).state).toBe('updating');
    clock.advance(MINUTE_MS);
    await tick(id);
    expect((await nodeOf(id, TENANT_A)).errorCode).toBe('update_timeout');

    const windowed = await seed([node(TENANT_B, 2, 0, 'vx-cliente-demo-c', 'cliente-demo-c')], {
      window: '02:00-05:00',
    });
    await engine.tick(windowed, 0);
    expect(cloud.requests.get('vx-cliente-demo-c')?.window).toBe('02:00-05:00');
    clock.advance(2 * 60 * MINUTE_MS);
    await tick(windowed);
    expect((await nodeOf(windowed, TENANT_B)).state).toBe('updating');
    clock.advance(24 * 60 * MINUTE_MS);
    await tick(windowed);
    expect((await nodeOf(windowed, TENANT_B)).errorCode).toBe('update_timeout');
  });

  it('a API pública fora: `health_failed` depois de 10 conferências, sem publicar o painel', async () => {
    const id = await seed([node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a')]);
    cloud.unhealthy.add('https://api-cliente-demo-a.veraxsistemas.com.br');
    await engine.tick(id, 0);
    cloud.host('vx-cliente-demo-a', 'ok');
    await tick(id);
    for (let index = 0; index < 9; index += 1) await tick(id);
    expect((await nodeOf(id, TENANT_A)).state).toBe('checking');
    await tick(id);
    const failed = await nodeOf(id, TENANT_A);
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'health_failed', healthPolls: 10 });
    expect(cloud.events.some((event) => event.startsWith('publish:'))).toBe(false);
  });

  it('idempotência: a mesma volta de novo, a volta perdida na fila e a entrega simultânea', async () => {
    const id = await seed([node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a')]);
    await engine.tick(id, 0);
    expect(await engine.tick(id, 0)).toBe('stale_tick');
    expect(requested()).toEqual(['vx-cliente-demo-a']);
    expect(await engine.tick(id, 5)).toBe('not_current');

    // A fila falha depois de a volta gravar a seguinte: a repetição da mesma volta a põe.
    queue.failNext(new Error('fila fora do ar'));
    clock.advance(FLEET_WAITS.tickMs);
    await expect(engine.tick(id, 1)).rejects.toThrow('fila fora do ar');
    expect(queue.tasks.some((task) => task.poll === 2)).toBe(false);
    expect(await engine.tick(id, 1)).toBe('stale_tick');
    expect(queue.tasks.filter((task) => task.poll === 2)).toHaveLength(1);

    // Outra entrega da mesma volta rodando agora: esta espera (503, o Cloud Tasks repete).
    await store.change(id, (rollout, _nodes, now) => ({
      rollout: { ...rollout, lease: { tick: 2, until: new Date(now.getTime() + MINUTE_MS) } },
      nodes: [],
    }));
    await expect(engine.tick(id, 2)).rejects.toBeInstanceOf(ApiError);
    // A concessão vencida (a entrega caiu no meio): a volta segue.
    clock.advance(10 * MINUTE_MS);
    expect(await engine.tick(id, 2)).toBe('continuing');
  });

  it('erro passageiro da nuvem não para o nó; a recusa (403) para', async () => {
    const id = await seed([
      node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a'),
      node(TENANT_B, 2, 1, 'vx-cliente-demo-c', 'cliente-demo-c'),
    ]);
    cloud.failures.set('request', [new CloudApiError('compute', 'instance_set_metadata', 503)]);
    await engine.tick(id, 0);
    const waiting = await nodeOf(id, TENANT_A);
    expect(waiting.state).toBe('updating');
    expect(waiting.requestedAt).toBeUndefined();
    expect(lines.some((line) => line.event === 'rollout_node_retry')).toBe(true);
    await tick(id);
    expect((await nodeOf(id, TENANT_A)).requestedAt).toBeDefined();
    // A recusa chega quando o segundo nó começa (na mesma volta em que o primeiro termina).
    cloud.failures.set('request', [new CloudApiError('compute', 'instance_set_metadata', 403)]);
    await runUntil(id, TENANT_A, 'done');
    expect(await nodeOf(id, TENANT_B)).toMatchObject({ state: 'failed', errorCode: 'compute_denied' });
    expect((await store.get(id))?.state).toBe('paused_on_failure');
  });

  it('a publicação que falha num site guarda o progresso dos anteriores e tenta de novo', async () => {
    const id = await seed([node('cell-sp1', 0, 0, 'verax-celula', 'verax', ['verax', 'cliente-demo-b'])]);
    await engine.tick(id, 0);
    cloud.host('verax-celula', 'ok');
    await tick(id);
    await tick(id);
    expect((await nodeOf(id, 'cell-sp1')).state).toBe('publishing');
    // O primeiro site publica; o segundo falha (passageiro).
    cloud.failures.set('publish', [undefined, new CloudApiError('firebase', 'version_create', 503)]);
    await tick(id);
    expect(await nodeOf(id, 'cell-sp1')).toMatchObject({ state: 'publishing', panelsDone: 1 });
    expect(cloud.siteReleases.get('vxc-verax-a1b2c3')).toBe('node-v1.3.0');
    await tick(id);
    expect(await nodeOf(id, 'cell-sp1')).toMatchObject({ state: 'done', panelsDone: 2 });
  });

  it('pular um nó e abortar: nada novo começa, e o que estava mudando termina', async () => {
    const id = await seed(
      [
        node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a'),
        node(TENANT_B, 2, 1, 'vx-cliente-demo-c', 'cliente-demo-c'),
        node(TENANT_C, 2, 2, 'vx-cliente-demo-e', 'cliente-demo-e'),
      ],
      { concurrency: 1 },
    );
    await fleet.actOnNode(id, TENANT_B, 'skip', OWNER);
    await expect(fleet.actOnNode(id, TENANT_B, 'skip', OWNER)).rejects.toMatchObject({
      code: 'node_not_skippable',
    });
    await engine.tick(id, (await store.get(id))?.nextTick ?? 0);
    await expect(fleet.actOnNode(id, TENANT_A, 'skip', OWNER)).rejects.toMatchObject({
      code: 'node_in_flight',
    });
    await fleet.act(id, 'abort', OWNER);
    await runUntil(id, TENANT_A, 'done');
    await tick(id);
    expect(requested()).toEqual(['vx-cliente-demo-a']);
    const rollout = await store.get(id);
    expect(rollout?.state).toBe('aborted');
    expect(rollout?.totals).toMatchObject({ done: 1, skipped: 1, pending: 1 });
    await expect(fleet.act(id, 'resume', OWNER)).rejects.toMatchObject({ code: 'rollout_not_paused' });
    const actions = (await documents.query(COLLECTIONS.auditLog)).map((doc) => doc.data.action);
    expect(actions).toEqual(expect.arrayContaining(['rollout.node_skipped', 'rollout.aborted']));
  });

  it('parar e retomar: o nó em andamento termina; nenhum novo começa até retomar', async () => {
    const id = await seed([
      node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a'),
      node(TENANT_B, 2, 1, 'vx-cliente-demo-c', 'cliente-demo-c'),
    ]);
    await engine.tick(id, 0);
    await fleet.act(id, 'pause', OWNER);
    await runUntil(id, TENANT_A, 'done');
    await tick(id);
    expect(requested()).toEqual(['vx-cliente-demo-a']);
    expect((await store.get(id))?.state).toBe('paused');
    await fleet.act(id, 'resume', OWNER);
    await tick(id);
    expect(requested()).toEqual(['vx-cliente-demo-a', 'vx-cliente-demo-c']);
  });

  it('voltar um nó: o pedido com `rollback` para a versão de antes, e o painel dessa versão', async () => {
    cloud.attributes.set('vx-cliente-demo-a', new Map([['ready', 'node-v1.2.3']]));
    const id = await seed([node(TENANT_A, 2, 0, 'vx-cliente-demo-a', 'cliente-demo-a')]);
    await engine.tick(id, 0);
    expect((await nodeOf(id, TENANT_A)).fromVersion).toBe('node-v1.2.3');
    await runUntil(id, TENANT_A, 'done');
    expect((await store.get(id))?.state).toBe('completed');

    await fleet.actOnNode(id, TENANT_A, 'rollback', OWNER);
    await tick(id);
    expect(cloud.requests.get('vx-cliente-demo-a')).toMatchObject({
      release: 'node-v1.2.3',
      intent: 'rollback',
      request: `${id}-2`,
      packageSha256: 'c'.repeat(64),
    });
    await runUntil(id, TENANT_A, 'reverted');
    expect(cloud.siteReleases.get('vxc-cliente-demo-a-a1b2c3')).toBe('node-v1.2.3');
    expect((await nodeOf(id, TENANT_A)).fromVersion).toBe('node-v1.2.3');
    const rollout = await store.get(id);
    expect(rollout?.state).toBe('completed');
    expect(rollout?.totals).toMatchObject({ reverted: 1, done: 0 });
    // Sem uma versão publicada antes (um nó do deploy.sh, só o commit), não há volta pela frota.
    const other = await seed([node(TENANT_B, 2, 0, 'vx-cliente-demo-c', 'cliente-demo-c')]);
    cloud.attributes.set('vx-cliente-demo-c', new Map([['version', 'c'.repeat(40)]]));
    await engine.tick(other, 0);
    await runUntil(other, TENANT_B, 'done');
    await expect(fleet.actOnNode(other, TENANT_B, 'rollback', OWNER)).rejects.toMatchObject({
      code: 'rollback_unavailable',
    });
  });
});
