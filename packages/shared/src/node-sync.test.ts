import { describe, expect, it } from 'vitest';
import { cloudAccountCreateSchema } from './cloud-accounts.js';
import {
  NODE_SYNC_CAPABILITIES,
  NODE_SYNC_ENVELOPE_PATTERN,
  NODE_SYNC_MAX_SOURCES,
  NODE_SYNC_MAX_USERS,
  NODE_SYNC_PATH,
  NODE_SYNC_PROTOCOL,
  NODE_SYNC_SOURCE_CODES,
  NODE_SYNC_USER_CODES,
  nodeSyncRequestSchema,
  nodeSyncResponseSchema,
  respondsTo,
} from './node-sync.js';

// Dados fictícios: ids gerados para o teste, contas de exemplo, IPs da faixa de documentação (RFC 5737).
const NODE_TENANT = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const SOURCE_A = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
const SOURCE_B = '0190a1b2-c3d4-7e5f-8a9b-000000000002';
const REQUEST_A = '01JD0000000000000000000001';
const REQUEST_B = '01JD0000000000000000000002';
const ENVELOPE = `v1:${'A'.repeat(512)}`;

function request(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    sequence: 42,
    sentAt: '2026-11-22T12:00:00.000Z',
    capabilities: ['log_sources', 'users'],
    node: {
      commit: 'a'.repeat(40),
      platform: 'gcp',
      mode: 'dedicated',
      tenantId: NODE_TENANT,
      vaultKey: { version: 1, publicKey: 'TFMwdExTMUNSVWRKVGlCUVZVSk1TVU09', fingerprint: 'f'.repeat(64) },
      serviceAccountId: '100000000000000000001',
      egressIps: ['203.0.113.10/32'],
      audience: 'https://conta.example.com/aws-reader',
      error: null,
    },
    sources: [
      {
        id: SOURCE_A,
        revision: 3,
        outcome: 'applied',
        code: null,
        credential: {
          revision: 2,
          outcome: 'applied',
          code: null,
          kind: 'cloudflare_api_token',
          keyIdSuffix: 'ab_9',
          expiresAt: null,
          verifiedAt: '2026-11-22T11:59:00.000Z',
        },
        account: {
          status: 'active',
          connection: 'connected',
          connectionError: null,
          collectionError: null,
          ingestFrom: null,
          lastEventAt: '2026-11-22T11:00:00.000Z',
          lastCollectedAt: '2026-11-22T11:55:00.000Z',
          checkRequestedAt: null,
        },
      },
      {
        id: SOURCE_B,
        revision: 1,
        outcome: 'failed',
        code: 'plan_limit_reached',
        credential: null,
        account: null,
      },
    ],
    users: [
      {
        requestId: REQUEST_A,
        outcome: 'created',
        code: null,
        user: { status: 'active', mfaEnabled: false, mustChangePassword: true },
      },
      { requestId: REQUEST_B, outcome: 'failed', code: 'users_disabled', user: null },
    ],
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    protocol: 1,
    generation: 7,
    pollAfterSeconds: 300,
    sources: [
      {
        id: SOURCE_A,
        revision: 3,
        state: 'active',
        spec: { provider: 'cloudflare', accountId: 'a'.repeat(32), zones: ['example.com'] },
        credential: { revision: 2, kind: 'cloudflare_api_token', envelope: ENVELOPE },
      },
      {
        id: SOURCE_B,
        revision: 2,
        state: 'removed',
        spec: { provider: 'aws', accountId: '111111111111', regions: ['sa-east-1'] },
        credential: null,
      },
    ],
    users: [
      {
        requestId: REQUEST_A,
        name: 'Pessoa Demo',
        email: 'pessoa@cliente-demo-a.example',
        role: 'analista_cliente',
        envelope: ENVELOPE,
        notAfter: '2026-11-25T12:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

const ok = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

function withNode(changes: Record<string, unknown>) {
  return request({ node: { ...request().node, ...changes } });
}

function withSource(changes: Record<string, unknown>, index = 0) {
  const sources = request().sources.map((source, position) =>
    position === index ? { ...source, ...changes } : source,
  );
  return request({ sources });
}

function withDesiredSource(changes: Record<string, unknown>, index = 0) {
  const sources = response().sources.map((source, position) =>
    position === index ? { ...source, ...changes } : source,
  );
  return response({ sources });
}

describe('sincronização do nó: constantes', () => {
  it('protocolo 1, rota pública e as capacidades do nó', () => {
    expect(NODE_SYNC_PROTOCOL).toBe(1);
    expect(NODE_SYNC_PATH).toBe('/v1/node-sync');
    // `cloudflare_oauth`: aceita pelo plano de controle antes de algum nó a anunciar.
    expect(NODE_SYNC_CAPABILITIES).toEqual(['log_sources', 'users', 'cloudflare_oauth']);
  });

  it('os códigos por fonte e por usuário', () => {
    expect(NODE_SYNC_SOURCE_CODES).toContain('source_unavailable');
    // A conta do console que o cliente excluiu no painel: o relato falha com este código até uma revisão maior.
    expect(NODE_SYNC_SOURCE_CODES).toContain('deleted_in_panel');
    expect(NODE_SYNC_SOURCE_CODES.filter((code) => code.startsWith('credential_rejected_'))).toEqual([
      'credential_rejected_invalid',
      'credential_rejected_inactive',
      'credential_rejected_expired',
      'credential_rejected_not_yet_valid',
      'credential_rejected_no_account_access',
      'credential_rejected_wrong_identity',
    ]);
    expect(NODE_SYNC_USER_CODES).toContain('users_disabled');
    expect(new Set(NODE_SYNC_SOURCE_CODES).size).toBe(NODE_SYNC_SOURCE_CODES.length);
    expect(new Set(NODE_SYNC_USER_CODES).size).toBe(NODE_SYNC_USER_CODES.length);
  });

  it('cloudflareOauth: a configuração do app sem segredo, desligada (null) ou ausente; escopo de escrita recusa a resposta', () => {
    const config = {
      clientId: 'clientedeteste0001',
      redirectUri: 'https://conta.exemplo.com.br/v1/public/cloudflare/callback',
      scopes: ['account-settings.read', 'zone.read', 'offline_access'],
    };
    expect(ok(nodeSyncResponseSchema, response())).toBe(true);
    expect(ok(nodeSyncResponseSchema, response({ cloudflareOauth: null }))).toBe(true);
    expect(ok(nodeSyncResponseSchema, response({ cloudflareOauth: config }))).toBe(true);
    for (const changes of [
      { clientSecret: 'x' },
      { scopes: ['zone.write', 'zone.read', 'offline_access'] },
      { scopes: ['zone.read'] },
      { redirectUri: 'https://outro.exemplo.com.br/' },
    ]) {
      expect(ok(nodeSyncResponseSchema, response({ cloudflareOauth: { ...config, ...changes } }))).toBe(
        false,
      );
    }
    expect(ok(nodeSyncRequestSchema, request({ capabilities: ['log_sources', 'cloudflare_oauth'] }))).toBe(
      true,
    );
  });

  it('respondsTo: só a capacidade anunciada', () => {
    expect(respondsTo(['log_sources'], 'log_sources')).toBe(true);
    expect(respondsTo(['log_sources'], 'users')).toBe(false);
    expect(respondsTo([], 'log_sources')).toBe(false);
  });

  it('o formato do envelope: versão sem zero à esquerda e base64 padrão, nada mais', () => {
    for (const envelope of [ENVELOPE, 'v999999999:QUJD', 'v12:QUI=', 'v3:QQ==']) {
      expect(NODE_SYNC_ENVELOPE_PATTERN.test(envelope)).toBe(true);
    }
    for (const envelope of [
      'A'.repeat(20),
      'v0:QUJD',
      'v01:QUJD',
      'V1:QUJD',
      'v1000000000:QUJD',
      'v1:',
      'v1:QUJD\n',
      'v1:QU-D',
      'v1:QUJD===',
    ]) {
      expect(NODE_SYNC_ENVELOPE_PATTERN.test(envelope)).toBe(false);
    }
  });
});

describe('sincronização do nó: pedido', () => {
  it('aceita o pedido completo e o mínimo (sem fontes nem usuários)', () => {
    expect(ok(nodeSyncRequestSchema, request())).toBe(true);
    expect(
      ok(
        nodeSyncRequestSchema,
        request({
          capabilities: [],
          sources: [],
          users: [],
          node: {
            ...request().node,
            platform: 'vm',
            tenantId: null,
            vaultKey: null,
            serviceAccountId: null,
            egressIps: [],
            error: 'tenant_ambiguous',
          },
        }),
      ),
    ).toBe(true);
  });

  it('estrito: campo a mais em qualquer nível, outro protocolo ou modo recusam a mensagem', () => {
    expect(ok(nodeSyncRequestSchema, request({ tenantId: 'qualquer' }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, request({ protocol: 2 }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ mode: 'cell' }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ extra: true }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withSource({ extra: true }))).toBe(false);
    expect(
      ok(
        nodeSyncRequestSchema,
        withSource({ credential: { ...request().sources[0]?.credential, secret: 'x' } }),
      ),
    ).toBe(false);
    const { users: _users, ...withoutUsers } = request();
    expect(ok(nodeSyncRequestSchema, withoutUsers)).toBe(false);
  });

  it('sequência, horário e capacidades', () => {
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '42']) {
      expect(ok(nodeSyncRequestSchema, request({ sequence }))).toBe(false);
    }
    expect(ok(nodeSyncRequestSchema, request({ sequence: Number.MAX_SAFE_INTEGER }))).toBe(true);
    expect(ok(nodeSyncRequestSchema, request({ sentAt: '22/11/2026' }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, request({ capabilities: ['plan_limits'] }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, request({ capabilities: ['users', 'users'] }))).toBe(false);
  });

  it('o que o nó informa de si', () => {
    expect(ok(nodeSyncRequestSchema, withNode({ commit: 'A'.repeat(40) }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ commit: 'a'.repeat(39) }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ platform: 'aws' }))).toBe(false);
    // O id do cliente vai no rótulo dos envelopes: UUID em minúsculas.
    expect(ok(nodeSyncRequestSchema, withNode({ tenantId: NODE_TENANT.toUpperCase() }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ serviceAccountId: '1'.repeat(20) }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ egressIps: ['203.0.113.10'] }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ audience: 'http://conta.example.com' }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withNode({ error: 'outro' }))).toBe(false);
    const vaultKey = request().node.vaultKey;
    for (const changes of [
      { version: 0 },
      { version: 1_000_000_000 },
      { fingerprint: 'F'.repeat(64) },
      { fingerprint: 'f'.repeat(63) },
      { publicKey: 'não é base64' },
      { publicKey: 'A'.repeat(1401) },
    ]) {
      expect(ok(nodeSyncRequestSchema, withNode({ vaultKey: { ...vaultKey, ...changes } }))).toBe(false);
    }
  });

  it('limites: fontes, usuários e IPs de saída', () => {
    const source = request().sources[1];
    const sources = Array.from({ length: NODE_SYNC_MAX_SOURCES + 1 }, (_, index) => ({
      ...source,
      id: `0190a1b2-c3d4-7e5f-8a9b-${index.toString(16).padStart(12, '0')}`,
    }));
    expect(ok(nodeSyncRequestSchema, request({ sources: sources.slice(0, NODE_SYNC_MAX_SOURCES) }))).toBe(
      true,
    );
    expect(ok(nodeSyncRequestSchema, request({ sources }))).toBe(false);
    const user = request().users[1];
    const users = Array.from({ length: NODE_SYNC_MAX_USERS + 1 }, (_, index) => ({
      ...user,
      requestId: `01JD${index.toString().padStart(22, '0')}`,
    }));
    expect(ok(nodeSyncRequestSchema, request({ users: users.slice(0, NODE_SYNC_MAX_USERS) }))).toBe(true);
    expect(ok(nodeSyncRequestSchema, request({ users }))).toBe(false);
    const egressIps = Array.from({ length: 17 }, (_, index) => `203.0.113.${index}/32`);
    expect(ok(nodeSyncRequestSchema, withNode({ egressIps: egressIps.slice(0, 16) }))).toBe(true);
    expect(ok(nodeSyncRequestSchema, withNode({ egressIps }))).toBe(false);
  });

  it('itens repetidos recusam a mensagem', () => {
    const [first] = request().sources;
    expect(ok(nodeSyncRequestSchema, request({ sources: [first, first] }))).toBe(false);
    const [user] = request().users;
    expect(ok(nodeSyncRequestSchema, request({ users: [user, user] }))).toBe(false);
  });

  it('códigos: só os da lista, presentes na falha e ausentes no resto', () => {
    expect(ok(nodeSyncRequestSchema, withSource({ code: 'credential_rejected_expired' }, 1))).toBe(true);
    expect(ok(nodeSyncRequestSchema, withSource({ code: 'outro' }, 1))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withSource({ code: null }, 1))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withSource({ code: 'internal_error' }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, withSource({ outcome: 'removed', credential: null }))).toBe(true);
    const credential = request().sources[0]?.credential;
    expect(
      ok(
        nodeSyncRequestSchema,
        withSource({ credential: { ...credential, outcome: 'failed', code: 'credential_unreadable' } }),
      ),
    ).toBe(true);
    expect(ok(nodeSyncRequestSchema, withSource({ credential: { ...credential, outcome: 'failed' } }))).toBe(
      false,
    );
    // A credencial colada no painel não tem revisão do console.
    expect(ok(nodeSyncRequestSchema, withSource({ credential: { ...credential, revision: null } }))).toBe(
      true,
    );
    expect(ok(nodeSyncRequestSchema, withSource({ credential: { ...credential, keyIdSuffix: 'abc' } }))).toBe(
      false,
    );
    const users = request().users;
    expect(ok(nodeSyncRequestSchema, request({ users: [{ ...users[1], code: 'email_taken' }] }))).toBe(true);
    expect(ok(nodeSyncRequestSchema, request({ users: [{ ...users[1], code: 'outro' }] }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, request({ users: [{ ...users[0], user: null }] }))).toBe(false);
    expect(ok(nodeSyncRequestSchema, request({ users: [{ ...users[0], code: 'expired' }] }))).toBe(false);
  });

  it('a conta reportada segue as regras de cloudAccountSchema', () => {
    const account = request().sources[0]?.account;
    for (const changes of [
      { status: 'deleted' },
      { connection: 'ok' },
      { connectionError: 'erro com espaço' },
      { collectionError: 'outro' },
      { ingestFrom: '2026-11-22T00:00:00.000Z' },
    ]) {
      expect(ok(nodeSyncRequestSchema, withSource({ account: { ...account, ...changes } }))).toBe(false);
    }
    expect(
      ok(
        nodeSyncRequestSchema,
        withSource({ account: { ...account, ingestFrom: '2026-11-21', collectionError: 'aws_token_stale' } }),
      ),
    ).toBe(true);
  });
});

