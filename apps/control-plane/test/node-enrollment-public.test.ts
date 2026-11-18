import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import {
  type ClaimRequest,
  type ClaimResponse,
  ENROLLMENT_CODE_TTL_MS,
  enrollmentHash,
  newEnrollmentSecret,
  type ReportRequest,
} from '../src/enrollment/enrollment.js';
import {
  type EnrollmentFailureCode,
  type EnrollmentGateway,
  EnrollmentGatewayError,
} from '../src/enrollment/enrollment-gateway.js';
import { ENROLLMENT_CLAIM_PER_IP } from '../src/enrollment/node-enrollment.controller.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import type { TenantRecord } from '../src/tenants/tenant.schema.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { demoTenant } from './support/tenant-store-contract.js';

const START = new Date('2026-11-18T12:00:00.000Z');
const SITE = 'https://veraxsistemas.com.br';
const RELEASE = 'node-v1.2.3';
const HOST = { cpus: 4, memoryMb: 16_384, diskGb: 200, os: 'Ubuntu 24.04', arch: 'x86_64' };
/** Gerados aqui: nenhum valor fixo que pareça segredo no repositório. */
const TUNNEL_TOKEN = `tunel-ficticio-${randomBytes(16).toString('hex')}`;
const ADMIN_PASSWORD = `Temporaria-${randomBytes(8).toString('hex')}`;

/** O cp-worker de mentira: grava o que chegou e responde o que o teste mandar. */
class FakeEnrollmentGateway implements EnrollmentGateway {
  claims: ClaimRequest[] = [];
  reports: { nodeKey: string; report: ReportRequest }[] = [];
  failure: EnrollmentFailureCode | 'crash' | undefined;
  response: ClaimResponse | undefined;

  claim(request: ClaimRequest): Promise<ClaimResponse> {
    this.claims.push(request);
    if (this.failure === 'crash') return Promise.reject(new Error('rede'));
    if (this.failure !== undefined) return Promise.reject(new EnrollmentGatewayError(this.failure));
    if (this.response === undefined) return Promise.reject(new Error('sem resposta'));
    return Promise.resolve(this.response);
  }

  report(nodeKey: string, report: ReportRequest): Promise<void> {
    this.reports.push({ nodeKey, report });
    if (this.failure === 'crash') return Promise.reject(new Error('rede'));
    if (this.failure !== undefined) return Promise.reject(new EnrollmentGatewayError(this.failure));
    return Promise.resolve();
  }
}

/**
 * O registro da VM do cliente pelo cp-public (`/v1/node-enrollment/claim|report`): o que ele confere antes de acordar o
 * cp-worker (o código e a chave do nó pelo hash, o formato, o JSON, o limite por IP), o 404 genérico, a falta de CORS e
 * a máscara dos segredos no log. O cp-worker é um dublê; o caminho inteiro está em `enrollment-worker.test.ts`.
 */
