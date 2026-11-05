import type { AppConfig } from '../common/config/config.module.js';
import type { EnvKey } from '../common/config/env.schema.js';
import { CloudflareApi, CLOUDFLARE_API_BASE } from './cloudflare-api.js';
import { RELEASE_PUBLIC_KEYS } from './release-keys.js';
import { type AccessTokenSource, GoogleAccessTokenSource } from './cloud-http.js';
import {
  ComputeApi,
  FirebaseHostingApi,
  GOOGLE_ENDPOINTS,
  type GoogleEndpoints,
  type JobRef,
  IamCredentialsApi,
  RunJobsApi,
  SecretVersionsApi,
  StorageApi,
} from './google-apis.js';

/** O que o provisionamento precisa da configuração, já conferido (plano §2.5, grupos "Provisionamento" e "Cloudflare"). */
export interface ProvisioningSettings {
  nodesProject: string;
  nodesRegion: string;
  nodesZone: string;
  tfstateBucket: string;
  /** O Job `cp-terraform` mora no projeto e na região do plano de controle (os mesmos das filas, run.tf). */
  job: JobRef;
  releaseBucket: string;
  nodeRelease: string;
  mailFromNodes: string;
  imagesRepository: string;
  supportEmail: string;
  cloudflare: { accountId: string; zoneId: string; apiToken: string; zoneName: string };
  panelDomainSuffix: string;
  apiDomainPrefix: string;
  firebaseProjects: readonly string[];
}

export type ProvisioningSettingsResult =
  { ready: true; settings: ProvisioningSettings } | { ready: false; missing: readonly string[] };

/** As variáveis sem as quais o `preflight` para com `provisioning_disabled` (só os nomes vão ao log). */
const REQUIRED: readonly EnvKey[] = [
  'NODES_PROJECT_ID',
  'NODES_REGION',
  'NODES_ZONE',
  'TFSTATE_BUCKET',
  'TERRAFORM_JOB_NAME',
  'TASKS_PROJECT_ID',
  'TASKS_LOCATION',
  'RELEASE_BUCKET',
  'NODE_RELEASE',
  'MAIL_FROM_NODES',
  'BOOTSTRAP_SUPPORT_EMAIL',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'FIREBASE_PANEL_PROJECTS',
];

/**
 * A configuração do provisionamento, ou o que falta. Com `PROVISIONING_ENABLED=false` (o padrão até existir o projeto
 * dos nós), nada está pronto. A partida do cp-worker já recusa o grupo incompleto com o provisionamento ligado
 * (`env.schema.ts`); a conferência aqui é a do passo, que nunca deixa um valor ausente chegar a uma chamada.
 */
export function resolveProvisioningSettings(config: AppConfig): ProvisioningSettingsResult {
  if (!config.PROVISIONING_ENABLED) return { ready: false, missing: ['PROVISIONING_ENABLED'] };
  const missing = REQUIRED.filter((key) => {
    const value = config[key];
    return value === undefined || (Array.isArray(value) && value.length === 0);
  });
  const c = config;
  if (
    missing.length > 0 ||
    c.NODES_PROJECT_ID === undefined ||
    c.NODES_REGION === undefined ||
    c.NODES_ZONE === undefined ||
    c.TFSTATE_BUCKET === undefined ||
    c.TERRAFORM_JOB_NAME === undefined ||
    c.TASKS_PROJECT_ID === undefined ||
    c.TASKS_LOCATION === undefined ||
    c.RELEASE_BUCKET === undefined ||
    c.NODE_RELEASE === undefined ||
    c.MAIL_FROM_NODES === undefined ||
    c.BOOTSTRAP_SUPPORT_EMAIL === undefined ||
    c.CLOUDFLARE_API_TOKEN === undefined ||
    c.CLOUDFLARE_ACCOUNT_ID === undefined ||
    c.CLOUDFLARE_ZONE_ID === undefined ||
    c.FIREBASE_PANEL_PROJECTS === undefined
  ) {
    return { ready: false, missing };
  }
  return {
    ready: true,
    settings: {
      nodesProject: c.NODES_PROJECT_ID,
      nodesRegion: c.NODES_REGION,
      nodesZone: c.NODES_ZONE,
      tfstateBucket: c.TFSTATE_BUCKET,
      job: { project: c.TASKS_PROJECT_ID, region: c.TASKS_LOCATION, job: c.TERRAFORM_JOB_NAME },
      releaseBucket: c.RELEASE_BUCKET,
      nodeRelease: c.NODE_RELEASE,
      mailFromNodes: c.MAIL_FROM_NODES,
      imagesRepository: c.NODE_IMAGES_REPOSITORY,
      supportEmail: c.BOOTSTRAP_SUPPORT_EMAIL,
      cloudflare: {
        accountId: c.CLOUDFLARE_ACCOUNT_ID,
        zoneId: c.CLOUDFLARE_ZONE_ID,
        apiToken: c.CLOUDFLARE_API_TOKEN,
        zoneName: c.CLOUDFLARE_ZONE_NAME,
      },
      panelDomainSuffix: c.PANEL_DOMAIN_SUFFIX,
      apiDomainPrefix: c.API_DOMAIN_PREFIX,
      firebaseProjects: c.FIREBASE_PANEL_PROJECTS,
    },
  };
}

