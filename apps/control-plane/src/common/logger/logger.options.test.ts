import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { LogCapture } from '../../../test/support/log-capture.js';
import { buildPinoOptions } from './logger.options.js';
import { REDACTED } from './sanitize.js';

// Valores marcados: se qualquer um aparecer na saída, a redaction falhou.
const SECRETS = {
  authorization: 'Bearer leak-authorization-0001',
  cookie: '__session=leak-cookie-0002',
  password: 'leak-password-0003',
  token: 'leak-token-0004',
  stripeKey: ['sk', 'test', 'leakStripeKey0005'].join('_'),
  signature: 't=1,v1=leak-signature-0006',
  tunnelToken: 'leak-tunnel-0007',
};

function createLogger(): { log: pino.Logger; capture: LogCapture } {
  const capture = new LogCapture();
  return { log: pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture), capture };
}

describe('logger com redaction (CP-01)', () => {
  it('remove authorization, cookie, assinatura, password, token e chave da Stripe de objetos logados', () => {
    const { log, capture } = createLogger();

    log.info(
      {
        headers: {
          authorization: SECRETS.authorization,
          cookie: SECRETS.cookie,
          'stripe-signature': SECRETS.signature,
        },
        body: { email: 'admin@cliente-demo-a.example', password: SECRETS.password },
        session: { token: SECRETS.token },
        stripe: { secretKey: SECRETS.stripeKey },
        tunnel: { token: SECRETS.tunnelToken },
      },
      'evento de teste',
    );

    for (const secret of Object.values(SECRETS)) {
      expect(capture.text).not.toContain(secret.replace('Bearer ', ''));
    }
    const [entry] = capture.entries();
    expect(entry).toMatchObject({
      message: 'evento de teste',
      severity: 'INFO',
      headers: { authorization: REDACTED, cookie: REDACTED, 'stripe-signature': REDACTED },
      body: { email: 'admin@cliente-demo-a.example', password: REDACTED },
      session: { token: REDACTED },
      stripe: { secretKey: REDACTED },
      tunnel: { token: REDACTED },
    });
    expect(entry?.['time']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('usa a severidade do Cloud Logging por nível', () => {
    const { log, capture } = createLogger();

    log.debug('d');
    log.warn('w');
    log.error('e');
    log.fatal('f');

    expect(capture.entries().map((entry) => entry['severity'])).toEqual([
      'DEBUG',
      'WARNING',
      'ERROR',
      'CRITICAL',
    ]);
  });

  it('limpa segredos que aparecem no texto da mensagem', () => {
    const { log, capture } = createLogger();

    log.warn(`chamada falhou com ${SECRETS.authorization} usando ${SECRETS.stripeKey}`);

    expect(capture.text).not.toContain('leak-authorization-0001');
    expect(capture.text).not.toContain(SECRETS.stripeKey);
  });

  it('limpa erros logados, inclusive propriedades anexadas e a causa', () => {
    const { log, capture } = createLogger();
    const error = Object.assign(new Error('falha', { cause: new Error(`token ${SECRETS.authorization}`) }), {
      config: { headers: { Authorization: SECRETS.authorization } },
      password: SECRETS.password,
    });

    log.error({ err: error }, 'erro inesperado');
    log.error(error);

    expect(capture.lines).toHaveLength(2);
    expect(capture.text).not.toContain('leak-authorization-0001');
    expect(capture.text).not.toContain(SECRETS.password);
    expect(capture.text).toContain('falha');
  });

  it('limpa segredos de child loggers', () => {
    const { log, capture } = createLogger();

    log.child({ context: 'StripeWebhook' }).info({ credentials: { secret: SECRETS.stripeKey } });

    expect(capture.text).not.toContain(SECRETS.stripeKey);
    expect(capture.text).toContain('StripeWebhook');
  });
});
