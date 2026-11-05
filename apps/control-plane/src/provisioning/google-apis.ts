import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  type AccessTokenSource,
  bearer,
  type CloudResponse,
  type CloudService,
  cloudRequest,
  errorReasonOf,
  expectOk,
  invalidResponse,
  jsonOf,
} from './cloud-http.js';

/**
 * Os endereços das APIs do Google que o provisionamento chama. Em produção, os de baixo; nos testes, um servidor falso
 * em 127.0.0.1 (nunca pelo ambiente: um endereço trocado por variável levaria o token da conta do serviço junto).
 */
export interface GoogleEndpoints {
  firebaseHosting: string;
  /** A origem aceita no `uploadUrl` que o `populateFiles` devolve (o token só vai para ela). */
  firebaseUpload: string;
  compute: string;
  storage: string;
  run: string;
  secretManager: string;
  /** IAM Service Account Credentials (`signBlob`), para o link assinado da exportação (CP-11). */
  iamCredentials: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  firebaseHosting: 'https://firebasehosting.googleapis.com/v1beta1',
  firebaseUpload: 'https://upload-firebasehosting.googleapis.com',
  compute: 'https://compute.googleapis.com/compute/v1',
  storage: 'https://storage.googleapis.com',
  run: 'https://run.googleapis.com/v2',
  secretManager: 'https://secretmanager.googleapis.com/v1',
  iamCredentials: 'https://iamcredentials.googleapis.com/v1',
};

/** A base comum: o token do Google em cada chamada e o serviço no erro. */
class GoogleApi {
  constructor(
    protected readonly service: CloudService,
    protected readonly tokens: AccessTokenSource,
    protected readonly fetchFn: typeof fetch,
  ) {}

  protected async call(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    operation: string,
    url: string,
    options: { json?: unknown; bytes?: Uint8Array; contentType?: string; maxResponseBytes?: number } = {},
  ): Promise<CloudResponse> {
    return cloudRequest(this.fetchFn, this.service, operation, {
      method,
      url,
      authorization: await bearer(this.tokens),
      ...options,
    });
  }

  protected parse<T extends z.ZodType>(operation: string, response: CloudResponse, schema: T): z.infer<T> {
    const parsed = schema.safeParse(
      jsonOf(this.service, operation, expectOk(this.service, operation, response)),
    );
    if (!parsed.success) throw invalidResponse(this.service, operation);
    return parsed.data;
  }
}

// --- Firebase Hosting ------------------------------------------------------------------------------------------

const siteListSchema = z.object({
  sites: z
    .array(z.object({ name: z.string().max(300) }))
    .max(1000)
    .optional(),
  nextPageToken: z.string().max(2000).optional(),
});
const versionSchema = z.object({
  name: z.string().regex(/^sites\/[a-z0-9-]{1,63}\/versions\/[A-Za-z0-9_-]{1,100}$/),
});
const populateSchema = z.object({
  uploadRequiredHashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .max(5000)
    .optional(),
  uploadUrl: z.string().max(2000).optional(),
});
const releaseListSchema = z.object({
  releases: z
    .array(
      z.object({ version: z.object({ labels: z.record(z.string(), z.string()).optional() }).optional() }),
    )
    .max(10)
    .optional(),
});

const dnsRecordSchema = z.object({
  domainName: z.string().max(253),
  type: z.string().max(10),
  rdata: z.string().max(2048),
  requiredAction: z.string().max(20).optional(),
});
const dnsRecordSetSchema = z.object({
  domainName: z.string().max(253).optional(),
  records: z.array(dnsRecordSchema).max(50).optional(),
});
const dnsUpdatesSchema = z.object({ desired: z.array(dnsRecordSetSchema).max(50).optional() }).optional();

const customDomainSchema = z.object({
  hostState: z.string().max(40).optional(),
  ownershipState: z.string().max(40).optional(),
  requiredDnsUpdates: dnsUpdatesSchema,
  cert: z
    .object({
      state: z.string().max(40).optional(),
      verification: z.object({ dns: dnsUpdatesSchema }).optional(),
    })
    .optional(),
});

/** Um domínio próprio de um site, como o Firebase o descreve agora (só o que o provisionamento lê). */
export interface CustomDomainStatus {
  hostState?: string;
  ownershipState?: string;
  certState?: string;
  /** Os registros que o Firebase pede (`requiredDnsUpdates.desired` e `cert.verification.dns.desired`). */
  desiredRecords: { domainName: string; type: string; rdata: string; requiredAction?: string }[];
}

