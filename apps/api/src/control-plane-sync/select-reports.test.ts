import {
  NODE_SYNC_MAX_SOURCES,
  NODE_SYNC_MAX_USERS,
  type NodeSyncSourceReport,
  type NodeSyncUserReport,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { type ReportCandidate, selectReports } from './control-plane-sync.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

/** Um relato de `bytes` bytes, com o hash e o último aceito dados. */
function candidate(
  n: number,
  { bytes = 100, changed = false, reportedAt = null as Date | null } = {},
): ReportCandidate {
  const report = { id: id(n) } as NodeSyncSourceReport;
  return {
    report,
    hash: `h${n}`,
    bytes,
    tracked: true,
    reportedHash: changed || reportedAt === null ? null : `h${n}`,
    reportedAt,
  };
}

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 22, 12, minutes));
const ids = (selected: ReportCandidate[]) => selected.map((item) => item.report.id);

describe('relatos no limite de tamanho do pedido', () => {
  it('cabem todos: vão todos, em ordem de id', () => {
    const all = [candidate(3, { reportedAt: at(1) }), candidate(1, { reportedAt: at(2) }), candidate(2)];
    const { selected, omitted } = selectReports(all, 500, 10_000);
    expect(ids(selected)).toEqual([id(1), id(2), id(3)]);
    expect(omitted).toBe(0);
  });

  it('o corpo nunca passa do limite (a base, os relatos e as vírgulas)', () => {
    const all = Array.from({ length: 10 }, (_, n) => candidate(n, { bytes: 100 }));
    // Base de 500 e limite de 803: cabem 3 (500 + 100 + 101 + 101 = 802); o quarto passaria (903).
    const { selected, omitted } = selectReports(all, 500, 803);
    expect(selected).toHaveLength(3);
    expect(omitted).toBe(7);
    expect(500 + selected.length * 100 + (selected.length - 1)).toBeLessThanOrEqual(803);
  });

  it('vão antes os que mudaram, depois os aceitos há mais tempo (o nunca aceito primeiro)', () => {
    const all = [
      candidate(1, { reportedAt: at(1) }),
      candidate(2, { reportedAt: at(5) }),
      candidate(3, { reportedAt: at(9), changed: true }),
      candidate(4),
      candidate(5, { reportedAt: at(3) }),
    ];
    // Cabem 3: o que mudou (3), o nunca aceito (4) e o aceito há mais tempo (1).
    const { selected } = selectReports(all, 0, 3 * 100 + 2);
    expect(ids(selected)).toEqual([id(1), id(3), id(4)]);
  });

  it('um relato grande demais não impede os menores que cabem', () => {
    const all = [candidate(1, { bytes: 5_000 }), candidate(2, { bytes: 100 }), candidate(3, { bytes: 100 })];
    const { selected, omitted } = selectReports(all, 0, 1_000);
    expect(ids(selected)).toEqual([id(2), id(3)]);
    expect(omitted).toBe(1);
  });

  it(`no máximo ${NODE_SYNC_MAX_SOURCES} relatos, mesmo cabendo`, () => {
    const all = Array.from({ length: NODE_SYNC_MAX_SOURCES + 20 }, (_, n) => candidate(n, { bytes: 10 }));
    const { selected, omitted } = selectReports(all, 0, 10_000_000);
    expect(selected).toHaveLength(NODE_SYNC_MAX_SOURCES);
    expect(omitted).toBe(20);
  });
});

describe('relatos dos pedidos de usuário no limite do pedido', () => {
  const requestId = (n: number) => `01JD${n.toString().padStart(22, '0')}`;
  const user = (n: number, reportedAt: Date | null = null): ReportCandidate<NodeSyncUserReport> => ({
    report: { requestId: requestId(n), outcome: 'failed', code: 'expired', user: null },
    hash: `u${n}`,
    bytes: 90,
    tracked: true,
    reportedHash: reportedAt === null ? null : `u${n}`,
    reportedAt,
  });

  it('a mesma régua, pelo id do pedido: os nunca aceitos e os aceitos há mais tempo primeiro; em ordem de id', () => {
    const all = [user(3, at(1)), user(1, at(5)), user(2)];
    const { selected, omitted } = selectReports(all, 0, 2 * 90 + 1, NODE_SYNC_MAX_USERS);
    expect(selected.map((item) => item.report.requestId)).toEqual([requestId(2), requestId(3)]);
    expect(omitted).toBe(1);
  });

  it(`no máximo ${NODE_SYNC_MAX_USERS} relatos de usuário, mesmo cabendo`, () => {
    const all = Array.from({ length: NODE_SYNC_MAX_USERS + 5 }, (_, n) => user(n));
    const { selected, omitted } = selectReports(all, 0, 10_000_000, NODE_SYNC_MAX_USERS);
    expect(selected).toHaveLength(NODE_SYNC_MAX_USERS);
    expect(omitted).toBe(5);
  });
});
