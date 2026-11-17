import { describe, expect, it } from 'vitest';
import {
  compareDetections,
  detectionListQuerySchema,
  detectionPageSchema,
  detectionSortKey,
  type DetectionRow,
  filterWindow,
  findingMatchesFilters,
  type FilterableFinding,
  hasContentFilter,
  incidentMatchesFilters,
} from './detections.js';
import { type Finding, findingListQuerySchema } from './findings.js';
import { rangeFitsHistory } from './history.js';
import type { Incident } from './incidents.js';
import { reportQuerySchema, reportQueryWindow } from './reports.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

const finding: Finding = {
  id: '018f2c1e-0000-7000-8000-000000000001',
  accountId: '111122223333',
  occurredAt: '2026-11-16T10:00:00.000Z',
  severity: 'high',
  status: 'new',
  title: 'Login no console sem MFA',
  source: 'cloudtrail',
  eventName: 'ConsoleLogin',
  region: 'us-east-1',
  resource: null,
  actor: { user: 'ana.souza', type: 'IAMUser', accessKeyId: null, ip: '203.0.113.10' },
  mitreTactics: ['Initial Access'],
  incidentId: null,
  commentCount: 0,
};

const incident: Incident = {
  id: '018f2c1e-0000-7000-8000-0000000000a1',
  severity: 'critical',
  status: 'open',
  riskScore: 80,
  findingCount: 2,
  firstSeenAt: '2026-11-10T08:00:00.000Z',
  lastSeenAt: '2026-11-16T09:00:00.000Z',
  keys: ['user:ana.souza'],
  accounts: ['111122223333'],
  resources: [],
  mitreTactics: ['Initial Access'],
  assignee: null,
};

