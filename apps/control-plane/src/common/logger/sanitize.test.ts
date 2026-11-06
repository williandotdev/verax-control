import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  forgetLiveSecret,
  MIN_LIVE_SECRET_LENGTH,
  REDACTED,
  isSensitiveKey,
  registerLiveSecret,
  sanitize,
  scrubString,
} from './sanitize.js';

/** Chaves e tokens falsos montados em partes, para o gitleaks não os ver como reais. */
const STRIPE_TEST_KEY = ['sk', 'test', 'chaveFalsa1234567890'].join('_');
const STRIPE_RESTRICTED_KEY = ['rk', 'live', 'chaveFalsa0987654321'].join('_');
const WEBHOOK_SECRET = ['whsec', 'segredoFalso1234567890'].join('_');
const GOOGLE_ACCESS_TOKEN = ['ya29', 'a0AfH6SMBtokenFalso-1234_abcd'].join('.');
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJhdWQiOiJ4In0', 'assinaturaFalsa_1234'].join('.');

describe('isSensitiveKey', () => {
  it.each([
    'authorization',
    'Authorization',
    'cookie',
    'set-cookie',
    'password',
    'newPassword',
    'temporaryPassword',
    'token',
    'accessToken',
    'idToken',
    'tunnelToken',
    'secret',
    'clientSecret',
    'webhookSecret',
    'STRIPE_SECRET_KEY',
    'CLOUDFLARE_API_TOKEN',
    'COOKIE_KEY',
    'stripe-signature',
    'Stripe-Signature',
    'x-api-key',
    'apiKey',
    'privateKey',
    'AccessKeyId',
    'credentials',
    'backupCodes',
    'otp',
    'totp',
    'externalId',
  ])('oculta %s', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['tenantId', 'slug', 'email', 'method', 'url', 'statusCode', 'eventId', 'runId', 'state', 'step'])(
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

  it('oculta chaves da Stripe (secreta e restrita) e o segredo do webhook', () => {
    const text = scrubString(`chaves ${STRIPE_TEST_KEY}, ${STRIPE_RESTRICTED_KEY} e ${WEBHOOK_SECRET}`);
    expect(text).toBe(`chaves ${REDACTED}, ${REDACTED} e ${REDACTED}`);
  });

  it('oculta token de acesso do Google e JWT (token de identidade)', () => {
    expect(scrubString(`access ${GOOGLE_ACCESS_TOKEN} id ${JWT}`)).toBe(`access ${REDACTED} id ${REDACTED}`);
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

  it('não altera texto comum, ids da Stripe nem slugs', () => {
    expect(scrubString('evento evt_1Abc do cliente cliente-demo-a (cus_Abc, sub_Def)')).toBe(
      'evento evt_1Abc do cliente cliente-demo-a (cus_Abc, sub_Def)',
    );
  });
});

describe('sanitize', () => {
  it('oculta chaves sensíveis em qualquer profundidade, inclusive dentro de arrays', () => {
    const result = sanitize({
      tenant: { slug: 'cliente-demo-a', password: 'p4ss' },
      headers: [{ 'stripe-signature': 't=1,v1=abc' }],
      deep: { a: { b: { c: { d: { token: 't' } } } } },
    });

    expect(result).toEqual({
      tenant: { slug: 'cliente-demo-a', password: REDACTED },
      headers: [{ 'stripe-signature': REDACTED }],
      deep: { a: { b: { c: { d: { token: REDACTED } } } } },
    });
  });

  it('mantém valores booleanos de chaves sensíveis (sim ou não não é segredo) e oculta o resto', () => {
    expect(
      sanitize({
        passwordRevealed: true,
        tokenUsed: false,
        password: 'p4ss',
        token: 1,
        secret: null,
      }),
    ).toEqual({
      passwordRevealed: true,
      tokenUsed: false,
      password: REDACTED,
      token: REDACTED,
      secret: REDACTED,
    });
  });

  it('não altera o objeto original e preserva Date', () => {
    const at = new Date('2026-11-04T12:00:00.000Z');
    const original = { password: 'p4ss', at };
    expect(sanitize(original)).toEqual({ password: REDACTED, at });
    expect(original.password).toBe('p4ss');
  });

  it('limpa a mensagem, a stack, as propriedades e a causa de erros', () => {
    const cause = new Error(`conexão com ${STRIPE_TEST_KEY} recusada`);
    const error = Object.assign(new Error('Bearer abc.def falhou', { cause }), { password: 'p4ss' });

    const json = JSON.stringify(sanitize({ error }));

    expect(json).not.toContain('abc.def');
    expect(json).not.toContain(STRIPE_TEST_KEY);
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

describe('segredos vivos (registerLiveSecret)', () => {
  /** Gerado no teste: um valor sem formato conhecido, como a senha temporária do primeiro admin. */
  const live = (): string => randomBytes(18).toString('base64url');

  it('oculta o valor registrado em qualquer texto e em qualquer campo, até ser esquecido', () => {
    const value = live();
    registerLiveSecret(value);
    try {
      expect(scrubString(`falha ao entregar ${value} ao site`)).toBe(`falha ao entregar ${REDACTED} ao site`);
      expect(JSON.stringify(sanitize({ detail: { note: `x${value}y` } }))).not.toContain(value);
    } finally {
      forgetLiveSecret(value);
    }
    expect(scrubString(`depois: ${value}`)).toBe(`depois: ${value}`);
  });

  it('ignora valores curtos, para não ocultar pedaços de texto comum', () => {
    const short = live().slice(0, MIN_LIVE_SECRET_LENGTH - 1);
    registerLiveSecret(short);
    expect(scrubString(`texto ${short}`)).toBe(`texto ${short}`);
    forgetLiveSecret(short);
  });
});
