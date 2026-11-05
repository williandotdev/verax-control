import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeCloud } from '../../test/support/fake-cloud.js';
import { scrubString } from '../common/logger/sanitize.js';
import { CloudApiError } from './cloud-http.js';
import { CloudflareApi } from './cloudflare-api.js';
import { ComputeApi, FirebaseHostingApi, RunJobsApi, SecretVersionsApi, StorageApi } from './google-apis.js';

const ACCOUNT = '0'.repeat(32);
const ZONE = '1'.repeat(32);

/**
 * Os clientes REST do provisionamento contra o servidor falso: o token certo em cada chamada, o que é sucesso, o que é
 * "já existe", o que repete e o que para, e nada de token, corpo ou mensagem de terceiro no erro.
 */
describe('clientes REST do provisionamento', () => {
  const cloud = new FakeCloud();
  const tokens = { token: () => Promise.resolve(cloud.googleToken) };
  let cloudflare: CloudflareApi;
  let firebase: FirebaseHostingApi;

  beforeAll(async () => {
    await cloud.start();
    cloudflare = new CloudflareApi(
      { accountId: ACCOUNT, zoneId: ZONE, apiToken: cloud.cloudflareToken },
      fetch,
      cloud.cloudflareBase,
    );
    firebase = new FirebaseHostingApi(tokens, fetch, cloud.endpoints);
  });

  afterAll(async () => {
    await cloud.stop();
  });

  beforeEach(() => {
    cloud.reset();
  });

  describe('Cloudflare', () => {
    it('cria o túnel gerenciado, acha pelo nome, e "já existe" na criação relê', async () => {
      expect(await cloudflare.findTunnel('vx-cliente-demo-a')).toBeUndefined();
      const created = await cloudflare.createTunnel('vx-cliente-demo-a');
      expect(created?.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await cloudflare.createTunnel('vx-cliente-demo-a')).toBeUndefined();
      expect(await cloudflare.findTunnel('vx-cliente-demo-a')).toEqual(created);
      const body = JSON.parse(cloud.requests.find((r) => r.method === 'POST')?.body ?? '{}') as Record<
        string,
        unknown
      >;
      expect(body).toEqual({ name: 'vx-cliente-demo-a', config_src: 'cloudflare' });
      expect(cloud.requests.every((request) => request.authorized)).toBe(true);
    });

    it('o ingresso aponta a API do cliente para a API do nó e o resto para 404', async () => {
      const tunnel = await cloudflare.createTunnel('vx-cliente-demo-a');
      await cloudflare.putTunnelIngress(
        tunnel?.id ?? '',
        'api-cliente-demo-a.veraxsistemas.com.br',
        'http://api:3000',
      );
      expect(cloud.tunnels.get(tunnel?.id ?? '')?.ingress).toEqual({
        ingress: [
          { hostname: 'api-cliente-demo-a.veraxsistemas.com.br', service: 'http://api:3000' },
          { service: 'http_status:404' },
        ],
      });
    });

    it('o token do túnel entra na máscara do logger assim que chega, e sai depois', async () => {
      const tunnel = await cloudflare.createTunnel('vx-cliente-demo-a');
      const token = await cloudflare.tunnelToken(tunnel?.id ?? '');
      expect(scrubString(`token=${token}`)).toBe('token=[REDACTED]');
      cloudflare.forgetTunnelToken(token);
      expect(scrubString(token)).toBe(token);
      // O token da API do Cloudflare fica na máscara desde a construção do cliente.
      expect(scrubString(cloud.cloudflareToken)).toBe('[REDACTED]');
    });

    it('DNS: cria uma vez, reconhece o igual, troca o conteúdo de um CNAME e relê no "já existe"', async () => {
      const record = {
        type: 'CNAME' as const,
        name: 'api-x.veraxsistemas.com.br',
        content: 'a.cfargotunnel.com',
        proxied: true,
      };
      const id = await cloudflare.ensureDnsRecord(record, 'teste');
      expect(await cloudflare.ensureDnsRecord(record, 'teste')).toBe(id);
      expect(cloud.dns.size).toBe(1);
      await cloudflare.ensureDnsRecord({ ...record, content: 'b.cfargotunnel.com' }, 'teste');
      expect([...cloud.dns.values()].map((r) => r.content)).toEqual(['b.cfargotunnel.com']);
      // Corrida: o registro aparece entre a listagem e a criação (o Cloudflare responde 81057).
      cloud.failNext('/dns_records', 400, {
        method: 'POST',
        body: { success: false, errors: [{ code: 81057 }] },
      });
      const txt = {
        type: 'TXT' as const,
        name: 'cliente.control.veraxsistemas.com.br',
        content: 'hosting-site=x',
        proxied: false,
      };
      await expect(cloudflare.ensureDnsRecord(txt, 'teste')).rejects.toThrow(CloudApiError);
      cloud.dns.set('f'.repeat(32), { id: 'f'.repeat(32), ...txt });
      expect(await cloudflare.ensureDnsRecord(txt, 'teste')).toBe('f'.repeat(32));
    });

    it('403 é configuração (para), 503 é transitório (repete); nenhum dos dois leva token ou mensagem', async () => {
      cloud.failNext('/cfd_tunnel', 403, {
        body: {
          success: false,
          errors: [{ code: 10000, message: `token ${cloud.cloudflareToken} sem permissão` }],
        },
      });
      const denied = await cloudflare.findTunnel('x').catch((error: unknown) => error);
      expect(denied).toBeInstanceOf(CloudApiError);
      expect((denied as CloudApiError).retryable).toBe(false);
      expect((denied as CloudApiError).denied).toBe(true);
      expect((denied as CloudApiError).reason).toBe('cf_10000');
      expect((denied as Error).message).not.toContain(cloud.cloudflareToken);
      expect((denied as Error).message).not.toContain('permissão');
      cloud.failNext('/cfd_tunnel', 503);
      const unavailable = (await cloudflare
        .findTunnel('x')
        .catch((error: unknown) => error)) as CloudApiError;
      expect(unavailable.retryable).toBe(true);
    });
  });

  describe('Firebase Hosting', () => {
    it('cria o site; 409 é "já existe", e o dono se confere à parte (403 é de outro projeto)', async () => {
      expect(await firebase.createSite('paineis-demo-1', 'vxc-cliente-demo-a-0a1b2c')).toEqual({
        created: true,
      });
      expect(await firebase.createSite('paineis-demo-1', 'vxc-cliente-demo-a-0a1b2c')).toEqual({
        created: false,
      });
      expect(await firebase.siteExists('paineis-demo-1', 'vxc-cliente-demo-a-0a1b2c')).toBe(true);
      cloud.foreignSites.add('vxc-de-outro-000000');
      expect(await firebase.createSite('paineis-demo-1', 'vxc-de-outro-000000')).toEqual({ created: false });
      expect(await firebase.siteExists('paineis-demo-1', 'vxc-de-outro-000000')).toBe(false);
      expect(await firebase.countSites('paineis-demo-1')).toBe(1);
    });

    it('publica: versão com a configuração e os rótulos, só os arquivos que faltam, finaliza e libera', async () => {
      await firebase.createSite('paineis-demo-1', 'vxc-a-000000');
      const files = new Map([
        ['/index.html', Buffer.from('<!doctype html>')],
        ['/assets/a.js', Buffer.from('a')],
      ]);
      const config = { headers: [{ glob: '**', headers: { 'Cache-Control': 'no-cache' } }], rewrites: [] };
      expect(
        await firebase.publish('vxc-a-000000', files, config, { 'verax-release': 'node-v1-2-3' }),
      ).toEqual({ uploaded: 2 });
      expect(await firebase.latestReleaseLabels('vxc-a-000000')).toEqual({ 'verax-release': 'node-v1-2-3' });
      expect(cloud.latestRelease('vxc-a-000000')?.files.get('/index.html')?.toString()).toBe(
        '<!doctype html>',
      );
      // De novo: o Firebase já tem os arquivos, nada é enviado.
      expect(
        await firebase.publish('vxc-a-000000', files, config, { 'verax-release': 'node-v1-2-3' }),
      ).toEqual({ uploaded: 0 });
    });

    it('o token só vai para o endereço de envio do próprio Firebase', async () => {
      const elsewhere = new FirebaseHostingApi(tokens, fetch, {
        ...cloud.endpoints,
        firebaseUpload: 'https://upload-firebasehosting.googleapis.com',
      });
      await expect(
        elsewhere.publish(
          'vxc-a-000000',
          new Map([['/index.html', Buffer.from('x')]]),
          { headers: [], rewrites: [] },
          {},
        ),
      ).rejects.toMatchObject({ reason: 'INVALID_RESPONSE' });
      expect(cloud.count('POST', '/upload/')).toBe(0);
    });

    it('domínio próprio: 409 é "já existe"; os registros pedidos vêm dos dois lugares da resposta', async () => {
      await firebase.createSite('paineis-demo-1', 'vxc-a-000000');
      cloud.newDomain = () => ({
        hostState: 'HOST_UNHOSTED',
        ownershipState: 'OWNERSHIP_MISSING',
        certState: 'CERT_PREPARING',
        desired: [
          {
            domainName: 'a.control.veraxsistemas.com.br',
            type: 'A',
            rdata: '203.0.113.10',
            requiredAction: 'ADD',
          },
        ],
      });
      expect(
        await firebase.createCustomDomain('paineis-demo-1', 'vxc-a-000000', 'a.control.veraxsistemas.com.br'),
      ).toEqual({ created: true });
      expect(
        await firebase.createCustomDomain('paineis-demo-1', 'vxc-a-000000', 'a.control.veraxsistemas.com.br'),
      ).toEqual({ created: false });
      expect(
        await firebase.getCustomDomain('paineis-demo-1', 'vxc-a-000000', 'a.control.veraxsistemas.com.br'),
      ).toEqual({
        hostState: 'HOST_UNHOSTED',
        ownershipState: 'OWNERSHIP_MISSING',
        certState: 'CERT_PREPARING',
        desiredRecords: [
          {
            domainName: 'a.control.veraxsistemas.com.br',
            type: 'A',
            rdata: '203.0.113.10',
            requiredAction: 'ADD',
          },
        ],
      });
      expect(
        await firebase.getCustomDomain('paineis-demo-1', 'vxc-a-000000', 'b.control.veraxsistemas.com.br'),
      ).toBeUndefined();
    });
  });

  describe('Compute, Storage, Run e Secret Manager', () => {
    it('guest attributes do espaço verax/; sem nenhum ainda (404), vazio', async () => {
      const compute = new ComputeApi(tokens, fetch, cloud.endpoints.compute);
      expect((await compute.guestAttributes('nos-demo', 'southamerica-east1-b', 'vx-a')).size).toBe(0);
      cloud.guestAttributes.set('nos-demo/southamerica-east1-b/vx-a', new Map([['ready', 'node-v1.2.3']]));
      expect(await compute.guestAttributes('nos-demo', 'southamerica-east1-b', 'vx-a')).toEqual(
        new Map([['ready', 'node-v1.2.3']]),
      );
      expect(cloud.requests.at(-1)?.path).toContain('queryPath=verax%2F');
    });

    it('objeto: o conteúdo, `undefined` se não existe e erro acima do teto', async () => {
      const storage = new StorageApi(tokens, fetch, cloud.endpoints.storage);
      cloud.objects.set('bucket-demo/runs/a/b/outputs.json', Buffer.from('{"a":1}'));
      expect((await storage.read('bucket-demo', 'runs/a/b/outputs.json', 1024))?.toString()).toBe('{"a":1}');
      expect(await storage.read('bucket-demo', 'runs/a/b/nada.json', 1024)).toBeUndefined();
      await expect(storage.read('bucket-demo', 'runs/a/b/outputs.json', 3)).rejects.toMatchObject({
        reason: 'RESPONSE_TOO_LARGE',
      });
    });

    it('o Job: dispara com as variáveis e acompanha a execução pelo nome curto', async () => {
      const run = new RunJobsApi(tokens, fetch, cloud.endpoints.run);
      const job = { project: 'verax-cp-demo', region: 'southamerica-east1', job: 'cp-terraform' };
      const execution = await run.run(job, [{ name: 'TENANT_SLUG', value: 'cliente-demo-a' }]);
      expect(execution).toMatch(/^cp-terraform-[0-9a-f]{6}$/);
      expect(cloud.executions.get(execution)?.env).toEqual([
        { name: 'TENANT_SLUG', value: 'cliente-demo-a' },
      ]);
      expect(await run.executionState(job, execution)).toBe('running');
      const state = cloud.executions.get(execution);
      if (state !== undefined) state.state = 'failed';
      expect(await run.executionState(job, execution)).toBe('failed');
      await expect(run.executionState(job, '../x')).rejects.toThrow(TypeError);
    });

    it('Secret Manager: a versão nova em base64 no corpo; o estado da mais nova sem ler o conteúdo', async () => {
      const secrets = new SecretVersionsApi(tokens, fetch, cloud.endpoints.secretManager);
      expect(await secrets.latestVersionState('nos-demo', 'vx-a-admin-bootstrap')).toBeUndefined();
      await secrets.addVersion('nos-demo', 'vx-a-cloudflare-tunnel-token', 'valor-de-teste');
      expect(cloud.secretVersions.get('nos-demo/vx-a-cloudflare-tunnel-token')?.[0]?.payload).toBe(
        'valor-de-teste',
      );
      expect(cloud.requests.at(-1)?.body).not.toContain('valor-de-teste');
      expect(await secrets.latestVersionState('nos-demo', 'vx-a-cloudflare-tunnel-token')).toBe('ENABLED');
    });

    it('Secret Manager: o conteúdo da mais nova; sem versão ou com ela desativada, nada; erro sem o conteúdo', async () => {
      const secrets = new SecretVersionsApi(tokens, fetch, cloud.endpoints.secretManager);
      expect(await secrets.accessLatest('cp-demo', 'cp-nodes-smtp-password')).toBeUndefined();
      cloud.secretVersions.set('cp-demo/cp-nodes-smtp-password', [
        { payload: 'senha-antiga-ficticia', state: 'ENABLED' },
        { payload: 'senha-nova-ficticia', state: 'ENABLED' },
      ]);
      expect(await secrets.accessLatest('cp-demo', 'cp-nodes-smtp-password')).toBe('senha-nova-ficticia');
      expect(cloud.requests.at(-1)?.path).toBe(
        '/secrets/v1/projects/cp-demo/secrets/cp-nodes-smtp-password/versions/latest:access',
      );
      cloud.secretVersions.get('cp-demo/cp-nodes-smtp-password')?.push({ payload: 'x', state: 'DISABLED' });
      expect(await secrets.accessLatest('cp-demo', 'cp-nodes-smtp-password')).toBeUndefined();
      cloud.failNext('cp-nodes-smtp-password', 403, { body: { error: { status: 'PERMISSION_DENIED' } } });
      const error = (await secrets
        .accessLatest('cp-demo', 'cp-nodes-smtp-password')
        .catch((caught: unknown) => caught)) as CloudApiError;
      expect(error).toBeInstanceOf(CloudApiError);
      expect(error.denied).toBe(true);
      expect(error.message).not.toContain('senha');
    });

    it('sem o token certo, o falso recusa (401): a conta do serviço é conferida em toda chamada', async () => {
      const wrong = new StorageApi(
        { token: () => Promise.resolve('ya29.outro') },
        fetch,
        cloud.endpoints.storage,
      );
      const error = (await wrong.read('b', 'o', 10).catch((caught: unknown) => caught)) as CloudApiError;
      expect(error.status).toBe(401);
      expect(error.denied).toBe(true);
      expect(error.message).not.toContain('ya29');
    });
  });
});
