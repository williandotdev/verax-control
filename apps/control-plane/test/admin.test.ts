import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { IAP_JWT_HEADER } from '../src/admin/iap-verifier.js';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import type { CostModelInput, PriceTableInput } from '../src/pricing/pricing.schema.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { TestIap } from './support/iap-test-keys.js';
import { LogCapture } from './support/log-capture.js';
import { fictitiousCostModel, fictitiousPriceTable } from './support/pricing-fixtures.js';

const START = new Date('2026-11-04T12:00:00.000Z');
const AUDIENCE = '/projects/111111111111/locations/southamerica-east1/services/cp-admin';
/** Responsável fictício (o que estaria em OWNER_PRINCIPALS) e uma pessoa autenticada pelo IAP que não é responsável. */
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';

/**
 * O console do responsável (`ROLE=admin`) pelo app inteiro: a guarda que confere o JWT do IAP (assinado por uma chave
 * ES256 gerada no teste, `iap-test-keys.ts`; nada fala com o Google), as tabelas de preços e os modelos de custo
 * (rascunho, edição, publicação com a checagem da grade) e o simulador de DRE. Tabela e modelo FICTÍCIOS. Um app por
 * arquivo.
 */
describe('cp-admin: console do responsável atrás do IAP', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const iap = new TestIap();
  let app: NestExpressApplication;

  function ownerToken(email = OWNER): string {
    return iap.token({ audience: AUDIENCE, email });
  }

  function call(
    method: 'get' | 'post' | 'put',
    path: string,
    token: string | null = ownerToken(),
  ): request.Test {
    const test = request(app.getHttpServer())[method](path);
    return token === null ? test : test.set(IAP_JWT_HEADER, token);
  }

  function send(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    token: string | null = ownerToken(),
  ): request.Test {
    return call(method, path, token).set('Content-Type', 'application/json').send(JSON.stringify(body));
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
      iapKeySource: iap,
      env: {
        LOG_LEVEL: 'debug',
        IAP_AUDIENCE: AUDIENCE,
        OWNER_PRINCIPALS: `${OWNER},sa-teste@projeto-demo.iam.gserviceaccount.com`,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    clock.set(START);
    documents.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('autenticação pelo IAP', () => {
    it('/health responde sem token (a sonda do Cloud Run não passa pelo IAP); o resto exige o JWT', async () => {
      await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const missing = await call('get', '/v1/admin/pricing-tables', null).expect(401);
      expect(missing.body).toMatchObject({
        statusCode: 401,
        code: 'unauthenticated',
        message: 'Não autenticado',
      });
      await call('get', '/v1/admin/pricing-tables').expect(200, []);
    });

    it('token adulterado, de outro algoritmo, outra audiência, outro emissor, vencido ou de chave desconhecida: 401', async () => {
      const cases: [string, string][] = [
        ['malformed', 'nao.e.jwt!'],
        ['malformed', 'apenas-um-pedaco'],
        ['algorithm', iap.token({ audience: AUDIENCE, email: OWNER, header: { alg: 'HS256' } })],
        ['algorithm', iap.token({ audience: AUDIENCE, email: OWNER, header: { alg: 'none' } })],
        [
          'invalid',
          iap.token({ audience: '/projects/222222222222/locations/x/services/outro', email: OWNER }),
        ],
        [
          'invalid',
          iap.token({ audience: AUDIENCE, email: OWNER, payload: { iss: 'https://accounts.google.com' } }),
        ],
        [
          'invalid',
          iap.token({
            audience: AUDIENCE,
            email: OWNER,
            payload: { iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
          }),
        ],
        ['invalid', iap.token({ audience: AUDIENCE, email: OWNER, signer: TestIap.otherSigner() })],
        ['unknown_key', iap.token({ audience: AUDIENCE, email: OWNER, header: { kid: 'kid-desconhecido' } })],
      ];
      const before = capture.lines.length;
      for (const [reason, token] of cases) {
        const response = await call('get', '/v1/admin/pricing-tables', token).expect(401);
        expect(response.body, reason).toMatchObject({ code: 'unauthenticated' });
      }
      const reasons = capture
        .entries()
        .slice(before)
        .filter((entry) => entry['event'] === 'admin_auth_failed')
        .map((entry) => entry['reason']);
      expect(reasons).toEqual(cases.map(([reason]) => reason));
      // Um kid desconhecido faz o console reler as chaves (rotação), uma vez.
      expect(iap.refreshes).toBe(1);
      // Nenhum token vai a log.
      for (const [, token] of cases) expect(capture.text).not.toContain(token.slice(-20));
    });

    it('token válido de quem não é responsável: 403, sem o e-mail no log', async () => {
      const before = capture.lines.length;
      const response = await call('get', '/v1/admin/pricing-tables', ownerToken(STRANGER)).expect(403);
      expect(response.body).toMatchObject({ code: 'forbidden' });
      expect(
        capture
          .entries()
          .slice(before)
          .find((entry) => entry['event'] === 'admin_auth_failed'),
      ).toMatchObject({ reason: 'not_owner' });
      expect(capture.text).not.toContain(STRANGER);
      // O e-mail confere sem diferenciar maiúsculas.
      await call('get', '/v1/admin/pricing-tables', ownerToken(OWNER.toUpperCase())).expect(200);
    });

    it('escritas só em JSON e nunca de outro site (o IAP autentica por cookie)', async () => {
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
      // Sem CORS: nem a origem do site recebe cabeçalho.
      const preflight = await request(app.getHttpServer())
        .options('/v1/admin/cost-models')
        .set('Origin', 'https://veraxsistemas.com.br')
        .set('Access-Control-Request-Method', 'POST');
      expect(Object.keys(preflight.headers).filter((header) => header.startsWith('access-control-'))).toEqual(
        [],
      );
    });

    it('GET /v1/admin/me devolve só o e-mail conferido no JWT (o cabeçalho do console)', async () => {
      const me = await call('get', '/v1/admin/me', ownerToken(OWNER.toUpperCase())).expect(200);
      expect(me.body).toEqual({ email: OWNER });
      await call('get', '/v1/admin/me', null).expect(401);
      await call('get', '/v1/admin/me', ownerToken(STRANGER)).expect(403);
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

  it('nenhum log leva custo, margem, preço, o e-mail do responsável ou o token', async () => {
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
      ownerToken().slice(-20),
    ]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });
});
