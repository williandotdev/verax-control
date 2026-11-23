import { describe, expect, it } from 'vitest';
import { cloudAccountSchema, CLOUDFLARE_BLOCKING_ERRORS } from './cloud-accounts.js';
import { CLOUD_CREDENTIAL_KINDS } from './cloud-credentials.js';
import {
  CLOUDFLARE_OAUTH_ATTEMPT_ERRORS,
  CLOUDFLARE_OAUTH_ATTEMPT_STATUSES,
  CLOUDFLARE_OAUTH_CALLBACK_ERRORS,
  CLOUDFLARE_OAUTH_CALLBACK_PATH,
  CLOUDFLARE_OAUTH_CODE_MAX_LENGTH,
  CLOUDFLARE_OAUTH_ISSUER,
  CLOUDFLARE_OAUTH_OPEN_STATUSES,
  CLOUDFLARE_OAUTH_RECONNECT_ERROR,
  CLOUDFLARE_OAUTH_STATE_MAX_LENGTH,
  cloudflareConnectionSchema,
  cloudflareConnectMode,
  cloudflareOauthAttemptSchema,
  cloudflareOauthCallbackError,
  cloudflareOauthChooseSchema,
  cloudflareOauthCompleteSchema,
  cloudflareOauthConfigSchema,
  cloudflareOauthScopesSchema,
  cloudflareOauthStartedSchema,
  cloudflareOauthStartSchema,
  cloudflareZoneSchema,
  compareCloudflareScopes,
  isCloudflareAuthorizeUrl,
  isCloudflareOauthRedirectUri,
  isCloudflareReadOnlyScope,
  parseCloudflareOauthState,
} from './cloudflare-oauth.js';

const REDIRECT = `https://conta.exemplo.com.br${CLOUDFLARE_OAUTH_CALLBACK_PATH}`;
const CONFIG = {
  clientId: 'clientedeteste0001',
  redirectUri: REDIRECT,
  scopes: ['account-settings.read', 'zone.read', 'offline_access'],
};
const NONCE = 'n'.repeat(43);
const STATE = `demo-a.${NONCE}`;
const CODE = 'codigo-de-teste.123';
const ID = '01900000-0000-7000-8000-000000000001';
const AT = '2026-11-23T12:00:00.000Z';

describe('Cloudflare por OAuth: quando vale', () => {
  it('só no nó gerenciado com a configuração; desligado ou na VM do cliente, o token colado', () => {
    expect(cloudflareConnectMode({ platform: 'gcp', oauth: CONFIG })).toBe('oauth');
    expect(cloudflareConnectMode({ platform: 'gcp', oauth: null })).toBe('token');
    expect(cloudflareConnectMode({ platform: 'vm', oauth: CONFIG })).toBe('token');
    expect(cloudflareConnectMode({ platform: 'vm', oauth: null })).toBe('token');
  });

  it('nada que um lado anterior recuse: nem tipo de credencial, nem campo na conta, nem erro que para a coleta', () => {
    // O tipo iria no relato estrito do nó e no enum do banco; o campo, no contrato estrito que o painel anterior lê.
    expect(CLOUD_CREDENTIAL_KINDS).toEqual([
      'cloudflare_api_token',
      'aws_access_key',
      'gcp_service_account_key',
    ]);
    expect(Object.keys(cloudAccountSchema.shape).filter((key) => /grant|oauth/i.test(key))).toEqual([]);
    // Entra na lista com o coletor que o grava e a explicação no painel. O formato já cabe no contrato de hoje.
    expect(CLOUDFLARE_BLOCKING_ERRORS as readonly string[]).not.toContain(CLOUDFLARE_OAUTH_RECONNECT_ERROR);
    expect(cloudAccountSchema.shape.connectionError.safeParse(CLOUDFLARE_OAUTH_RECONNECT_ERROR).success).toBe(
      true,
    );
  });
});

describe('Cloudflare por OAuth: escopos só de leitura', () => {
  it.each(['account-settings.read', 'zone.read', 'audit-logs.read', 'offline_access', 'offline'])(
    'aceita %s',
    (scope) => {
      expect(isCloudflareReadOnlyScope(scope)).toBe(true);
    },
  );

  it.each([
    'zone.write',
    'zone.edit',
    'zone.admin',
    'zone.run',
    'zone.purge',
    'zone',
    'read',
    '.read',
    'zone.read.write',
    'zone.write.read',
    'zone.read ',
    ' zone.read',
    'zone.read dns.write',
    'zone.read\ndns.write',
    'Zone.Read',
    'zone:read',
    '*',
    '*.read',
    'openid',
    'profile',
    '',
    `${'z'.repeat(64)}.read`,
  ])('recusa %j', (scope) => {
    expect(isCloudflareReadOnlyScope(scope)).toBe(false);
  });

  it('a lista pede leitura e renovação, sem repetir', () => {
    expect(cloudflareOauthScopesSchema.safeParse(CONFIG.scopes).success).toBe(true);
    for (const scopes of [
      [],
      ['zone.read'],
      ['offline_access'],
      ['offline_access', 'offline'],
      ['zone.read', 'zone.read', 'offline_access'],
      ['zone.read', 'offline_access', 'dns.write'],
      [...Array.from({ length: 16 }, (_, index) => `recurso${index}.read`), 'offline_access'],
    ]) {
      expect(cloudflareOauthScopesSchema.safeParse(scopes).success).toBe(false);
    }
  });

  it('compara o concedido com o pedido: falta e sobra; a renovação não conta', () => {
    const requested = ['account-settings.read', 'zone.read', 'offline_access'];
    expect(compareCloudflareScopes(requested, 'zone.read account-settings.read')).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(compareCloudflareScopes(requested, 'zone.read  offline_access')).toEqual({
      missing: ['account-settings.read'],
      unexpected: [],
    });
    expect(compareCloudflareScopes(requested, 'zone.read account-settings.read dns.write')).toEqual({
      missing: [],
      unexpected: ['dns.write'],
    });
    expect(compareCloudflareScopes(requested, '')).toEqual({
      missing: ['account-settings.read', 'zone.read'],
      unexpected: [],
    });
  });
});

