import { describe, expect, it } from 'vitest';
import { caseFilterShape, caseListQuerySchema } from './cases.js';
import { PERMISSIONS, ROLES } from './permissions.js';
import { meSchema } from './session.js';
import {
  caseSplitSchema,
  isMassTriageRole,
  triageFilterSchema,
  triageOperationCreateSchema,
  triageOperationDetailSchema,
  triageScopeChanged,
  triageTargetSchema,
  triageUndoSchema,
} from './triage-operations.js';

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const id = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const ids = (count: number): string[] => Array.from({ length: count }, (_, index) => id(index + 1));

const base = {
  requestId: id(1),
  action: 'status',
  status: 'resolved',
  target: { caseIds: [id(2)] },
  expectedCount: 3,
};

describe('pedido de triagem em massa', () => {
  it('o mínimo, com os padrões', () => {
    expect(triageOperationCreateSchema.parse(base)).toEqual({ ...base, includeCritical: false });
  });

  it('cada ação com o que é dela', () => {
    const { status, ...rest } = base;
    expect(status).toBe('resolved');
    expect(ok(triageOperationCreateSchema, { ...rest, action: 'promote' })).toBe(true);
    expect(ok(triageOperationCreateSchema, { ...rest, action: 'attach', incidentId: id(9) })).toBe(true);
    expect(ok(triageOperationCreateSchema, { ...rest, action: 'attach' })).toBe(false);
    expect(ok(triageOperationCreateSchema, { ...base, action: 'promote' })).toBe(false);
    expect(ok(triageOperationCreateSchema, { ...base, incidentId: id(9) })).toBe(false);
    expect(ok(triageOperationCreateSchema, { ...rest, action: 'status' })).toBe(false);
    // O desfazer tem rota própria.
    expect(ok(triageOperationCreateSchema, { ...rest, action: 'undo' })).toBe(false);
  });

  it('desfazer tudo de uma pessoa pede o motivo, e só aceita a pessoa', () => {
    const all = {
      requestId: id(1),
      action: 'undo_all_of',
      target: { userId: 'abc' },
      reason: 'Conta comprometida',
    };
    expect(ok(triageOperationCreateSchema, all)).toBe(true);
    expect(ok(triageOperationCreateSchema, { ...all, reason: undefined })).toBe(false);
    expect(ok(triageOperationCreateSchema, { ...all, expectedCount: 1 })).toBe(false);
    expect(ok(triageOperationCreateSchema, { ...all, target: { caseIds: [id(2)] } })).toBe(false);
    expect(ok(triageOperationCreateSchema, { ...base, target: { userId: 'abc' } })).toBe(false);
  });

  it('os tetos do alvo: 50 casos, 500 alertas, sem repetição', () => {
    expect(ok(triageTargetSchema, { caseIds: ids(50) })).toBe(true);
    expect(ok(triageTargetSchema, { caseIds: ids(51) })).toBe(false);
    expect(ok(triageTargetSchema, { findingIds: ids(500) })).toBe(true);
    expect(ok(triageTargetSchema, { findingIds: ids(501) })).toBe(false);
    const upper = '0000000A-0000-4000-8000-000000000001';
    expect(ok(triageTargetSchema, { findingIds: [upper, upper.toLowerCase()] })).toBe(false);
    expect(ok(triageTargetSchema, { caseIds: [id(1)], group: 'openssl' })).toBe(true);
    expect(ok(triageTargetSchema, { findingIds: [id(1)], group: 'openssl' })).toBe(false);
    expect(ok(triageTargetSchema, {})).toBe(false);
  });

  it('o motivo: texto de verdade, até 500 caracteres', () => {
    const withReason = (reason: unknown) => ok(triageOperationCreateSchema, { ...base, reason });
    for (const good of ['ok', 'duas\nlinhas', 'com\ttab', 'ç'.repeat(500), '\u{1F600}']) {
      expect(withReason(good), good.slice(0, 20)).toBe(true);
    }
    for (const bad of ['', '  ', 'x'.repeat(501), 'a\u0000', 'a\u001b[31m', 'a\u007f', '\ud800', 3, null]) {
      expect(withReason(bad), String(bad).slice(0, 20)).toBe(false);
    }
  });
});

