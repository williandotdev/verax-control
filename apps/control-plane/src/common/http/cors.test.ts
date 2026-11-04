import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_PATH } from '../../webhook/raw-body.js';
import { buildCorsDelegate, type CorsDecision, NO_CORS_PATHS } from './cors.js';

const SITE = 'https://veraxsistemas.com.br';
const SITE_WWW = 'https://www.veraxsistemas.com.br';

function decide(origins: readonly string[], url: string, origin?: string): CorsDecision {
  const delegate = buildCorsDelegate(origins);
  let decision: CorsDecision | undefined;
  delegate({ url, headers: origin === undefined ? {} : { origin } } as IncomingMessage, (error, options) => {
    expect(error).toBeNull();
    decision = options;
  });
  if (decision === undefined) throw new Error('o delegate não respondeu');
  return decision;
}

describe('CORS do cp-public (CP-03)', () => {
  it('aceita só as origens do site, normalizadas (barra final na configuração não atrapalha)', () => {
    const origins = [`${SITE}/`, SITE_WWW];
    expect(decide(origins, '/v1/public/checkout', SITE).origin).toBe(true);
    expect(decide(origins, '/v1/public/checkout', SITE_WWW).origin).toBe(true);
    for (const foreign of [
      'https://evil.example',
      'http://veraxsistemas.com.br',
      'https://veraxsistemas.com.br.evil.example',
      'https://conta.veraxsistemas.com.br',
      'null',
    ]) {
      expect(decide(origins, '/v1/public/checkout', foreign).origin, foreign).toBe(false);
    }
    expect(decide(origins, '/v1/public/checkout').origin).toBe(false);
  });

  it('credentials só nas rotas de status, e só para origem aceita', () => {
    expect(decide([SITE], '/v1/public/checkout', SITE).credentials).toBe(false);
    expect(decide([SITE], '/v1/public/slugs/cliente-demo-a', SITE).credentials).toBe(false);
    expect(decide([SITE], '/v1/public/status', SITE).credentials).toBe(true);
    expect(decide([SITE], '/v1/public/status/reveal?x=1', SITE).credentials).toBe(true);
    expect(decide([SITE], '/v1/public/statusx', SITE).credentials).toBe(false);
    expect(decide([SITE], '/v1/public/status', 'https://evil.example').credentials).toBe(false);
  });

  it('expõe X-Request-Id e só os métodos e cabeçalhos usados', () => {
    expect(decide([SITE], '/v1/public/checkout', SITE)).toMatchObject({
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
      exposedHeaders: ['X-Request-Id'],
    });
  });

  it('sem origens configuradas, nenhuma é aceita', () => {
    expect(decide([], '/v1/public/checkout', SITE).origin).toBe(false);
  });

  it('o webhook da Stripe não tem CORS nenhum, nem para a origem do site (CP-04)', () => {
    expect(decide([SITE], '/v1/stripe/webhook', SITE)).toMatchObject({ origin: false, credentials: false });
    expect(decide([SITE], '/v1/stripe/webhook?x=1', SITE).origin).toBe(false);
    expect(WEBHOOK_PATH).toBe('/v1/stripe/webhook');
    expect(NO_CORS_PATHS.has(WEBHOOK_PATH)).toBe(true);
  });
});
