import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cloudAccountSchema } from './cloud-accounts.js';
import {
  CLOUDFLARE_TOKEN_FORMAT_MESSAGE,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  cloudCredentialInputSchema,
  cloudCredentialStatusSchema,
  cloudflareTokenTemplateUrl,
  credentialStatus,
  daysUntilExpiry,
  GLOBAL_API_KEY_MESSAGE,
  isCloudflareApiTokenShape,
  isCloudflareGlobalApiKey,
} from './cloud-credentials.js';
import { hasPermission, ROLES } from './permissions.js';

// Valores gerados na hora, no formato do Cloudflare: nenhum token real no repositório.
const legacyToken = () => randomBytes(30).toString('base64url');
const accountToken = () => `cfat_${randomBytes(30).toString('base64url')}${randomBytes(4).toString('hex')}`;
const userToken = () => `cfut_${randomBytes(30).toString('base64url')}${randomBytes(4).toString('hex')}`;
const legacyGlobalKey = (length = 37) => randomBytes(32).toString('hex').slice(0, length);

const issuesOf = (input: unknown) => {
  const result = cloudCredentialInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('credencial colada no painel (fase 2, PR-11)', () => {
  it('aceita o token de conta, o de usuário e o formato antigo (40 caracteres)', () => {
    for (const token of [legacyToken(), accountToken(), userToken()]) {
      expect(cloudCredentialInputSchema.parse({ kind: 'cloudflare_api_token', token })).toEqual({
        kind: 'cloudflare_api_token',
        token,
      });
    }
  });

  it.each([37, 40, 45])('recusa a Global API Key antiga (%i hexadecimais) com mensagem própria', (length) => {
    const key = legacyGlobalKey(length);
    expect(isCloudflareGlobalApiKey(key)).toBe(true);
    expect(issuesOf({ kind: 'cloudflare_api_token', token: key })).toEqual([GLOBAL_API_KEY_MESSAGE]);
  });

  it('recusa a Global API Key no formato novo (cfk_)', () => {
    const key = `cfk_${randomBytes(30).toString('base64url')}`;
    expect(issuesOf({ kind: 'cloudflare_api_token', token: key })).toEqual([GLOBAL_API_KEY_MESSAGE]);
  });

  it('hexadecimal fora do tamanho da Global API Key, ou com maiúsculas, não é tratado como ela', () => {
    expect(isCloudflareGlobalApiKey(legacyGlobalKey(36))).toBe(false);
    expect(isCloudflareGlobalApiKey(randomBytes(23).toString('hex'))).toBe(false);
    expect(isCloudflareGlobalApiKey(legacyGlobalKey(37).toUpperCase())).toBe(false);
  });

  it.each([
    ['curto demais', () => randomBytes(15).toString('base64url')],
    ['com espaço', () => `${legacyToken().slice(0, 20)} ${legacyToken().slice(0, 20)}`],
    ['com quebra de linha', () => `${legacyToken()}\n`],
    ['com aspas', () => `"${legacyToken()}"`],
    ['longo demais', () => 'a'.repeat(256)],
    ['com acento', () => `${legacyToken()}ç`],
  ])('recusa o token %s, sem repetir o valor na mensagem', (_name, make) => {
    const token = make();
    expect(isCloudflareApiTokenShape(token)).toBe(false);
    const messages = issuesOf({ kind: 'cloudflare_api_token', token });
    expect(messages).toEqual([CLOUDFLARE_TOKEN_FORMAT_MESSAGE]);
    expect(messages.join(' ')).not.toContain(token);
  });

  it('o corpo é estrito: tipo fora da lista (a chave da AWS ainda não), campo a mais ou faltando', () => {
    const token = legacyToken();
    expect(issuesOf({ kind: 'aws_access_key', token })).not.toEqual([]);
    expect(issuesOf({ kind: 'cloudflare_api_token', token, accountId: 'outra' })).not.toEqual([]);
    expect(issuesOf({ kind: 'cloudflare_api_token' })).not.toEqual([]);
    expect(issuesOf({ token })).not.toEqual([]);
  });

  it('situação pela validade: em dia, vencendo nos próximos 14 dias ou vencida', () => {
    const now = new Date('2026-11-04T12:00:00.000Z');
    const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);
    expect(credentialStatus(null, now)).toBe('active');
    expect(credentialStatus(inDays(15), now)).toBe('active');
    expect(credentialStatus(inDays(14), now)).toBe('expiring');
    expect(credentialStatus(inDays(0.5).toISOString(), now)).toBe('expiring');
    expect(credentialStatus(now, now)).toBe('expired');
    expect(daysUntilExpiry(inDays(0.5), now)).toBe(1);
    expect(daysUntilExpiry(inDays(14), now)).toBe(14);
    expect(daysUntilExpiry(inDays(-3), now)).toBe(0);
    expect(daysUntilExpiry(null, now)).toBeNull();
  });

  it('os metadados nunca levam o segredo nem o texto cifrado (objeto estrito)', () => {
    const status = {
      kind: 'cloudflare_api_token',
      keyIdSuffix: 'a1fa',
      issuedAt: null,
      expiresAt: '2026-12-01T00:00:00.000Z',
      verifiedAt: '2026-11-04T12:00:00.000Z',
      status: 'active',
    };
    expect(cloudCredentialStatusSchema.safeParse(status).success).toBe(true);
    for (const extra of [{ token: legacyToken() }, { ciphertext: 'v1:AAAA' }, { keyVersion: 1 }]) {
      expect(cloudCredentialStatusSchema.safeParse({ ...status, ...extra }).success).toBe(false);
    }
    expect(cloudCredentialStatusSchema.safeParse({ ...status, keyIdSuffix: 'a1f' }).success).toBe(false);
    expect(
      cloudAccountSchema.safeParse({
        id: '018f2c1e-0000-7000-8000-0000000c0005',
        provider: 'cloudflare',
        accountId: 'd0e0000000000000000000000000a1fa',
        regions: [],
        roleArn: null,
        externalId: null,
        buckets: { cloudtrail: null, guardduty: null, waf: null },
        pubsubSubscription: null,
        sinkTopic: null,
        sinkWriterIdentity: null,
        zones: ['loja-alfa.example'],
        keyStatus: status,
        egressIps: ['203.0.113.10/32'],
        status: 'active',
        connection: 'waiting',
        connectionError: null,
        lastCollectedAt: null,
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('o link de criação do token pede só permissões de leitura, num token de conta', () => {
    expect(CLOUDFLARE_TOKEN_PERMISSIONS.every((permission) => permission.type === 'read')).toBe(true);
    const url = new URL(cloudflareTokenTemplateUrl());
    expect(url.origin).toBe('https://dash.cloudflare.com');
    expect(url.searchParams.get('to')).toBe('/:account/api-tokens');
    expect(JSON.parse(url.searchParams.get('permissionGroupKeys') ?? '[]')).toEqual([
      { key: 'account_settings', type: 'read' },
      { key: 'zone', type: 'read' },
      { key: 'analytics', type: 'read' },
    ]);
    expect(url.searchParams.get('name')).toMatch(/^Verax Control/);
  });

  it('só os administradores colam, trocam e removem a credencial', () => {
    expect(ROLES.filter((role) => hasPermission(role, 'cloud_credentials:write'))).toEqual([
      'admin_verax',
      'admin_cliente',
    ]);
  });
});