describe('sincronização do nó: resposta', () => {
  it('aceita a resposta completa; cada seção é opcional (capacidade não anunciada)', () => {
    expect(ok(nodeSyncResponseSchema, response())).toBe(true);
    const { sources: _sources, users: _users, ...bare } = response();
    expect(ok(nodeSyncResponseSchema, bare)).toBe(true);
    expect(ok(nodeSyncResponseSchema, response({ tenantId: 'x' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, response({ protocol: 2 }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, response({ generation: -1 }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, response({ generation: 0 }))).toBe(true);
  });

  it('pollAfterSeconds de 60 a 3600', () => {
    expect(ok(nodeSyncResponseSchema, response({ pollAfterSeconds: 60 }))).toBe(true);
    expect(ok(nodeSyncResponseSchema, response({ pollAfterSeconds: 3600 }))).toBe(true);
    expect(ok(nodeSyncResponseSchema, response({ pollAfterSeconds: 59 }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, response({ pollAfterSeconds: 3601 }))).toBe(false);
  });

  it('o cadastro da fonte é o do painel (cloudAccountCreateSchema), sem tirar nem pôr', () => {
    const spec = response().sources[0]?.spec;
    expect(cloudAccountCreateSchema.safeParse(spec).success).toBe(true);
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ spec: { ...spec, extra: 1 } }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ spec: { ...spec, accountId: 'curto' } }))).toBe(
      false,
    );
    expect(
      ok(
        nodeSyncResponseSchema,
        withDesiredSource(
          {
            spec: { provider: 'gcp', accountId: 'cliente-demo-a', pubsubSubscription: null },
            credential: null,
          },
          0,
        ),
      ),
    ).toBe(true);
  });

  it('credencial: tipo do provedor da fonte, envelope no formato, nunca na lápide', () => {
    const credential = response().sources[0]?.credential;
    expect(
      ok(
        nodeSyncResponseSchema,
        withDesiredSource({ credential: { ...credential, kind: 'aws_access_key' } }),
      ),
    ).toBe(false);
    for (const envelope of ['texto claro', 'v0:QUJD', `v1:${'A'.repeat(8190)}`]) {
      expect(ok(nodeSyncResponseSchema, withDesiredSource({ credential: { ...credential, envelope } }))).toBe(
        false,
      );
    }
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ credential: { ...credential, token: 'x' } }))).toBe(
      false,
    );
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ state: 'removed' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ state: 'removed', credential: null }))).toBe(true);
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ state: 'paused' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withDesiredSource({ id: SOURCE_A.toUpperCase() }))).toBe(false);
  });

  it('usuários: papel de cliente, e-mail, envelope e prazo', () => {
    const [user] = response().users;
    const withUser = (changes: Record<string, unknown>) => response({ users: [{ ...user, ...changes }] });
    for (const role of ['admin_cliente', 'analista_cliente', 'leitura']) {
      expect(ok(nodeSyncResponseSchema, withUser({ role }))).toBe(true);
    }
    expect(ok(nodeSyncResponseSchema, withUser({ role: 'admin_verax' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withUser({ email: 'não é e-mail' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withUser({ email: `${'a'.repeat(250)}@x.example` }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withUser({ envelope: 'senha em texto' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withUser({ password: 'x' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withUser({ requestId: 'curto' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, withUser({ notAfter: 'amanhã' }))).toBe(false);
    expect(ok(nodeSyncResponseSchema, response({ users: [user, user] }))).toBe(false);
  });
});
