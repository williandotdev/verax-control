import 'reflect-metadata';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/common/audit/audit.service.js';
import { REDACTED } from '../src/common/logger/sanitize.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { AuditLog } from '../src/generated/prisma/client.js';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';
import {
  EXPLODE_AFTER_INSERT,
  FORCE_AUDIT_FAILURE,
  WidgetProbeModule,
} from './support/widget-probe.module.js';

describe('trilha de auditoria (T1.3)', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;
  let prisma: PrismaService;

  async function auditFor(requestId: string | undefined): Promise<AuditLog[]> {
    expect(requestId).toBeTypeOf('string');
    return prisma.auditLog.findMany({ where: { requestId } });
  }

  async function widgetExists(name: string): Promise<boolean> {
    const rows = await prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM widget_probe WHERE name = ${name}`;
    return rows[0]?.n !== 0n;
  }

  beforeAll(async () => {
    app = await createApp({ capture, imports: [WidgetProbeModule] });
    prisma = app.get(PrismaService);
    // Trigger só de teste: recusa gravar auditoria de um tipo de recurso específico.
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."resourceType" = 'force-audit-failure' THEN
          RAISE EXCEPTION 'auditoria recusada pelo teste';
        END IF;
        RETURN NEW;
      END;
      $$`;
    await prisma.$executeRaw`
      CREATE OR REPLACE TRIGGER test_reject_audit BEFORE INSERT ON "AuditLog"
      FOR EACH ROW EXECUTE FUNCTION test_reject_audit()`;
  });

  afterAll(async () => {
    await prisma.$executeRaw`DROP TRIGGER IF EXISTS test_reject_audit ON "AuditLog"`;
    await app.close();
  });

  describe('escritas com sucesso', () => {
    it('registra quem, ação, recurso, estado novo, data, IP, user agent e request id', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/widgets-probe')
        .set('User-Agent', 'teste-auditoria/1.0')
        .set('X-Forwarded-For', '203.0.113.99')
        .send({ name: 'sensor-a', password: 'leak-audit-5001', notes: 'ok' })
        .expect(201);

      const [entry, ...others] = await auditFor(response.headers['x-request-id']);
      expect(others).toHaveLength(0);
      expect(entry).toMatchObject({
        actorType: 'anonymous',
        actorId: null,
        tenantId: null,
        action: 'widget.create',
        resourceType: 'widget',
        resourceId: (response.body as { id: string }).id,
        outcome: 'success',
        statusCode: 201,
        before: null,
        after: {
          id: (response.body as { id: string }).id,
          name: 'sensor-a',
          password: REDACTED,
          notes: 'ok',
        },
        userAgent: 'teste-auditoria/1.0',
      });
      expect(entry?.occurredAt).toBeInstanceOf(Date);
      // Sem proxy confiável configurado, o X-Forwarded-For não é aceito como IP do cliente.
      expect(entry?.ip).toMatch(/127\.0\.0\.1|::1/);
      expect(JSON.stringify(entry)).not.toContain('leak-audit-5001');
    });

    it('registra o estado anterior e o novo numa alteração', async () => {
      const created = await request(app.getHttpServer())
        .post('/v1/widgets-probe')
        .send({ name: 'antes' })
        .expect(201);
      const id = (created.body as { id: string }).id;

      const response = await request(app.getHttpServer())
        .patch(`/v1/widgets-probe/${id}`)
        .send({ name: 'depois' })
        .expect(200);

      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry).toMatchObject({
        action: 'widget.rename',
        resourceId: id,
        before: { id, name: 'antes' },
        after: { id, name: 'depois' },
        statusCode: 200,
        outcome: 'success',
      });
    });

    it('sem descrição do service, registra método e rota com o status declarado', async () => {
      const response = await request(app.getHttpServer()).post('/v1/widgets-probe/no-body').expect(204);
      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry).toMatchObject({
        action: 'POST /v1/widgets-probe/no-body',
        outcome: 'success',
        statusCode: 204,
      });
    });

    it('limita o tamanho do estado gravado', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/widgets-probe')
        .send({ name: 'grande', notes: 'x'.repeat(20 * 1024) })
        .expect(201);
      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry?.after).toMatchObject({ truncated: true });
    });
  });

  describe('tentativas que falham', () => {
    it('erro depois de gravar: a alteração é desfeita e a tentativa fica registrada', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/widgets-probe')
        .send({ name: EXPLODE_AFTER_INSERT })
        .expect(500);

      expect(await widgetExists(EXPLODE_AFTER_INSERT)).toBe(false);
      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry).toMatchObject({
        action: 'widget.create',
        outcome: 'failure',
        statusCode: 500,
        before: null,
        after: null,
      });
    });

    it('se a auditoria não pode ser gravada, a alteração também não é', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/widgets-probe')
        .send({ name: FORCE_AUDIT_FAILURE })
        .expect(500);

      expect(await widgetExists(FORCE_AUDIT_FAILURE)).toBe(false);
      await vi.waitFor(() => expect(capture.text).toContain('falha ao gravar auditoria'));
      expect(await auditFor(response.headers['x-request-id'])).toHaveLength(0);
    });

    it('validação recusada também é auditada', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/widgets-probe')
        .send({ name: '', role: 'admin_verax' })
        .expect(400);
      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry).toMatchObject({ action: 'POST /v1/widgets-probe', outcome: 'failure', statusCode: 400 });
    });

    it('corpo não declarado recusado também é auditado', async () => {
      const response = await request(app.getHttpServer())
        .post('/v1/widgets-probe/no-body')
        .send({ x: 1 })
        .expect(400);
      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry).toMatchObject({ outcome: 'failure', statusCode: 400 });
    });

    it('acesso negado fica como "denied"', async () => {
      const response = await request(app.getHttpServer()).post('/v1/widgets-probe/forbidden').expect(403);
      const [entry] = await auditFor(response.headers['x-request-id']);
      expect(entry).toMatchObject({ outcome: 'denied', statusCode: 403 });
    });
  });

  it('leituras não são auditadas', async () => {
    const response = await request(app.getHttpServer()).get('/v1/widgets-probe').expect(200);
    expect(await auditFor(response.headers['x-request-id'])).toHaveLength(0);
  });

  describe('imutabilidade', () => {
    it.each([
      ['UPDATE', () => prisma.$executeRaw`UPDATE "AuditLog" SET action = 'adulterado'`],
      ['DELETE', () => prisma.$executeRaw`DELETE FROM "AuditLog"`],
      ['TRUNCATE', () => prisma.$executeRaw`TRUNCATE "AuditLog"`],
    ])('o banco bloqueia %s', async (operation, run) => {
      expect(await prisma.auditLog.count()).toBeGreaterThan(0);
      await expect(run()).rejects.toThrow(`somente inserção: ${operation} bloqueado`);
    });

    it('o client do Prisma também não consegue alterar nem apagar', async () => {
      await expect(prisma.auditLog.updateMany({ data: { action: 'adulterado' } })).rejects.toThrow(
        /somente inserção/,
      );
      await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/somente inserção/);
    });

    it('o AuditService só sabe inserir', () => {
      const methods = Object.getOwnPropertyNames(AuditService.prototype).filter(
        (name) => name !== 'constructor',
      );
      expect(methods).toEqual(['write']);
    });

    it('nenhuma rota da API altera ou apaga auditoria', () => {
      const router = app.getHttpAdapter().getInstance() as {
        router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] };
      };
      const auditWrites = router.router.stack
        .flatMap((layer) => (layer.route ? [layer.route] : []))
        .filter((route) => /audit/i.test(route.path))
        .filter((route) => ['put', 'patch', 'delete', 'post'].some((method) => route.methods[method]));
      expect(auditWrites).toEqual([]);
    });
  });
});
