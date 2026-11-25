import {
  type CaseSummary,
  type Finding,
  TRIAGE_EMPTY_CODE,
  TRIAGE_INCIDENT_RESOLVED_CODE,
  TRIAGE_QUEUE_FULL_CODE,
  TRIAGE_QUOTA_CODE,
  TRIAGE_REASON_REQUIRED_CODE,
  TRIAGE_SCOPE_CHANGED_CODE,
  TRIAGE_TOO_LARGE_CODE,
  triageOperationCreateSchema,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import {
  addPending,
  BULK_ACTIONS,
  bulkProblem,
  type BulkScope,
  cleanReason,
  expectedCount,
  filterTarget,
  groupFilter,
  isActionable,
  limitProblem,
  needsTypedConfirmation,
  reasonRequired,
  requestBody,
  scopeOfCaseGroup,
  scopeOfCases,
  scopeOfFilter,
  scopeOfFindings,
  selectionNote,
  sumPending,
  typedMatches,
} from './bulk';

const ID = '018f2c1e-0000-7000-8000-000000000001';
const OTHER = '018f2c1e-0000-7000-8000-000000000002';
const REQUEST = '018f2c1e-0000-4000-8000-00000000000f';

const pending = (critical: number, high: number, medium: number, low: number) => ({
  critical,
  high,
  medium,
  low,
});

const caseRow = (overrides: Partial<CaseSummary> = {}): CaseSummary => ({
  id: ID,
  queue: 'detection',
  family: 'cloudtrail',
  title: 'Grupo de log apagado',
  keyParts: [],
  sources: ['cloudtrail'],
  severity: 'critical',
  protected: false,
  pending: pending(2, 3, 0, 1),
  counts: { total: 10, new: 4, investigating: 2, legitimate: 2, resolved: 1, incident: 1 },
  sealedAt: null,
  sealReason: null,
  recurrence: 0,
  openedAt: '2026-11-20T10:00:00.000Z',
  firstSeenAt: '2026-11-20T10:00:00.000Z',
  lastSeenAt: '2026-11-24T10:00:00.000Z',
  lastAlertAt: '2026-11-24T10:00:00.000Z',
  preview: { accounts: [], actors: [], ips: [], resources: [] },
  mitreTactics: [],
  ...overrides,
});

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  id: ID,
  accountId: '111111111111',
  occurredAt: '2026-11-24T10:00:00.000Z',
  severity: 'high',
  status: 'new',
  title: 'Alerta',
  source: 'cloudtrail',
  eventName: null,
  region: null,
  resource: null,
  actor: { user: null, type: null, accessKeyId: null, ip: null },
  mitreTactics: [],
  incidentId: null,
  commentCount: 0,
  ...overrides,
});

const scope = (overrides: Partial<BulkScope> = {}): BulkScope => ({
  target: { caseIds: [ID] },
  label: '1 caso',
  cases: 1,
  pending: pending(2, 3, 0, 1),
  investigating: 2,
  protectedTitles: [],
  ...overrides,
});

