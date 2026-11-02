import type { Request } from 'express';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import type { RequestAuth } from '../auth/request-auth.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { DenialAudit } from './denial-audit.service.js';

const auth: RequestAuth = {
  sessionId: 's',
  userId: 'u',
  email: 'u@cliente.example',
  role: 'leitura',
  tenantId: 't',
  activeTenantId: null,
  scopeTenantId: 't',
  mfaEnabled: true,
};

function setup(writeImpl: () => Promise<void> = () => Promise.resolve()) {
  const write = vi.fn(writeImpl);
  const error = vi.fn();
  const denials = new DenialAudit({} as PrismaService, { write }, { error } as unknown as PinoLogger);
  return { denials, write, error };
}

function fakeRequest(method: string, withAuth: boolean): Request {
  return {
    method,
    auth: withAuth ? auth : undefined,
    route: { path: '/v1/sonda' },
    path: '/v1/sonda',
    params: {},
    ip: '198.51.100.7',
    id: 'req-1',
    get: () => undefined,
  } as unknown as Request;
}

describe('DenialAudit', () => {
  it('grava a escrita negada de quem tem sessão', async () => {
    const { denials, write } = setup();
    await denials.record(fakeRequest('PATCH', true), 403);
    expect(write).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        action: 'PATCH /v1/sonda',
        actor: { type: 'user', id: 'u', tenantId: 't' },
        outcome: 'denied',
        statusCode: 403,
        requestId: 'req-1',
      }),
    );
  });

  it('não grava leitura nem requisição anônima', async () => {
    const { denials, write } = setup();
    await denials.record(fakeRequest('GET', true), 403);
    await denials.record(fakeRequest('POST', false), 403);
    expect(write).not.toHaveBeenCalled();
  });

  it('falha ao gravar vai para o log e não muda a resposta', async () => {
    const { denials, error } = setup(() => Promise.reject(new Error('banco fora')));
    await expect(denials.record(fakeRequest('POST', true), 403)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });
});
