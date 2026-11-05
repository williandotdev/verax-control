import 'reflect-metadata';
import {
  PERIOD_BEYOND_HISTORY_CODE,
  periodBeyondHistoryMessage,
  planHistorySchema,
  REPORT_KINDS,
  reportSchemas,
  resolvePlan,
} from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSignedInUser, withCsrf } from './support/auth-helpers.js';
import { TEST_WEB_ORIGIN } from './support/create-app.js';
import { dateDaysAgo, type PlanHistoryFixture, planHistoryFixture } from './support/plan-history.js';

/** O nó destes testes está no Essencial: o histórico vem da tabela de planos do repositório, nunca digitado aqui. */
const HISTORY_DAYS = resolvePlan('essencial').limits.historyDays as number;

describe('histórico do plano nas telas: Essencial (fase 2, PR-20)', () => {
  let fx: PlanHistoryFixture;

  beforeAll(async () => {
    fx = await planHistoryFixture({ PLAN: 'essencial' });
  });

  afterAll(async () => {
    await fx.app.close();
  });

  it('o Essencial guarda 90 dias', () => {
    expect(HISTORY_DAYS).toBe(90);
  });

  describe('GET /v1/plan/history', () => {
    it.each(['admin_cliente', 'analista_cliente', 'leitura'] as const)(
      '%s lê só o histórico do plano',
      async (role) => {
        const response = await fx.as[role]('/v1/plan/history').expect(200);
        expect(response.body).toEqual({ historyDays: HISTORY_DAYS });
        expect(planHistorySchema.safeParse(response.body).success).toBe(true);
      },
    );

    it('o plano e o uso continuam só para quem administra', async () => {
      await fx.as.analista_cliente('/v1/plan').expect(403);
      await fx.as.leitura('/v1/plan').expect(403);
    });

    it('a Verax lê o histórico sem escolher cliente (é do nó, não de um cliente)', async () => {
      const verax = await createSignedInUser(fx.app, { role: 'admin_verax' });
      const response = await request(fx.app.getHttpServer())
        .get('/v1/plan/history')
        .set('Cookie', verax.cookie)
        .expect(200);
      expect(response.body).toEqual({ historyDays: HISTORY_DAYS });
    });

    it('sem sessão, 401', async () => {
      await fx.anonymous('/v1/plan/history').expect(401);
    });
  });

  describe('12 meses é recusado (400) com o código e a mensagem do plano', () => {
    const refused = (response: request.Response) => {
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: PERIOD_BEYOND_HISTORY_CODE,
        message: periodBeyondHistoryMessage(HISTORY_DAYS),
      });
    };

    it('achados, para todos os papéis', async () => {
      for (const role of ['admin_cliente', 'analista_cliente', 'leitura'] as const) {
        refused(await fx.as[role]('/v1/findings?period=12m'));
      }
    });

    it('auditoria (a trilha fica 13 meses, mas o filtro segue o plano)', async () => {
      refused(await fx.as.admin_cliente('/v1/audit?period=12m'));
    });

    it.each(REPORT_KINDS)('relatório %s', async (kind) => {
      refused(await fx.as.leitura(`/v1/reports/${kind}?period=12m`));
    });

    it('a Verax recebe a mesma recusa no cliente escolhido', async () => {
      const verax = await createSignedInUser(fx.app, { role: 'admin_verax' });
      const csrf = await withCsrf(fx.app, verax.cookie);
      await request(fx.app.getHttpServer())
        .post('/v1/session/tenant')
        .set('Cookie', csrf.cookie)
        .set('Origin', TEST_WEB_ORIGIN)
        .set('X-CSRF-Token', csrf.token)
        .send({ tenantId: fx.tenantA })
        .expect(200);
      const get = (path: string) => request(fx.app.getHttpServer()).get(path).set('Cookie', csrf.cookie);
      refused(await get('/v1/findings?period=12m'));
      refused(await get('/v1/audit?period=12m'));
      refused(await get('/v1/reports/summary?period=12m'));
    });

    it('período fora da lista continua sendo a validação de sempre, sem o código do plano', async () => {
      const response = await fx.as.leitura('/v1/findings?period=1y').expect(400);
      expect((response.body as { code?: string }).code).not.toBe(PERIOD_BEYOND_HISTORY_CODE);
    });
  });

  describe('até 90 dias passa', () => {
    it('achados e auditoria: 90 dias alcançam o registro de 80 dias, 30 dias não; nada do outro cliente', async () => {
      const finding = await fx.insertFinding(fx.tenantA, 80);
      const otherFinding = await fx.insertFinding(fx.tenantB, 80);
      expect(await fx.findingIds('leitura', '90d')).toContain(finding);
      expect(await fx.findingIds('leitura', '90d')).not.toContain(otherFinding);
      expect(await fx.findingIds('leitura', '30d')).not.toContain(finding);

      const entry = await fx.insertAudit(fx.tenantA, 80);
      const otherEntry = await fx.insertAudit(fx.tenantB, 80);
      expect(await fx.auditIds('90d')).toContain(entry);
      expect(await fx.auditIds('90d')).not.toContain(otherEntry);
      expect(await fx.auditIds('30d')).not.toContain(entry);
    });

    it('relatórios de 90 dias, no contrato', async () => {
      for (const kind of REPORT_KINDS) {
        const response = await fx.as.leitura(`/v1/reports/${kind}?period=90d`).expect(200);
        expect(reportSchemas[kind].safeParse(response.body).success).toBe(true);
      }
    });
  });

  it('a evolução da postura mostra os 90 dias do plano', async () => {
    const now = Date.now();
    await fx.insertScans(Array.from({ length: 120 }, (_, days) => days));
    const [account] = (await fx.posture()).accounts;
    expect(account?.history).toHaveLength(HISTORY_DAYS);
    expect(account?.history[0]?.date).toBe(dateDaysAgo(HISTORY_DAYS - 1, now));
    expect(account?.history.at(-1)?.date).toBe(dateDaysAgo(0, now));
  });
});
