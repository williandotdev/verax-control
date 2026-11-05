import { createHash, createSign, createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';
import type { GoogleEndpoints } from '../../src/provisioning/google-apis.js';

/**
 * As APIs externas do provisionamento (CP-07) num servidor falso em 127.0.0.1, com estado: Cloudflare (túneis,
 * configuração, token, DNS), Firebase Hosting (sites, versões, envio, liberações, domínios), Compute (guest
 * attributes), Cloud Storage (leitura), Cloud Run (o Job e as execuções) e Secret Manager (versões). Confere o token de
 * cada chamada (o do Google nas APIs do Google, o do Cloudflare no Cloudflare), grava cada pedido e deixa o teste
 * mandar falhas (`failNext`). Nenhum valor de verdade: projetos, ids e tokens são gerados aqui.
 */
export interface RecordedRequest {
  method: string;
  path: string;
  authorized: boolean;
  body: string;
}

interface Failure {
  method?: string;
  pathIncludes: string;
  status: number;
  body?: unknown;
  times: number;
}

export interface FakeTunnel {
  id: string;
  name: string;
  token: string;
  ingress?: unknown;
}

export interface FakeDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface FakeDomain {
  hostState: string;
  ownershipState: string;
  certState: string;
  desired: { domainName: string; type: string; rdata: string; requiredAction?: string }[];
}

export interface FakeExecution {
  state: 'running' | 'succeeded' | 'failed';
  env: { name: string; value: string }[];
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export class FakeCloud {
  readonly googleToken = `ya29.teste-${hex(24)}`;
  readonly cloudflareToken = `cf-teste-${hex(20)}`;
  readonly requests: RecordedRequest[] = [];

  readonly tunnels = new Map<string, FakeTunnel>();
  readonly dns = new Map<string, FakeDnsRecord>();
  /** Sites por projeto do Firebase deste teste. */
  readonly sites = new Map<string, Set<string>>();
  /** Ids de site que existem em projetos de outros (o id é global no Firebase). */
  readonly foreignSites = new Set<string>();
  readonly releases = new Map<string, { labels: Record<string, string>; files: Map<string, Buffer> }[]>();
  readonly domains = new Map<string, FakeDomain>();
  readonly objects = new Map<string, Buffer>();
  readonly executions = new Map<string, FakeExecution>();
  readonly guestAttributes = new Map<string, Map<string, string>>();
  readonly secretVersions = new Map<string, { payload: string; state: string }[]>();
  /** VMs (`<projeto>/<zona>/<nome>`) e o estado do Compute; `stop`/`start` passam por STOPPING/STAGING numa consulta. */
  readonly instances = new Map<string, { status: string }>();
  /** A chave da conta que assina (`signBlob`): os testes conferem o link assinado com a pública. */
  readonly signer = generateKeyPairSync('rsa', { modulusLength: 2048 });
  /** Os pedidos por link assinado que chegaram (método, caminho, assinatura válida ou não). */
  readonly signedRequests: { method: string; path: string; valid: boolean }[] = [];
  /** Como o domínio novo nasce (o teste muda depois). */
  newDomain: () => FakeDomain = () => ({
    hostState: 'HOST_UNHOSTED',
    ownershipState: 'OWNERSHIP_MISSING',
    certState: 'CERT_PREPARING',
    desired: [],
  });

  private readonly failures: Failure[] = [];
  private readonly versions = new Map<
    string,
    { site: string; config: unknown; labels: Record<string, string>; files: Record<string, string> }
  >();
  private readonly blobs = new Map<string, Buffer>();
  private server: Server | undefined;
  private base = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  get endpoints(): GoogleEndpoints {
    return {
      firebaseHosting: `${this.base}/firebase/v1beta1`,
      firebaseUpload: `${this.base}/upload`,
      compute: `${this.base}/compute/v1`,
      storage: `${this.base}/storage`,
      run: `${this.base}/run/v2`,
      secretManager: `${this.base}/secrets/v1`,
      iamCredentials: `${this.base}/iam/v1`,
    };
  }

  get cloudflareBase(): string {
    return `${this.base}/cloudflare/client/v4`;
  }

  /** As próximas `times` chamadas cujo caminho contém o trecho recebem este status. */
  failNext(
    pathIncludes: string,
    status: number,
    options: { method?: string; times?: number; body?: unknown } = {},
  ): void {
    this.failures.push({
      pathIncludes,
      status,
      method: options.method,
      body: options.body,
      times: options.times ?? 1,
    });
  }

  clearFailures(): void {
    this.failures.length = 0;
  }

  reset(): void {
    this.clearFailures();
    this.requests.length = 0;
    for (const map of [
      this.tunnels,
      this.dns,
      this.sites,
      this.releases,
      this.domains,
      this.objects,
      this.executions,
      this.guestAttributes,
      this.secretVersions,
      this.instances,
      this.versions,
      this.blobs,
    ] as Map<unknown, unknown>[]) {
      map.clear();
    }
    this.foreignSites.clear();
    this.signedRequests.length = 0;
  }

  /** O total de chamadas por método e trecho de caminho. */
  count(method: string, pathIncludes: string): number {
    return this.requests.filter((request) => request.method === method && request.path.includes(pathIncludes))
      .length;
  }

  private send(res: ServerResponse, status: number, body?: unknown): void {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  private async read(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base);
    const method = req.method ?? 'GET';
    const raw = await this.read(req);
    const cloudflare = url.pathname.startsWith('/cloudflare/');
    const expected = `Bearer ${cloudflare ? this.cloudflareToken : this.googleToken}`;
    const authorized = req.headers.authorization === expected;
    this.requests.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorized,
      body: raw.toString('latin1'),
    });
    if (url.searchParams.has('X-Goog-Signature') && url.pathname.startsWith('/storage/')) {
      // Um link assinado V4: sem token, a credencial é a assinatura (conferida aqui por conta própria).
      this.signedStorageRoute(method, url, req.headers.host ?? '', res);
      return;
    }
    if (!authorized) {
      this.send(res, 401, { error: { status: 'UNAUTHENTICATED' } });
      return;
    }
    const failure = this.failures.find(
      (candidate) =>
        url.pathname.includes(candidate.pathIncludes) &&
        (candidate.method === undefined || candidate.method === method),
    );
    if (failure !== undefined) {
      failure.times -= 1;
      if (failure.times <= 0) this.failures.splice(this.failures.indexOf(failure), 1);
      this.send(
        res,
        failure.status,
        failure.body ?? { error: { status: 'SIMULATED' }, errors: [{ code: 9999 }] },
      );
      return;
    }
    const json = (): Record<string, unknown> =>
      raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
    if (cloudflare) this.cloudflareRoute(method, url, json, res);
    else if (url.pathname.startsWith('/firebase/')) this.firebaseRoute(method, url, json, res);
    else if (url.pathname.startsWith('/upload/')) this.uploadRoute(method, url, raw, res);
    else if (url.pathname.startsWith('/compute/')) this.computeRoute(method, url, res);
    else if (url.pathname.startsWith('/storage/')) this.storageRoute(url, res);
    else if (url.pathname.startsWith('/run/')) this.runRoute(method, url, json, res);
    else if (url.pathname.startsWith('/secrets/')) this.secretsRoute(method, url, json, res);
    else if (url.pathname.startsWith('/iam/')) this.iamRoute(method, url, json, res);
    else this.send(res, 404);
  }

  // --- Links assinados e IAM Credentials ------------------------------------------------------------------------------

  /** O texto que a conta assinaria para este pedido, montado de novo a partir do que chegou (V4, `host` só). */
  stringToSignOf(method: string, url: URL, host: string): string {
    const query = [...url.searchParams.entries()]
      .filter(([key]) => key !== 'X-Goog-Signature')
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
      .join('&');
    const canonical = [method, url.pathname, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
    const scope = (url.searchParams.get('X-Goog-Credential') ?? '').split('/').slice(1).join('/');
    return [
      'GOOG4-RSA-SHA256',
      url.searchParams.get('X-Goog-Date') ?? '',
      scope,
      createHash('sha256').update(canonical).digest('hex'),
    ].join('\n');
  }

  private signedStorageRoute(method: string, url: URL, host: string, res: ServerResponse): void {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(this.stringToSignOf(method, url, host));
    const signature = Buffer.from(url.searchParams.get('X-Goog-Signature') ?? '', 'hex');
    const valid = verifier.verify(this.signer.publicKey, signature);
    this.signedRequests.push({ method, path: url.pathname, valid });
    if (!valid) {
      this.send(res, 403, { error: { status: 'SIGNATURE_DOES_NOT_MATCH' } });
      return;
    }
    const [bucket, ...rest] = url.pathname.replace(/^\/storage\//, '').split('/');
    const object = this.objects.get(`${bucket ?? ''}/${rest.map(decodeURIComponent).join('/')}`);
    if (object === undefined) {
      this.send(res, 404);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': object.length });
    res.end(method === 'HEAD' ? undefined : object);
  }

  private iamRoute(method: string, url: URL, json: () => Record<string, unknown>, res: ServerResponse): void {
    const match = /^\/iam\/v1\/projects\/-\/serviceAccounts\/([^/]+):signBlob$/.exec(url.pathname);
    if (match === null || method !== 'POST') {
      this.send(res, 404);
      return;
    }
    const raw = json().payload;
    const payload = Buffer.from(typeof raw === 'string' ? raw : '', 'base64');
    const signer = createSign('RSA-SHA256');
    signer.update(payload);
    this.send(res, 200, {
      keyId: hex(8),
      signedBlob: signer.sign(this.signer.privateKey).toString('base64'),
    });
  }

  // --- Cloudflare ----------------------------------------------------------------------------------------------------

  private cloudflareRoute(
    method: string,
    url: URL,
    json: () => Record<string, unknown>,
    res: ServerResponse,
  ): void {
    const ok = (result: unknown): void =>
      this.send(res, 200, { success: true, errors: [], messages: [], result });
    const path = url.pathname.replace('/cloudflare/client/v4', '');
    let match: RegExpExecArray | null;
    if (/^\/accounts\/[0-9a-f]{32}\/cfd_tunnel$/.test(path)) {
      if (method === 'GET') {
        const name = url.searchParams.get('name');
        ok(
          [...this.tunnels.values()]
            .filter((tunnel) => tunnel.name === name)
            .map(({ id, name: n }) => ({ id, name: n })),
        );
        return;
      }
      const body = json();
      const name = String(body.name);
      if ([...this.tunnels.values()].some((tunnel) => tunnel.name === name)) {
        this.send(res, 409, {
          success: false,
          errors: [{ code: 1013, message: 'tunnel name already exists' }],
        });
        return;
      }
      const id = `${hex(4)}-${hex(2)}-${hex(2)}-${hex(2)}-${hex(6)}`;
      this.tunnels.set(id, { id, name, token: `tunnel-token-${hex(32)}` });
      ok({ id, name });
      return;
    }
    if (
      (match = /^\/accounts\/[0-9a-f]{32}\/cfd_tunnel\/([0-9a-f-]+)(\/connections)?$/.exec(path)) !== null &&
      method === 'DELETE'
    ) {
      const id = match[1] ?? '';
      if (!this.tunnels.has(id)) {
        this.send(res, 404, { success: false, errors: [{ code: 1003 }] });
        return;
      }
      if (match[2] === undefined) this.tunnels.delete(id);
      ok({ id });
      return;
    }
    if (
      (match = /^\/accounts\/[0-9a-f]{32}\/cfd_tunnel\/([0-9a-f-]+)\/(configurations|token)$/.exec(path)) !==
      null
    ) {
      const tunnel = this.tunnels.get(match[1] ?? '');
      if (tunnel === undefined) {
        this.send(res, 404, { success: false, errors: [{ code: 1003 }] });
        return;
      }
      if (match[2] === 'token') ok(tunnel.token);
      else {
        tunnel.ingress = json().config;
        ok({ tunnel_id: tunnel.id });
      }
      return;
    }
    if (/^\/zones\/[0-9a-f]{32}\/dns_records$/.test(path)) {
      if (method === 'GET') {
        const type = url.searchParams.get('type');
        const name = url.searchParams.get('name');
        ok(
          [...this.dns.values()].filter(
            (record) => (type === null || record.type === type) && record.name === name,
          ),
        );
        return;
      }
      const body = json();
      const record: FakeDnsRecord = {
        id: hex(16),
        type: String(body.type),
        name: String(body.name),
        content: String(body.content),
        proxied: body.proxied === true,
      };
      if (
        [...this.dns.values()].some(
          (r) => r.type === record.type && r.name === record.name && r.content === record.content,
        )
      ) {
        this.send(res, 400, { success: false, errors: [{ code: 81057, message: 'record already exists' }] });
        return;
      }
      this.dns.set(record.id, record);
      ok(record);
      return;
    }
    if (
      (match = /^\/zones\/[0-9a-f]{32}\/dns_records\/([0-9a-f]{32})$/.exec(path)) !== null &&
      (method === 'GET' || method === 'DELETE')
    ) {
      const existing = this.dns.get(match[1] ?? '');
      if (existing === undefined) {
        this.send(res, 404, { success: false, errors: [{ code: 81044 }] });
        return;
      }
      if (method === 'DELETE') this.dns.delete(existing.id);
      ok(method === 'DELETE' ? { id: existing.id } : existing);
      return;
    }
    if (
      (match = /^\/zones\/[0-9a-f]{32}\/dns_records\/([0-9a-f]{32})$/.exec(path)) !== null &&
      method === 'PUT'
    ) {
      const existing = this.dns.get(match[1] ?? '');
      if (existing === undefined) {
        this.send(res, 404, { success: false, errors: [{ code: 81044 }] });
        return;
      }
      const body = json();
      Object.assign(existing, { content: String(body.content), proxied: body.proxied === true });
      ok(existing);
      return;
    }
    this.send(res, 404, { success: false, errors: [{ code: 7003 }] });
  }

  // --- Firebase Hosting ----------------------------------------------------------------------------------------------

  private firebaseRoute(
    method: string,
    url: URL,
    json: () => Record<string, unknown>,
    res: ServerResponse,
  ): void {
    const path = url.pathname.replace('/firebase/v1beta1', '');
    let match: RegExpExecArray | null;
    if ((match = /^\/projects\/([a-z0-9-]+)\/sites$/.exec(path)) !== null) {
      const project = match[1] ?? '';
      const sites = this.sites.get(project) ?? new Set<string>();
      this.sites.set(project, sites);
      if (method === 'GET') {
        this.send(res, 200, {
          sites: [...sites].map((site) => ({ name: `projects/${project}/sites/${site}` })),
        });
        return;
      }
      const siteId = url.searchParams.get('siteId') ?? '';
      if (sites.has(siteId) || this.foreignSites.has(siteId)) {
        this.send(res, 409, { error: { status: 'ALREADY_EXISTS' } });
        return;
      }
      sites.add(siteId);
      this.send(res, 200, { name: `projects/${project}/sites/${siteId}` });
      return;
    }
    if ((match = /^\/projects\/([a-z0-9-]+)\/sites\/([a-z0-9-]+)$/.exec(path)) !== null) {
      const ours = this.sites.get(match[1] ?? '')?.has(match[2] ?? '') === true;
      if (method === 'DELETE') {
        if (ours) this.sites.get(match[1] ?? '')?.delete(match[2] ?? '');
        this.send(res, ours ? 200 : 404, ours ? {} : { error: { status: 'NOT_FOUND' } });
        return;
      }
      if (ours) this.send(res, 200, { name: path.slice(1) });
      else
        this.send(res, this.foreignSites.has(match[2] ?? '') ? 403 : 404, { error: { status: 'NOT_FOUND' } });
      return;
    }
    if (
      (match = /^\/projects\/([a-z0-9-]+)\/sites\/([a-z0-9-]+)\/customDomains\/?([a-z0-9.-]*)$/.exec(
        path,
      )) !== null
    ) {
      const site = match[2] ?? '';
      if (method === 'POST') {
        const domain = url.searchParams.get('customDomainId') ?? '';
        const key = `${site}/${domain}`;
        if (this.domains.has(key)) {
          this.send(res, 409, { error: { status: 'ALREADY_EXISTS' } });
          return;
        }
        this.domains.set(key, this.newDomain());
        this.send(res, 200, { name: `operations/${hex(4)}` });
        return;
      }
      const domain = this.domains.get(`${site}/${match[3] ?? ''}`);
      if (domain === undefined) {
        this.send(res, 404, { error: { status: 'NOT_FOUND' } });
        return;
      }
      if (method === 'DELETE') {
        this.domains.delete(`${site}/${match[3] ?? ''}`);
        this.send(res, 200, { name: `operations/${hex(4)}` });
        return;
      }
      this.send(res, 200, {
        hostState: domain.hostState,
        ownershipState: domain.ownershipState,
        requiredDnsUpdates: { desired: [{ domainName: match[3], records: domain.desired }] },
        cert: { state: domain.certState },
      });
      return;
    }
    if ((match = /^\/sites\/([a-z0-9-]+)\/versions$/.exec(path)) !== null && method === 'POST') {
      const body = json();
      const name = `sites/${match[1]}/versions/${hex(8)}`;
      this.versions.set(name, {
        site: match[1] ?? '',
        config: body.config,
        labels: (body.labels ?? {}) as Record<string, string>,
        files: {},
      });
      this.send(res, 200, { name, status: 'CREATED' });
      return;
    }
    if ((match = /^\/(sites\/[a-z0-9-]+\/versions\/[0-9a-f]+):populateFiles$/.exec(path)) !== null) {
      const version = this.versions.get(match[1] ?? '');
      const files = (json().files ?? {}) as Record<string, string>;
      if (version === undefined) {
        this.send(res, 404);
        return;
      }
      version.files = files;
      const required = [...new Set(Object.values(files))].filter((hash) => !this.blobs.has(hash));
      this.send(res, 200, {
        uploadRequiredHashes: required,
        uploadUrl: `${this.base}/upload/${match[1]}:files`,
      });
      return;
    }
    if ((match = /^\/(sites\/[a-z0-9-]+\/versions\/[0-9a-f]+)$/.exec(path)) !== null && method === 'PATCH') {
      this.send(res, 200, { name: match[1], status: 'FINALIZED' });
      return;
    }
    if ((match = /^\/sites\/([a-z0-9-]+)\/releases$/.exec(path)) !== null) {
      const site = match[1] ?? '';
      const list = this.releases.get(site) ?? [];
      this.releases.set(site, list);
      if (method === 'GET') {
        const latest = list.at(-1);
        this.send(
          res,
          200,
          latest === undefined ? {} : { releases: [{ version: { labels: latest.labels } }] },
        );
        return;
      }
      const version = this.versions.get(url.searchParams.get('versionName') ?? '');
      if (version === undefined) {
        this.send(res, 400, { error: { status: 'INVALID_ARGUMENT' } });
        return;
      }
      const files = new Map<string, Buffer>();
      for (const [file, hash] of Object.entries(version.files)) {
        const blob = this.blobs.get(hash);
        if (blob !== undefined) files.set(file, gunzipSync(blob));
      }
      list.push({ labels: version.labels, files });
      this.send(res, 200, { name: `sites/${site}/releases/${hex(4)}` });
      return;
    }
    this.send(res, 404, { error: { status: 'NOT_FOUND' } });
  }

  private uploadRoute(method: string, url: URL, raw: Buffer, res: ServerResponse): void {
    const hash = url.pathname.split('/').at(-1) ?? '';
    if (method !== 'POST' || !/^[0-9a-f]{64}$/.test(hash)) {
      this.send(res, 404);
      return;
    }
    this.blobs.set(hash, raw);
    this.send(res, 200, {});
  }

  /** O que foi publicado por último num site: os arquivos (descomprimidos), a configuração e os rótulos. */
  latestRelease(site: string): { labels: Record<string, string>; files: Map<string, Buffer> } | undefined {
    return this.releases.get(site)?.at(-1);
  }

  /** A configuração da versão publicada por último num site. */
  latestConfig(site: string): unknown {
    const labels = this.latestRelease(site)?.labels;
    const version = [...this.versions.values()].reverse().find((v) => v.site === site && v.labels === labels);
    return version?.config;
  }

  // --- Compute, Storage, Run, Secret Manager --------------------------------------------------------------------------

  private computeRoute(method: string, url: URL, res: ServerResponse): void {
    const instance =
      /^\/compute\/v1\/projects\/([a-z0-9-]+)\/zones\/([a-z0-9-]+)\/instances\/([a-z0-9-]+)(\/stop|\/start)?$/.exec(
        url.pathname,
      );
    if (instance !== null) {
      const key = `${instance[1]}/${instance[2]}/${instance[3]}`;
      const vm = this.instances.get(key);
      if (vm === undefined) {
        this.send(res, 404, { error: { status: 'NOT_FOUND' } });
        return;
      }
      if (instance[4] === undefined && method === 'GET') {
        const shown = vm.status;
        // A operação assíncrona termina na consulta seguinte.
        if (vm.status === 'STOPPING') vm.status = 'TERMINATED';
        if (vm.status === 'STAGING') vm.status = 'RUNNING';
        this.send(res, 200, { name: instance[3], status: shown });
        return;
      }
      if (method === 'POST' && instance[4] === '/stop') vm.status = 'STOPPING';
      else if (method === 'POST' && instance[4] === '/start') vm.status = 'STAGING';
      else {
        this.send(res, 404);
        return;
      }
      this.send(res, 200, { name: `operation-${hex(4)}`, status: 'RUNNING' });
      return;
    }
    const match =
      /^\/compute\/v1\/projects\/([a-z0-9-]+)\/zones\/([a-z0-9-]+)\/instances\/([a-z0-9-]+)\/getGuestAttributes$/.exec(
        url.pathname,
      );
    const attributes =
      match === null ? undefined : this.guestAttributes.get(`${match[1]}/${match[2]}/${match[3]}`);
    if (attributes === undefined || attributes.size === 0) {
      this.send(res, 404, { error: { status: 'NOT_FOUND' } });
      return;
    }
    this.send(res, 200, {
      queryValue: { items: [...attributes].map(([key, value]) => ({ namespace: 'verax', key, value })) },
    });
  }

  private storageRoute(url: URL, res: ServerResponse): void {
    const match = /^\/storage\/storage\/v1\/b\/([a-z0-9._-]+)\/o\/(.+)$/.exec(url.pathname);
    const object =
      match === null ? undefined : this.objects.get(`${match[1]}/${decodeURIComponent(match[2] ?? '')}`);
    if (object === undefined || url.searchParams.get('alt') !== 'media') {
      this.send(res, 404, { error: { status: 'NOT_FOUND' } });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': object.length });
    res.end(object);
  }

  private runRoute(method: string, url: URL, json: () => Record<string, unknown>, res: ServerResponse): void {
    let match: RegExpExecArray | null;
    if (
      (match = /^\/run\/v2\/(projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+):run$/.exec(
        url.pathname,
      )) !== null &&
      method === 'POST'
    ) {
      const overrides = json().overrides as {
        containerOverrides: { env: { name: string; value: string }[] }[];
      };
      const name = `cp-terraform-${hex(3)}`;
      this.executions.set(name, { state: 'running', env: overrides.containerOverrides[0]?.env ?? [] });
      this.send(res, 200, {
        name: `${match[1]}/operations/${hex(4)}`,
        metadata: { name: `${match[1]}/executions/${name}` },
      });
      return;
    }
    if ((match = /\/executions\/([a-z0-9-]+)$/.exec(url.pathname)) !== null) {
      const execution = this.executions.get(match[1] ?? '');
      if (execution === undefined) {
        this.send(res, 404, { error: { status: 'NOT_FOUND' } });
        return;
      }
      const done = execution.state !== 'running';
      this.send(res, 200, {
        ...(done ? { completionTime: '2026-11-05T12:00:00Z' } : {}),
        succeededCount: execution.state === 'succeeded' ? 1 : 0,
        failedCount: execution.state === 'failed' ? 1 : 0,
      });
      return;
    }
    this.send(res, 404);
  }

  private secretsRoute(
    method: string,
    url: URL,
    json: () => Record<string, unknown>,
    res: ServerResponse,
  ): void {
    let match: RegExpExecArray | null;
    if (
      (match = /^\/secrets\/v1\/projects\/([a-z0-9-]+)\/secrets\/([a-z0-9-]+):addVersion$/.exec(
        url.pathname,
      )) !== null &&
      method === 'POST'
    ) {
      const data = (json().payload as { data?: string } | undefined)?.data ?? '';
      const key = `${match[1]}/${match[2]}`;
      const list = this.secretVersions.get(key) ?? [];
      list.push({ payload: Buffer.from(data, 'base64').toString('utf8'), state: 'ENABLED' });
      this.secretVersions.set(key, list);
      this.send(res, 200, {
        name: `projects/${match[1]}/secrets/${match[2]}/versions/${list.length}`,
        state: 'ENABLED',
      });
      return;
    }
    if (
      (match = /^\/secrets\/v1\/projects\/([a-z0-9-]+)\/secrets\/([a-z0-9-]+)\/versions\/latest$/.exec(
        url.pathname,
      )) !== null
    ) {
      const latest = this.secretVersions.get(`${match[1]}/${match[2]}`)?.at(-1);
      if (latest === undefined) this.send(res, 404, { error: { status: 'NOT_FOUND' } });
      else this.send(res, 200, { name: url.pathname, state: latest.state });
      return;
    }
    if (
      (match = /^\/secrets\/v1\/projects\/([a-z0-9-]+)\/secrets\/([a-z0-9-]+)\/versions$/.exec(
        url.pathname,
      )) !== null &&
      method === 'GET'
    ) {
      const list = this.secretVersions.get(`${match[1]}/${match[2]}`);
      if (list === undefined) {
        this.send(res, 404, { error: { status: 'NOT_FOUND' } });
        return;
      }
      this.send(res, 200, {
        versions: list
          .map((version, index) => ({
            name: `projects/${match?.[1]}/secrets/${match?.[2]}/versions/${index + 1}`,
            state: version.state,
          }))
          .reverse(),
      });
      return;
    }
    if (
      (match =
        /^\/secrets\/v1\/projects\/([a-z0-9-]+)\/secrets\/([a-z0-9-]+)\/versions\/([0-9]+):destroy$/.exec(
          url.pathname,
        )) !== null &&
      method === 'POST'
    ) {
      const version = this.secretVersions.get(`${match[1]}/${match[2]}`)?.[Number(match[3]) - 1];
      if (version === undefined) {
        this.send(res, 404, { error: { status: 'NOT_FOUND' } });
        return;
      }
      if (version.state === 'DESTROYED') {
        this.send(res, 400, { error: { status: 'FAILED_PRECONDITION' } });
        return;
      }
      version.state = 'DESTROYED';
      version.payload = '';
      this.send(res, 200, { name: url.pathname, state: 'DESTROYED' });
      return;
    }
    this.send(res, 404);
  }
}
