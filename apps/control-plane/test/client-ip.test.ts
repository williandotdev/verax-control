import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './support/create-app.js';
import { LogCapture } from './support/log-capture.js';

/** Endereços de documentação (RFC 5737 e 3849): cliente, saída do Hosting, chamador direto e um IP forjado. */
const CLIENT = '203.0.113.10';
const CLIENT_V6 = '2001:db8::10';
const HOSTING_EGRESS = '198.51.100.7';
const DIRECT_CALLER = '192.0.2.44';
const FORGED = '192.0.2.99';
const LOOPBACK = ['127.0.0.1', '::ffff:127.0.0.1', '::1'];

/**
 * O IP do cliente que o app deriva (`req.ip`: o dos limites por IP e do log da requisição) para o formato de
 * X-Forwarded-For que chega ao contêiner, com a configuração de produção recomendada: TRUST_PROXY_HOPS=1 (padrão)
 * e as saídas do Hosting em TRUSTED_PROXIES. O socket do supertest (loopback) faz o papel do front end do Cloud
 * Run; cada entrada do cabeçalho é um salto acrescentado por quem encaminhou: o Hosting acrescenta o IP do cliente
 * dele, e o Cloud Run acrescenta o IP de quem se conectou a ele (a saída do Hosting, ou o chamador direto). Os
 * demais arranjos (sem lista, 0 saltos) estão no teste unitário da regra, `client-ip.test.ts`; um app por arquivo.
 */
describe('IP do cliente atrás do Hosting e do Cloud Run', () => {
  const capture = new LogCapture();
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ trustProxyHops: 1, trustedProxies: '198.51.100.0/24', capture });
  });

  afterAll(async () => {
    await app.close();
  });

  async function ipSeenBy(forwardedFor: string | undefined): Promise<string> {
    const before = capture.lines.length;
    let call = request(app.getHttpServer()).get('/v1/public/nada');
    if (forwardedFor !== undefined) call = call.set('x-forwarded-for', forwardedFor);
    await call.expect(404);
    const completed = await vi.waitFor(() => {
      const entry = capture
        .entries()
        .slice(before)
        .find((line) => line['message'] === 'request completed');
      expect(entry).toBeDefined();
      return entry;
    });
    const req = completed?.['req'] as { ip?: unknown; remoteAddress?: unknown };
    expect(LOOPBACK).toContain(req.remoteAddress);
    expect(typeof req.ip).toBe('string');
    return req.ip as string;
  }

  it('pelo Hosting, o cliente é o IP que o Hosting viu: nada antes dele conta', async () => {
    expect(await ipSeenBy(`${CLIENT}, ${HOSTING_EGRESS}`)).toBe(CLIENT);
    // Um cliente do Hosting que manda o próprio X-Forwarded-For não escolhe o IP: o Hosting acrescenta o real.
    expect(await ipSeenBy(`${FORGED}, ${CLIENT}, ${HOSTING_EGRESS}`)).toBe(CLIENT);
    expect(await ipSeenBy(`${CLIENT_V6}, ${HOSTING_EGRESS}`)).toBe(CLIENT_V6);
  });

  it('quem chama o run.app direto é identificado pelo IP que o Cloud Run acrescentou, mesmo forjando o cabeçalho', async () => {
    expect(await ipSeenBy(`${CLIENT}, ${DIRECT_CALLER}`)).toBe(DIRECT_CALLER);
    // Nem fingir ser o Hosting adianta: a saída do Hosting precisa ser o endereço que o Cloud Run acrescentou.
    expect(await ipSeenBy(`${HOSTING_EGRESS}, ${DIRECT_CALLER}`)).toBe(DIRECT_CALLER);
    expect(await ipSeenBy(`${CLIENT}, ${HOSTING_EGRESS}, ${DIRECT_CALLER}`)).toBe(DIRECT_CALLER);
  });

  it('sem cabeçalho, o cliente é quem se conectou (aqui, o socket local)', async () => {
    expect(LOOPBACK).toContain(await ipSeenBy(undefined));
  });
});