describe('filtros da tela Detecções', () => {
  it('a lista de achados aceita os filtros novos, todos opcionais (um painel de antes manda só os quatro de antes)', () => {
    expect(findingListQuerySchema.parse({ severity: 'high', page: '1' })).toEqual({
      severity: 'high',
      page: 1,
      pageSize: 25,
    });
    expect(
      findingListQuerySchema.parse({
        source: 'guardduty',
        tactic: 'Credential Access',
        technique: 'T1078.004',
        q: '  ana  ',
        from: '2026-11-01T03:00:00.000Z',
        to: '2026-11-08T02:59:59.999Z',
      }),
    ).toMatchObject({ source: 'guardduty', tactic: 'Credential Access', technique: 'T1078.004', q: 'ana' });
  });

  it.each([
    ['fonte desconhecida', { source: 'vpcflow' }],
    ['tática fora da lista', { tactic: 'Hacking' }],
    ['técnica fora do padrão', { technique: 'T10' }],
    ['busca vazia', { q: '   ' }],
    ['busca com caractere de controle', { q: 'a\u0000b' }],
    ['busca longa demais', { q: 'x'.repeat(201) }],
    ['intervalo só com o começo', { from: '2026-11-01T00:00:00.000Z' }],
    ['intervalo invertido', { from: '2026-11-08T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }],
    ['intervalo de mais de 365 dias', { from: '2025-01-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }],
    [
      'período e intervalo juntos',
      { period: '7d', from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
    ],
    ['data sem fuso', { from: '2026-11-01T00:00:00', to: '2026-11-02T00:00:00' }],
  ])('recusa %s', (_name, query) => {
    expect(findingListQuerySchema.safeParse(query).success).toBe(false);
    expect(detectionListQuerySchema.safeParse(query).success).toBe(false);
  });

  it('a visão agrupada tem também "sem responsável" e a ordem; nada além disso', () => {
    expect(detectionListQuerySchema.parse({ unassigned: 'true', sort: 'severity' })).toMatchObject({
      unassigned: 'true',
      sort: 'severity',
    });
    expect(detectionListQuerySchema.safeParse({ sort: 'risk' }).success).toBe(false);
    expect(detectionListQuerySchema.parse({ kind: 'incident' })).toMatchObject({ kind: 'incident' });
    expect(detectionListQuerySchema.safeParse({ kind: 'finding' }).success).toBe(false);
    expect(detectionListQuerySchema.safeParse({ tenantId: 'x' }).success).toBe(false);
    expect(findingListQuerySchema.safeParse({ unassigned: 'true' }).success).toBe(false);
  });

  it('a janela: período até agora, intervalo personalizado ou todo o histórico', () => {
    expect(filterWindow({ period: '24h' }, NOW)).toEqual({
      from: new Date('2026-11-15T12:00:00.000Z'),
      to: null,
    });
    expect(filterWindow({ from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' }, NOW)).toEqual({
      from: new Date('2026-11-01T00:00:00.000Z'),
      to: new Date('2026-11-02T00:00:00.000Z'),
    });
    expect(filterWindow({}, NOW)).toEqual({ from: null, to: null });
  });

  it('o achado: cada filtro, e a busca sem diferenciar maiúsculas em vários campos', () => {
    const detail: FilterableFinding = { ...finding, mitreTechniques: ['T1078'] };
    expect(findingMatchesFilters(detail, {}, NOW)).toBe(true);
    expect(findingMatchesFilters(detail, { severity: 'critical' }, NOW)).toBe(false);
    expect(findingMatchesFilters(detail, { status: 'new', source: 'cloudtrail' }, NOW)).toBe(true);
    expect(findingMatchesFilters(detail, { period: '24h' }, NOW)).toBe(true);
    expect(
      findingMatchesFilters(
        detail,
        { from: '2026-11-01T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z' },
        NOW,
      ),
    ).toBe(false);
    expect(findingMatchesFilters(detail, { tactic: 'Initial Access', technique: 'T1078' }, NOW)).toBe(true);
    expect(findingMatchesFilters(detail, { technique: 'T1110' }, NOW)).toBe(false);
    for (const q of ['ANA.SOUZA', 'consolelogin', '203.0.113', '1111222', 'sem mfa']) {
      expect(findingMatchesFilters(detail, { q }, NOW), q).toBe(true);
    }
    expect(findingMatchesFilters(detail, { q: 'joao' }, NOW)).toBe(false);
  });

  it('o incidente: a severidade, o status pelo equivalente, o responsável e a janela pelo próprio incidente', () => {
    const findings = [finding];
    expect(incidentMatchesFilters(incident, findings, {}, NOW)).toBe(true);
    expect(incidentMatchesFilters(incident, findings, { severity: 'high' }, NOW)).toBe(false);
    expect(incidentMatchesFilters(incident, findings, { status: 'new' }, NOW)).toBe(true);
    expect(incidentMatchesFilters(incident, findings, { status: 'investigating' }, NOW)).toBe(false);
    // "Legítimo" é só de achado: nenhum incidente entra.
    expect(incidentMatchesFilters(incident, findings, { status: 'legitimate' }, NOW)).toBe(false);
    expect(incidentMatchesFilters(incident, findings, { unassigned: 'true' }, NOW)).toBe(true);
    expect(
      incidentMatchesFilters(
        { ...incident, assignee: { id: 'u', name: 'Ana' } },
        findings,
        { unassigned: 'true' },
        NOW,
      ),
    ).toBe(false);
    // Ativo em algum momento da janela: o último achado depois do começo, o primeiro antes do fim.
    expect(incidentMatchesFilters(incident, findings, { period: '24h' }, NOW)).toBe(true);
    expect(
      incidentMatchesFilters(
        incident,
        findings,
        { from: '2026-11-11T00:00:00.000Z', to: '2026-11-12T00:00:00.000Z' },
        NOW,
      ),
    ).toBe(true);
    expect(
      incidentMatchesFilters(
        incident,
        findings,
        { from: '2026-11-01T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' },
        NOW,
      ),
    ).toBe(false);
  });

  it('o incidente pelos filtros de conteúdo: basta um achado dele bater', () => {
    const other: FilterableFinding = { ...finding, source: 'guardduty', title: 'Chave usada de IP novo' };
    expect(hasContentFilter({ severity: 'high' })).toBe(false);
    expect(hasContentFilter({ q: 'x' })).toBe(true);
    expect(incidentMatchesFilters(incident, [finding, other], { source: 'guardduty' }, NOW)).toBe(true);
    expect(incidentMatchesFilters(incident, [finding], { source: 'guardduty' }, NOW)).toBe(false);
    expect(incidentMatchesFilters(incident, [finding, other], { q: 'ip novo' }, NOW)).toBe(true);
  });

  it('a ordem: a mais recente primeiro, ou a mais grave e, nela, a mais recente; o id desempata', () => {
    const rows: DetectionRow[] = [
      {
        kind: 'finding',
        finding: { ...finding, id: '018f2c1e-0000-7000-8000-000000000003', severity: 'low' },
      },
      { kind: 'incident', incident, matchedFindings: 2 },
      {
        kind: 'finding',
        finding: { ...finding, id: '018f2c1e-0000-7000-8000-000000000002', severity: 'low' },
      },
    ];
    const ids = (sort: 'recent' | 'severity') =>
      [...rows]
        .sort((a, b) => compareDetections(sort, detectionSortKey(a), detectionSortKey(b)))
        .map((row) => detectionSortKey(row).id.slice(-3));
    expect(ids('recent')).toEqual(['003', '002', '0a1']);
    expect(ids('severity')).toEqual(['0a1', '003', '002']);
  });

  it('a página da visão agrupada: incidente ou achado avulso, estrita', () => {
    const page = {
      items: [
        { kind: 'incident', incident, matchedFindings: 1 },
        { kind: 'finding', finding },
      ],
      page: 1,
      pageSize: 20,
      total: 2,
    };
    expect(detectionPageSchema.parse(page)).toEqual(page);
    expect(detectionPageSchema.safeParse({ ...page, items: [{ kind: 'alert', finding }] }).success).toBe(
      false,
    );
    expect(
      detectionPageSchema.safeParse({ ...page, items: [{ kind: 'finding', finding, extra: 1 }] }).success,
    ).toBe(false);
  });
});

describe('intervalo personalizado no histórico do plano e nos relatórios', () => {
  it('o começo cabe no histórico, com um dia de folga; sem limite, sempre', () => {
    expect(rangeFitsHistory(new Date('2026-08-18T12:00:00.000Z'), 90, NOW)).toBe(true);
    expect(rangeFitsHistory(new Date('2026-08-17T11:00:00.000Z'), 90, NOW)).toBe(false);
    expect(rangeFitsHistory(new Date('2020-01-01T00:00:00.000Z'), null, NOW)).toBe(true);
  });

  it('o relatório aceita um período (24 h também) ou um intervalo; sem nenhum, 30 dias', () => {
    expect(reportQueryWindow(reportQuerySchema.parse({}), NOW)).toEqual({
      period: '30d',
      from: '2026-10-17T12:00:00.000Z',
      to: NOW.toISOString(),
    });
    expect(reportQueryWindow(reportQuerySchema.parse({ period: '24h' }), NOW).from).toBe(
      '2026-11-15T12:00:00.000Z',
    );
    expect(
      reportQueryWindow(
        reportQuerySchema.parse({ from: '2026-11-01T03:00:00.000Z', to: '2026-11-08T02:59:59.999Z' }),
        NOW,
      ),
    ).toEqual({ period: 'custom', from: '2026-11-01T03:00:00.000Z', to: '2026-11-08T02:59:59.999Z' });
    expect(
      reportQuerySchema.safeParse({
        period: '7d',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
