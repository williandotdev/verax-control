import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MetadataTokenProvider, PubsubRestReader } from '../../src/gcp/pubsub.client.js';

const SUBSCRIPTION = 'projects/projeto-no/subscriptions/verax-node-security-projeto-alfa';

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

describe('cliente do Pub/Sub (REST, token da VM)', () => {
  let server: Server;
  let base: string;
  let requests: Recorded[];
  let pullStatus: number;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        requests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          headers: request.headers,
          body,
        });
        response.setHeader('content-type', 'application/json');
        if (request.url?.startsWith('/token')) {
          response.end(
            JSON.stringify({ access_token: 'token-da-vm', expires_in: 3600, token_type: 'Bearer' }),
          );
          return;
        }
        if (request.url?.endsWith(':pull')) {
          response.statusCode = pullStatus;
          response.end(
            pullStatus === 200
              ? JSON.stringify({
                  receivedMessages: [{ ackId: 'a1', message: { data: 'e30=', messageId: 'm1' } }],
                })
              : JSON.stringify({ error: { message: 'detalhe interno do projeto-secreto' } }),
          );
          return;
        }
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = [];
    pullStatus = 200;
  });

  it('pede o token ao servidor de metadados com o cabeçalho exigido, e reaproveita até perto de vencer', async () => {
    const tokens = new MetadataTokenProvider(`${base}/token`);
    expect(await tokens.token()).toBe('token-da-vm');
    expect(await tokens.token()).toBe('token-da-vm');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers['metadata-flavor']).toBe('Google');
  });

  it('lê e confirma mensagens com o token da VM', async () => {
    const reader = new PubsubRestReader(new MetadataTokenProvider(`${base}/token`), base);
    expect(await reader.pull(SUBSCRIPTION, 50)).toEqual([{ ackId: 'a1', data: 'e30=', messageId: 'm1' }]);
    await reader.acknowledge(SUBSCRIPTION, ['a1']);
    const calls = requests.filter((request) => !request.url.startsWith('/token'));
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST /${SUBSCRIPTION}:pull`,
      `POST /${SUBSCRIPTION}:acknowledge`,
    ]);
    expect(calls[0]?.headers.authorization).toBe('Bearer token-da-vm');
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ maxMessages: 50 });
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual({ ackIds: ['a1'] });
  });

  it('nada a confirmar não chama a API', async () => {
    const reader = new PubsubRestReader(new MetadataTokenProvider(`${base}/token`), base);
    await reader.acknowledge(SUBSCRIPTION, []);
    expect(requests).toHaveLength(0);
  });

  it('erro do Google vira só o código: o detalhe da resposta não vai para a mensagem nem para o log', async () => {
    pullStatus = 403;
    const reader = new PubsubRestReader(new MetadataTokenProvider(`${base}/token`), base);
    const error: unknown = await reader.pull(SUBSCRIPTION, 10).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Pub/Sub pull respondeu 403');
    expect((error as Error).message).not.toContain('projeto-secreto');
  });

  it.each(['../../outro', 'projects/x/subscriptions/y', `${SUBSCRIPTION}/../acknowledge`])(
    'nome de assinatura inválido nem chega à rede: %s',
    async (subscription) => {
      const reader = new PubsubRestReader(new MetadataTokenProvider(`${base}/token`), base);
      await expect(reader.pull(subscription, 1)).rejects.toThrow('assinatura do Pub/Sub em formato inválido');
      expect(requests).toHaveLength(0);
    },
  );
});