/** A configuração do site no formato da API (`VersionConfig`), já com a API do cliente. */
export interface HostingConfig {
  headers: { glob: string; headers: Record<string, string> }[];
  rewrites: { glob: string; path: string }[];
}

/**
 * Firebase Hosting REST v1beta1 (https://firebase.google.com/docs/reference/hosting/rest): sites, versões, liberações e
 * domínios próprios, com o `firebasehosting.admin` do cp-worker em cada projeto do pool. A publicação é a lógica de
 * `scripts/firebase-hosting-deploy.mjs` em TypeScript (gzip sem data, hash do comprimido, só os que faltam).
 */
export class FirebaseHostingApi extends GoogleApi {
  constructor(
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
    private readonly endpoints: Pick<
      GoogleEndpoints,
      'firebaseHosting' | 'firebaseUpload'
    > = GOOGLE_ENDPOINTS,
  ) {
    super('firebase', tokens, fetchFn);
  }

  /** Quantos sites o projeto tem (o padrão do projeto conta; o limite é 36 por projeto). */
  async countSites(project: string): Promise<number> {
    let count = 0;
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL(`${this.endpoints.firebaseHosting}/projects/${project}/sites`);
      url.searchParams.set('pageSize', '100');
      if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
      const result = this.parse(
        'sites_list',
        await this.call('GET', 'sites_list', url.toString()),
        siteListSchema,
      );
      count += result.sites?.length ?? 0;
      pageToken = result.nextPageToken === '' ? undefined : result.nextPageToken;
      if (pageToken === undefined) return count;
    }
    return count;
  }

  /** O site existe neste projeto? 404 (ou 403, id de outro projeto) é "não". */
  async siteExists(project: string, siteId: string): Promise<boolean> {
    const response = await this.call(
      'GET',
      'site_get',
      `${this.endpoints.firebaseHosting}/projects/${project}/sites/${siteId}`,
    );
    if (response.status === 404 || response.status === 403) return false;
    expectOk(this.service, 'site_get', response);
    return true;
  }

  /** Cria o site. `created: false` com 409: o id já existe (deste projeto ou de outro; quem chama confere). */
  async createSite(project: string, siteId: string): Promise<{ created: boolean }> {
    const url = new URL(`${this.endpoints.firebaseHosting}/projects/${project}/sites`);
    url.searchParams.set('siteId', siteId);
    const response = await this.call('POST', 'site_create', url.toString(), { json: {} });
    if (response.status === 409) return { created: false };
    expectOk(this.service, 'site_create', response);
    return { created: true };
  }

  /** Os rótulos da versão da liberação mais recente do site (para não publicar duas vezes o mesmo bundle). */
  async latestReleaseLabels(siteId: string): Promise<Record<string, string> | undefined> {
    const url = new URL(`${this.endpoints.firebaseHosting}/sites/${siteId}/releases`);
    url.searchParams.set('pageSize', '1');
    const result = this.parse(
      'releases_list',
      await this.call('GET', 'releases_list', url.toString()),
      releaseListSchema,
    );
    return result.releases?.[0]?.version?.labels;
  }

  /** Publica os arquivos com a configuração: versão, arquivos que faltam, finalização e liberação. */
  async publish(
    siteId: string,
    files: ReadonlyMap<string, Buffer>,
    config: HostingConfig,
    labels: Record<string, string>,
  ): Promise<{ uploaded: number }> {
    const manifest: Record<string, string> = {};
    const blobs = new Map<string, Buffer>();
    for (const [path, content] of files) {
      const compressed = gzipSync(content, { level: 9 });
      const hash = createHash('sha256').update(compressed).digest('hex');
      manifest[path] = hash;
      blobs.set(hash, compressed);
    }
    const version = this.parse(
      'version_create',
      await this.call(
        'POST',
        'version_create',
        `${this.endpoints.firebaseHosting}/sites/${siteId}/versions`,
        {
          json: { config, labels },
        },
      ),
      versionSchema,
    );
    const populated = this.parse(
      'version_populate',
      await this.call(
        'POST',
        'version_populate',
        `${this.endpoints.firebaseHosting}/${version.name}:populateFiles`,
        {
          json: { files: manifest },
        },
      ),
      populateSchema,
    );
    const required = populated.uploadRequiredHashes ?? [];
    if (required.length > 0) {
      const uploadUrl = populated.uploadUrl ?? '';
      // O token só vai para o endereço de envio do próprio Firebase.
      if (!uploadUrl.startsWith(`${this.endpoints.firebaseUpload}/`))
        throw invalidResponse(this.service, 'version_populate');
      for (const hash of required) {
        const blob = blobs.get(hash);
        if (blob === undefined) throw invalidResponse(this.service, 'version_populate');
        expectOk(
          this.service,
          'file_upload',
          await this.call('POST', 'file_upload', `${uploadUrl}/${hash}`, { bytes: blob }),
        );
      }
    }
    const finalize = new URL(`${this.endpoints.firebaseHosting}/${version.name}`);
    finalize.searchParams.set('update_mask', 'status');
    expectOk(
      this.service,
      'version_finalize',
      await this.call('PATCH', 'version_finalize', finalize.toString(), { json: { status: 'FINALIZED' } }),
    );
    const release = new URL(`${this.endpoints.firebaseHosting}/sites/${siteId}/releases`);
    release.searchParams.set('versionName', version.name);
    expectOk(
      this.service,
      'release_create',
      await this.call('POST', 'release_create', release.toString(), { json: {} }),
    );
    return { uploaded: required.length };
  }

  /** Cria o domínio próprio do site. `created: false` com 409 (já existe). */
  async createCustomDomain(project: string, siteId: string, domain: string): Promise<{ created: boolean }> {
    const url = new URL(
      `${this.endpoints.firebaseHosting}/projects/${project}/sites/${siteId}/customDomains`,
    );
    url.searchParams.set('customDomainId', domain);
    const response = await this.call('POST', 'domain_create', url.toString(), { json: {} });
    if (response.status === 409) return { created: false };
    expectOk(this.service, 'domain_create', response);
    return { created: true };
  }

  async getCustomDomain(
    project: string,
    siteId: string,
    domain: string,
  ): Promise<CustomDomainStatus | undefined> {
    const response = await this.call(
      'GET',
      'domain_get',
      `${this.endpoints.firebaseHosting}/projects/${project}/sites/${siteId}/customDomains/${domain}`,
    );
    if (response.status === 404) return undefined;
    const parsed = this.parse('domain_get', response, customDomainSchema);
    const sets = [
      ...(parsed.requiredDnsUpdates?.desired ?? []),
      ...(parsed.cert?.verification?.dns?.desired ?? []),
    ];
    return {
      hostState: parsed.hostState,
      ownershipState: parsed.ownershipState,
      certState: parsed.cert?.state,
      desiredRecords: sets.flatMap((set) => set.records ?? []),
    };
  }

  /**
   * Apaga o domínio próprio do site (Exclusão 1, CP-11). Já ausente (404) conta como feito: devolve `false`. O Firebase
   * guarda o domínio apagado por um tempo antes de esquecê-lo, mas ele deixa de ser servido na hora.
   */
  async deleteCustomDomain(project: string, siteId: string, domain: string): Promise<boolean> {
    const response = await this.call(
      'DELETE',
      'domain_delete',
      `${this.endpoints.firebaseHosting}/projects/${project}/sites/${siteId}/customDomains/${domain}`,
    );
    if (response.status === 404) return false;
    expectOk(this.service, 'domain_delete', response);
    return true;
  }

  /** Apaga o site do painel (Exclusão 1, CP-11). Já ausente (404) conta como feito: devolve `false`. */
  async deleteSite(project: string, siteId: string): Promise<boolean> {
    const response = await this.call(
      'DELETE',
      'site_delete',
      `${this.endpoints.firebaseHosting}/projects/${project}/sites/${siteId}`,
    );
    if (response.status === 404) return false;
    expectOk(this.service, 'site_delete', response);
    return true;
  }
}