describe('Cloudflare por OAuth: configuração', () => {
  it('aceita a do app e recusa campo a mais (um segredo nunca entra)', () => {
    expect(cloudflareOauthConfigSchema.safeParse(CONFIG).success).toBe(true);
    expect(cloudflareOauthConfigSchema.safeParse({ ...CONFIG, clientSecret: 'x' }).success).toBe(false);
    expect(cloudflareOauthConfigSchema.safeParse({ ...CONFIG, clientId: 'com espaço' }).success).toBe(false);
    expect(cloudflareOauthConfigSchema.safeParse({ ...CONFIG, scopes: ['zone.write'] }).success).toBe(false);
  });

  it.each([
    `http://conta.exemplo.com.br${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `https://conta.exemplo.com.br:8443${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `https://conta.exemplo.com.br:443${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `https://usuario@conta.exemplo.com.br${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `${REDIRECT}?destino=https://outro.exemplo`,
    `${REDIRECT}#x`,
    `${REDIRECT}/`,
    `https://conta.exemplo.com.br/outro/..${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `https://CONTA.exemplo.com.br${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `https://conta.exemplo.com.br\\@outro.exemplo${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `https://localhost${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    `javascript:alert(1)//${CLOUDFLARE_OAUTH_CALLBACK_PATH}`,
    'nada',
    '',
  ])('recusa o retorno %j', (value) => {
    expect(isCloudflareOauthRedirectUri(value)).toBe(false);
  });
});

describe('Cloudflare por OAuth: state e retorno', () => {
  it('separa o subdomínio da parte aleatória', () => {
    expect(parseCloudflareOauthState(STATE)).toEqual({ slug: 'demo-a', nonce: NONCE });
    // O maior subdomínio cabe.
    const longest = `${'a'.repeat(16)}.${NONCE}`;
    expect(longest).toHaveLength(CLOUDFLARE_OAUTH_STATE_MAX_LENGTH);
    expect(parseCloudflareOauthState(longest)).not.toBeNull();
  });

  it.each([
    NONCE,
    `.${NONCE}`,
    `demo-a.${'n'.repeat(42)}`,
    `demo-a.${'n'.repeat(44)}`,
    `demo-a.${'n'.repeat(42)}=`,
    `demo-a.x.${NONCE}`,
    `outro.exemplo.com/${NONCE}`,
    `xn--demo.${NONCE}`,
    `Demo.${NONCE}`,
    `demo/..%2f.${NONCE}`,
    `demo-a.${NONCE}\n`,
    '',
  ])('recusa o state %j', (state) => {
    expect(parseCloudflareOauthState(state)).toBeNull();
  });

  it('complete: o código com o emissor, ou o erro da lista; nunca os dois nem campo a mais', () => {
    const ok = { state: STATE, code: CODE, iss: CLOUDFLARE_OAUTH_ISSUER };
    expect(cloudflareOauthCompleteSchema.safeParse(ok).success).toBe(true);
    expect(cloudflareOauthCompleteSchema.safeParse({ state: STATE, error: 'access_denied' }).success).toBe(
      true,
    );
    for (const body of [
      { state: STATE, code: CODE },
      { state: STATE, iss: CLOUDFLARE_OAUTH_ISSUER },
      { state: STATE },
      { ...ok, error: 'access_denied' },
      { ...ok, tenantId: ID },
      { ...ok, code: 'com espaço e mais' },
      { ...ok, code: 'a'.repeat(CLOUDFLARE_OAUTH_CODE_MAX_LENGTH + 1) },
      { ...ok, code: 'curto' },
      { ...ok, iss: '' },
      { state: STATE, error: 'texto livre do Cloudflare' },
      { state: STATE, error: 'access_denied', error_description: 'x' },
    ]) {
      expect(cloudflareOauthCompleteSchema.safeParse(body).success).toBe(false);
    }
  });

  it('o erro desconhecido vira other', () => {
    for (const known of CLOUDFLARE_OAUTH_CALLBACK_ERRORS)
      expect(cloudflareOauthCallbackError(known)).toBe(known);
    expect(cloudflareOauthCallbackError('<script>')).toBe('other');
    expect(cloudflareOauthCallbackError('toString')).toBe('other');
  });

  it('start: só o id da conta; o painel só navega para a autorização do Cloudflare', () => {
    expect(cloudflareOauthStartSchema.safeParse({}).success).toBe(true);
    expect(cloudflareOauthStartSchema.safeParse({ cloudAccountId: ID }).success).toBe(true);
    expect(cloudflareOauthStartSchema.safeParse({ tenantId: ID }).success).toBe(false);
    expect(isCloudflareAuthorizeUrl('https://dash.cloudflare.com/oauth2/auth?client_id=x')).toBe(true);
    for (const url of [
      'https://dash.cloudflare.com/oauth2/auth',
      'https://dash.cloudflare.com/oauth2/authx?client_id=x',
      'https://dash.cloudflare.com.exemplo.com/oauth2/auth?client_id=x',
      'javascript:alert(1)',
    ]) {
      expect(isCloudflareAuthorizeUrl(url)).toBe(false);
      expect(
        cloudflareOauthStartedSchema.safeParse({ attemptId: ID, authorizeUrl: url, expiresAt: AT }).success,
      ).toBe(false);
    }
  });
});

