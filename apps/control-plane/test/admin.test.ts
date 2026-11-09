import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { opaqueRef, SESSION_IDLE_MS } from '../src/admin/auth/admin-auth.schema.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import type { CostModelInput, PriceTableInput } from '../src/pricing/pricing.schema.js';
import { MemoryAdminSecrets, seedOwnerSession, sessionCookie } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousCostModel, fictitiousPriceTable } from './support/pricing-fixtures.js';

const START = new Date('2026-11-04T12:00:00.000Z');
/** Responsável fictício (o que estaria em OWNER_PRINCIPALS) e uma pessoa que não é responsável. */
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';

/**
 * O console do responsável (`ROLE=admin`) pelo app inteiro: a guarda que exige a sessão do login próprio (cookie
 * `__session`; as sessões destes testes são gravadas direto no Firestore em memória, `support/admin-auth.ts`, e o
 * login em si está em `admin-auth.test.ts`), as tabelas de preços e os modelos de custo (rascunho, edição, publicação
 * com a checagem da grade) e o simulador de DRE. Tabela e modelo FICTÍCIOS. Um app por arquivo.
 */
describe('cp-admin: console do responsável com login próprio', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  let app: NestExpressApplication;
  /** O cookie da sessão do responsável e o de uma sessão de quem não está (mais) em OWNER_PRINCIPALS. */
  let ownerCookie = '';
  let strangerCookie = '';

  function call(
    method: 'get' | 'post' | 'put',
    path: string,
    cookie: string | null = ownerCookie,
  ): request.Test {
    const test = request(app.getHttpServer())[method](path);
    return cookie === null ? test : test.set('Cookie', cookie);
  }

  function send(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    cookie: string | null = ownerCookie,
  ): request.Test {
    return call(method, path, cookie).set('Content-Type', 'application/json').send(JSON.stringify(body));
  }

  async function publishCostModel(
    model: CostModelInput = fictitiousCostModel(),
    version = 'custos-teste-v1',
  ): Promise<request.Response> {
    await send('post', '/v1/admin/cost-models', { version, content: model }).expect(201);
    return send('post', `/v1/admin/cost-models/${version}/publish`, {}).expect(200);
  }

  async function createTable(
    table: PriceTableInput = fictitiousPriceTable(),
    version = 'teste-v1',
  ): Promise<void> {
    await send('post', '/v1/admin/pricing-tables', { version, content: table }).expect(201);
  }

  async function auditActions(): Promise<string[]> {
    const docs = await documents.query(COLLECTIONS.auditLog, { orderBy: { field: 'at' } });
    return docs.map((doc) => String(doc.data['action']));
  }

  beforeAll(async () => {
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: new MemoryAdminSecrets(),
      env: {
        LOG_LEVEL: 'debug',
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: `${OWNER},sa-teste@projeto-demo.iam.gserviceaccount.com`,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(async () => {
    clock.set(START);
    documents.clear();
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    strangerCookie = await seedOwnerSession(documents, clock, STRANGER);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('sessão do login próprio', () => {
    it('/health responde sem sessão (a sonda do Cloud Run); o resto exige o cookie __session', async () => {
      await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const missing = await call('get', '/v1/admin/pricing-tables', null).expect(401);
      expect(missing.body).toMatchObject({
        statusCode: 401,
        code: 'unauthenticated',
        message: 'Não autenticado',
      });
      await call('get', '/v1/admin/pricing-tables').expect(200, []);
    });

    it('cookie inventado, de outro nome ou adulterado: 401, sem o cookie no log', async () => {
      const real = ownerCookie.split('=')[1] ?? '';
      const tampered = `${real.slice(0, -1)}${real.endsWith('A') ? 'B' : 'A'}`;
      const cases = [
        sessionCookie('nao-e-um-id'),
        sessionCookie('A'.repeat(43)),
        sessionCookie(tampered),
        `outro=${real}`,
        `__Session=${real}`,
      ];
      const before = capture.lines.length;
      for (const cookie of cases) {
        const response = await call('get', '/v1/admin/pricing-tables', cookie).expect(401);
        expect(response.body, cookie).toMatchObject({ code: 'unauthenticated' });
      }
      const refused = capture
        .entries()
        .slice(before)
        .filter((entry) => entry['event'] === 'admin_session_refused')
        .map((entry) => entry['reason']);
      expect(refused).toEqual(['invalid', 'invalid', 'invalid', 'missing', 'missing']);
      expect(capture.text).not.toContain(real);
      // Sessão ausente ou vencida é o dia a dia do console: não entra na métrica de recusas (admin_auth_failed).
      expect(
        capture
          .entries()
          .slice(before)
          .some((entry) => entry['event'] === 'admin_auth_failed'),
      ).toBe(false);
    });

    it('30 min sem uso ou 12 h desde o login: 401, e a sessão é apagada no servidor', async () => {
      clock.advance(SESSION_IDLE_MS - MINUTE_MS);
      await call('get', '/v1/admin/me').expect(200);
      // O uso de agora conta: mais 29 min e ainda vale.
      clock.advance(SESSION_IDLE_MS - MINUTE_MS);
      await call('get', '/v1/admin/me').expect(200);
      clock.advance(SESSION_IDLE_MS);
      await call('get', '/v1/admin/me').expect(401);
      const ref = opaqueRef(ownerCookie.split('=')[1] ?? '');
      expect(await documents.get(COLLECTIONS.adminSessions, ref)).toBeUndefined();

      // Prazo absoluto: usada a cada 20 min, ainda cai 12 h depois do login.
      clock.set(START);
      const cookie = await seedOwnerSession(documents, clock, OWNER);
      for (let elapsed = 0; elapsed < 12 * 60; elapsed += 20) {
        await call('get', '/v1/admin/me', cookie).expect(200);
        clock.advance(20 * MINUTE_MS);
      }
      await call('get', '/v1/admin/me', cookie).expect(401);
    });

    it('sessão de quem não está em OWNER_PRINCIPALS: 403, sem o e-mail no log', async () => {
      const before = capture.lines.length;
      const response = await call('get', '/v1/admin/pricing-tables', strangerCookie).expect(403);
      expect(response.body).toMatchObject({ code: 'forbidden' });
      expect(
        capture
          .entries()
          .slice(before)
          .find((entry) => entry['event'] === 'admin_auth_failed'),
      ).toMatchObject({ reason: 'not_owner' });
      expect(capture.text).not.toContain(STRANGER);
    });

    it('conta apagada (cadastro refeito): as sessões dela caem na próxima regravação', async () => {
      await documents.runTransaction(async (tx) => {
        const accounts = await tx.query(COLLECTIONS.adminAccounts);
        for (const account of accounts) tx.delete(COLLECTIONS.adminAccounts, account.id);
      });
      clock.advance(2 * MINUTE_MS);
      await call('get', '/v1/admin/me').expect(401);
    });

    it('escritas só em JSON e nunca de outro site, inclusive o login e o cadastro', async () => {
      const form = await call('post', '/v1/admin/cost-models')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('version=custos-teste-v1')
        .expect(415);
      expect(form.body).toMatchObject({ code: 'unsupported_media_type' });
      await call('post', '/v1/admin/pricing-tables/teste-v1/publish').expect(415);
      const crossSite = await send('post', '/v1/admin/cost-models', {
        version: 'custos-teste-v1',
        content: {},
      })
        .set('Sec-Fetch-Site', 'cross-site')
        .expect(403);
      expect(crossSite.body).toMatchObject({ code: 'cross_site' });
      expect(await documents.query(COLLECTIONS.costModels)).toHaveLength(0);
      // As rotas sem sessão (login e cadastro) seguem as mesmas regras de escrita.
      await call('post', '/v1/admin/login', null)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('email=x&password=y&code=123456')
        .expect(415);
      await send('post', '/v1/admin/login', { email: OWNER, password: 'x', code: '123456' }, null)
        .set('Sec-Fetch-Site', 'same-site')
        .expect(403);
      await send('post', '/v1/admin/setup/start', {}, null).set('Sec-Fetch-Site', 'cross-site').expect(403);
      // Sem CORS: nem a origem do site recebe cabeçalho.
      const preflight = await request(app.getHttpServer())
        .options('/v1/admin/cost-models')
        .set('Origin', 'https://veraxsistemas.com.br')
        .set('Access-Control-Request-Method', 'POST');
      expect(Object.keys(preflight.headers).filter((header) => header.startsWith('access-control-'))).toEqual(
        [],
      );
    });

    it('GET /v1/admin/me devolve só o e-mail da sessão (o cabeçalho do console)', async () => {
      const me = await call('get', '/v1/admin/me').expect(200);
      expect(me.body).toEqual({ email: OWNER });
      await call('get', '/v1/admin/me', null).expect(401);
      await call('get', '/v1/admin/me', strangerCookie).expect(403);
    });

    it('as rotas públicas e o webhook não existem no cp-admin', async () => {
      await call('get', '/v1/public/pricing').expect(404);
      await send('post', '/v1/public/quote', {}).expect(404);
      await send('post', '/v1/public/checkout', {}).expect(404);
      await send('post', '/v1/stripe/webhook', {}).expect(404);
    });
  });

  describe('modelos de custo e tabelas de preços', () => {
    it('cria, lê e publica o modelo de custos; conteúdo inválido volta com os caminhos', async () => {
      const invalid = await send('post', '/v1/admin/cost-models', {
        version: 'custos-teste-v1',
        content: { ...fictitiousCostModel(), refundReserveRate: 2 },
      }).expect(400);
      expect(invalid.body).toMatchObject({
        code: 'invalid_request',
        details: { issues: [{ path: 'refundReserveRate' }] },
      });

      const published = await publishCostModel();

      expect(published.body).toMatchObject({ version: 'custos-teste-v1', status: 'published', report: null });
      const read = await call('get', '/v1/admin/cost-models/custos-teste-v1').expect(200);
      expect(read.body).toMatchObject({ status: 'published', content: { exchange: { brlPerUsd: 2 } } });
      const list = await call('get', '/v1/admin/cost-models').expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          version: 'custos-teste-v1',
          status: 'published',
          current: true,
          publishedBy: OWNER,
          updatedBy: OWNER,
        }) as unknown,
      ]);
      // A lista é só o resumo: o conteúdo (custos) fica na leitura da versão.
      expect(JSON.stringify(list.body)).not.toContain('brlPerUsd');
      expect(published.body).toMatchObject({ publishedBy: OWNER, updatedBy: OWNER });
      expect(await auditActions()).toEqual(['costs.draft.created', 'costs.published']);
    });

    it('publica a tabela de preços que passa na checagem; a anterior vira aposentada; publicada não muda', async () => {
      await publishCostModel();
      await createTable();
      const changed = fictitiousPriceTable();
      changed.users.max = 12;
      clock.advance(MINUTE_MS);
      const updated = await send('put', '/v1/admin/pricing-tables/teste-v1', { content: changed }).expect(
        200,
      );
      expect(updated.body).toMatchObject({ status: 'draft', content: { users: { max: 12 } } });

      const checked = await send('post', '/v1/admin/pricing-tables/teste-v1/check', {}).expect(200);
      expect(checked.body).toMatchObject({ costModelVersion: 'custos-teste-v1', report: { ok: true } });

      const published = await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(200);

      expect(published.body).toMatchObject({
        version: 'teste-v1',
        status: 'published',
        effectiveFrom: clock.now().toISOString(),
        report: { ok: true, belowMinimum: { count: 0 }, taxRateId: 'teste_a', paymentMethod: 'card' },
      });
      const stored = await call('get', '/v1/admin/pricing-tables/teste-v1').expect(200);
      expect(stored.body).toMatchObject({
        status: 'published',
        publishedBy: OWNER,
        publishCheck: { ok: true, costModelVersion: 'custos-teste-v1', belowMinimum: 0 },
      });

      const immutable = await send('put', '/v1/admin/pricing-tables/teste-v1', { content: changed }).expect(
        409,
      );
      expect(immutable.body).toMatchObject({ code: 'version_immutable' });
      const again = await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(409);
      expect(again.body).toMatchObject({ code: 'version_immutable' });

      clock.advance(MINUTE_MS);
      await createTable(fictitiousPriceTable(), 'teste-v2');
      await send('post', '/v1/admin/pricing-tables/teste-v2/publish', {}).expect(200);
      const list = await call('get', '/v1/admin/pricing-tables').expect(200);
      expect(
        (list.body as { version: string; status: string; current: boolean }[]).map((entry) => [
          entry.version,
          entry.status,
          entry.current,
        ]),
      ).toEqual([
        ['teste-v2', 'published', true],
        ['teste-v1', 'retired', false],
      ]);
      const audit = (await documents.query(COLLECTIONS.auditLog)).map((doc) => doc.data);
      expect(audit.every((entry) => entry['actor'] === `owner:${OWNER}`)).toBe(true);
      expect(await auditActions()).toEqual([
        'costs.draft.created',
        'costs.published',
        'pricing.draft.created',
        'pricing.draft.updated',
        'pricing.published',
        'pricing.draft.created',
        'pricing.published',
        'pricing.retired',
      ]);
    });

    it('recusa publicar a tabela com configuração abaixo da margem mínima: 422 com o relatório, auditado, segue rascunho', async () => {
      await publishCostModel();
      // Suporte prioritário quase de graça (fictício): as configurações com ele ficam abaixo da margem mínima.
      const losing = fictitiousPriceTable();
      losing.prioritySupport.amount = 100;
      await createTable(losing);

      const refused = await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(422);

      const body = refused.body as {
        code: string;
        details: {
          costModelVersion: string;
          report: {
            ok: boolean;
            belowMinimum: { count: number; configurations: { configuration: { support: string } }[] };
          };
        };
      };
      expect(body.code).toBe('publish_guard_failed');
      expect(body.details.costModelVersion).toBe('custos-teste-v1');
      expect(body.details.report.ok).toBe(false);
      expect(body.details.report.belowMinimum.count).toBeGreaterThan(0);
      expect(
        body.details.report.belowMinimum.configurations.every(
          (entry) => entry.configuration.support === 'priority',
        ),
      ).toBe(true);
      expect((await call('get', '/v1/admin/pricing-tables/teste-v1').expect(200)).body).toMatchObject({
        status: 'draft',
      });
      expect(await auditActions()).toContain('pricing.publish_refused');
      const refusal = (await documents.query(COLLECTIONS.auditLog)).find(
        (doc) => doc.data['action'] === 'pricing.publish_refused',
      );
      expect(refusal?.data['details']).toMatchObject({ version: 'teste-v1', check: { ok: false } });
      // O relatório vai só na resposta: o log diz que recusou, sem margem nem configuração.
      expect(capture.entries().find((entry) => entry['event'] === 'pricing_publish_refused')).toMatchObject({
        version: 'teste-v1',
        costModelVersion: 'custos-teste-v1',
      });
      expect(capture.text).not.toContain('"belowMinimum"');
    });

    it('sem modelo de custos publicado, a tabela não publica (409); versão repetida, inexistente ou inválida', async () => {
      await createTable();
      const missing = await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(409);
      expect(missing.body).toMatchObject({ code: 'cost_model_missing' });
      const repeated = await send('post', '/v1/admin/pricing-tables', {
        version: 'teste-v1',
        content: fictitiousPriceTable(),
      }).expect(409);
      expect(repeated.body).toMatchObject({ code: 'version_exists' });
      await call('get', '/v1/admin/pricing-tables/inexistente').expect(404);
      await call('get', '/v1/admin/pricing-tables/Versao_Invalida').expect(404);
      const badVersion = await send('post', '/v1/admin/pricing-tables', {
        version: 'Versao Invalida',
        content: fictitiousPriceTable(),
      }).expect(400);
      expect(badVersion.body).toMatchObject({ details: { issues: [{ path: 'version' }] } });
      const extra = await send('post', '/v1/admin/pricing-tables/teste-v1/publish', { forcar: true }).expect(
        400,
      );
      expect(extra.body).toMatchObject({ code: 'invalid_request' });
      const past = await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {
        effectiveFrom: '2020-01-01T00:00:00Z',
      });
      expect(past.status).toBe(409);
    });

    it('um modelo de custos novo publica sempre, e avisa quando a tabela vigente deixa de passar na checagem', async () => {
      await publishCostModel();
      await createTable();
      await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(200);
      clock.advance(MINUTE_MS);

      const stricter = { ...fictitiousCostModel(), margins: { minimum: 0.45, alert: 0.5 } };
      const published = await publishCostModel(stricter, 'custos-teste-v2');

      expect(published.body).toMatchObject({ status: 'published', report: { ok: false } });
      expect(capture.entries().find((entry) => entry['event'] === 'pricing_margin_alert')).toMatchObject({
        priceTableVersion: 'teste-v1',
        costModelVersion: 'custos-teste-v2',
      });
      expect((await call('get', '/v1/admin/cost-models/custos-teste-v1').expect(200)).body).toMatchObject({
        status: 'retired',
      });
    });
  });

  describe('simulador de DRE', () => {
    it('a DRE de uma configuração com a tabela e o modelo vigentes (as contas fictícias do dre.test.ts)', async () => {
      await publishCostModel();
      await createTable();
      await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(200);

      const response = await send('post', '/v1/admin/dre/simulate', {
        configuration: {
          mode: 'managed',
          cloudAccounts: 4,
          monthlyGib: 50,
          agents: 10,
          historyDays: 180,
          support: 'standard',
        },
        paymentMethod: 'card',
      }).expect(200);

      expect(response.body).toMatchObject({
        contactUs: false,
        priceTableVersion: 'teste-v1',
        costModelVersion: 'custos-teste-v1',
        dre: {
          paymentMethod: 'card',
          taxRateId: 'teste_a',
          monthly: {
            grossRevenue: 128_000,
            taxes: 12_800,
            refundReserve: 3_840,
            netRevenue: 111_360,
            infrastructure: 25_740,
            paymentFees: 7_730,
            support: 22_400,
            contributionMargin: 55_490,
            fixedCosts: 20_000,
            result: 35_490,
          },
          quote: { configuration: { size: 'P' }, monthlyTotal: 128_000 },
        },
        // As metas e a alíquota do modelo usado, para o console marcar a margem e nomear o imposto.
        margins: { minimum: 0.25, alert: 0.35 },
        taxRate: { id: 'teste_a', label: 'Alíquota de teste A', rate: 0.1 },
      });
    });

    it('com um rascunho e outra alíquota; sob consulta; alíquota inexistente e sem tabela vigente', async () => {
      await publishCostModel();
      await createTable();
      const configuration = {
        mode: 'managed',
        cloudAccounts: 4,
        monthlyGib: 50,
        agents: 10,
        historyDays: 180,
        support: 'standard',
      };

      const missingTable = await send('post', '/v1/admin/dre/simulate', {
        configuration,
        paymentMethod: 'card',
      }).expect(409);
      expect(missingTable.body).toMatchObject({ code: 'pricing_table_missing' });

      const draft = await send('post', '/v1/admin/dre/simulate', {
        configuration,
        paymentMethod: 'boleto',
        priceTableVersion: 'teste-v1',
        taxRateId: 'teste_b',
      }).expect(200);
      expect(draft.body).toMatchObject({
        taxRate: { id: 'teste_b', label: 'Alíquota de teste B', rate: 0.2 },
        dre: {
          taxRateId: 'teste_b',
          paymentMethod: 'boleto',
          monthly: { taxes: 25_600, paymentFees: 1_580 },
        },
      });

      const contact = await send('post', '/v1/admin/dre/simulate', {
        configuration: { ...configuration, agents: 999 },
        paymentMethod: 'card',
        priceTableVersion: 'teste-v1',
      }).expect(200);
      expect(contact.body).toMatchObject({ contactUs: true, reason: 'agents_above_max' });
      expect(contact.body).not.toHaveProperty('margins');

      const unknownTax = await send('post', '/v1/admin/dre/simulate', {
        configuration,
        paymentMethod: 'card',
        priceTableVersion: 'teste-v1',
        taxRateId: 'inexistente',
      }).expect(422);
      expect(unknownTax.body).toMatchObject({
        code: 'cost_model_incomplete',
        details: { problems: ['taxes.rates.inexistente'] },
      });
    });
  });

  it('nenhum log leva custo, margem, preço, o e-mail do responsável ou o cookie da sessão', async () => {
    await publishCostModel();
    await createTable();
    await send('post', '/v1/admin/pricing-tables/teste-v1/publish', {}).expect(200);
    await send('post', '/v1/admin/dre/simulate', {
      configuration: {
        mode: 'managed',
        cloudAccounts: 4,
        monthlyGib: 50,
        agents: 10,
        historyDays: 180,
        support: 'standard',
      },
      paymentMethod: 'card',
    }).expect(200);

    const text = capture.text;
    expect(text).toContain('pricing_table_published');
    for (const forbidden of [
      OWNER,
      '"contributionMargin',
      '"grossRevenue"',
      '"vmUsdPerMonth"',
      '"brlPerUsd"',
      '"amount":',
      '"minimumMargin"',
      ownerCookie.slice(-20),
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});