// --- Compute: guest attributes ----------------------------------------------------------------------------------

const guestAttributesSchema = z.object({
  queryValue: z
    .object({
      items: z
        .array(
          z.object({
            namespace: z.string().max(64).optional(),
            key: z.string().max(64),
            value: z.string().max(1024),
          }),
        )
        .max(100)
        .optional(),
    })
    .optional(),
});

const instanceSchema = z.object({ status: z.string().regex(/^[A-Z_]{1,40}$/) });

/**
 * `instances.getGuestAttributes`, `instances.get`, `instances.stop` e `instances.start` com o `cpNodeLifecycle` do
 * cp-worker (só VMs `vx-*`).
 */
export class ComputeApi extends GoogleApi {
  constructor(
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = GOOGLE_ENDPOINTS.compute,
  ) {
    super('compute', tokens, fetchFn);
  }

  /** Os atributos do espaço `verax/` (chave sem o espaço → valor). Sem atributo ainda (404): vazio. */
  async guestAttributes(project: string, zone: string, instance: string): Promise<Map<string, string>> {
    const url = new URL(
      `${this.base}/projects/${project}/zones/${zone}/instances/${instance}/getGuestAttributes`,
    );
    url.searchParams.set('queryPath', 'verax/');
    const response = await this.call('GET', 'guest_attributes', url.toString());
    if (response.status === 404) return new Map();
    const parsed = this.parse('guest_attributes', response, guestAttributesSchema);
    const values = new Map<string, string>();
    for (const item of parsed.queryValue?.items ?? []) {
      if (item.namespace === undefined || item.namespace === 'verax') values.set(item.key, item.value);
    }
    return values;
  }

