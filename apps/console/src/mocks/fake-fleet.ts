import type {
  FleetPlan,
  Inventory,
  ReleaseEntry,
  Rollout,
  RolloutNode,
  RolloutRequest,
} from '@/features/fleet/api';

/**
 * A frota simulada do console (as versões, os nós e as rodadas), com dados FICTÍCIOS: a célula da Verax, um nó dedicado
 * e duas versões no bucket. O motor não roda aqui: as rodadas mudam só pelas operações do responsável, e o teste põe o
 * estado que quiser em `rollouts`.
 */
export interface FakeFleetState {
  releases: ReleaseEntry[];
  inventory: Inventory;
  rollouts: Map<string, { rollout: Rollout; nodes: RolloutNode[] }>;
  /** O último pedido de rodada que chegou (o teste confere o que a tela mandou). */
  lastRequest?: RolloutRequest;
  sequence: number;
}

const CELL_NODE = { key: 'cell-sp1', kind: 'cell' as const, wave: 0, label: 'sp1', instance: 'verax-celula' };
const DEDICATED_NODE = {
  key: 'tenant-01JC0000000000000000000D01',
  kind: 'dedicated' as const,
  wave: 2,
  label: 'cliente-demo-d',
  instance: 'vx-cliente-demo-d',
};

export function createFakeFleet(now: Date): FakeFleetState {
  const state: FakeFleetState = {
    releases: [
      { release: 'node-v1.3.0', commit: 'a'.repeat(40), status: 'ok' },
      { release: 'node-v1.2.3', commit: 'c'.repeat(40), status: 'panel_missing' },
    ],
    inventory: {
      nodes: [
        {
          ...CELL_NODE,
          version: 'node-v1.2.3',
          updateState: 'ok',
          panels: [{ slug: 'verax', release: 'node-v1.2.3' }],
        },
        {
          ...DEDICATED_NODE,
          version: 'node-v1.2.3',
          panels: [{ slug: 'cliente-demo-d', release: 'node-v1.2.3' }],
        },
      ],
      excluded: [
        {
          key: 'tenant-01JC0000000000000000000E01',
          label: 'cliente-demo-e',
          kind: 'dedicated',
          reason: 'tenant_stopped',
        },
      ],
    },
    rollouts: new Map(),
    sequence: 0,
  };
  const id = '01JD0000000000000000000R01';
  const at = new Date(now.getTime() - 60 * 60_000).toISOString();
  state.rollouts.set(id, {
    rollout: {
      id,
      release: 'node-v1.2.3',
      commit: 'c'.repeat(40),
      intent: 'upgrade',
      state: 'paused_on_failure',
      concurrency: 1,
      createdBy: 'responsavel@verax.example',
      createdAt: at,
      updatedAt: at,
      failure: { nodeKey: DEDICATED_NODE.key, code: 'node_rolled_back:health_failed', at },
      totals: { nodes: 2, pending: 0, inFlight: 0, done: 1, failed: 1, skipped: 0, reverted: 0 },
    },
    nodes: [
      {
        ...CELL_NODE,
        state: 'done',
        attempt: 1,
        fromVersion: 'node-v1.2.2',
        panels: ['verax'],
        panelsDone: 1,
      },
      {
        ...DEDICATED_NODE,
        state: 'failed',
        attempt: 1,
        fromVersion: 'node-v1.2.2',
        nodeState: 'rolled_back',
        errorCode: 'node_rolled_back:health_failed',
        panels: ['cliente-demo-d'],
        panelsDone: 0,
      },
    ],
  });
  return state;
}

type FakeResponse = { status: number; body: unknown };

function failure(status: number, message: string, code: string): FakeResponse {
  return { status, body: { statusCode: status, message, code } };
}

function totals(nodes: RolloutNode[]): Rollout['totals'] {
  const count = (states: RolloutNode['state'][]) =>
    nodes.filter((node) => states.includes(node.state)).length;
  return {
    nodes: nodes.length,
    pending: count(['pending']),
    inFlight: count(['updating', 'checking', 'publishing']),
    done: count(['done']),
    failed: count(['failed']),
    skipped: count(['skipped']),
    reverted: count(['reverted']),
  };
}

function active(state: FakeFleetState): Rollout | undefined {
  return [...state.rollouts.values()]
    .map((entry) => entry.rollout)
    .find((rollout) => ['running', 'paused', 'paused_on_failure'].includes(rollout.state));
}

