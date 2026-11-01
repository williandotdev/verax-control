import { ServiceUnavailableException } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { HealthController, READINESS_TIMEOUT_MS } from './health.controller.js';

function controllerWith(queryRaw: () => Promise<unknown>): { controller: HealthController; warn: unknown } {
  const warn = vi.fn();
  const prisma = { $queryRaw: queryRaw } as unknown as PrismaService;
  const logger = { warn } as unknown as PinoLogger;
  return { controller: new HealthController(prisma, logger), warn };
}

describe('HealthController.ready', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('desiste após o timeout quando o banco aceita a conexão mas não responde', async () => {
    vi.useFakeTimers();
    const { controller, warn } = controllerWith(() => new Promise(() => undefined));

    const result = controller.ready();
    const assertion = expect(result).rejects.toBeInstanceOf(ServiceUnavailableException);
    await vi.advanceTimersByTimeAsync(READINESS_TIMEOUT_MS);

    await assertion;
    expect(warn).toHaveBeenCalledOnce();
  });

  it('responde ok quando a consulta volta a tempo', async () => {
    const { controller } = controllerWith(() => Promise.resolve([{ '?column?': 1 }]));
    await expect(controller.ready()).resolves.toEqual({ status: 'ok' });
  });
});