  /** O estado da VM (`RUNNING`, `STOPPING`, `TERMINATED`...), ou `undefined` se ela não existe (404). */
  async instanceStatus(project: string, zone: string, instance: string): Promise<string | undefined> {
    const response = await this.call(
      'GET',
      'instance_get',
      `${this.base}/projects/${project}/zones/${zone}/instances/${instance}`,
    );
    if (response.status === 404) return undefined;
    return this.parse('instance_get', response, instanceSchema).status;
  }

  /**
   * Para ou liga a VM (`instances.stop`/`instances.start`, o `cpNodeLifecycle` do cp-worker, só nas VMs `vx-*`). A
   * operação é assíncrona: quem chama consulta o estado depois. O disco e os snapshots ficam.
   */
  async setPower(project: string, zone: string, instance: string, action: 'stop' | 'start'): Promise<void> {
    const operation = action === 'stop' ? 'instance_stop' : 'instance_start';
    expectOk(
      this.service,
      operation,
      await this.call(
        'POST',
        operation,
        `${this.base}/projects/${project}/zones/${zone}/instances/${instance}/${action}`,
        { json: {} },
      ),
    );
  }
}

// --- Cloud Storage -------------------------------------------------------------------------------------------------

/** Leitura de objetos (o manifesto e o bundle no bucket de releases; o `outputs.json` em `runs/`). */
export class StorageApi extends GoogleApi {
  constructor(
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = GOOGLE_ENDPOINTS.storage,
  ) {
    super('storage', tokens, fetchFn);
  }

  /** O conteúdo do objeto, até `maxBytes`; `undefined` se não existe. */
  async read(bucket: string, object: string, maxBytes: number): Promise<Buffer | undefined> {
    const url = new URL(`${this.base}/storage/v1/b/${bucket}/o/${encodeURIComponent(object)}`);
    url.searchParams.set('alt', 'media');
    const response = await this.call('GET', 'object_read', url.toString(), { maxResponseBytes: maxBytes });
    if (response.status === 404) return undefined;
    return expectOk(this.service, 'object_read', response).body;
  }
}

// --- Cloud Run: o Job do Terraform ------------------------------------------------------------------------------

const EXECUTION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const operationSchema = z.object({
  metadata: z.object({ name: z.string().max(400) }).optional(),
});
const executionSchema = z.object({
  completionTime: z.string().max(64).optional(),
  succeededCount: z.number().int().min(0).optional(),
  failedCount: z.number().int().min(0).optional(),
  cancelledCount: z.number().int().min(0).optional(),
});

export type ExecutionState = 'running' | 'succeeded' | 'failed';

export interface JobRef {
  project: string;
  region: string;
  job: string;
}

/**
 * Cloud Run Admin API v2 (https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run):
 * `jobs.run` com `overrides` (o `cpJobRunner` do cp-worker: `run.jobs.runWithOverrides`) e `executions.get`. Sem o
 * `@google-cloud/run` que o plano sugeria (dependência nova não aprovada): duas chamadas REST bastam.
 */