function plan(state: FakeFleetState, release: string): FakeResponse {
  const entry = state.releases.find((candidate) => candidate.release === release);
  if (entry === undefined)
    return failure(422, 'A versão não está no bucket de releases.', 'release_manifest_missing');
  if (entry.status !== 'ok') {
    return failure(422, 'Esta versão não tem o bundle do painel.', 'panel_bundle_missing');
  }
  const body: FleetPlan = {
    release: { release, commit: entry.commit ?? '' },
    nodes: [
      { ...CELL_NODE, panels: ['verax'] },
      { ...DEDICATED_NODE, panels: ['cliente-demo-d'] },
    ],
    excluded: state.inventory.excluded,
    ...(active(state) === undefined ? {} : { activeRolloutId: active(state)?.id }),
  };
  return { status: 200, body };
}

/** Atende `/v1/admin/fleet/...` (as partes depois de `fleet`). */
export function handleFleetRequest(
  state: FakeFleetState,
  now: Date,
  email: string,
  method: string,
  parts: string[],
  body: unknown,
): FakeResponse {
  const [first, id, third, key, action] = parts;
  if (method === 'GET' && first === 'releases') return { status: 200, body: { releases: state.releases } };
  if (method === 'GET' && first === 'inventory') return { status: 200, body: state.inventory };
  if (method === 'POST' && first === 'plan') return plan(state, (body as { release?: string }).release ?? '');
  if (first !== 'rollouts') return failure(404, 'Recurso não encontrado', 'not_found');
  if (method === 'GET' && id === undefined) {
    const rollouts = [...state.rollouts.values()]
      .map((entry) => entry.rollout)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return { status: 200, body: { rollouts } };
  }
  if (method === 'POST' && id === undefined) {
    const request = body as RolloutRequest;
    state.lastRequest = request;
    if (request.confirmRelease !== request.release) {
      return failure(
        400,
        'A versão digitada não confere com a escolhida: nada foi promovido.',
        'confirmation_mismatch',
      );
    }
    if (active(state) !== undefined)
      return failure(409, 'Já existe uma rodada da frota em andamento.', 'rollout_active');
    state.sequence += 1;
    const newId = `01JD00000000000000000N${String(state.sequence).padStart(4, '0')}`;
    const nodes: RolloutNode[] = [
      { ...CELL_NODE, state: 'pending', attempt: 0, panels: ['verax'], panelsDone: 0 },
      { ...DEDICATED_NODE, state: 'pending', attempt: 0, panels: ['cliente-demo-d'], panelsDone: 0 },
    ];
    const rollout: Rollout = {
      id: newId,
      release: request.release,
      commit: 'a'.repeat(40),
      intent: 'upgrade',
      state: 'running',
      concurrency: request.concurrency,
      ...(request.window === undefined ? {} : { window: request.window }),
      createdBy: email,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      totals: totals(nodes),
    };
    state.rollouts.set(newId, { rollout, nodes });
    return { status: 201, body: { rollout } };
  }
  const entry = id === undefined ? undefined : state.rollouts.get(id);
  if (entry === undefined) return failure(404, 'Rodada ou nó não encontrado.', 'not_found');
  if (method === 'GET' && third === undefined) return { status: 200, body: entry };
  if (method !== 'POST') return failure(404, 'Recurso não encontrado', 'not_found');
  const rollout = entry.rollout;
  if (third === 'nodes') {
    const node = entry.nodes.find((candidate) => candidate.key === key);
    if (node === undefined) return failure(404, 'Rodada ou nó não encontrado.', 'not_found');
    if (action === 'skip') {
      if (node.state !== 'pending' && node.state !== 'failed') {
        return failure(409, 'Só um nó na fila ou com falha pode ser pulado.', 'node_not_skippable');
      }
      node.state = 'skipped';
    } else if (action === 'rollback') {
      node.state = 'pending';
      node.operation = { kind: 'revert', release: node.fromVersion ?? '' };
      delete node.errorCode;
    } else {
      return failure(404, 'Recurso não encontrado', 'not_found');
    }
    rollout.totals = totals(entry.nodes);
    return { status: 200, body: entry };
  }
  if (third === 'pause') {
    if (rollout.state !== 'running') return failure(409, 'A rodada não está andando.', 'rollout_not_running');
    rollout.state = 'paused';
  } else if (third === 'resume') {
    if (rollout.state !== 'paused' && rollout.state !== 'paused_on_failure') {
      return failure(409, 'A rodada não está parada.', 'rollout_not_paused');
    }
    rollout.state = 'running';
    delete rollout.failure;
    for (const node of entry.nodes) {
      if (node.state === 'failed') {
        node.state = 'pending';
        delete node.errorCode;
      }
    }
  } else if (third === 'abort') {
    if (!['running', 'paused', 'paused_on_failure'].includes(rollout.state)) {
      return failure(409, 'A rodada já terminou.', 'rollout_finished');
    }
    rollout.state = 'aborted';
    rollout.finishedAt = now.toISOString();
  } else {
    return failure(404, 'Recurso não encontrado', 'not_found');
  }
  rollout.totals = totals(entry.nodes);
  return { status: 200, body: { rollout } };
}