describe('as contas do alvo', () => {
  it('somam por severidade', () => {
    expect(sumPending(pending(1, 2, 3, 4))).toBe(10);
    expect(addPending([pending(1, 0, 2, 0), pending(0, 5, 1, 0)])).toEqual(pending(1, 5, 3, 0));
    expect(addPending([])).toEqual(pending(0, 0, 0, 0));
  });

  it('dos casos: os ids, as contas somadas, os em análise e os protegidos', () => {
    const built = scopeOfCases([
      caseRow(),
      caseRow({ id: OTHER, title: 'Outro', protected: true, pending: pending(0, 0, 1, 0) }),
    ]);
    expect(built).toMatchObject({
      target: { caseIds: [ID, OTHER] },
      label: '2 casos',
      cases: 2,
      pending: pending(2, 3, 1, 1),
      investigating: 4,
      protectedTitles: ['Outro'],
    });
    expect(scopeOfCases([caseRow()]).label).toBe('Grupo de log apagado');
  });

  it('do subgrupo de um caso: o valor inteiro vai no alvo, e não se sabe quantos já estão em análise', () => {
    expect(
      scopeOfCaseGroup(caseRow({ protected: true }), { value: 'openssl', pending: pending(1, 0, 0, 2) }),
    ).toMatchObject({
      target: { caseIds: [ID], group: 'openssl' },
      pending: pending(1, 0, 0, 2),
      investigating: null,
      protectedTitles: ['Grupo de log apagado'],
    });
  });

  it('dos alertas: um de cada, e quantos já estão em análise', () => {
    expect(
      scopeOfFindings([finding(), finding({ id: OTHER, severity: 'critical', status: 'investigating' })]),
    ).toMatchObject({
      target: { findingIds: [ID, OTHER] },
      cases: null,
      pending: pending(1, 1, 0, 0),
      investigating: 1,
      protectedTitles: null,
    });
  });

  it('do filtro: as contas são da prévia, e a severidade escolhe casos', () => {
    const preview = { cases: 3, alerts: 9, new: 7, investigating: 2, pending: pending(1, 8, 0, 0) };
    expect(scopeOfFilter({ state: 'pending', severity: 'high' }, 'x', preview)).toMatchObject({
      target: { filter: { state: 'pending', severity: 'high' } },
      cases: 3,
      pending: pending(1, 8, 0, 0),
      investigating: 2,
      severityFiltered: true,
    });
    expect(scopeOfFilter({ state: 'pending', q: 'ana' }, 'x', preview).severityFiltered).toBe(false);
    // Um nó de antes não diz os novos por severidade nem os protegidos.
    expect(scopeOfFilter({ state: 'pending', q: 'ana' }, 'x', preview)).toMatchObject({
      fresh: null,
      protectedCases: null,
      protectedTitles: null,
    });
    const told = {
      ...preview,
      protectedCases: 2,
      byStatus: { new: pending(1, 6, 0, 0), investigating: pending(0, 2, 0, 0) },
    };
    expect(scopeOfFilter({ state: 'pending', q: 'ana' }, 'x', told)).toMatchObject({
      fresh: pending(1, 6, 0, 0),
      protectedCases: 2,
      protectedTitles: null,
    });
  });
});

describe('quantos alertas a pessoa confirma', () => {
  it('sem incluir os críticos, eles saem da conta; incluindo, entram', () => {
    expect(expectedCount(scope(), false, 'legitimate')).toEqual({ count: 4, exact: true });
    expect(expectedCount(scope(), true, 'legitimate')).toEqual({ count: 6, exact: true });
    expect(expectedCount(scope(), true, 'promote')).toEqual({ count: 6, exact: true });
  });

  it('para "em análise", os que já estão saem da conta', () => {
    expect(expectedCount(scope(), true, 'investigating')).toEqual({ count: 4, exact: true });
    // Sem nenhum crítico, a conta é a mesma com ou sem a inclusão.
    expect(expectedCount(scope({ pending: pending(0, 3, 0, 3) }), false, 'investigating')).toEqual({
      count: 4,
      exact: true,
    });
    expect(expectedCount(scope({ investigating: 0 }), false, 'investigating')).toEqual({
      count: 4,
      exact: true,
    });
  });

  it('com os novos por severidade (a prévia de um filtro), a conta de "em análise" é exata', () => {
    const told = scope({ pending: pending(2, 3, 1, 0), investigating: 3, fresh: pending(1, 1, 1, 0) });
    expect(expectedCount(told, false, 'investigating')).toEqual({ count: 2, exact: true });
    expect(expectedCount(told, true, 'investigating')).toEqual({ count: 3, exact: true });
    // As outras ações tiram da fila também quem já está em análise.
    expect(expectedCount(told, false, 'resolved')).toEqual({ count: 4, exact: true });
    expect(expectedCount({ ...told, fresh: null }, false, 'investigating')).toEqual({
      count: 4,
      exact: false,
    });
  });

  it('é um teto quando não dá para saber quantos dos que saem já estavam em análise', () => {
    expect(expectedCount(scope(), false, 'investigating')).toEqual({ count: 4, exact: false });
    expect(expectedCount(scope({ investigating: null }), true, 'investigating')).toEqual({
      count: 6,
      exact: false,
    });
  });
});