export class RunJobsApi extends GoogleApi {
  constructor(
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = GOOGLE_ENDPOINTS.run,
  ) {
    super('run', tokens, fetchFn);
  }

  /** Dispara uma execução com as variáveis da vez; devolve o nome curto dela (o fim de `.../executions/<nome>`). */
  async run(job: JobRef, env: readonly { name: string; value: string }[]): Promise<string> {
    const operation = this.parse(
      'job_run',
      await this.call('POST', 'job_run', `${this.jobPath(job)}:run`, {
        json: { overrides: { containerOverrides: [{ env }] } },
      }),
      operationSchema,
    );
    const name = operation.metadata?.name ?? '';
    const prefix = `projects/${job.project}/locations/${job.region}/jobs/${job.job}/executions/`;
    const short = name.startsWith(prefix) ? name.slice(prefix.length) : '';
    if (!EXECUTION_NAME_PATTERN.test(short)) throw invalidResponse(this.service, 'job_run');
    return short;
  }

  /** Em andamento, concluída com sucesso ou com falha (cancelada conta como falha). */
  async executionState(job: JobRef, execution: string): Promise<ExecutionState> {
    if (!EXECUTION_NAME_PATTERN.test(execution)) throw new TypeError('nome de execução inválido');
    const parsed = this.parse(
      'execution_get',
      await this.call('GET', 'execution_get', `${this.jobPath(job)}/executions/${execution}`),
      executionSchema,
    );
    if (parsed.completionTime === undefined || parsed.completionTime === '') return 'running';
    return (parsed.succeededCount ?? 0) >= 1 &&
      (parsed.failedCount ?? 0) === 0 &&
      (parsed.cancelledCount ?? 0) === 0
      ? 'succeeded'
      : 'failed';
  }

  private jobPath(job: JobRef): string {
    return `${this.base}/projects/${job.project}/locations/${job.region}/jobs/${job.job}`;
  }
}

export function isExecutionName(value: string): boolean {
  return EXECUTION_NAME_PATTERN.test(value);
}

// --- Secret Manager -------------------------------------------------------------------------------------------------

