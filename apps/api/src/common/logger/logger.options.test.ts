import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { LogCapture } from '../../../test/support/log-capture.js';
import { buildPinoOptions } from './logger.options.js';
import { REDACTED } from './sanitize.js';

// Valores marcados: se qualquer um aparecer na saída, a redaction falhou.
const SECRETS = {
  authorization: 'Bearer leak-authorization-0001',
  cookie: 'verax.session=leak-cookie-0002',
  password: 'leak-password-0003',
  token: 'leak-token-0004',
  awsSecretAccessKey: 'leak-aws-secret-0005',
  awsSessionToken: 'leak-aws-session-0006',
  awsAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
};

function createLogger(): { log: pino.Logger; capture: LogCapture } {
  const capture = new LogCapture();
  return { log: pino(buildPinoOptions({ LOG_LEVEL: 'trace' }), capture), capture };
}

describe('logger com redaction (T1.1)', () => {
  it('remove authorization, cookie, password, token e segredos AWS de objetos logados', () => {
    const { log, capture } = createLogger();

    log.info(
      {
        headers: { authorization: SECRETS.authorization, cookie: SECRETS.cookie },
        body: { email: 'analista@cliente.example', password: SECRETS.password },
        session: { token: SECRETS.token },
        aws: {
          Credentials: {
            AccessKeyId: SECRETS.awsAccessKeyId,
            SecretAccessKey: SECRETS.awsSecretAccessKey,
            SessionToken: SECRETS.awsSessionToken,
          },
        },
      },
      'evento de teste',
    );

    for (const secret of Object.values(SECRETS)) {
      expect(capture.text).not.toContain(secret.replace('Bearer ', ''));
    }
    const [entry] = capture.entries();
    expect(entry).toMatchObject({
      msg: 'evento de teste',
      headers: { authorization: REDACTED, cookie: REDACTED },
      body: { email: 'analista@cliente.example', password: REDACTED },
      session: { token: REDACTED },
      aws: { Credentials: REDACTED },
    });
  });

  it('limpa segredos que aparecem no texto da mensagem', () => {
    const { log, capture } = createLogger();

    log.warn(`chamada falhou com ${SECRETS.authorization} usando ${SECRETS.awsAccessKeyId}`);

    expect(capture.text).not.toContain('leak-authorization-0001');
    expect(capture.text).not.toContain(SECRETS.awsAccessKeyId);
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

    log.child({ context: 'AwsInventory' }).info({ credentials: { secret: SECRETS.awsSecretAccessKey } });

    expect(capture.text).not.toContain(SECRETS.awsSecretAccessKey);
    expect(capture.text).toContain('AwsInventory');
  });
});
