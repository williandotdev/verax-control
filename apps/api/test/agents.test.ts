import 'reflect-metadata';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  agentInstallSchema,
  agentListSchema,
  findingDetailSchema,
  findingSchema,
  incidentDetailSchema,
  paginatedSchema,
} from '@verax/shared';
import { Logger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AGENTS_FEED_MAX_BYTES,
  AGENTS_SYNC_STATE,
  type AgentsFeedFile,
  readAgentsFeed,
  WazuhAgentsSync,
} from '../src/agents/agents-sync.js';
import { parseAgentAlert } from '../src/alerts/agent-alert.js';
import { AgentAlertSync } from '../src/alerts/agent-alert-sync.js';
import { AlertSync } from '../src/alerts/alert-sync.js';
import { agentFindingKey, wazuhFindingKey } from '../src/alerts/finding-draft.js';
import { parseWazuhAlert } from '../src/alerts/wazuh-alert.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { type AgentAlertOptions, agentAlert, fimAlert } from './alerts/agent-fixtures.js';
import { cloudTrailAlert } from './alerts/fixtures.js';
import { createSignedInUser, createTenant, withCsrf } from './support/auth-helpers.js';
import { createApp, TEST_WEB_ORIGIN } from './support/create-app.js';
import { FakeIndexer, wazuhTime } from './support/fake-indexer.js';
import { LogCapture } from './support/log-capture.js';

const DAY = 24 * 3_600_000;
const MINUTE = 60_000;
/** CA pública de teste (só o certificado; a chave foi descartada ao gerar). */
const CA = readFileSync(new URL('./fixtures/agents-ca.crt', import.meta.url), 'utf8');
// Senha de registro gerada a cada execução: 32 hexadecimais, letras e dígitos como a do install.sh.
const enrollment = randomBytes(16).toString('hex');
// Ids de agente próprios deste arquivo (o id é único no banco).
const base = randomInt(100_000, 900_000);
const agentId = (n: number) => String(base + n);

/** A resposta da API do manager como o host a exporta (com os espaços do Python do Wazuh). */
function managerResponse(items: unknown[]): string {
  return JSON.stringify({
    data: {
      affected_items: items,
      total_affected_items: items.length,
      total_failed_items: 0,
      failed_items: [],
    },
    message: 'All selected agents information was returned',
    error: 0,
  }).replaceAll('":', '": ');
}