const versionStateSchema = z.object({ state: z.string().max(40).optional() });
const accessedVersionSchema = z.object({
  payload: z.object({
    data: z
      .string()
      .max(48 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  }),
});

/**
 * Secret Manager REST v1, só o que o provisionamento precisa: gravar uma versão nos cofres do nó (o token do túnel e a
 * senha da caixa de envio, `secretVersionAdder`), ver o estado da versão mais nova do `admin-bootstrap` (`versions.get`,
 * do `secretVersionManager`), sem ler o conteúdo, e ler a senha da caixa de envio dos nós no cofre do plano de controle
 * (`cp-nodes-smtp-password`, `secretAccessor`).
 */
export class SecretVersionsApi extends GoogleApi {
  constructor(
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = GOOGLE_ENDPOINTS.secretManager,
  ) {
    super('secretmanager', tokens, fetchFn);
  }

  /** Grava uma versão nova com `value`. O valor só vai no corpo da requisição. */
  async addVersion(project: string, secretId: string, value: string): Promise<void> {
    const response = await this.call(
      'POST',
      'version_add',
      `${this.base}/projects/${project}/secrets/${secretId}:addVersion`,
      {
        json: { payload: { data: Buffer.from(value, 'utf8').toString('base64') } },
      },
    );
    expectOk(this.service, 'version_add', response);
  }

  /**
   * O conteúdo da versão `latest` (a criada por último), em UTF-8. Sem versão nenhuma (404) ou com a última desativada
   * ou destruída (`FAILED_PRECONDITION`), `undefined`. O conteúdo só sai daqui como valor de retorno: o erro de uma
   * resposta fora do formato não cita o corpo, e o `dataCrc32c` é ignorado (o TLS já confere a integridade).
   */
  async accessLatest(project: string, secretId: string): Promise<string | undefined> {
    const response = await this.call(
      'GET',
      'version_access',
      `${this.base}/projects/${project}/secrets/${secretId}/versions/latest:access`,
      { maxResponseBytes: 64 * 1024 },
    );
    if (response.status === 404) return undefined;
    if (response.status === 400 && errorReasonOf(response.body) === 'FAILED_PRECONDITION') return undefined;
    const data = this.parse('version_access', response, accessedVersionSchema).payload.data;
    return Buffer.from(data, 'base64').toString('utf8');
  }

  /** O estado da versão `latest` (`ENABLED`, `DISABLED`, `DESTROYED`); sem versão nenhuma (404), `undefined`. */
  async latestVersionState(project: string, secretId: string): Promise<string | undefined> {
    const response = await this.call(
      'GET',
      'version_get',
      `${this.base}/projects/${project}/secrets/${secretId}/versions/latest`,
    );
    if (response.status === 404) return undefined;
    return this.parse('version_get', response, versionStateSchema).state;
  }

  /**
   * As versões do cofre (o número e o estado, nunca o conteúdo), com `versions.list` (o `cpSecretVersionDestroyer` no
   * `credentials-key`, CP-11). Cofre inexistente (404): `undefined`.
   */
  async listVersions(project: string, secretId: string): Promise<SecretVersionInfo[] | undefined> {
    const versions: SecretVersionInfo[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(`${this.base}/projects/${project}/secrets/${secretId}/versions`);
      url.searchParams.set('pageSize', '100');
      if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
      const response = await this.call('GET', 'versions_list', url.toString());
      if (response.status === 404) return undefined;
      const parsed = this.parse('versions_list', response, versionListSchema);
      for (const version of parsed.versions ?? []) {
        const id = version.name.split('/').at(-1) ?? '';
        if (!version.name.startsWith(`projects/`) || !/^[0-9]{1,10}$/.test(id)) {
          throw invalidResponse(this.service, 'versions_list');
        }
        versions.push({ id, state: version.state ?? 'STATE_UNSPECIFIED' });
      }
      pageToken = parsed.nextPageToken === '' ? undefined : parsed.nextPageToken;
      if (pageToken === undefined) return versions;
    }
    throw invalidResponse(this.service, 'versions_list');
  }

  /** Destrói uma versão (permanente: o conteúdo some). Já destruída (400 `FAILED_PRECONDITION`) conta como feito. */
  async destroyVersion(project: string, secretId: string, versionId: string): Promise<void> {
    if (!/^[0-9]{1,10}$/.test(versionId)) throw new TypeError('versão inválida');
    const response = await this.call(
      'POST',
      'version_destroy',
      `${this.base}/projects/${project}/secrets/${secretId}/versions/${versionId}:destroy`,
      { json: {} },
    );
    if (response.status === 404) return;
    if (response.status === 400 && errorReasonOf(response.body) === 'FAILED_PRECONDITION') return;
    expectOk(this.service, 'version_destroy', response);
  }
}

export interface SecretVersionInfo {
  /** O número da versão (`1`, `2`...). */
  id: string;
  state: string;
}

const versionListSchema = z.object({
  versions: z
    .array(
      z.object({
        name: z.string().max(300),
        state: z
          .string()
          .regex(/^[A-Z_]{1,40}$/)
          .optional(),
      }),
    )
    .max(100)
    .optional(),
  nextPageToken: z.string().max(2000).optional(),
});

// --- IAM Service Account Credentials ---------------------------------------------------------------------------

const signBlobSchema = z.object({
  keyId: z.string().max(100).optional(),
  signedBlob: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

/**
 * `serviceAccounts.signBlob` (https://docs.cloud.google.com/iam/docs/reference/credentials/rest): a assinatura RSA
 * SHA-256 de um texto com a chave gerenciada pelo Google de uma conta de serviço, sem chave nenhuma fora do Google. É
 * o que assina o link de download da exportação (CP-11), com a conta `EXPORT_SIGNER_SA_EMAIL`.
 */
export class IamCredentialsApi extends GoogleApi {
  constructor(
    tokens: AccessTokenSource,
    fetchFn: typeof fetch = fetch,
    private readonly base: string = GOOGLE_ENDPOINTS.iamCredentials,
  ) {
    super('iamcredentials', tokens, fetchFn);
  }

  async signBlob(serviceAccount: string, payload: Buffer): Promise<Buffer> {
    const parsed = this.parse(
      'sign_blob',
      await this.call(
        'POST',
        'sign_blob',
        `${this.base}/projects/-/serviceAccounts/${encodeURIComponent(serviceAccount)}:signBlob`,
        { json: { payload: payload.toString('base64') } },
      ),
      signBlobSchema,
    );
    return Buffer.from(parsed.signedBlob, 'base64');
  }
}
