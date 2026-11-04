import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MIN_LIVE_SECRET_LENGTH,
  REDACTED,
  isSensitiveKey,
  forgetLiveSecret,
  registerLiveSecret,
  sanitize,
  scrubString,
} from './sanitize.js';

describe('isSensitiveKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'password',
    'newPassword',
    'current_password',
    'token',
    'accessToken',
    'refresh_token',
    'sessionToken',
    'SessionToken',
    'secret',
    'clientSecret',
    'SecretAccessKey',
    'aws_secret_access_key',
    'AWS_SESSION_TOKEN',
    'AccessKeyId',
    'x-api-key',
    'apiKey',
    'privateKey',
    'DATABASE_URL',
    'connectionString',
    'credentials',
    'backupCodes',
    'recoveryCodes',
    'otp',
    'totp',
    'externalId',
    'ciphertext',
  ])('oculta %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['userId', 'tenantId', 'email', 'method', 'url', 'statusCode', 'ruleId', 'accountId'])(
    'mantém %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('scrubString', () => {
  it('oculta token Bearer em texto livre', () => {
    expect(scrubString('falhou com Authorization: Bearer eyJhbGciOi.abc-def_123')).toBe(
      `falhou com Authorization: Bearer ${REDACTED}`,
    );
  });

  it('oculta ID de chave de acesso AWS de longo prazo e temporária', () => {
    const text = scrubString('chaves AKIAIOSFODNN7EXAMPLE e ASIAIOSFODNN7EXAMPLE');
    expect(text).not.toMatch(/AKIA|ASIA/);
    expect(text).toBe(`chaves ${REDACTED} e ${REDACTED}`);
  });

  it('oculta a senha embutida em URL e preserva o resto', () => {
    expect(scrubString('postgresql://verax:s3nh4-forte@db.internal:5432/verax')).toBe(
      `postgresql://verax:${REDACTED}@db.internal:5432/verax`,
    );
  });

  it('não altera texto comum', () => {
    expect(scrubString('usuário entrou no cliente piloto')).toBe('usuário entrou no cliente piloto');
  });

  it('oculta o segredo de uma linha do arquivo credentials da AWS copiada para o texto', () => {
    const secret = randomBytes(30).toString('base64');
    const text = scrubString(
      `[verax-111111111111]\naws_secret_access_key = ${secret}\nAWS_SESSION_TOKEN=${secret}x`,
    );
    expect(text).not.toContain(secret);
    expect(text).toBe(
      `[verax-111111111111]\naws_secret_access_key = ${REDACTED}\nAWS_SESSION_TOKEN=${REDACTED}`,
    );
  });

  it('oculta o segredo vivo (decifrado do cofre) em qualquer lugar do texto, inclusive repetido', () => {
    const secret = randomBytes(30).toString('base64url');
    expect(scrubString(`antes ${secret}`)).toContain(secret);
    registerLiveSecret(secret);
    expect(scrubString(`recusado: ${secret}; de novo:${secret}.`)).toBe(
      `recusado: ${REDACTED}; de novo:${REDACTED}.`,
    );
    // Também dentro de objetos e erros, que passam pela mesma limpeza.
    expect(
      JSON.stringify(sanitize({ detail: { reason: `token ${secret}` }, err: new Error(secret) })),
    ).not.toContain(secret);
  });

  it('o valor esquecido (fim da requisição que colou a credencial, na API) deixa de ser guardado', () => {
    const secret = randomBytes(30).toString('base64url');
    registerLiveSecret(secret);
    expect(scrubString(secret)).toBe(REDACTED);
    forgetLiveSecret(secret);
    expect(scrubString(`texto ${secret}`)).toBe(`texto ${secret}`);
  });

  it('valor curto não vira segredo vivo (não oculta pedaços de texto comum)', () => {
    const short = 'x'.repeat(MIN_LIVE_SECRET_LENGTH - 1);
    registerLiveSecret(short);
    expect(scrubString(`texto ${short}`)).toBe(`texto ${short}`);
  });
});

describe('sanitize', () => {
  it('oculta chaves sensíveis em qualquer profundidade, inclusive dentro de arrays', () => {
    const result = sanitize({
      user: { email: 'a@b.c', password: 'p4ss' },
      aws: [{ Credentials: { SecretAccessKey: 'x', SessionToken: 'y' } }],
      deep: { a: { b: { c: { d: { token: 't' } } } } },
    });

    expect(result).toEqual({
      user: { email: 'a@b.c', password: REDACTED },
      aws: [{ Credentials: REDACTED }],
      deep: { a: { b: { c: { d: { token: REDACTED } } } } },
    });
  });

  it('mantém valores booleanos de chaves sensíveis (sim ou não não é segredo) e oculta o resto', () => {
    expect(
      sanitize({
        mustChangePassword: true,
        passwordEnabled: false,
        password: 'p4ss',
        token: 1,
        secret: null,
      }),
    ).toEqual({
      mustChangePassword: true,
      passwordEnabled: false,
      password: REDACTED,
      token: REDACTED,
      secret: REDACTED,
    });
  });

  it('não altera o objeto original', () => {
    const original = { password: 'p4ss' };
    sanitize(original);
    expect(original.password).toBe('p4ss');
  });

  it('limpa a mensagem, a stack, as propriedades e a causa de erros', () => {
    const cause = new Error('conexão postgresql://u:segredo@h/db recusada');
    const error = Object.assign(new Error('Bearer abc.def falhou', { cause }), { password: 'p4ss' });

    const json = JSON.stringify(sanitize({ error }));

    expect(json).not.toContain('abc.def');
    expect(json).not.toContain('segredo');
    expect(json).not.toContain('p4ss');
    expect(json).toContain('"type":"Error"');
  });

  it('usa toJSON quando existe (ex.: URL com credencial)', () => {
    const result = sanitize({ endpoint: new URL('https://usuario:segredo@exemplo.com/caminho') });
    expect(JSON.stringify(result)).not.toContain('segredo');
  });

  it('suporta referência circular e limita a profundidade', () => {
    const circular: Record<string, unknown> = { name: 'a' };
    circular['self'] = circular;
    expect(sanitize(circular)).toEqual({ name: 'a', self: '[Circular]' });

    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) nested = { nested };
    expect(JSON.stringify(sanitize(nested))).toContain('[Truncated]');
  });

  it('não despeja conteúdo binário', () => {
    expect(sanitize({ body: Buffer.from('segredo') })).toEqual({ body: '[Binary]' });
  });
});