describe('agentes do Wazuh nas instâncias do cliente', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const tenantA = randomUUID();
  let tenantB: string;
  let adminA: { id: string; cookie: string };
  let analystA: { cookie: string };
  let readerA: { cookie: string };
  let adminB: { id: string; cookie: string };
  let verax: { id: string; cookie: string; csrfToken: string };

  const get = (path: string, cookie: string) => request(app.getHttpServer()).get(path).set('Cookie', cookie);
  const list = async (cookie: string, query = '') =>
    agentListSchema.parse((await get(`/v1/agents${query}`, cookie).expect(200)).body);
  const install = async (cookie: string) => {
    const response = await get('/v1/agents/install', cookie).expect(200);
    expect(response.headers['cache-control']).toBe('no-store');
    return agentInstallSchema.parse(response.body);
  };
  const auditsOf = (actorId: string) =>
    prisma.auditLog.findMany({
      where: { actorId, action: 'agents.install_instructions.view' },
      orderBy: { occurredAt: 'asc' },
    });

  async function selectTenant(tenantId: string) {
    await request(app.getHttpServer())
      .post('/v1/session/tenant')
      .send({ tenantId })
      .set('Cookie', verax.cookie)
      .set('Origin', TEST_WEB_ORIGIN)
      .set('X-CSRF-Token', verax.csrfToken)
      .expect(200);
  }

  beforeAll(async () => {
    app = await createApp({
      capture,
      wazuhAgents: {
        WAZUH_AGENTS_ADDRESS: '203.0.113.10',
        WAZUH_AGENTS_TENANT: tenantA,
        WAZUH_AGENTS_SOURCES: '198.51.100.0/28,192.0.2.15/32',
        WAZUH_AGENTS_MAX: '3',
        WAZUH_AGENTS_CA: Buffer.from(CA).toString('base64'),
        WAZUH_AGENTS_ENROLLMENT_PASSWORD: enrollment,
      },
    });
    prisma = app.get(PrismaService);
    await prisma.tenant.create({ data: { id: tenantA, name: 'Cliente Demo A (agentes)' } });
    tenantB = await createTenant(app, 'Cliente Demo B (agentes)');
    adminA = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantA });
    analystA = await createSignedInUser(app, { role: 'analista_cliente', tenantId: tenantA });
    readerA = await createSignedInUser(app, { role: 'leitura', tenantId: tenantA });
    adminB = await createSignedInUser(app, { role: 'admin_cliente', tenantId: tenantB });
    const veraxUser = await createSignedInUser(app, { role: 'admin_verax' });
    const csrf = await withCsrf(app, veraxUser.cookie);
    verax = { id: veraxUser.id, cookie: csrf.cookie, csrfToken: csrf.token };

    await prisma.wazuhAgent.createMany({
      data: [
        {
          tenantId: tenantA,
          agentId: agentId(1),
          name: 'web-01',
          ip: '198.51.100.20',
          osName: 'Ubuntu',
          osVersion: '24.04.1 LTS',
          osPlatform: 'ubuntu',
          version: 'Wazuh v4.14.9',
          status: 'active',
          lastKeepAliveAt: new Date(),
          registeredAt: new Date(Date.now() - DAY),
        },
        { tenantId: tenantA, agentId: agentId(2), name: 'db-01', status: 'disconnected' },
        { tenantId: tenantB, agentId: agentId(3), name: 'b-01', status: 'active' },
      ],
    });
    const listedAt = new Date();
    await prisma.syncState.upsert({
      where: { name: AGENTS_SYNC_STATE },
      create: { name: AGENTS_SYNC_STATE, lastProcessedAt: listedAt },
      update: { lastProcessedAt: listedAt },
    });
  });

  afterAll(async () => {
    await prisma.wazuhAgent.deleteMany({ where: { agentId: { in: [1, 2, 3, 4, 5].map(agentId) } } });
    await app.close();
  });

  describe('lista', () => {
    it('os agentes do cliente do nó, por nome, com a hora da última lista do manager', async () => {
      const page = await list(adminA.cookie);
      expect(page.items.map((agent) => agent.name)).toEqual(['db-01', 'web-01']);
      expect(page.total).toBe(2);
      expect(page.items[1]).toMatchObject({
        agentId: agentId(1),
        ip: '198.51.100.20',
        osName: 'Ubuntu',
        osVersion: '24.04.1 LTS',
        version: 'Wazuh v4.14.9',
        status: 'active',
      });
      expect(page.items[0]).toMatchObject({ osName: null, version: null, lastKeepAliveAt: null });
      expect(typeof page.syncedAt).toBe('string');
      const active = await list(adminA.cookie, '?status=active');
      expect(active.items.map((agent) => agent.name)).toEqual(['web-01']);
    });

    it('todo papel do cliente lê a lista', async () => {
      for (const cookie of [analystA.cookie, readerA.cookie]) expect((await list(cookie)).total).toBe(2);
    });

    it('isolamento: B não vê os agentes de A, e A não vê os de B', async () => {
      const ofB = await list(adminB.cookie);
      expect(ofB.items.map((agent) => agent.name)).toEqual(['b-01']);
      // O nó não é de B: nem a hora da lista do manager.
      expect(ofB.syncedAt).toBeNull();
      expect(JSON.stringify(await list(adminA.cookie))).not.toContain(agentId(3));
    });

    it('filtro fora da lista e campo desconhecido são recusados', async () => {
      await get('/v1/agents?status=removed', adminA.cookie).expect(400);
      await get('/v1/agents?tenantId=x', adminA.cookie).expect(400);
    });

    it('sem sessão, 401; admin_verax sem cliente escolhido, a recusa de sempre', async () => {
      await request(app.getHttpServer()).get('/v1/agents').expect(401);
      await request(app.getHttpServer()).get('/v1/agents/install').expect(401);
      const response = await get('/v1/agents', verax.cookie).expect(409);
      expect(response.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    });
  });

  describe('instruções de instalação', () => {
    it('administrador do cliente do nó: endereço, faixas, CA e a senha de registro, sem cache', async () => {
      const result = await install(adminA.cookie);
      expect(result).toMatchObject({
        status: 'ready',
        managerAddress: '203.0.113.10',
        eventsPort: 1514,
        enrollmentPort: 1515,
        group: 'default',
        allowedSources: ['198.51.100.0/28', '192.0.2.15/32'],
        enrollmentPassword: enrollment,
        canEnroll: true,
        registered: 2,
        maxAgents: 3,
      });
      expect(result.caCertificate?.trim()).toBe(CA.trim());
    });

    it('a trilha do cliente registra que as instruções foram vistas, e se a senha foi mostrada, nunca a senha', async () => {
      const [entry] = await auditsOf(adminA.id);
      expect(entry).toMatchObject({
        tenantId: tenantA,
        outcome: 'success',
        statusCode: 200,
        resourceType: 'wazuh_agents',
        after: { status: 'ready', enrollmentPasswordShown: true, registered: 2, maxAgents: 3 },
      });
      const all = await prisma.auditLog.findMany({ where: { tenantId: tenantA } });
      expect(JSON.stringify(all)).not.toContain(enrollment);
    });

    it('analista e leitura veem as instruções, sem a senha', async () => {
      for (const cookie of [analystA.cookie, readerA.cookie]) {
        const result = await install(cookie);
        expect(result).toMatchObject({ status: 'ready', enrollmentPassword: null, canEnroll: false });
        expect(result.caCertificate).not.toBeNull();
      }
    });

    it('outro cliente: os agentes não estão ligados para ele, e nada vai para a trilha', async () => {
      const result = await install(adminB.cookie);
      expect(result).toMatchObject({
        status: 'disabled',
        managerAddress: null,
        allowedSources: [],
        caCertificate: null,
        enrollmentPassword: null,
        canEnroll: true,
        registered: 1,
      });
      expect(await auditsOf(adminB.id)).toEqual([]);
    });

    it('admin_verax com o cliente do nó escolhido vê a senha, na trilha do cliente; com outro, desligado', async () => {
      await get('/v1/agents/install', verax.cookie).expect(409);
      await selectTenant(tenantA);
      expect((await install(verax.cookie)).enrollmentPassword).toBe(enrollment);
      const [entry] = await auditsOf(verax.id);
      expect(entry).toMatchObject({ tenantId: tenantA, after: { enrollmentPasswordShown: true } });
      await selectTenant(tenantB);
      expect((await install(verax.cookie)).status).toBe('disabled');
    });

    it('no limite de agentes do nó, a senha não sai (nem para quem administra)', async () => {
      await prisma.wazuhAgent.create({
        data: { tenantId: tenantA, agentId: agentId(5), name: 'limite-01', status: 'never_connected' },
      });
      const result = await install(adminA.cookie);
      expect(result).toMatchObject({
        status: 'ready',
        registered: 3,
        maxAgents: 3,
        enrollmentPassword: null,
      });
      const entries = await auditsOf(adminA.id);
      expect(entries.at(-1)).toMatchObject({ after: { enrollmentPasswordShown: false, registered: 3 } });
      await prisma.wazuhAgent.delete({ where: { agentId: agentId(5) } });
    });

    it('a senha nunca vai para o log, nem quando alguém a escreve numa mensagem', () => {
      app.get(Logger).warn(`teste: mensagem com a senha ${enrollment} no meio`);
      expect(capture.text).not.toContain(enrollment);
      expect(capture.text).toContain('teste: mensagem com a senha');
    });
  });

  describe('lista vinda do manager (tarefa wazuh-agents do worker)', () => {
    const feedAt = new Date(Date.now() - 30_000);
    const sync = (content: string | null, tenantId: string = tenantA) =>
      new WazuhAgentsSync(prisma, { file: '/run/wazuh-agents/agents.json', tenantId }, () =>
        Promise.resolve<AgentsFeedFile | null>(content === null ? null : { content, modifiedAt: feedAt }),
      );

    it('grava a lista no cliente do nó: atualiza, inclui, tira quem saiu do manager e quem não é do cliente', async () => {
      const report = await sync(
        managerResponse([
          {
            os: { name: 'Ubuntu', platform: 'ubuntu', version: '24.04.2 LTS' },
            version: 'Wazuh v4.14.9',
            lastKeepAlive: '2026-11-04T12:00:00+00:00',
            status: 'active',
            id: agentId(1),
            registerIP: 'any',
            name: 'web-01',
            dateAdd: '2026-11-01T09:00:00+00:00',
            ip: '198.51.100.21',
            group: ['default'],
          },
          {
            group: ['default'],
            status: 'never_connected',
            id: agentId(4),
            registerIP: 'any',
            name: 'win-01',
            dateAdd: '2026-11-04T11:00:00+00:00',
            ip: 'any',
          },
          // O próprio manager, um item fora do formato e um nome com caractere de controle: ficam de fora.
          { id: '000', name: 'wazuh.manager', status: 'active', lastKeepAlive: '9999-12-31T23:59:59+00:00' },
          { id: 'x', name: 'invalido', status: 'active' },
          { id: agentId(9), name: 'web\u001b[31m', status: 'active' },
        ]),
      ).runOnce();
      expect(report).toEqual({ status: 'synced', agents: 2, invalid: 2, removed: 2 });
      const rows = await prisma.wazuhAgent.findMany({
        where: { agentId: { in: [1, 2, 3, 4, 9].map(agentId) } },
        orderBy: { name: 'asc' },
      });
      expect(rows.map((row) => [row.name, row.tenantId])).toEqual([
        ['web-01', tenantA],
        ['win-01', tenantA],
      ]);
      expect(rows[0]).toMatchObject({
        osVersion: '24.04.2 LTS',
        ip: '198.51.100.21',
        lastKeepAliveAt: new Date('2026-11-04T12:00:00Z'),
      });
      expect(rows[1]).toMatchObject({ osName: null, version: null, lastKeepAliveAt: null, ip: 'any' });
      const state = await prisma.syncState.findUniqueOrThrow({ where: { name: AGENTS_SYNC_STATE } });
      expect(state).toMatchObject({ lastProcessedAt: feedAt, lastError: null });
      // O painel lê o que o worker gravou.
      expect((await list(adminA.cookie)).items.map((agent) => agent.name)).toEqual(['web-01', 'win-01']);
      expect((await list(adminB.cookie)).total).toBe(0);
    });

    it('lista fora do formato: nada muda, e o tipo do erro fica no estado', async () => {
      for (const [content, kind] of [
        ['{"data":', 'invalid_json'],
        [JSON.stringify({ error: 1, data: { affected_items: [], total_affected_items: 0 } }), 'invalid_feed'],
      ] as const) {
        await expect(sync(content).runOnce()).rejects.toMatchObject({ kind });
        const state = await prisma.syncState.findUniqueOrThrow({ where: { name: AGENTS_SYNC_STATE } });
        expect(state.lastError).toBe(kind);
        expect(await prisma.wazuhAgent.count({ where: { tenantId: tenantA } })).toBe(2);
      }
    });

    it('antes da primeira lista, a tarefa espera; com o cliente do nó desativado, nada é gravado', async () => {
      expect(await sync(null).runOnce()).toEqual({ status: 'waiting' });
      const inactive = await prisma.tenant.create({
        data: { name: 'Cliente Demo C (agentes, inativo)', status: 'inactive' },
        select: { id: true },
      });
      const report = await sync(
        managerResponse([{ id: agentId(7), name: 'c-01', status: 'active' }]),
        inactive.id,
      ).runOnce();
      expect(report).toEqual({ status: 'tenant_unavailable' });
      expect(await prisma.wazuhAgent.count({ where: { agentId: agentId(7) } })).toBe(0);
      expect(await prisma.wazuhAgent.count({ where: { tenantId: tenantA } })).toBe(2);
    });

    it('o arquivo do host: ausente é null; acima do teto nem é lido; a hora é a do arquivo', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'verax-agentes-'));
      try {
        expect(await readAgentsFeed(join(dir, 'agents.json'))).toBeNull();
        const file = join(dir, 'agents.json');
        await writeFile(file, managerResponse([]));
        const at = new Date('2026-11-04T10:00:00Z');
        await utimes(file, at, at);
        const read = await readAgentsFeed(file);
        expect(read?.modifiedAt.toISOString()).toBe(at.toISOString());
        expect(JSON.parse(read?.content ?? '')).toMatchObject({ error: 0 });
        await writeFile(file, Buffer.alloc(AGENTS_FEED_MAX_BYTES + 1, 0x20));
        await expect(readAgentsFeed(file)).rejects.toMatchObject({ kind: 'too_large' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  /**
   * Alertas dos agentes (tarefa `wazuh-agent-alerts` do worker). Ficam neste arquivo porque a lista dos agentes
   * (`WazuhAgent`) e a hora dela são globais no banco de teste, e a tarefa `wazuh-agents` acima tira da lista quem não
   * é do cliente do nó: em outro arquivo, rodando em paralelo, os agentes deste teste sumiriam no meio.
   */
  describe('alertas dos agentes viram achados do cliente do nó (tarefa wazuh-agent-alerts do worker)', () => {
    const app01 = agentId(11);
    const app02 = agentId(12);
    const bApp = agentId(13);
    const lateAgent = agentId(14);
    const accountA = String(randomInt(100_000_000_000, 999_999_999_999));
    const accountB = String(randomInt(100_000_000_000, 999_999_999_999));
    const trailA = `trilha-agentes-a-${randomInt(1e6, 9e6)}`;
    const findingPage = paginatedSchema(findingSchema);

    /** Alerta do agente app-01 do cliente A, `minutesAgo` minutos atrás, com id próprio. */
    const alertOf = (minutesAgo: number, options: AgentAlertOptions = {}) =>
      agentAlert({
        id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
        timestamp: wazuhTime(new Date(Date.now() - minutesAgo * MINUTE)),
        agentId: app01,
        agentName: 'app-01',
        ...options,
      });
    const syncFor = (documents: Record<string, unknown>[], tenantId: string | null = tenantA) =>
      new AgentAlertSync(prisma, new FakeIndexer(documents), tenantId, {
        name: `teste-${randomUUID().slice(0, 8)}`,
      });
    const keyOf = (document: Record<string, unknown>) => {
      const parsed = parseAgentAlert(document);
      if (!parsed.ok) throw new Error('fixture inválida');
      return { source_sourceEventId: { source: 'wazuh', sourceEventId: agentFindingKey(parsed.alert) } };
    };
    const queuedOf = (document: Record<string, unknown>) =>
      prisma.unownedAlert.findUnique({
        where: { source_sourceEventId: { source: 'wazuh', sourceEventId: String(document['id']) } },
      });
    const markListed = (at: Date) =>
      prisma.syncState.upsert({
        where: { name: AGENTS_SYNC_STATE },
        create: { name: AGENTS_SYNC_STATE, lastProcessedAt: at },
        update: { lastProcessedAt: at },
      });

    beforeAll(async () => {
      await prisma.wazuhAgent.createMany({
        data: [
          { tenantId: tenantA, agentId: app01, name: 'app-01', status: 'active' },
          { tenantId: tenantA, agentId: app02, name: 'app-02', status: 'active' },
          { tenantId: tenantB, agentId: bApp, name: 'b-app-01', status: 'active' },
        ],
      });
      await prisma.cloudAccount.create({
        data: { tenantId: tenantA, accountId: accountA, regions: ['sa-east-1'], cloudtrailBucket: trailA },
      });
      await prisma.cloudAccount.create({
        data: { tenantId: tenantB, accountId: accountB, regions: ['sa-east-1'] },
      });
      // A lista do manager é mais nova que os alertas: nenhum espera por ela (salvo no teste da espera).
      await markListed(new Date());
    });

    afterAll(async () => {
      await prisma.wazuhAgent.deleteMany({ where: { agentId: { in: [app01, app02, bApp, lateAgent] } } });
    });

    it('agente da lista do cliente do nó: vira achado dele, com a instância, e só ele o vê (A/B)', async () => {
      const document = alertOf(20);
      const report = await syncFor([document]).runOnce();
      expect(report).toMatchObject({
        status: 'done',
        read: 1,
        created: 1,
        unowned: 0,
        deferred: 0,
        skipped: 0,
      });

      const finding = await prisma.finding.findUniqueOrThrow({ where: keyOf(document) });
      expect(finding).toMatchObject({
        tenantId: tenantA,
        accountId: `agent:${app01}`,
        source: 'wazuh',
        rawEventId: document['id'],
        logSource: 'wazuh_agent',
        severity: 'high',
        status: 'new',
        ruleId: '5712',
        ruleLevel: 10,
        eventName: 'sshd',
        region: null,
        resource: 'host:app-01',
        actorUser: 'admin',
        sourceIp: '203.0.113.9',
        mitreTactics: ['Credential Access'],
        mitreTechniques: ['T1110'],
      });
      expect(await queuedOf(document)).toBeNull();

      // O painel lê o achado pelo contrato de sempre, com o agente como origem.
      const detail = findingDetailSchema.parse(
        (await get(`/v1/findings/${finding.id}`, adminA.cookie).expect(200)).body,
      );
      expect(detail).toMatchObject({
        accountId: `agent:${app01}`,
        source: 'wazuh_agent',
        resource: 'host:app-01',
      });
      const pageA = findingPage.parse(
        (await get('/v1/findings?pageSize=100', adminA.cookie).expect(200)).body,
      );
      expect(pageA.items.map((item) => item.id)).toContain(finding.id);
      // B nunca vê o achado do agente de A, nem pelo id.
      await get(`/v1/findings/${finding.id}`, adminB.cookie).expect(404);
      const pageB = findingPage.parse(
        (await get('/v1/findings?pageSize=100', adminB.cookie).expect(200)).body,
      );
      expect(pageB.items.map((item) => item.id)).not.toContain(finding.id);
    });

    it('reler a janela não duplica e não desfaz a triagem', async () => {
      const document = alertOf(18, { data: { srcip: '198.51.100.30' } });
      const sync = syncFor([document]);
      await sync.runOnce();
      await prisma.finding.update({ where: keyOf(document), data: { status: 'resolved' } });

      expect(await sync.runOnce()).toMatchObject({ read: 1, created: 0, duplicates: 1, unowned: 0 });
      expect(await syncFor([document]).runOnce()).toMatchObject({ created: 0, duplicates: 1 });
      expect((await prisma.finding.findUniqueOrThrow({ where: keyOf(document) })).status).toBe('resolved');
      expect(await prisma.finding.count({ where: { rawEventId: String(document['id']) } })).toBe(1);
    });

    it('na dúvida, de ninguém: agente fora da lista, nome trocado e o agente de outro cliente vão para a fila', async () => {
      const unknown = alertOf(16, { agentId: agentId(19), agentName: 'fantasma' });
      const renamed = alertOf(16, { agentId: app02, agentName: 'app-01' });
      const ofB = alertOf(16, { agentId: bApp, agentName: 'b-app-01' });
      const report = await syncFor([unknown, renamed, ofB]).runOnce();
      expect(report).toMatchObject({ read: 3, created: 0, unowned: 3, deferred: 0 });

      expect(await queuedOf(unknown)).toMatchObject({
        reason: 'unknown_agent',
        accounts: [`agent:${agentId(19)}`],
        ruleId: '5712',
        ruleLevel: 10,
      });
      expect(await queuedOf(renamed)).toMatchObject({
        reason: 'agent_name_mismatch',
        accounts: [`agent:${app02}`],
      });
      // O nó é de A: o agente registrado para B não é do cliente do nó.
      expect(await queuedOf(ofB)).toMatchObject({ reason: 'unknown_agent', accounts: [`agent:${bApp}`] });
      for (const document of [unknown, renamed, ofB]) {
        expect(await prisma.finding.count({ where: { rawEventId: String(document['id']) } })).toBe(0);
      }
      // A fila não guarda o log bruto.
      expect(JSON.stringify(await queuedOf(unknown))).not.toContain('Invalid user');
    });

    it('agentes desligados no worker (sem o cliente do nó): nem o agente da lista vira achado', async () => {
      const document = alertOf(15);
      expect(await syncFor([document], null).runOnce()).toMatchObject({ created: 0, unowned: 1 });
      expect(await queuedOf(document)).toMatchObject({
        reason: 'agents_disabled',
        accounts: [`agent:${app01}`],
      });
      expect(await prisma.finding.findUnique({ where: keyOf(document) })).toBeNull();
    });

    it('o nó de B só atribui o agente de B: o de A vai para a fila (A/B)', async () => {
      const ofA = alertOf(14);
      const ofB = alertOf(14, { agentId: bApp, agentName: 'b-app-01', data: { srcip: '198.51.100.40' } });
      const report = await syncFor([ofA, ofB], tenantB).runOnce();
      expect(report).toMatchObject({ created: 1, unowned: 1 });
      expect(await prisma.finding.findUniqueOrThrow({ where: keyOf(ofB) })).toMatchObject({
        tenantId: tenantB,
        accountId: `agent:${bApp}`,
      });
      expect(await queuedOf(ofA)).toMatchObject({ reason: 'unknown_agent' });
      expect(await prisma.finding.findUnique({ where: keyOf(ofA) })).toBeNull();
    });

    it('conta AWS de outro cliente citada no alerta do agente: conflito; a do próprio cliente não muda nada', async () => {
      const conflict = alertOf(13, { data: { srcip: '198.51.100.50', aws: { aws_account_id: accountB } } });
      const own = alertOf(13, { data: { srcip: '198.51.100.51', aws: { aws_account_id: accountA } } });
      const report = await syncFor([conflict, own]).runOnce();
      expect(report).toMatchObject({ created: 1, unowned: 1 });
      expect(await queuedOf(conflict)).toMatchObject({
        reason: 'agent_account_conflict',
        accounts: [`agent:${app01}`, accountB],
      });
      expect(await prisma.finding.findUnique({ where: keyOf(conflict) })).toBeNull();
      expect(await prisma.finding.findUniqueOrThrow({ where: keyOf(own) })).toMatchObject({
        tenantId: tenantA,
      });
    });

    it('o alerta do manager fica com o sync da AWS, e o do agente com cara de AWS, com o dos agentes: nunca os dois', async () => {
      const at = (minutesAgo: number) => ({
        id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
        timestamp: wazuhTime(new Date(Date.now() - minutesAgo * MINUTE)),
      });
      const manager = { ...cloudTrailAlert({ account: accountA, bucket: trailA }), ...at(12) };
      // O mesmo tipo de evento da AWS, mandado pelo agente app-01 como log da instância.
      const forged = {
        ...cloudTrailAlert({ account: accountA, bucket: trailA }),
        ...at(12),
        agent: { id: app01, name: 'app-01' },
      };
      const indexer = new FakeIndexer([manager, forged]);
      const name = () => `teste-${randomUUID().slice(0, 8)}`;

      const aws = await new AlertSync(prisma, indexer, { name: name() }).runOnce();
      expect(aws).toMatchObject({ read: 2, created: 1, unowned: 0, skipped: 1 });
      const agents = await new AgentAlertSync(prisma, indexer, tenantA, { name: name() }).runOnce();
      expect(agents).toMatchObject({ read: 2, created: 1, unowned: 0, skipped: 1 });

      const awsKey = (document: Record<string, unknown>) => {
        const parsed = parseWazuhAlert(document);
        if (!parsed.ok) throw new Error(parsed.reason);
        return {
          source_sourceEventId: { source: 'wazuh', sourceEventId: wazuhFindingKey(parsed.alert, accountA) },
        };
      };
      expect(await prisma.finding.findUniqueOrThrow({ where: awsKey(manager) })).toMatchObject({
        tenantId: tenantA,
        accountId: accountA,
        logSource: 'cloudtrail',
      });
      expect(await prisma.finding.findUnique({ where: awsKey(forged) })).toBeNull();
      expect(await prisma.finding.findUniqueOrThrow({ where: keyOf(forged) })).toMatchObject({
        tenantId: tenantA,
        accountId: `agent:${app01}`,
        logSource: 'wazuh_agent',
      });
      expect(await prisma.finding.count({ where: { rawEventId: String(forged['id']) } })).toBe(1);
      expect(await prisma.finding.count({ where: { rawEventId: String(manager['id']) } })).toBe(1);
    });

    it('lista atrás do alerta: o alerta recente do agente novo espera; com ele na lista, a próxima execução o grava', async () => {
      await markListed(new Date(Date.now() - 10 * MINUTE));
      try {
        const document = alertOf(0.5, {
          agentId: lateAgent,
          agentName: 'app-03',
          data: { srcip: '198.51.100.60' },
        });
        const sync = syncFor([document]);
        expect(await sync.runOnce()).toMatchObject({ read: 1, created: 0, unowned: 0, deferred: 1 });
        expect(await queuedOf(document)).toBeNull();

        await prisma.wazuhAgent.create({
          data: { tenantId: tenantA, agentId: lateAgent, name: 'app-03', status: 'active' },
        });
        await markListed(new Date());
        // A sobreposição relê o alerta.
        expect(await sync.runOnce()).toMatchObject({ read: 1, created: 1, deferred: 0, unowned: 0 });
        expect(await prisma.finding.findUniqueOrThrow({ where: keyOf(document) })).toMatchObject({
          tenantId: tenantA,
          resource: 'host:app-03',
        });
        expect(await queuedOf(document)).toBeNull();
      } finally {
        await markListed(new Date());
      }
    });

    it('achados da mesma instância viram um incidente do cliente do nó, com o agente entre as origens', async () => {
      const options = {
        agentId: app02,
        agentName: 'app-02',
        data: { srcip: '198.51.100.71', srcuser: 'deploy' },
      };
      const first = alertOf(11, options);
      const second = fimAlert({
        id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
        timestamp: wazuhTime(new Date(Date.now() - 10 * MINUTE)),
        agentId: app02,
        agentName: 'app-02',
      });
      const report = await syncFor([first, second]).runOnce();
      expect(report).toMatchObject({ created: 2, incidentsOpened: 1, incidentsJoined: 1 });

      const { incidentId } = await prisma.finding.findUniqueOrThrow({ where: keyOf(second) });
      expect(incidentId).not.toBeNull();
      const incident = incidentDetailSchema.parse(
        (await get(`/v1/incidents/${incidentId}`, adminA.cookie).expect(200)).body,
      );
      expect(incident.accounts).toEqual([`agent:${app02}`]);
      expect(incident.resources).toEqual(['host:app-02']);
      expect(incident.findings.map((item) => item.source)).toEqual(['wazuh_agent', 'wazuh_agent']);
      await get(`/v1/incidents/${incidentId}`, adminB.cookie).expect(404);
    });

    it('exceção do cliente pela instância: o achado já nasce legítimo, e a exceção conta o uso', async () => {
      const exception = await prisma.alertException.create({
        data: {
          tenantId: tenantA,
          ruleId: '550',
          field: 'resource',
          value: 'host:app-01',
          reason: 'Atualização de pacotes programada',
          createdById: adminA.id,
        },
      });
      const document = fimAlert({
        id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
        timestamp: wazuhTime(new Date(Date.now() - 9 * MINUTE)),
        agentId: app01,
        agentName: 'app-01',
      });
      expect(await syncFor([document]).runOnce()).toMatchObject({ created: 1, excepted: 1 });
      expect(await prisma.finding.findUniqueOrThrow({ where: keyOf(document) })).toMatchObject({
        status: 'legitimate',
        exceptionId: exception.id,
      });
      expect(await prisma.alertException.findUniqueOrThrow({ where: { id: exception.id } })).toMatchObject({
        matchedCount: 1,
      });
    });
  });
});
