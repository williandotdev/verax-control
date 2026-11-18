import { describe, expect, it } from 'vitest';
import { scrubString } from '../common/logger/sanitize.js';
import type { Tenant } from '../tenants/tenant.schema.js';
import {
  codeClaimable,
  ENROLLMENT_SECRET_PATTERN,
  enrollmentHash,
  newEnrollmentSecret,
  nodeKeyFromAuthorization,
  nodeKeyValid,
  reportRequestSchema,
  sameHash,
} from './enrollment.js';
import { EnrollmentGatewayError, WorkerEnrollmentGateway } from './enrollment-gateway.js';

const NOW = new Date('2026-11-18T12:00:00.000Z');

function tenant(extra: Partial<Tenant> = {}): Tenant {
  return { hosting: 'customer', state: 'provisioning', ...extra } as Tenant;
}

describe('código de instalação e chave do nó', () => {
  it('32 bytes em base64url (43 caracteres), guardados só como SHA-256 em hexadecimal', () => {
    const secret = newEnrollmentSecret();
    expect(secret).toMatch(ENROLLMENT_SECRET_PATTERN);
    expect(newEnrollmentSecret()).not.toBe(secret);
    expect(enrollmentHash(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(sameHash(enrollmentHash(secret), enrollmentHash(secret))).toBe(true);
    expect(sameHash(enrollmentHash(secret), enrollmentHash(newEnrollmentSecret()))).toBe(false);
    expect(sameHash(undefined, enrollmentHash(secret))).toBe(false);
    expect(sameHash('abc', enrollmentHash(secret))).toBe(false);
  });

  it('o código vale uma vez, até vencer, só no ambiente do cliente e num estado que registra', () => {
    const code = newEnrollmentSecret();
    const hash = enrollmentHash(code);
    const enrollment = {
      codeHash: hash,
      codeExpiresAt: new Date(NOW.getTime() + 1000),
      codeCreatedAt: NOW,
      codeCreatedBy: 'owner:responsavel@verax.example',
    };
    expect(codeClaimable(tenant({ enrollment }), hash, NOW)).toBe(true);
    expect(codeClaimable(tenant({ enrollment }), hash, new Date(NOW.getTime() + 1000))).toBe(false);
    expect(codeClaimable(tenant({ enrollment: { ...enrollment, claimedAt: NOW } }), hash, NOW)).toBe(false);
    expect(codeClaimable(tenant({ enrollment, hosting: 'verax' }), hash, NOW)).toBe(false);
    expect(codeClaimable(tenant({ enrollment, state: 'canceled' }), hash, NOW)).toBe(false);
    expect(codeClaimable(tenant({ enrollment }), enrollmentHash(newEnrollmentSecret()), NOW)).toBe(false);
    const nodeKey = enrollmentHash(newEnrollmentSecret());
    const claimed = tenant({
      state: 'active',
      enrollment: { ...enrollment, claimedAt: NOW, nodeKeyHash: nodeKey },
    });
    expect(nodeKeyValid(claimed, nodeKey)).toBe(true);
    expect(nodeKeyValid({ ...claimed, state: 'deleted' }, nodeKey)).toBe(false);
    expect(nodeKeyValid(tenant({ enrollment }), nodeKey)).toBe(false);
  });

  it('a chave do nó só no Bearer, no formato; o corpo do report é estrito', () => {
    const key = newEnrollmentSecret();
    expect(nodeKeyFromAuthorization(`Bearer ${key}`)).toBe(key);
    expect(nodeKeyFromAuthorization(`bearer ${key}`)).toBe(key);
    for (const header of [
      undefined,
      '',
      key,
      `Basic ${key}`,
      `Bearer ${key} x`,
      'Bearer curta',
      [`Bearer ${key}`],
    ]) {
      expect(nodeKeyFromAuthorization(header)).toBeUndefined();
    }
    expect(reportRequestSchema.safeParse({ status: 'error', code: 'disk_too_small' }).success).toBe(true);
    expect(reportRequestSchema.safeParse({ status: 'error', code: 'a2' }).success).toBe(true);
    expect(reportRequestSchema.safeParse({ status: 'error', code: '2a' }).success).toBe(false);
    expect(reportRequestSchema.safeParse({ status: 'error', code: 'a'.repeat(41) }).success).toBe(false);
  });
});

describe('WorkerEnrollmentGateway', () => {
  const tokens = { get: (): Promise<string> => Promise.resolve('token-de-identidade-de-teste') };
  const response = {
    tenantId: '01JC0000000000000000000000',
    slug: 'cliente-demo-a',
    apiOrigin: 'https://api-cliente-demo-a.veraxsistemas.com.br',
    webOrigin: 'https://cliente-demo-a.control.veraxsistemas.com.br',
    release: 'node-v1.2.3',
    size: 'P',
    nodeConf: [{ name: 'PLAN', value: 'enterprise' }],
    tenantName: 'Cliente Demo A Ltda',
    adminEmail: 'admin@cliente-demo-a.example',
    mail: {
      host: 'smtp.exemplo.example',
      port: 587,
      user: 'a@b.example',
      from: 'a@b.example',
      password: 'senha-da-caixa-ficticia',
    },
    tunnelToken: 'token-do-tunel-ficticio-0001',
    nodeKey: newEnrollmentSecret(),
  };

  function gateway(
    status: number,
    body: unknown,
  ): { calls: { url: string; init: RequestInit }[]; client: WorkerEnrollmentGateway } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = ((url: URL, init: RequestInit) => {
      calls.push({ url: url.toString(), init });
      return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
    }) as unknown as typeof fetch;
    return {
      calls,
      client: new WorkerEnrollmentGateway('https://cp-worker.exemplo.example', tokens, fetchFn),
    };
  }

  it('claim: a rota interna com o token do cp-public; os segredos da resposta entram na máscara do logger', async () => {
    const h = gateway(200, response);
    const request = {
      code: newEnrollmentSecret(),
      release: 'node-v1.2.3',
      host: { cpus: 2, memoryMb: 8192, diskGb: 100, os: 'Debian 12', arch: 'x86_64' },
    };
    expect(await h.client.claim(request)).toEqual(response);
    expect(h.calls[0]?.url).toBe('https://cp-worker.exemplo.example/internal/node-enrollment/claim');
    expect((h.calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer token-de-identidade-de-teste',
    );
    for (const secret of [response.tunnelToken, response.nodeKey, response.mail.password]) {
      expect(scrubString(`x ${secret} y`)).not.toContain(secret);
    }
  });

  it('report: 204; os códigos do worker que a VM vê, e o resto vira unavailable; resposta fora do formato também', async () => {
    const ok = gateway(204, undefined);
    await ok.client.report(newEnrollmentSecret(), { status: 'error', code: 'x' });
    expect(ok.calls[0]?.url).toBe('https://cp-worker.exemplo.example/internal/node-enrollment/report');
    for (const [status, code] of [
      [400, 'invalid_request'],
      [401, 'unauthenticated'],
      [404, 'not_found'],
      [409, 'release_mismatch'],
      [403, 'unavailable'],
      [500, 'unavailable'],
    ] as const) {
      await expect(
        gateway(status, { code: 'x' }).client.report(newEnrollmentSecret(), { status: 'error', code: 'x' }),
      ).rejects.toEqual(new EnrollmentGatewayError(code));
    }
    await expect(gateway(200, { ...response, extra: 1 }).client.claim({} as never)).rejects.toEqual(
      new EnrollmentGatewayError('unavailable'),
    );
  });
});