describe('filtro da triagem em massa', () => {
  it('os campos são os da lista de casos, com o mesmo formato', () => {
    const query = {
      queue: 'vulnerability',
      severity: 'high',
      source: 'inspector',
      accountId: '111122223333',
      tactic: 'Impact',
      technique: 'T1485',
      period: '24h',
      q: 'texto',
      groupBy: 'package',
      group: ' valor exato ',
    };
    const parsed = triageFilterSchema.parse(query);
    expect(parsed).toEqual({ ...query, state: 'pending' });
    expect(caseListQuerySchema.parse(query)).toMatchObject(parsed);
    for (const field of Object.keys(caseFilterShape)) {
      const bad = { q: 'x', [field]: { objeto: true } };
      expect([ok(triageFilterSchema, bad), ok(caseListQuerySchema, bad)], field).toEqual([false, false]);
    }
  });

  it('só estados com pendência, sem página nem ordem', () => {
    expect(ok(triageFilterSchema, { q: 'x', state: 'investigating' })).toBe(true);
    for (const extra of [
      { state: 'all' },
      { state: 'treated' },
      { page: 1 },
      { pageSize: 10 },
      { sort: 'recent' },
    ]) {
      expect(ok(triageFilterSchema, { q: 'x', ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });

  it('precisa estreitar além da fila, do estado e do período', () => {
    const range = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' };
    for (const wide of [{}, { queue: 'detection' }, { state: 'pending' }, { period: '7d' }, range]) {
      expect(ok(triageFilterSchema, { ...wide }), JSON.stringify(wide)).toBe(false);
      expect(ok(triageFilterSchema, { ...wide, severity: 'low' }), JSON.stringify(wide)).toBe(true);
    }
    for (const narrow of [
      { source: 'waf' },
      { accountId: '111122223333' },
      { tactic: 'Impact' },
      { technique: 'T1485' },
      { q: 'x' },
      { groupBy: 'package' },
    ]) {
      expect(ok(triageFilterSchema, narrow), JSON.stringify(narrow)).toBe(true);
    }
  });

  it('o grupo sem o agrupamento, e o período com o intervalo, são recusados como na lista', () => {
    expect(ok(triageFilterSchema, { q: 'x', group: 'a' })).toBe(false);
    expect(
      ok(triageFilterSchema, {
        q: 'x',
        period: '7d',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T00:00:00.000Z',
      }),
    ).toBe(false);
    expect(ok(triageFilterSchema, { q: 'x', from: '2026-11-01T00:00:00.000Z' })).toBe(false);
  });
});

describe('a folga entre o confirmado e o achado: 10% e mais 20', () => {
  it.each([
    [0, 20, false],
    [0, 21, true],
    [1, 21, false],
    [1, 22, true],
    [10, 31, false],
    [10, 32, true],
    [100, 130, false],
    [100, 131, true],
    [24_000, 26_420, false],
    [24_000, 26_421, true],
    [500, 3, false],
  ])('%i confirmados, %i achados', (expected, actual, changed) => {
    expect(triageScopeChanged(expected, actual)).toBe(changed);
  });
});

describe('quem administra', () => {
  it('é por papel: nenhuma permissão nova, que um painel aberto de antes recusaria no /v1/me', () => {
    expect(ROLES.filter((role) => isMassTriageRole(role))).toEqual(['admin_verax', 'admin_cliente']);
    expect(Object.keys(PERMISSIONS)).not.toContain('findings:triage_mass');
    const me = {
      userId: 'u',
      email: 'u@cliente.example',
      role: 'admin_cliente',
      tenantId: id(1),
      activeTenantId: null,
      scopeTenantId: id(1),
      mfaEnabled: true,
      mustChangePassword: false,
    };
    expect(ok(meSchema, { ...me, permissions: ['findings:triage'] })).toBe(true);
    expect(ok(meSchema, { ...me, permissions: ['findings:triage', 'findings:triage_mass'] })).toBe(false);
  });
});

describe('desfazer e dividir', () => {
  it('o desfazer pede o requestId; o motivo é opcional', () => {
    expect(ok(triageUndoSchema, { requestId: id(1) })).toBe(true);
    expect(ok(triageUndoSchema, { requestId: id(1), reason: 'x' })).toBe(true);
    expect(ok(triageUndoSchema, {})).toBe(false);
    expect(ok(triageUndoSchema, { requestId: id(1), force: true })).toBe(false);
  });

  it('dividir: pela lista ou pelo subgrupo, nunca os dois', () => {
    expect(ok(caseSplitSchema, { findingIds: ids(500) })).toBe(true);
    expect(ok(caseSplitSchema, { findingIds: ids(501) })).toBe(false);
    expect(ok(caseSplitSchema, { group: 'openssl', reason: 'x' })).toBe(true);
    expect(ok(caseSplitSchema, { group: 'openssl', findingIds: [id(1)] })).toBe(false);
    expect(ok(caseSplitSchema, {})).toBe(false);
  });
});

describe('a operação', () => {
  it('a resposta é fechada: um campo a mais é recusado', () => {
    const operation = {
      id: id(1),
      action: 'status',
      status: 'resolved',
      state: 'done',
      reason: null,
      author: null,
      createdAt: '2026-11-24T12:00:00.000Z',
      matched: 3,
      changed: 3,
      skipped: 0,
      undoUntil: null,
      undoOfId: null,
      requestId: id(2),
      target: { kind: 'filter', filter: { q: 'x', state: 'pending' } },
      incidentId: null,
      includeCritical: false,
      excludedCritical: 0,
      expectedCount: 3,
      cutoffAt: '2026-11-24T12:00:00.000Z',
      remaining: 0,
      failed: 0,
      stop: null,
      updatedAt: '2026-11-24T12:00:00.000Z',
      undoId: null,
      warnings: [],
      can: { cancel: false, continue: false, undo: true },
    };
    expect(triageOperationDetailSchema.parse(operation)).toEqual(operation);
    expect(ok(triageOperationDetailSchema, { ...operation, ids: [] })).toBe(false);
    expect(ok(triageOperationDetailSchema, { ...operation, target: { kind: 'cases', ids: [] } })).toBe(false);
    expect(ok(triageOperationDetailSchema, { ...operation, stop: 'outro' })).toBe(false);
  });
});