describe('cp-public: registro da VM do cliente', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const tenants = new TenantStore(documents, clock, new AuditService(documents, clock));
  const gateway = new FakeEnrollmentGateway();
  let app: NestExpressApplication;
  let sequence = 0;
  let slugs = 0;
  let ip = '';

  beforeAll(async () => {
    app = await createApp({
      role: 'public',
      clock,
      documentStore: documents,
      enrollmentGateway: gateway,
      capture,
      trustProxyHops: 1,
      env: { LOG_LEVEL: 'debug', SITE_ORIGINS: SITE },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.set(START);
    gateway.claims = [];
    gateway.reports = [];
    gateway.failure = undefined;
    sequence += 1;
    // Um IP de documentação por teste: os limites por IP não vazam de um teste para outro.
    ip = `203.0.113.${sequence}`;
  });

  /** Um cliente da VM própria em provisionamento, com um código (e, com `claimed`, a chave do nó) gravados. */
  async function enrolled(
    options: { claimed?: boolean; expiresInMs?: number } = {},
  ): Promise<{ tenant: TenantRecord; code: string; nodeKey: string }> {
    slugs += 1;
    const seed = demoTenant(`cliente-pub-${slugs}`);
    const created = await tenants.create(
      {
        ...seed,
        consent: undefined,
        stripe: undefined,
        billing: { mode: 'contract' },
        hosting: 'customer',
        configuration: { ...seed.configuration, mode: 'self_hosted' },
      },
      { reason: 'teste', audit: { actor: 'system' }, initialState: 'waiting_customer_install' },
    );
    const code = newEnrollmentSecret();
    const nodeKey = newEnrollmentSecret();
    const now = clock.now();
    const tenant = (
      await tenants.change(created.id, () => ({
        to: 'provisioning',
        reason: 'teste',
        audit: { actor: 'system' },
        mutate: (t) => ({
          ...t,
          provisioning: { runId: created.id, step: 'enrollment.wait', attempts: 0 },
          enrollment: {
            codeHash: enrollmentHash(code),
            codeExpiresAt: new Date(now.getTime() + (options.expiresInMs ?? ENROLLMENT_CODE_TTL_MS)),
            codeCreatedAt: now,
            codeCreatedBy: 'owner:responsavel@verax.example',
            ...(options.claimed === true ? { claimedAt: now, nodeKeyHash: enrollmentHash(nodeKey) } : {}),
          },
        }),
      }))
    ).tenant;
    gateway.response = {
      tenantId: tenant.id,
      slug: tenant.slug,
      apiOrigin: `https://api-${tenant.slug}.veraxsistemas.com.br`,
      webOrigin: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      release: RELEASE,
      size: 'P',
      nodeConf: [{ name: 'PLAN', value: 'enterprise' }],
      tenantName: tenant.company.legalName,
      adminEmail: tenant.adminEmail ?? 'admin@exemplo.example',
      mail: null,
      tunnelToken: TUNNEL_TOKEN,
      nodeKey,
    };
    return { tenant, code, nodeKey };
  }

  function claim(body: unknown): request.Test {
    return request(app.getHttpServer())
      .post('/v1/node-enrollment/claim')
      .set('X-Forwarded-For', ip)
      .set('Origin', SITE)
      .send(body as object);
  }

  function report(authorization: string | undefined, body: unknown): request.Test {
    const call = request(app.getHttpServer()).post('/v1/node-enrollment/report').set('X-Forwarded-For', ip);
    return (authorization === undefined ? call : call.set('Authorization', authorization)).send(
      body as object,
    );
  }

  it('claim: o código certo vai ao cp-worker, e a resposta sai uma vez, sem cache, sem CORS e fora do log', async () => {
    const { code, nodeKey } = await enrolled();
    const response = await claim({ code, release: RELEASE, host: HOST });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ tunnelToken: TUNNEL_TOKEN, nodeKey, release: RELEASE, size: 'P' });
    expect(response.headers['cache-control']).toBe('private, no-store');
    // Chamado por máquina: nem a origem do site recebe cabeçalho de CORS.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(gateway.claims).toEqual([{ code, release: RELEASE, host: HOST }]);
    for (const secret of [code, nodeKey, TUNNEL_TOKEN]) expect(capture.text).not.toContain(secret);
  });

  it('claim: desconhecido, vencido ou já usado é o mesmo 404, sem acordar o cp-worker', async () => {
    const used = await enrolled({ claimed: true });
    const expired = await enrolled({ expiresInMs: MINUTE_MS });
    clock.set(new Date(START.getTime() + MINUTE_MS));
    const bodies: unknown[] = [];
    for (const code of [newEnrollmentSecret(), used.code, expired.code]) {
      const response = await claim({ code, release: RELEASE, host: HOST });
      expect(response.status).toBe(404);
      const { requestId: _id, ...rest } = response.body as Record<string, unknown>;
      bodies.push(rest);
    }
    expect(bodies[0]).toMatchObject({ statusCode: 404, message: 'Não encontrado', code: 'not_found' });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(gateway.claims).toEqual([]);
  });

  it('claim: corpo estrito (400), só JSON (415) e os códigos do cp-worker que a VM vê', async () => {
    const { code } = await enrolled();
    for (const body of [
      { code: 'curto', release: RELEASE, host: HOST },
      { code, release: 'v1', host: HOST },
      { code, release: RELEASE, host: { ...HOST, cpus: 0 } },
      { code, release: RELEASE, host: HOST, extra: 1 },
      { code, release: RELEASE },
    ]) {
      expect((await claim(body)).status).toBe(400);
    }
    const form = await request(app.getHttpServer())
      .post('/v1/node-enrollment/claim')
      .set('X-Forwarded-For', ip)
      .type('form')
      .send(`code=${code}`);
    expect(form.status).toBe(415);
    gateway.failure = 'release_mismatch';
    expect((await claim({ code, release: RELEASE, host: HOST })).body).toMatchObject({
      code: 'release_mismatch',
    });
    gateway.failure = 'unavailable';
    expect((await claim({ code, release: RELEASE, host: HOST })).status).toBe(503);
    gateway.failure = 'crash';
    const crashed = await claim({ code, release: RELEASE, host: HOST });
    expect(crashed.status).toBe(503);
    expect(crashed.body).toMatchObject({ code: 'enrollment_unavailable' });
    expect(capture.text).not.toContain(code);
  });

  it('claim: limite por IP (429 com Retry-After), outro IP segue', async () => {
    for (let index = 0; index < ENROLLMENT_CLAIM_PER_IP.capacity; index += 1) {
      expect((await claim({ code: newEnrollmentSecret(), release: RELEASE, host: HOST })).status).toBe(404);
    }
    const limited = await claim({ code: newEnrollmentSecret(), release: RELEASE, host: HOST });
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    ip = '198.51.100.7';
    expect((await claim({ code: newEnrollmentSecret(), release: RELEASE, host: HOST })).status).toBe(404);
  });

  it('report: só com a chave do nó (401 sem ela, fora do formato ou desconhecida); 204 com ela', async () => {
    const { nodeKey } = await enrolled({ claimed: true });
    const ready = { status: 'ready', version: RELEASE, adminBootstrapPassword: ADMIN_PASSWORD };
    for (const authorization of [
      undefined,
      'Bearer curta',
      `Basic ${nodeKey}`,
      `Bearer ${newEnrollmentSecret()}`,
    ]) {
      const response = await report(authorization, ready);
      expect(response.status).toBe(401);
      expect(response.body).toMatchObject({ code: 'unauthenticated' });
    }
    expect(gateway.reports).toEqual([]);
    // O corpo estrito: um campo a mais, um status desconhecido, um código de erro fora do formato.
    for (const body of [
      { ...ready, extra: true },
      { status: 'done' },
      { status: 'error', code: 'Com Espaço' },
      { status: 'ready', version: RELEASE, adminBootstrapPassword: 'curta' },
    ]) {
      expect((await report(`Bearer ${nodeKey}`, body)).status).toBe(400);
    }
    const ok = await report(`Bearer ${nodeKey}`, ready);
    expect(ok.status).toBe(204);
    expect(
      (await report(`Bearer ${nodeKey}`, { status: 'error', code: 'docker_install_failed' })).status,
    ).toBe(204);
    expect(gateway.reports).toEqual([
      { nodeKey, report: ready },
      { nodeKey, report: { status: 'error', code: 'docker_install_failed' } },
    ]);
    for (const secret of [nodeKey, ADMIN_PASSWORD]) expect(capture.text).not.toContain(secret);
  });

  it('report: a chave de um código ainda não usado não existe; o cliente cancelado não reporta mais', async () => {
    const pending = await enrolled();
    expect((await report(`Bearer ${pending.nodeKey}`, { status: 'error', code: 'x' })).status).toBe(401);
    const claimed = await enrolled({ claimed: true });
    await tenants.change(claimed.tenant.id, () => ({
      to: 'canceled',
      reason: 'teste',
      audit: { actor: 'system' },
    }));
    expect((await report(`Bearer ${claimed.nodeKey}`, { status: 'error', code: 'x' })).status).toBe(401);
    expect(gateway.reports).toEqual([]);
  });
});
