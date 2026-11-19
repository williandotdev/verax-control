import { createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { REDACTED, scrubString } from '../common/logger/sanitize.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { CredentialRejected, CredentialSourceUnavailable } from '../credentials/credential-check.js';
import { parsePrivateKeys, parsePublicKey } from '../credentials/credential-keys.js';
import { credentialBinding, GcpServiceAccountKey, seal } from '../credentials/credential-vault.js';
import { GcpServiceAccountKeyCheck, PUBSUB_CONSUME_PERMISSION } from './gcp-key-check.js';
import {
  GOOGLE_TOKEN_URL,
  GoogleTokenError,
  isAllowedTokenUrl,
  PUBSUB_SCOPE,
  ServiceAccountTokenProvider,
} from './service-account-token.js';
import { GcpKeyMissingError, VaultPubsubReader } from './vault-pubsub-reader.js';

// Chaves geradas na hora: nenhuma chave real no repositório. Projeto e conta fictícios.
const PROJECT = 'cliente-demo-a';
const SUBSCRIPTION = `projects/${PROJECT}/subscriptions/verax-control-security`;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const fields = () => ({
  projectId: PROJECT,
  clientEmail: `verax-control-reader@${PROJECT}.iam.gserviceaccount.com`,
  privateKeyId: randomBytes(20).toString('hex'),
  privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

interface Seen {
  path: string;
  body: string;
  authorization: string | undefined;
}

/** O Google falso: o endpoint de token (confere o JWT com a chave pública) e o Pub/Sub, em 127.0.0.1. */
class FakeGoogle {
  readonly seen: Seen[] = [];
  tokenStatus = 200;
  tokenError = 'invalid_grant';
  permissions: string[] | 'missing' = [PUBSUB_CONSUME_PERMISSION];
  messages = 0;
  readonly issued: string[] = [];
  #server: Server | null = null;

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handle(request).then(({ status, body }) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
  }

  get base(): string {
    return `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.#server?.close(() => resolve()));
  }

  async #handle(request: IncomingMessage): Promise<{ status: number; body: unknown }> {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    const path = request.url ?? '';
    this.seen.push({ path, body, authorization: request.headers.authorization });
    if (path === '/token') {
      if (this.tokenStatus !== 200)
        return { status: this.tokenStatus, body: { error: this.tokenError, error_description: 'detalhe' } };
      const assertion = new URLSearchParams(body).get('assertion') ?? '';
      const [header = '', claims = '', signature = ''] = assertion.split('.');
      const verifier = createVerify('RSA-SHA256');
      verifier.update(`${header}.${claims}`);
      if (!verifier.verify(pair.publicKey, Buffer.from(signature, 'base64url'))) {
        return { status: 400, body: { error: 'invalid_grant' } };
      }
      const token = `ya29.${randomBytes(32).toString('base64url')}`;
      this.issued.push(token);
      return { status: 200, body: { access_token: token, expires_in: 3599, token_type: 'Bearer' } };
    }
    if (path.endsWith(':testIamPermissions')) {
      if (this.permissions === 'missing') return { status: 404, body: { error: { code: 404 } } };
      return { status: 200, body: this.permissions.length > 0 ? { permissions: this.permissions } : {} };
    }
    if (path.endsWith(':pull')) {
      const receivedMessages = Array.from({ length: this.messages }, (_unused, index) => ({
        ackId: `ack-${index}`,
        message: { data: Buffer.from('{}').toString('base64'), messageId: `m-${index}` },
      }));
      return { status: 200, body: receivedMessages.length > 0 ? { receivedMessages } : {} };
    }
    if (path.endsWith(':acknowledge')) return { status: 200, body: {} };
    return { status: 404, body: {} };
  }
}

describe('a chave da conta de serviço da GCP (VM própria do cliente)', () => {
  const google = new FakeGoogle();

  beforeAll(() => google.start());
  afterAll(() => google.stop());
  beforeEach(() => {
    google.seen.length = 0;
    google.tokenStatus = 200;
    google.permissions = [PUBSUB_CONSUME_PERMISSION];
  });

  it('o token: um JWT assinado com a chave, com o ID dela, só o escopo do Pub/Sub e o endereço fixo como público', async () => {
    const key = new GcpServiceAccountKey(fields());
    const tokens = new ServiceAccountTokenProvider(key, { url: `${google.base}/token` });
    const token = await tokens.token();
    expect(await tokens.token()).toBe(token);
    expect(google.seen).toHaveLength(1);
    const form = new URLSearchParams(google.seen[0]?.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header = '', claims = ''] = (form.get('assertion') ?? '').split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
      kid: key.privateKeyId,
    });
    const payload = JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>;
    expect(payload).toMatchObject({ iss: key.clientEmail, scope: PUBSUB_SCOPE, aud: GOOGLE_TOKEN_URL });
    expect(Number(payload.exp) - Number(payload.iat)).toBe(3600);
    // O token vira segredo vivo: some de qualquer linha de log.
    expect(scrubString(`token ${token}`)).toBe(`token ${REDACTED}`);
    tokens.release();
    expect(scrubString(token)).toBe(token);
  });

  it('só o endereço oficial ou um servidor falso local', () => {
    expect(isAllowedTokenUrl(GOOGLE_TOKEN_URL)).toBe(true);
    expect(isAllowedTokenUrl('http://127.0.0.1:9/token')).toBe(true);
    for (const url of ['https://exemplo.invalid/token', 'http://localhost/token', 'http://10.0.0.1/token']) {
      expect(isAllowedTokenUrl(url)).toBe(false);
      expect(() => new ServiceAccountTokenProvider(new GcpServiceAccountKey(fields()), { url })).toThrow();
    }
  });

  it('a chave recusada pelo Google (apagada, desativada) e o Google fora dão erros diferentes, só com o código', async () => {
    const key = new GcpServiceAccountKey(fields());
    google.tokenStatus = 400;
    const rejected = await new ServiceAccountTokenProvider(key, { url: `${google.base}/token` })
      .token()
      .catch((error: unknown) => error);
    expect(rejected).toMatchObject({ code: 'invalid_grant', rejected: true });
    expect((rejected as Error).message).not.toContain('detalhe');
    google.tokenStatus = 503;
    const down = await new ServiceAccountTokenProvider(key, { url: `${google.base}/token` })
      .token()
      .catch((error: unknown) => error);
    expect(down).toBeInstanceOf(GoogleTokenError);
    expect(down).toMatchObject({ code: 'http_503', rejected: false });
  });

  it('a conferência na API: o token e o testIamPermissions na assinatura, com o sufixo do ID da chave', async () => {
    const key = new GcpServiceAccountKey(fields());
    const check = new GcpServiceAccountKeyCheck({
      tokenUrl: `${google.base}/token`,
      pubsubBaseUrl: google.base,
    });
    expect(await check.check(key, SUBSCRIPTION)).toEqual({
      keyIdSuffix: key.privateKeyId.slice(-4),
      issuedAt: null,
      expiresAt: null,
    });
    const probe = google.seen.find((seen) => seen.path.endsWith(':testIamPermissions'));
    expect(probe?.path).toBe(`/${SUBSCRIPTION}:testIamPermissions`);
    expect(JSON.parse(probe?.body ?? '{}')).toEqual({ permissions: [PUBSUB_CONSUME_PERMISSION] });
    expect(probe?.authorization).toMatch(/^Bearer ya29\./);
    // Nenhuma mensagem lida nem confirmada na conferência.
    expect(
      google.seen.some((seen) => seen.path.endsWith(':pull') || seen.path.endsWith(':acknowledge')),
    ).toBe(false);
  });

  it('sem a permissão na assinatura (ou sem a assinatura): no_account_access; chave recusada: invalid; fora: 503', async () => {
    const check = new GcpServiceAccountKeyCheck({
      tokenUrl: `${google.base}/token`,
      pubsubBaseUrl: google.base,
    });
    for (const permissions of [[], 'missing'] as const) {
      google.permissions = permissions === 'missing' ? 'missing' : [];
      await expect(check.check(new GcpServiceAccountKey(fields()), SUBSCRIPTION)).rejects.toMatchObject({
        reason: 'no_account_access',
      });
    }
    google.permissions = [PUBSUB_CONSUME_PERMISSION];
    google.tokenStatus = 400;
    const rejected = await check
      .check(new GcpServiceAccountKey(fields()), SUBSCRIPTION)
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(CredentialRejected);
    expect(rejected).toMatchObject({ reason: 'invalid' });
    google.tokenStatus = 500;
    const down = await check
      .check(new GcpServiceAccountKey(fields()), SUBSCRIPTION)
      .catch((error: unknown) => error);
    expect(down).toBeInstanceOf(CredentialSourceUnavailable);
  });

  describe('a leitura no worker (VaultPubsubReader)', () => {
    const vaultPair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const publicKey = parsePublicKey(
      Buffer.from(vaultPair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
      1,
    );
    const keyring = parsePrivateKeys(
      `1:${Buffer.from(vaultPair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')}`,
      1,
    );
    const account = { id: randomUUID(), tenantId: randomUUID(), accountId: PROJECT };
    const sealedKey = () =>
      seal(
        publicKey,
        credentialBinding({ ...account, provider: 'gcp' }, 'gcp_service_account_key'),
        new GcpServiceAccountKey(fields()),
      ).ciphertext;
    const prismaWith = (row: () => unknown) =>
      ({ cloudAccount: { findFirst: () => Promise.resolve(row()) } }) as unknown as PrismaService;

    it('lê e confirma a assinatura com o token da chave da conta; o token fica guardado entre as leituras', async () => {
      const ciphertext = sealedKey();
      const reader = new VaultPubsubReader(
        prismaWith(() => ({ ...account, credential: { kind: 'gcp_service_account_key', ciphertext } })),
        keyring,
        { token: { url: `${google.base}/token` }, pubsubBaseUrl: google.base },
      );
      google.messages = 2;
      const messages = await reader.pull(SUBSCRIPTION, 10);
      expect(messages.map((message) => message.ackId)).toEqual(['ack-0', 'ack-1']);
      await reader.acknowledge(
        SUBSCRIPTION,
        messages.map((message) => message.ackId),
      );
      expect(google.seen.map((seen) => seen.path)).toEqual([
        '/token',
        `/${SUBSCRIPTION}:pull`,
        `/${SUBSCRIPTION}:acknowledge`,
      ]);
      google.messages = 0;
    });

    it('sem conta com a chave, ou com um texto que não abre: gcp_key_missing (o erro de conexão das contas)', async () => {
      for (const row of [
        null,
        {
          ...account,
          credential: {
            kind: 'gcp_service_account_key',
            ciphertext: `v1:${randomBytes(600).toString('base64')}`,
          },
        },
      ]) {
        const reader = new VaultPubsubReader(
          prismaWith(() => row),
          keyring,
          {
            token: { url: `${google.base}/token` },
            pubsubBaseUrl: google.base,
          },
        );
        const failure = await reader.pull(SUBSCRIPTION, 10).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(GcpKeyMissingError);
        expect((failure as Error).name).toBe('gcp_key_missing');
      }
      expect(google.seen).toEqual([]);
    });
  });
});
