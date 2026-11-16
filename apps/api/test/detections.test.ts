import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  compareDetections,
  type DetectionPage,
  detectionPageSchema,
  type DetectionSort,
  type DetectionSortKey,
  PERIOD_BEYOND_HISTORY_CODE,
  periodBeyondHistoryMessage,
  resolvePlan,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { DETECTION_PAGE_OUT_OF_RANGE_CODE } from '../src/detections/detections.service.js';
import type { FindingSeverity, Prisma } from '../src/generated/prisma/client.js';
import { createSignedInUser, createTenant, createUser } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** O nó destes testes está no Essencial (90 dias), para a recusa do intervalo além do histórico. */
const HISTORY_DAYS = resolvePlan('essencial').limits.historyDays as number;

type Get = (path: string) => request.Test;
type FindingOverrides = Partial<Prisma.FindingUncheckedCreateInput>;

describe('tela Detecções: visão agrupada (GET /v1/detections)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;

  /** Um cliente novo e o GET com a sessão de leitura dele: cada cenário começa com o banco do cliente vazio. */
  async function newClient(name: string): Promise<{ tenantId: string; get: Get }> {
    const tenantId = await createTenant(app, name);
    const { cookie } = await createSignedInUser(app, { role: 'leitura', tenantId });
    return { tenantId, get: (path) => request(app.getHttpServer()).get(path).set('Cookie', cookie) };
  }

  /** Achado gravado como o sync grava (pela API, achado não é criado). */
  async function insertFinding(tenantId: string, overrides: FindingOverrides = {}) {
    return prisma.finding.create({
      data: {
        tenantId,
        accountId: '111122223333',
        source: 'wazuh',
        sourceEventId: randomUUID(),
        logSource: 'cloudtrail',
        occurredAt: new Date(Date.now() - HOUR),
        severity: 'high',
        ruleId: '80202',
        ruleLevel: 10,
        title: 'AWS CloudTrail: trilha desligada',
        eventName: 'StopLogging',
        resource: 'arn:aws:cloudtrail:sa-east-1:111122223333:trail/principal',
        actorUser: 'deploy-bot',
        accessKeyId: 'DEMO3QX7Z2KD9WLB5N8R',
        sourceIp: '198.51.100.23',
        mitreTactics: ['Defense Evasion'],
        mitreTechniques: ['T1562.008'],
        ...overrides,
      },
      select: { id: true },
    });
  }

  /** Incidente com os achados dele (um por item de `findings`, no último instante do incidente se não disser). */
  async function insertIncident(
    tenantId: string,
    overrides: Partial<Prisma.IncidentUncheckedCreateInput> = {},
    findings: FindingOverrides[] = [{}],
  ) {
    const lastSeenAt = new Date(overrides.lastSeenAt ?? Date.now() - HOUR);
    const incident = await prisma.incident.create({
      data: {
        tenantId,
        severity: 'high',
        riskScore: 50,
        findingCount: findings.length,
        firstSeenAt: lastSeenAt,
        lastSeenAt,
        keys: ['ip:198.51.100.23'],
        accounts: ['111122223333'],
        resources: [],
        mitreTactics: ['Credential Access'],
        mitreTechniques: ['T1110'],
        ...overrides,
      },
      select: { id: true, severity: true, lastSeenAt: true },
    });
    const findingIds: string[] = [];
    for (const finding of findings) {
      findingIds.push(
        (await insertFinding(tenantId, { incidentId: incident.id, occurredAt: lastSeenAt, ...finding })).id,
      );
    }
    return { ...incident, findingIds };
  }

  async function pageOf(get: Get, query = ''): Promise<DetectionPage> {
    return detectionPageSchema.parse((await get(`/v1/detections?${query}`).expect(200)).body);
  }

  /** Os ids das linhas, com o tipo: `i:<id>` para incidente, `f:<id>` para achado. */
  async function rowsOf(get: Get, query = ''): Promise<string[]> {
    return (await pageOf(get, query)).items.map((row) =>
      row.kind === 'incident' ? `i:${row.incident.id}` : `f:${row.finding.id}`,
    );
  }

  const isoDaysAgo = (days: number) => new Date(Date.now() - days * DAY).toISOString();

  beforeAll(async () => {
    app = await createApp({ plan: { PLAN: 'essencial' } });
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('isolamento entre clientes', () => {
    it('A nunca vê incidente nem achado de B, nem pela busca, pela conta ou pela tática', async () => {
      const a = await newClient('Cliente A (detecções)');
      const b = await newClient('Cliente B (detecções)');
      const shared = { title: 'Chave vazada em repositório', accountId: '222222222222' };
      const ownIncident = await insertIncident(a.tenantId, {}, [shared]);
      const ownFinding = await insertFinding(a.tenantId, shared);
      const otherIncident = await insertIncident(b.tenantId, {}, [shared, { title: 'Outro de B' }]);
      const otherFinding = await insertFinding(b.tenantId, shared);
      const otherIds = [otherIncident.id, ...otherIncident.findingIds, otherFinding.id];

      for (const query of [
        '',
        'q=vazada',
        'q=VAZADA',
        'accountId=222222222222',
        'tactic=Defense%20Evasion',
        'technique=T1562.008',
        'source=cloudtrail',
        'sort=severity',
        'status=new',
      ]) {
        const page = await pageOf(a.get, query);
        const body = JSON.stringify(page);
        for (const id of otherIds) expect(body, query).not.toContain(id);
        expect(page.total, query).toBe(2);
        expect(
          page.items.map((row) => (row.kind === 'incident' ? row.incident.id : row.finding.id)).sort(),
        ).toEqual([ownIncident.id, ownFinding.id].sort());
      }
      // A contagem dos achados que batem também é só do próprio incidente.
      const [incidentRow] = (await pageOf(a.get, 'q=vazada')).items.filter((row) => row.kind === 'incident');
      expect(incidentRow).toMatchObject({ matchedFindings: 1 });
    });
  });

  describe('linhas', () => {
    it('incidente com a contagem dos achados; achado avulso; achado de incidente não vira linha à parte', async () => {
      const c = await newClient('Cliente (linhas)');
      const incident = await insertIncident(c.tenantId, { severity: 'critical' }, [{}, {}, {}]);
      const standalone = await insertFinding(c.tenantId, { occurredAt: new Date(Date.now() - 2 * HOUR) });
      const page = await pageOf(c.get);
      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({
        kind: 'incident',
        incident: { id: incident.id, severity: 'critical', findingCount: 3 },
        matchedFindings: 3,
      });
      expect(page.items[1]).toMatchObject({
        kind: 'finding',
        finding: { id: standalone.id, incidentId: null, source: 'cloudtrail' },
      });
    });
  });

  describe('filtros', () => {
    it('severidade vale para o incidente e para o achado avulso', async () => {
      const c = await newClient('Cliente (severidade)');
      const critical = await insertIncident(c.tenantId, { severity: 'critical' }, [{ severity: 'low' }]);
      // O incidente é de severidade alta, mesmo com um achado crítico dentro.
      await insertIncident(c.tenantId, { severity: 'high' }, [{ severity: 'critical' }]);
      const finding = await insertFinding(c.tenantId, { severity: 'critical' });
      await insertFinding(c.tenantId, { severity: 'low' });
      expect((await rowsOf(c.get, 'severity=critical')).sort()).toEqual(
        [`i:${critical.id}`, `f:${finding.id}`].sort(),
      );
    });

    it('status: novo é o incidente aberto; legítimo é só de achado (nenhum incidente)', async () => {
      const c = await newClient('Cliente (status)');
      const open = await insertIncident(c.tenantId, { status: 'open' });
      const investigating = await insertIncident(c.tenantId, { status: 'investigating' });
      const resolved = await insertIncident(c.tenantId, { status: 'resolved' });
      const fresh = await insertFinding(c.tenantId, { status: 'new' });
      const triaging = await insertFinding(c.tenantId, { status: 'investigating' });
      const legitimate = await insertFinding(c.tenantId, { status: 'legitimate' });
      const done = await insertFinding(c.tenantId, { status: 'resolved' });
      // Um incidente aberto com achado legítimo dentro não entra no filtro "legítimo".
      await insertIncident(c.tenantId, { status: 'open' }, [{ status: 'legitimate' }]);
      const sorted = async (query: string) => (await rowsOf(c.get, query)).sort();
      expect(await sorted('status=new')).toEqual(expect.arrayContaining([`i:${open.id}`, `f:${fresh.id}`]));
      expect(await sorted('status=new')).toHaveLength(3);
      expect(await sorted('status=investigating')).toEqual(
        [`i:${investigating.id}`, `f:${triaging.id}`].sort(),
      );
      expect(await sorted('status=legitimate')).toEqual([`f:${legitimate.id}`]);
      expect(await sorted('status=resolved')).toEqual([`i:${resolved.id}`, `f:${done.id}`].sort());
    });

    it('sem responsável: só os incidentes sem ninguém, e os achados avulsos saem', async () => {
      const c = await newClient('Cliente (responsável)');
      const colleague = await createUser(app, { role: 'analista_cliente', tenantId: c.tenantId });
      const free = await insertIncident(c.tenantId);
      const taken = await insertIncident(c.tenantId, { assigneeId: colleague.id });
      const finding = await insertFinding(c.tenantId);
      expect((await rowsOf(c.get)).sort()).toEqual(
        [`i:${free.id}`, `i:${taken.id}`, `f:${finding.id}`].sort(),
      );
      const page = await pageOf(c.get, 'unassigned=true');
      expect(page.items.map((row) => row.kind === 'incident' && row.incident.id)).toEqual([free.id]);
      expect(page.total).toBe(1);
    });

    it('janela: o incidente entra se esteve ativo nela; o achado, pela data do evento', async () => {
      const c = await newClient('Cliente (janela)');
      // Ativo de 20 a 10 dias atrás.
      const incident = await insertIncident(
        c.tenantId,
        { firstSeenAt: new Date(Date.now() - 20 * DAY), lastSeenAt: new Date(Date.now() - 10 * DAY) },
        [{ occurredAt: new Date(Date.now() - 20 * DAY) }, { occurredAt: new Date(Date.now() - 10 * DAY) }],
      );
      const recent = await insertFinding(c.tenantId, { occurredAt: new Date(Date.now() - 2 * DAY) });
      const old = await insertFinding(c.tenantId, { occurredAt: new Date(Date.now() - 14 * DAY) });
      const sorted = async (query: string) => (await rowsOf(c.get, query)).sort();
      const range = (from: number, to: number) => `from=${isoDaysAgo(from)}&to=${isoDaysAgo(to)}`;

      expect(await sorted('period=7d')).toEqual([`f:${recent.id}`]);
      expect(await sorted('period=30d')).toEqual(
        [`i:${incident.id}`, `f:${recent.id}`, `f:${old.id}`].sort(),
      );
      // O intervalo cruza só o meio do incidente: entra, mesmo sem nenhum achado dele dentro do intervalo.
      expect(await sorted(range(15, 12))).toEqual([`i:${incident.id}`, `f:${old.id}`].sort());
      // Depois do último achado do incidente, e antes do primeiro: fica de fora.
      expect(await sorted(range(5, 1))).toEqual([`f:${recent.id}`]);
      expect(await sorted(range(40, 25))).toEqual([]);
      // As pontas valem: o último achado no começo do intervalo e o primeiro no fim.
      const incidentRow = await prisma.incident.findUniqueOrThrow({ where: { id: incident.id } });
      const edge = (from: Date, to: Date) => `from=${from.toISOString()}&to=${to.toISOString()}`;
      expect(await sorted(edge(incidentRow.lastSeenAt, new Date()))).toContain(`i:${incident.id}`);
      expect(await sorted(edge(new Date(Date.now() - 30 * DAY), incidentRow.firstSeenAt))).toContain(
        `i:${incident.id}`,
      );
    });

    it('conteúdo: o incidente entra por um achado dele, e conta quantos batem', async () => {
      const c = await newClient('Cliente (conteúdo)');
      const incident = await insertIncident(c.tenantId, {}, [
        {
          title: 'GuardDuty: exclusão em massa de objetos',
          eventName: 'DeleteObjects',
          logSource: 'guardduty',
          accountId: '444455556666',
          mitreTactics: ['Impact'],
          mitreTechniques: ['T1485'],
          actorUser: 'Operador-Noturno',
          sourceIp: '203.0.113.77',
          accessKeyId: 'DEMOKEYIMPACT0000001',
          resource: 'arn:aws:s3:::bucket-de-backup',
        },
        {},
        {},
      ]);
      const standalone = await insertFinding(c.tenantId, {
        title: 'Login sem MFA',
        eventName: 'ConsoleLogin',
      });
      const sorted = async (query: string) => (await rowsOf(c.get, query)).sort();
      const matched = async (query: string) =>
        (await pageOf(c.get, query)).items.flatMap((row) =>
          row.kind === 'incident' ? [row.matchedFindings] : [],
        );

      expect(await matched('')).toEqual([3]);
      for (const query of [
        'tactic=Impact',
        'technique=T1485',
        'source=guardduty',
        'accountId=444455556666',
        'q=EXCLUSAO'.replace('A', 'Ã'),
        'q=deleteobjects',
        'q=operador-noturno',
        'q=203.0.113',
        'q=demokeyimpact',
        'q=BUCKET-DE-BACKUP',
        'q=444455',
      ]) {
        expect(await sorted(encodeURI(query)), query).toEqual([`i:${incident.id}`]);
        expect(await matched(encodeURI(query)), query).toEqual([1]);
      }
      // Um filtro de conteúdo que só o achado avulso tem.
      expect(await sorted('q=consolelogin')).toEqual([`f:${standalone.id}`]);
      // Os dois batem: as linhas e a contagem dos achados do incidente.
      expect(await sorted('tactic=Defense%20Evasion')).toEqual(
        [`i:${incident.id}`, `f:${standalone.id}`].sort(),
      );
      expect(await matched('tactic=Defense%20Evasion')).toEqual([2]);
      // A técnica é exata: a técnica-mãe não pega a subtécnica.
      expect(await sorted('technique=T1562')).toEqual([]);
      expect(await sorted('technique=T1562.008')).toEqual([`i:${incident.id}`, `f:${standalone.id}`].sort());
      // Os curingas do LIKE são texto comum na busca.
      expect(await sorted('q=%25')).toEqual([]);
      expect(await sorted('q=_')).toEqual([]);
      // Todos os filtros juntos: conteúdo, severidade, status e janela.
      expect(await sorted('q=demokeyimpact&severity=critical&status=new&period=7d')).toEqual([]);
      expect(await sorted('q=demokeyimpact&severity=high&status=resolved&period=7d')).toEqual([]);
      expect(await sorted('q=demokeyimpact&severity=high&status=new&period=7d')).toEqual([
        `i:${incident.id}`,
      ]);
    });
  });

  describe('ordem e paginação', () => {
    it.each(['recent', 'severity'] as const)(
      'ordem "%s": igual à de compareDetections, sem repetir nem perder linha entre as páginas',
      async (sort: DetectionSort) => {
        const c = await newClient(`Cliente (ordem ${sort})`);
        const base = Date.now() - HOUR;
        const at = (hours: number) => new Date(base - hours * HOUR);
        const keys: (DetectionSortKey & { row: string })[] = [];
        const incident = async (severity: FindingSeverity, hours: number) => {
          const row = await insertIncident(
            c.tenantId,
            { severity, firstSeenAt: at(hours + 1), lastSeenAt: at(hours) },
            [
              { severity, occurredAt: at(hours) },
              { severity, occurredAt: at(hours + 1) },
            ],
          );
          keys.push({ row: `i:${row.id}`, id: row.id, severity, at: at(hours).toISOString() });
        };
        const finding = async (severity: FindingSeverity, hours: number) => {
          const row = await insertFinding(c.tenantId, { severity, occurredAt: at(hours) });
          keys.push({ row: `f:${row.id}`, id: row.id, severity, at: at(hours).toISOString() });
        };
        await incident('high', 1);
        await incident('critical', 5);
        await incident('low', 2);
        await incident('high', 3);
        await incident('high', 3);
        await finding('medium', 1); // mesma data do primeiro incidente
        await finding('critical', 4);
        await finding('high', 3); // mesma data e severidade de dois incidentes: o id desempata
        await finding('high', 3);
        await finding('low', 0);
        await finding('high', 6);
        const expected = [...keys].sort((a, b) => compareDetections(sort, a, b)).map((key) => key.row);
        const query = sort === 'recent' ? '' : 'sort=severity&';

        expect(await rowsOf(c.get, `${query}pageSize=100`)).toEqual(expected);
        const seen: string[] = [];
        for (let page = 1; page <= 6; page += 1) {
          const result = await pageOf(c.get, `${query}page=${page}&pageSize=2`);
          expect(result.total).toBe(11);
          expect(result.page).toBe(page);
          seen.push(
            ...result.items.map((row) =>
              row.kind === 'incident' ? `i:${row.incident.id}` : `f:${row.finding.id}`,
            ),
          );
        }
        expect(seen).toEqual(expected);
        expect((await pageOf(c.get, `${query}page=7&pageSize=2`)).items).toEqual([]);
      },
    );

    it('a página além das 5 000 primeiras linhas é recusada (400); até lá, responde', async () => {
      const c = await newClient('Cliente (profundidade)');
      await pageOf(c.get, 'page=50&pageSize=100');
      const response = await c.get('/v1/detections?page=51&pageSize=100').expect(400);
      expect(response.body).toMatchObject({
        code: DETECTION_PAGE_OUT_OF_RANGE_CODE,
        message: 'Página fora do alcance: refine os filtros',
      });
    });
  });

  describe('validação', () => {
    let get: Get;

    beforeAll(async () => {
      get = (await newClient('Cliente (validação)')).get;
    });

    it.each([
      'technique=T10',
      'technique=t1078',
      'technique=T1078.4',
      'tactic=Ataque',
      'source=syslog',
      'severity=urgente',
      'status=aberto',
      'sort=antigos',
      'unassigned=false',
      'q=%20%20',
      `q=${'a'.repeat(201)}`,
      'q=a%00b',
      `from=${isoDaysAgo(2)}`,
      `from=${isoDaysAgo(2)}&to=${isoDaysAgo(1)}&period=7d`,
      `from=${isoDaysAgo(1)}&to=${isoDaysAgo(2)}`,
      `from=${isoDaysAgo(80)}&to=2026-13-01T00:00:00Z`,
      'from=ontem&to=hoje',
      "accountId=1' OR '1'='1",
      'tenantId=00000000-0000-0000-0000-000000000000',
      'pageSize=101',
    ])('recusa %s (400)', async (query) => {
      const response = await get(`/v1/detections?${query}`).expect(400);
      expect((response.body as { code?: string }).code).not.toBe(PERIOD_BEYOND_HISTORY_CODE);
    });

    it('intervalo de mais de 365 dias é recusado antes do histórico do plano', async () => {
      const response = await get(`/v1/detections?from=${isoDaysAgo(400)}&to=${isoDaysAgo(0)}`).expect(400);
      expect((response.body as { code?: string }).code).not.toBe(PERIOD_BEYOND_HISTORY_CODE);
    });
  });

  describe('histórico do plano (Essencial, 90 dias)', () => {
    let get: Get;

    beforeAll(async () => {
      get = (await newClient('Cliente (histórico)')).get;
    });

    const refused = (response: request.Response) => {
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: PERIOD_BEYOND_HISTORY_CODE,
        message: periodBeyondHistoryMessage(HISTORY_DAYS),
      });
    };

    it('o período e o intervalo que começam antes do histórico são recusados', async () => {
      refused(await get('/v1/detections?period=12m'));
      refused(await get(`/v1/detections?from=${isoDaysAgo(HISTORY_DAYS + 2)}&to=${isoDaysAgo(0)}`));
    });

    it('até o histórico (com um dia de folga para o fuso), passa', async () => {
      await get('/v1/detections?period=90d').expect(200);
      await get(`/v1/detections?from=${isoDaysAgo(HISTORY_DAYS + 0.5)}&to=${isoDaysAgo(0)}`).expect(200);
    });
  });

  describe('permissões', () => {
    it.each(['admin_cliente', 'analista_cliente', 'leitura'] as const)('%s lê', async (role) => {
      const tenantId = await createTenant(app, `Cliente (${role})`);
      const { cookie } = await createSignedInUser(app, { role, tenantId });
      await request(app.getHttpServer()).get('/v1/detections').set('Cookie', cookie).expect(200);
    });

    it('sem sessão, 401', async () => {
      await request(app.getHttpServer()).get('/v1/detections').expect(401);
    });

    it('a Verax sem cliente escolhido recebe 409 TENANT_REQUIRED', async () => {
      const verax = await createSignedInUser(app, { role: 'admin_verax' });
      const response = await request(app.getHttpServer())
        .get('/v1/detections')
        .set('Cookie', verax.cookie)
        .expect(409);
      expect(response.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    });
  });
});