/** A API do nó e o painel do cliente, pela internet (o túnel e o Firebase), para o passo `node.health`. */
export interface TenantProbe {
  /** `GET <apiOrigin>/health` e `/health/ready` com 200. */
  apiHealthy(apiOrigin: string): Promise<boolean>;
  /** O painel no endereço padrão do site (`https://<site>.web.app`) responde com `Strict-Transport-Security`. */
  panelServesHsts(siteOrigin: string): Promise<boolean>;
}

const PROBE_TIMEOUT_MS = 10_000;

async function probe(url: string): Promise<Response | undefined> {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    await response.body?.cancel();
    return response;
  } catch {
    return undefined;
  }
}

/** Sem credencial nenhuma: são os mesmos endereços públicos que o cliente vai abrir. */
export class HttpsTenantProbe implements TenantProbe {
  async apiHealthy(apiOrigin: string): Promise<boolean> {
    for (const path of ['/health', '/health/ready']) {
      const response = await probe(`${apiOrigin}${path}`);
      if (response?.status !== 200) return false;
    }
    return true;
  }

  async panelServesHsts(siteOrigin: string): Promise<boolean> {
    const response = await probe(`${siteOrigin}/`);
    return response?.status === 200 && (response.headers.get('strict-transport-security') ?? '') !== '';
  }
}

/** Os clientes das APIs externas que os passos usam, montados uma vez por processo. */
export interface ProvisioningApis {
  /** O cliente do Cloudflare com o token da configuração (só existe com o provisionamento configurado). */
  cloudflare(settings: ProvisioningSettings): CloudflareApi;
  firebase: FirebaseHostingApi;
  compute: ComputeApi;
  storage: StorageApi;
  runJobs: RunJobsApi;
  secrets: SecretVersionsApi;
  /** A assinatura do link da exportação (CP-11), pela conta `EXPORT_SIGNER_SA_EMAIL`. */
  iam: IamCredentialsApi;
  /**
   * O endereço do Cloud Storage para o link assinado e o `fetch` que confere o objeto por ele (sem token: o link é a
   * credencial). Em produção, `https://storage.googleapis.com`.
   */
  signedStorage: { base: string; fetchFn: typeof fetch };
  probe: TenantProbe;
  /** As chaves públicas de release com que o manifesto é conferido (as do repositório; outras só nos testes). */
  releaseKeys: Readonly<Record<string, string>>;
}

export const PROVISIONING_APIS = Symbol('PROVISIONING_APIS');

/** Só nos testes: os endereços de um servidor falso em 127.0.0.1, o token falso e a sonda em memória. */
export interface ProvisioningApiOptions {
  fetchFn?: typeof fetch;
  googleEndpoints?: GoogleEndpoints;
  cloudflareBase?: string;
  accessTokens?: AccessTokenSource;
  probe?: TenantProbe;
  releaseKeys?: Readonly<Record<string, string>>;
}

export function createProvisioningApis(options: ProvisioningApiOptions = {}): ProvisioningApis {
  const fetchFn = options.fetchFn ?? fetch;
  const endpoints = options.googleEndpoints ?? GOOGLE_ENDPOINTS;
  const tokens = options.accessTokens ?? new GoogleAccessTokenSource();
  const cloudflareBase = options.cloudflareBase ?? CLOUDFLARE_API_BASE;
  let cloudflare: { token: string; api: CloudflareApi } | undefined;
  return {
    cloudflare(settings) {
      if (cloudflare?.token !== settings.cloudflare.apiToken) {
        cloudflare = {
          token: settings.cloudflare.apiToken,
          api: new CloudflareApi(settings.cloudflare, fetchFn, cloudflareBase),
        };
      }
      return cloudflare.api;
    },
    firebase: new FirebaseHostingApi(tokens, fetchFn, endpoints),
    compute: new ComputeApi(tokens, fetchFn, endpoints.compute),
    storage: new StorageApi(tokens, fetchFn, endpoints.storage),
    runJobs: new RunJobsApi(tokens, fetchFn, endpoints.run),
    secrets: new SecretVersionsApi(tokens, fetchFn, endpoints.secretManager),
    iam: new IamCredentialsApi(tokens, fetchFn, endpoints.iamCredentials),
    signedStorage: { base: endpoints.storage, fetchFn },
    probe: options.probe ?? new HttpsTenantProbe(),
    releaseKeys: options.releaseKeys ?? RELEASE_PUBLIC_KEYS,
  };
}
