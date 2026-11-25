import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { caseKeyOf } from './case-key.js';
import { RecentOpenings } from './case-limits.js';
import {
  byArrival,
  type OpenCase,
  planBatch,
  type PlanFinding,
  type PlanInput,
  SAMPLE_LIMITS,
  SAMPLE_VALUE_MAX,
  touchesProtected,
  uuidV7,
} from './case-plan.js';

const T0 = new Date('2026-11-02T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let counter = 0;
function finding(overrides: Partial<PlanFinding> = {}): PlanFinding {
  counter += 1;
  return {
    id: `01a00000-0000-7000-8000-${String(counter).padStart(12, '0')}`,
    createdAt: T0,
    occurredAt: overrides.createdAt ?? T0,
    lastSeenAt: null,
    severity: 'high',
    accountId: '111122223333',
    logSource: 'cloudtrail',
    ruleId: '100305',
    title: 'x',
    eventName: null,
    resource: null,
    actorUser: 'maria',
    accessKeyId: null,
    sourceIp: null,
    caseGroup: null,
    mitreTactics: [],
    mitreTechniques: [],
    ...overrides,
  };
}

function plan(findings: readonly PlanFinding[], overrides: Partial<PlanInput> = {}) {
  let next = 0;
  return planBatch({
    findings,
    now: at(365 * DAY_MS),
    noticedByAlert: false,
    open: new Map(),
    previous: new Map(),
    openings: new RecentOpenings(),
    protectedItems: new Set(),
    newId: () => `caso-${(next += 1)}`,
    ...overrides,
  });
}

function openCase(of: PlanFinding, overrides: Partial<OpenCase> = {}): OpenCase {
  const key = caseKeyOf(of);
  return {
    id: 'aberto',
    groupKey: key.groupKey,
    queue: key.queue,
    openedAt: T0,
    lastAlertAt: T0,
    firstSeenAt: T0,
    lastSeenAt: T0,
    pending: true,
    promoted: false,
    treated: false,
    recurrence: 0,
    noticedSeverity: null,
    ruleIds: ['100305'],
    accounts: [],
    actors: [],
    ips: [],
    resources: [],
    mitreTactics: [],
    mitreTechniques: [],
    ...overrides,
  };
}
const opened = (of: PlanFinding, overrides: Partial<OpenCase> = {}) => {
  const row = openCase(of, overrides);
  return new Map([[row.groupKey, row]]);
};

describe('o plano de um lote', () => {
  it('cada alerta vai para um caso só, na ordem de chegada, seja qual for a ordem em que veio', () => {
    const findings = [
      finding({ createdAt: at(3) }),
      finding({ createdAt: at(1) }),
      finding({ createdAt: at(2), ruleId: '100306' }),
      finding({ createdAt: at(1) }),
    ];
    const result = plan(findings);
    expect(result.created.map(({ id, anchorFindingId }) => [id, anchorFindingId])).toEqual([
      ['caso-1', findings[1]?.id],
      ['caso-2', findings[2]?.id],
    ]);
    expect(result.assignments).toEqual([
      { findingId: findings[1]?.id, caseId: 'caso-1', group: null },
      { findingId: findings[3]?.id, caseId: 'caso-1', group: null },
      { findingId: findings[2]?.id, caseId: 'caso-2', group: null },
      { findingId: findings[0]?.id, caseId: 'caso-1', group: null },
    ]);
    expect(result).toMatchObject({ touched: [], sealed: [] });
    expect([...findings].sort(byArrival).map(({ id }) => id)).toEqual(
      result.assignments.map(({ findingId }) => findingId),
    );
  });

  it('o caso do banco que continua: junta, e não muda o que entrou', () => {
    const alert = finding({ createdAt: at(HOUR_MS), occurredAt: at(-HOUR_MS), sourceIp: '203.0.113.9' });
    const open = opened(alert);
    const before = structuredClone([...open]);
    const result = plan([alert], { open });
    expect(result.created).toEqual([]);
    expect(result.sealed).toEqual([]);
    expect(result.touched).toEqual([
      {
        id: 'aberto',
        firstSeenAt: at(-HOUR_MS),
        lastSeenAt: T0,
        lastAlertAt: at(HOUR_MS),
        noticedSeverity: null,
        ruleIds: ['100305'],
        accounts: ['111122223333'],
        actors: ['maria'],
        ips: ['203.0.113.9'],
        resources: [],
        mitreTactics: [],
        mitreTechniques: [],
      },
    ]);
    expect([...open]).toEqual(before);
  });

  it('o que fica no lugar de um caso do banco só abre depois dele; o do meio já nasce selado', () => {
    const findings = [0, 3, 6].map((day) => finding({ createdAt: at(day * DAY_MS) }));
    const result = plan(findings, { open: opened(findings[0] as PlanFinding, { recurrence: 2 }) });
    expect(result.sealed).toEqual([{ id: 'aberto', reason: 'window' }]);
    expect(
      result.created.map(({ id, previousCaseId, recurrence, state }) => ({
        id,
        previousCaseId,
        recurrence,
        state,
      })),
    ).toEqual([
      { id: 'caso-1', previousCaseId: 'aberto', recurrence: 3, state: { kind: 'sealed', reason: 'window' } },
      { id: 'caso-2', previousCaseId: 'caso-1', recurrence: 4, state: { kind: 'replaces' } },
    ]);
    // O do banco recebeu o primeiro antes de ser selado.
    expect(result.touched.map(({ id }) => id)).toEqual(['aberto']);
  });

  it('sem caso aberto no banco, o último da cadeia nasce aberto; com um anterior selado, é a volta dele', () => {
    const findings = [0, 3].map((day) => finding({ createdAt: at(day * DAY_MS) }));
    const { groupKey } = caseKeyOf(findings[0] as PlanFinding);
    const result = plan(findings, { previous: new Map([[groupKey, { id: 'antigo', recurrence: 7 }]]) });
    expect(result.sealed).toEqual([]);
    expect(
      result.created.map(({ previousCaseId, recurrence, state }) => [previousCaseId, recurrence, state]),
    ).toEqual([
      ['antigo', 8, { kind: 'sealed', reason: 'window' }],
      ['caso-1', 9, { kind: 'open' }],
    ]);
  });

  it('o caso sem pendência recebe um alerta e volta a ter: os seguintes do lote entram no mesmo', () => {
    const findings = [finding({ createdAt: at(1) }), finding({ createdAt: at(2) })];
    const treated = plan(findings, {
      open: opened(findings[0] as PlanFinding, { pending: false, treated: true }),
    });
    expect(treated.sealed).toEqual([{ id: 'aberto', reason: 'treated' }]);
    expect(treated.assignments.map(({ caseId }) => caseId)).toEqual(['caso-1', 'caso-1']);
    const promoted = plan(findings, {
      open: opened(findings[0] as PlanFinding, { pending: false, treated: true, promoted: true }),
    });
    expect(promoted).toMatchObject({ sealed: [], created: [] });
    expect(promoted.assignments.map(({ caseId }) => caseId)).toEqual(['aberto', 'aberto']);
  });

  it('as aberturas do próprio lote contam nos limites, e a reunida também é um caso da fila', () => {
    const scan = (index: number) =>
      finding({
        logSource: 'vpc_flow',
        ruleId: '100400',
        actorUser: null,
        sourceIp: `203.0.${index}.7`,
        createdAt: at(index),
      });
    const result = plan(Array.from({ length: 10 }, (_, index) => scan(index)));
    expect(result.created).toHaveLength(9);
    expect(result.folded).toEqual({ distributed: 2, overflow: 0, rollup: 0 });
    const openings = new RecentOpenings();
    plan(
      Array.from({ length: 10 }, (_, index) => scan(index)),
      { openings },
    );
    expect(openings.inQueue('detection', at(100))).toBe(9);
  });

  it('a alta que já tem caso reunido aberto entra nele; a chave com caso próprio, no próprio', () => {
    const scan = (network: number, createdAt: Date) =>
      finding({
        logSource: 'vpc_flow',
        ruleId: '100400',
        actorUser: null,
        sourceIp: `203.0.${network}.7`,
        createdAt,
      });
    const findings = [
      ...Array.from({ length: 9 }, (_, index) => scan(index, at(index))),
      scan(20, at(50)),
      scan(0, at(60)),
    ];
    const result = plan(findings);
    expect(result.assignments.slice(8).map(({ caseId }) => caseId)).toEqual(['caso-9', 'caso-9', 'caso-1']);
  });

  it('o item da lista de proteção é o recurso, quem agiu, a chave de acesso ou o endereço', () => {
    const items = new Set(['ec2:i-0abc', 'DEMOCHAVE1', '203.0.113.9', 'maria']);
    const none = finding({ actorUser: null });
    expect(touchesProtected(none, items)).toBe(false);
    expect(touchesProtected({ ...none, resource: 'ec2:i-0abc' }, items)).toBe(true);
    expect(touchesProtected({ ...none, actorUser: 'maria' }, items)).toBe(true);
    expect(touchesProtected({ ...none, accessKeyId: 'DEMOCHAVE1' }, items)).toBe(true);
    expect(touchesProtected({ ...none, sourceIp: '203.0.113.9' }, items)).toBe(true);
  });

  it('as amostras: sem vazio, sem repetido, cortadas e até o teto', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      finding({
        createdAt: at(index),
        sourceIp: `203.0.113.${index}`,
        resource: index === 0 ? '   ' : `recurso-${index}-${'x'.repeat(2000)}`,
        mitreTactics: [`tática ${index}`, '', `tática ${index}`],
        mitreTechniques: [`T${1000 + index}`],
      }),
    );
    const [created] = plan(rows).created;
    expect(created?.ips).toHaveLength(SAMPLE_LIMITS.ips);
    expect(created?.resources).toHaveLength(SAMPLE_LIMITS.resources);
    expect(created?.resources.every((value) => value.length === SAMPLE_VALUE_MAX)).toBe(true);
    expect(created?.mitreTactics).toEqual(Array.from({ length: 20 }, (_, index) => `tática ${index}`));
    expect(created?.mitreTechniques).toHaveLength(SAMPLE_LIMITS.mitreTechniques);
    expect(created).toMatchObject({ ruleIds: ['100305'], accounts: ['111122223333'], actors: ['maria'] });
  });

  it('a severidade avisada: com o aviso por alerta, só do alto e do crítico, e sempre a maior; por caso, nada', () => {
    const noticed = (severities: PlanFinding['severity'][], noticedByAlert: boolean) =>
      plan(
        severities.map((severity) =>
          // A mesma chave em qualquer severidade: a de vulnerabilidade não tem faixa.
          finding({ severity, logSource: 'inspector', ruleId: '990511', caseGroup: 'openssl' }),
        ),
        { noticedByAlert },
      ).created[0]?.noticedSeverity;
    expect(noticed(['low', 'medium'], true)).toBeNull();
    expect(noticed(['medium', 'high', 'low'], true)).toBe('high');
    expect(noticed(['critical', 'high'], true)).toBe('critical');
    expect(noticed(['critical', 'high'], false)).toBeNull();
  });

  it('um caso que já existe: com o aviso por alerta, a severidade avisada só sobe; por caso, fica como está', () => {
    const marked = (severity: PlanFinding['severity'], noticedByAlert: boolean) => {
      const alert = finding({ createdAt: at(HOUR_MS), severity });
      return plan([alert], { open: opened(alert, { noticedSeverity: 'high' }), noticedByAlert }).touched[0]
        ?.noticedSeverity;
    };
    expect(marked('critical', true)).toBe('critical');
    expect(marked('high', true)).toBe('high');
    expect(marked('critical', false)).toBe('high');
  });

  it('a chegada no futuro vale agora', () => {
    const alert = finding({ createdAt: at(DAY_MS) });
    expect(plan([alert], { now: at(HOUR_MS) }).created[0]).toMatchObject({
      openedAt: at(HOUR_MS),
      lastAlertAt: at(HOUR_MS),
    });
  });

  it('um lote vazio é um plano vazio', () => {
    expect(plan([])).toEqual({
      created: [],
      assignments: [],
      touched: [],
      sealed: [],
      folded: { distributed: 0, overflow: 0, rollup: 0 },
    });
  });
});

describe('o id de um caso novo', () => {
  it('é um UUID v7: válido, com o horário na frente e sem repetir', () => {
    const ids = Array.from({ length: 1_000 }, () => uuidV7(T0.getTime()));
    expect(new Set(ids).size).toBe(1_000);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(Number.parseInt(id.replace('-', '').slice(0, 12), 16)).toBe(T0.getTime());
    }
    expect(uuidV7(T0.getTime()) < uuidV7(T0.getTime() + 1)).toBe(true);
    expect(uuidV7()).not.toBe(randomUUID());
  });
});