describe('as regras da confirmação', () => {
  it('o motivo é obrigatório só para tirar da fila mais de um alerta', () => {
    expect(BULK_ACTIONS.filter((action) => reasonRequired(action, 2))).toEqual(['legitimate', 'resolved']);
    expect(BULK_ACTIONS.filter((action) => reasonRequired(action, 1))).toEqual([]);
  });

  it('acima de 1.000 alertas, a quantidade é digitada', () => {
    expect(needsTypedConfirmation(1_000)).toBe(false);
    expect(needsTypedConfirmation(1_001)).toBe(true);
    expect(typedMatches('1.234', 1_234)).toBe(true);
    expect(typedMatches(' 1234 ', 1_234)).toBe(true);
    expect(typedMatches('1235', 1_234)).toBe(false);
    expect(typedMatches('', 1_234)).toBe(false);
    expect(typedMatches('sim', 1_234)).toBe(false);
  });

  it('o motivo é aparado e perde o que a API recusa', () => {
    expect(cleanReason('  Janela\nde\tmanutenção ')).toBe('Janela\nde\tmanutenção');
    expect(
      cleanReason(`a${String.fromCharCode(0)}b${String.fromCharCode(27)}c${String.fromCharCode(127)}`),
    ).toBe('abc');
    expect(cleanReason('   ')).toBe('');
    expect(cleanReason('x'.repeat(600))).toHaveLength(500);
    // Um surrogate solto (um emoji cortado ao colar) não chega à API.
    expect(cleanReason(`ok ${String.fromCharCode(0xd83d)}`).isWellFormed()).toBe(true);
    expect(cleanReason(`${'x'.repeat(499)}😀`).isWellFormed()).toBe(true);
  });

  it('os limites: nada a fazer, o teto de uma operação e a cota de quem não administra', () => {
    expect(limitProblem(0, 'admin_cliente')).toMatch(/Não há alerta pendente/);
    expect(limitProblem(2_000, 'analista_cliente')).toBeNull();
    expect(limitProblem(2_001, 'analista_cliente')).toMatch(/2\.000 alertas de uma vez, só um administrador/);
    expect(limitProblem(2_001, 'admin_cliente')).toBeNull();
    expect(limitProblem(2_001, 'admin_verax')).toBeNull();
    expect(limitProblem(50_000, 'admin_cliente')).toBeNull();
    expect(limitProblem(50_001, 'admin_cliente')).toMatch(/máximo é 50\.000/);
  });

  it('o aviso do teto da seleção diz quantos ficaram de fora', () => {
    expect(selectionNote(0, 50, 'casos')).toBeNull();
    expect(selectionNote(3, 50, 'casos')).toMatch(/^Até 50 casos por vez: 3 ficaram de fora/);
  });

  it('só o alerta novo ou em análise, fora de incidente, pode ser tratado', () => {
    expect(isActionable({ status: 'new', incidentId: null })).toBe(true);
    expect(isActionable({ status: 'investigating', incidentId: null })).toBe(true);
    expect(isActionable({ status: 'new', incidentId: ID })).toBe(false);
    expect(isActionable({ status: 'legitimate', incidentId: null })).toBe(false);
    expect(isActionable({ status: 'resolved', incidentId: null })).toBe(false);
  });
});

describe('o filtro como alvo', () => {
  it('precisa de mais que a fila, a situação e o período', () => {
    expect(filterTarget({ queue: 'detection', state: 'pending' })).toBeNull();
    expect(filterTarget({ queue: 'detection', state: 'pending', period: '7d' })).toBeNull();
    expect(filterTarget({ queue: 'detection', state: 'pending', severity: 'low' })).toEqual({
      queue: 'detection',
      state: 'pending',
      severity: 'low',
    });
    expect(filterTarget({ state: 'investigating', q: 'ana', severity: undefined })).toEqual({
      state: 'investigating',
      q: 'ana',
    });
  });

  it('do grupo de vulnerabilidades: o valor exato; sem valor, só por onde agrupa', () => {
    const filters = { state: 'pending', severity: 'high', accountId: undefined } as const;
    expect(groupFilter('package', { value: 'openssl' }, filters)).toEqual({
      queue: 'vulnerability',
      groupBy: 'package',
      group: 'openssl',
      state: 'pending',
      severity: 'high',
    });
    expect(groupFilter('package', { value: null }, filters)).toEqual({
      queue: 'vulnerability',
      groupBy: 'package',
      state: 'pending',
      severity: 'high',
    });
  });
});