describe('Cloudflare por OAuth: tentativa, conexão e zonas', () => {
  const attempt = {
    id: ID,
    status: 'choosing',
    errorCode: null,
    accounts: [{ accountId: 'a'.repeat(32), name: 'Conta Demo A', state: 'available' }],
    accountIdRequired: false,
    cloudAccountIds: [],
    expiresAt: AT,
  };

  it('a tentativa: o código só na falha, e nenhum segredo', () => {
    expect(cloudflareOauthAttemptSchema.safeParse(attempt).success).toBe(true);
    expect(
      cloudflareOauthAttemptSchema.safeParse({ ...attempt, status: 'failed', errorCode: 'oauth_denied' })
        .success,
    ).toBe(true);
    expect(cloudflareOauthAttemptSchema.safeParse({ ...attempt, status: 'failed' }).success).toBe(false);
    expect(cloudflareOauthAttemptSchema.safeParse({ ...attempt, errorCode: 'oauth_denied' }).success).toBe(
      false,
    );
    for (const secret of ['state', 'code', 'verifier', 'accessToken', 'refreshToken', 'stateHash']) {
      expect(cloudflareOauthAttemptSchema.safeParse({ ...attempt, [secret]: 'x' }).success).toBe(false);
    }
  });

  it('as abertas são as que ainda vencem; os códigos não repetem', () => {
    expect(
      CLOUDFLARE_OAUTH_ATTEMPT_STATUSES.filter(
        (status) => !(CLOUDFLARE_OAUTH_OPEN_STATUSES as readonly string[]).includes(status),
      ),
    ).toEqual(['done', 'failed', 'expired']);
    expect(new Set(CLOUDFLARE_OAUTH_ATTEMPT_ERRORS).size).toBe(CLOUDFLARE_OAUTH_ATTEMPT_ERRORS.length);
  });

  it('a escolha: ao menos uma conta, sem repetir, só IDs do Cloudflare', () => {
    expect(cloudflareOauthChooseSchema.safeParse({ accountIds: ['a'.repeat(32)] }).success).toBe(true);
    for (const accountIds of [[], ['a'.repeat(32), 'a'.repeat(32)], ['111111111111']]) {
      expect(cloudflareOauthChooseSchema.safeParse({ accountIds }).success).toBe(false);
    }
  });

  it('a conexão: a autorização só no modo OAuth', () => {
    const grant = {
      status: 'active',
      consentedAt: AT,
      lastRefreshAt: null,
      scopes: ['zone.read'],
      accounts: 1,
    };
    expect(cloudflareConnectionSchema.safeParse({ method: 'oauth', grant }).success).toBe(true);
    expect(cloudflareConnectionSchema.safeParse({ method: 'token', grant: null }).success).toBe(true);
    expect(cloudflareConnectionSchema.safeParse({ method: null, grant: null }).success).toBe(true);
    expect(cloudflareConnectionSchema.safeParse({ method: 'token', grant }).success).toBe(false);
    expect(cloudflareConnectionSchema.safeParse({ method: 'oauth', grant: null }).success).toBe(false);
  });

  it('a zona que sumiu tem a data', () => {
    const zone = {
      zoneId: 'b'.repeat(32),
      name: 'exemplo.com.br',
      plan: null,
      state: 'reading',
      lastReadAt: AT,
      lastErrorCode: null,
      firstSeenAt: AT,
      missingSince: null,
    };
    expect(cloudflareZoneSchema.safeParse(zone).success).toBe(true);
    expect(cloudflareZoneSchema.safeParse({ ...zone, state: 'missing', missingSince: AT }).success).toBe(
      true,
    );
    expect(cloudflareZoneSchema.safeParse({ ...zone, state: 'missing' }).success).toBe(false);
    expect(cloudflareZoneSchema.safeParse({ ...zone, missingSince: AT }).success).toBe(false);
  });
});