describe('o corpo do pedido', () => {
  const build = (action: (typeof BULK_ACTIONS)[number], reason = ' Combinado. ') =>
    requestBody({ scope: scope(), action, incidentId: OTHER, includeCritical: false, expected: 4, reason });

  it.each([
    ['investigating', { action: 'status', status: 'investigating' }],
    ['legitimate', { action: 'status', status: 'legitimate' }],
    ['resolved', { action: 'status', status: 'resolved' }],
    ['promote', { action: 'promote' }],
    ['attach', { action: 'attach', incidentId: OTHER }],
  ] as const)('%s: o que a API espera', (action, expected) => {
    const body = build(action);
    expect(body).toEqual({
      ...expected,
      target: { caseIds: [ID] },
      expectedCount: 4,
      includeCritical: false,
      reason: 'Combinado.',
    });
    // O contrato da API aceita o pedido como ele sai.
    expect(triageOperationCreateSchema.safeParse({ ...body, requestId: REQUEST }).success).toBe(true);
  });

  it('sem motivo, o campo nem vai', () => {
    expect(build('promote', '  ')).not.toHaveProperty('reason');
  });
});

describe('o que cada recusa pede', () => {
  const refusal = (status: number, code?: string, details?: Record<string, number>) =>
    bulkProblem(new ApiRequestError(status, 'mensagem da API', code, undefined, undefined, details));

  it('o conjunto mudou: confirmar de novo, com a contagem nova', () => {
    expect(refusal(409, TRIAGE_SCOPE_CHANGED_CODE, { count: 120, excludedCritical: 2 })).toMatchObject({
      kind: 'scope_changed',
      count: 120,
      message: expect.stringContaining('agora são 120 alertas') as string,
    });
    // Sem a contagem (nó de outra versão), não há o que confirmar.
    expect(refusal(409, TRIAGE_SCOPE_CHANGED_CODE).kind).toBe('refused');
  });

  it('só críticos, ou mais nada', () => {
    expect(refusal(409, TRIAGE_EMPTY_CODE, { count: 0, excludedCritical: 3 })).toMatchObject({
      kind: 'only_critical',
      excluded: 3,
      message: expect.stringContaining('há 3 alertas críticos') as string,
    });
    expect(refusal(409, TRIAGE_EMPTY_CODE, { count: 0, excludedCritical: 1 })).toMatchObject({
      message: expect.stringContaining('tratá-lo') as string,
    });
    expect(refusal(409, TRIAGE_EMPTY_CODE, { count: 0, excludedCritical: 0 }).kind).toBe('empty');
    expect(refusal(409, TRIAGE_EMPTY_CODE).kind).toBe('empty');
  });

  it('o motivo', () => {
    expect(refusal(400, TRIAGE_REASON_REQUIRED_CODE).kind).toBe('reason');
  });

  it('a cota: com o limite da API, e nunca como falta de permissão', () => {
    expect(refusal(403, TRIAGE_QUOTA_CODE, { limit: 5_000, count: 5_200 })).toEqual({
      kind: 'refused',
      message: expect.stringContaining('5.000 alertas') as string,
    });
    expect(refusal(403, TRIAGE_QUOTA_CODE).message).toMatch(/Peça a um administrador/);
    expect(refusal(403).message).toMatch(/Sem permissão/);
  });

  it.each([
    [TRIAGE_QUEUE_FULL_CODE, /operações demais na fila/],
    [TRIAGE_TOO_LARGE_CODE, /Estreite o filtro/],
    [TRIAGE_INCIDENT_RESOLVED_CODE, /já foi resolvido/],
  ])('%s', (code, message) => {
    expect(refusal(409, code)).toEqual({
      kind: 'refused',
      message: expect.stringMatching(message) as string,
    });
  });

  it('item que não existe mais', () => {
    expect(refusal(404)).toMatchObject({
      kind: 'refused',
      message: expect.stringMatching(/não existe mais/) as string,
    });
  });

  it('banco ocupado, servidor que caiu e falta de conexão: repetir é seguro', () => {
    expect(refusal(503)).toMatchObject({
      kind: 'retry',
      message: expect.stringMatching(/ocupado/) as string,
    });
    expect(refusal(500)).toMatchObject({
      kind: 'retry',
      message: expect.stringMatching(/não vale duas vezes/) as string,
    });
    expect(bulkProblem(new TypeError('fetch'))).toMatchObject({ kind: 'retry' });
  });

  it('o resto diz o que a API disse', () => {
    expect(refusal(409, 'OUTRO')).toEqual({ kind: 'refused', message: 'mensagem da API' });
  });
});
