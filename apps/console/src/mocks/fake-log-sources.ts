import type {
  AwsLogBucketSource,
  AwsStackMismatchField,
  AwsStackView,
  CredentialKind,
  LogSourceCredentialView,
  LogSourceReport,
  LogSourceSpec,
  LogSourceStatus,
  LogSourceView,
  NodeSyncOverview,
  NodeSyncSourceCode,
  NodeSyncView,
  NodeUserView,
  ReadKeysView,
  TenantDetail,
  ValidationIssue,
} from '@/lib/api-types';
import { createNodeUser, fakeNodeUsers, nodeUsersOverview } from './fake-node-users';

/**
 * As fontes de log na API simulada do console (`/v1/admin/tenants/:id/node-sync` e `.../log-sources...`), em memória:
 * o nó de cada cliente (o que ele disse de si), as fontes com a revisão, os metadados da chave e o último relato do nó.
 * Imita `apps/control-plane/src/admin/admin-log-sources.*`: os códigos de recusa, o 400 com `details.issues`, a
 * situação de cada fonte e os blocos do que mandar ao cliente. A validação é só uma amostra (a de verdade é a da API).
 *
 * A chave colada nunca é guardada aqui: só os metadados (o tipo, a revisão, quando e por quem). Valores FICTÍCIOS: as
 * contas `111111111111`/`222222222222`, os IPs da faixa de documentação (203.0.113.0/24), e a impressão digital e o
 * commit montados por repetição. `simulateNodeSync` faz o papel da próxima sincronização do nó.
 */

/** O nó como o cp-admin o guarda (a situação "parado" é calculada na leitura). */
export type FakeNode = Omit<NodeSyncView, 'stale' | 'platformMismatch'>;

export interface FakeLogSource {
  spec: LogSourceSpec;
  state: 'active' | 'removed';
  revision: number;
  credential: LogSourceCredentialView | null;
  report: LogSourceReport | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface FakeNodeSync {
  node: FakeNode | null;
  generation: number;
  sources: Map<string, FakeLogSource>;
  /** Os usuários do cliente pedidos pelo console (`fake-node-users.ts`); ausente: nenhum. */
  users?: NodeUserView[];
}

export interface FakeLogSourcesState {
  /** Por cliente; um cliente sem entrada é o que nunca sincronizou e não tem fonte. */
  tenants: Map<string, FakeNodeSync>;
  /** O limite de operações do responsável esgotado: toda escrita responde 429. */
  rateLimited?: boolean;
  /** As contas (`<provedor>:<conta>`) que o cliente já cadastrou no painel: o nó recusa (`account_exists_panel`). */
  panelAccounts: Set<string>;
  /** O código com que o nó recusa a próxima chave (`credential_rejected_*`); sem ele, aceita. */
  rejectCredential?: NodeSyncSourceCode;
}

export interface FakeResponse {
  status: number;
  body: unknown;
}

const MINUTE = 60_000;
const OWNER = 'owner:responsavel@verax.example';
export const FAKE_VAULT_FINGERPRINT = '0f1e'.repeat(16);
export const FAKE_NODE_COMMIT = '1a2b3c4d'.repeat(5);
export const FAKE_NODE_SERVICE_ACCOUNT_ID = '100000000000000000001';
export const FAKE_EGRESS_IPS = ['203.0.113.10/32'];
const AUDIENCE = 'https://control.veraxsistemas.com.br/aws-reader';
const TEMPLATE_URL = '/v1/admin/aws-reader/verax-control-reader.yaml';
const STALE_AFTER_MS = 15 * MINUTE;
const MAX_SOURCES = 500;
/** O id da fonte: UUID em minúsculas. */
const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const CREDENTIAL_PROVIDERS: Readonly<Record<CredentialKind, LogSourceSpec['provider']>> = {
  cloudflare_api_token: 'cloudflare',
  aws_access_key: 'aws',
  gcp_service_account_key: 'gcp',
};

let sourceCounter = 0;

/** Um UUID fictício e previsível (o cp-admin usa `randomUUID`). */
function nextSourceId(): string {
  sourceCounter += 1;
  return `00000000-0000-4000-8000-${sourceCounter.toString(16).padStart(12, '0')}`;
}

function error(
  status: number,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): FakeResponse {
  return {
    status,
    body: { statusCode: status, message, code, ...(details === undefined ? {} : { details }) },
  };
}

function invalid(issues: ValidationIssue[]): FakeResponse {
  return error(400, 'Dados inválidos.', 'invalid_request', { issues });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** O nó de um cliente sincronizado agora, com o cofre pronto; `patch` muda o que o teste quiser. */
export function fakeNode(platform: 'gcp' | 'vm', now: Date, patch: Partial<FakeNode> = {}): FakeNode {
  return {
    lastSeenAt: new Date(now.getTime() - 2 * MINUTE).toISOString(),
    platform,
    commit: FAKE_NODE_COMMIT,
    capabilities: ['log_sources'],
    authKind: platform === 'gcp' ? 'gcp_identity' : 'node_key',
    nodeTenantId: '00000000-0000-4000-8000-0000000000aa',
    vaultReady: true,
    keyVersion: 1,
    fingerprint: FAKE_VAULT_FINGERPRINT,
    keySince: new Date(now.getTime() - 3 * 24 * 60 * MINUTE).toISOString(),
    serviceAccountId: platform === 'gcp' ? FAKE_NODE_SERVICE_ACCOUNT_ID : null,
    egressIps: [...FAKE_EGRESS_IPS],
    audience: AUDIENCE,
    error: null,
    ...patch,
  };
}

function appliedReport(id: string, revision: number, now: Date, provider: LogSourceSpec['provider']) {
  return {
    id,
    revision,
    outcome: 'applied' as const,
    code: null,
    credential: null,
    account: {
      status: 'active' as const,
      connection: 'connected' as const,
      connectionError: null,
      collectionError: null,
      ingestFrom:
        provider === 'aws' ? new Date(now.getTime() - 24 * 60 * MINUTE).toISOString().slice(0, 10) : null,
      lastEventAt: new Date(now.getTime() - 10 * MINUTE).toISOString(),
      lastCollectedAt: new Date(now.getTime() - 3 * MINUTE).toISOString(),
      checkRequestedAt: null,
    },
    reportedAt: new Date(now.getTime() - 2 * MINUTE).toISOString(),
  };
}

/**
 * O estado inicial, FICTÍCIO: o cliente ativo da Verax ("contrato-ativo") sincronizado, com uma conta AWS aplicada,
 * uma do Cloudflare com a chave recusada, uma AWS que o cliente já tinha no painel e uma removida; o cliente pago
 * ("cliente-demo-b") com o nó parado e uma fonte pendente. Os demais nunca sincronizaram.
 */
export function createFakeLogSources(now: Date): FakeLogSourcesState {
  const at = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE).toISOString();
  const base = { createdBy: OWNER, updatedBy: OWNER };
  // O nó do cliente ativo é da versão que recebe usuários; o do cliente parado, de antes dela.
  const active: FakeNodeSync = {
    node: fakeNode('gcp', now, { capabilities: ['log_sources', 'users'] }),
    generation: 6,
    sources: new Map(),
    users: fakeNodeUsers(now),
  };
  const aws = '00000000-0000-4000-8000-00000000a001';
  active.sources.set(aws, {
    spec: {
      provider: 'aws',
      accountId: '111111111111',
      regions: ['sa-east-1', 'us-east-1'],
      buckets: { cloudtrail: 'cliente-demo-trilha', guardduty: 'cliente-demo-guardduty' },
    },
    state: 'active',
    revision: 2,
    credential: null,
    report: appliedReport(aws, 2, now, 'aws'),
    createdAt: at(600),
    updatedAt: at(300),
    ...base,
  });
  const cloudflare = '00000000-0000-4000-8000-00000000a002';
  active.sources.set(cloudflare, {
    spec: {
      provider: 'cloudflare',
      accountId: 'cf000000000000000000000000000001',
      zones: ['exemplo.com.br'],
    },
    state: 'active',
    revision: 1,
    credential: {
      kind: 'cloudflare_api_token',
      revision: 1,
      keyVersion: 1,
      fingerprint: FAKE_VAULT_FINGERPRINT,
      submittedAt: at(120),
      submittedBy: OWNER,
      envelopeStored: false,
    },
    report: {
      ...appliedReport(cloudflare, 1, now, 'cloudflare'),
      credential: {
        revision: 1,
        outcome: 'failed',
        code: 'credential_rejected_no_account_access',
        kind: 'cloudflare_api_token',
        keyIdSuffix: null,
        expiresAt: null,
        verifiedAt: null,
      },
      account: {
        status: 'active',
        connection: 'waiting',
        connectionError: null,
        collectionError: null,
        ingestFrom: null,
        lastEventAt: null,
        lastCollectedAt: null,
        checkRequestedAt: null,
      },
    },
    createdAt: at(120),
    updatedAt: at(120),
    ...base,
  });
  const panel = '00000000-0000-4000-8000-00000000a003';
  active.sources.set(panel, {
    spec: { provider: 'aws', accountId: '222222222222', regions: ['sa-east-1'] },
    state: 'active',
    revision: 1,
    credential: null,
    report: {
      id: panel,
      revision: 1,
      outcome: 'failed',
      code: 'account_exists_panel',
      credential: null,
      account: null,
      reportedAt: at(60),
    },
    createdAt: at(90),
    updatedAt: at(90),
    ...base,
  });
  const removed = '00000000-0000-4000-8000-00000000a004';
  active.sources.set(removed, {
    spec: { provider: 'aws', accountId: '333333333333', regions: ['us-east-1'] },
    state: 'removed',
    revision: 2,
    credential: null,
    report: {
      id: removed,
      revision: 2,
      outcome: 'removed',
      code: null,
      credential: null,
      account: null,
      reportedAt: at(1_000),
    },
    createdAt: at(2_000),
    updatedAt: at(1_100),
    ...base,
  });

  const stale: FakeNodeSync = {
    node: fakeNode('gcp', now, { lastSeenAt: at(40) }),
    generation: 1,
    sources: new Map([
      [
        '00000000-0000-4000-8000-00000000b001',
        {
          spec: { provider: 'cloudflare', accountId: 'cf000000000000000000000000000002' },
          state: 'active',
          revision: 1,
          credential: null,
          report: null,
          createdAt: at(30),
          updatedAt: at(30),
          ...base,
        },
      ],
    ]),
  };

  return {
    tenants: new Map([
      ['01JC0000000000000000000D01', active],
      ['01JC0000000000000000000B01', stale],
    ]),
    panelAccounts: new Set(['aws:222222222222']),
  };
}

function syncOf(state: FakeLogSourcesState, tenantId: string): FakeNodeSync {
  let sync = state.tenants.get(tenantId);
  if (sync === undefined) {
    sync = { node: null, generation: 0, sources: new Map() };
    state.tenants.set(tenantId, sync);
  }
  return sync;
}

/** A situação da fonte, pelas mesmas regras do cp-admin (`sourceStatusOf`). */
function statusOf(source: FakeLogSource): {
  status: LogSourceStatus;
  code: NodeSyncSourceCode | null;
  pending: boolean;
} {
  const report = source.report;
  const specPending = report === null || report.revision < source.revision;
  const wanted = source.credential?.revision ?? 0;
  const reported = report?.credential ?? null;
  const applied =
    reported !== null && reported.revision !== null && reported.outcome === 'applied' ? reported.revision : 0;
  const pending = specPending || wanted > applied;
  if (source.state === 'removed') {
    const done = !specPending && report.outcome === 'removed';
    return { status: done ? 'removed' : 'removing', code: null, pending: !done };
  }
  if (!specPending && report.outcome === 'failed') return { status: 'failed', code: report.code, pending };
  if (
    wanted > 0 &&
    reported !== null &&
    reported.revision !== null &&
    reported.revision >= wanted &&
    reported.outcome === 'failed'
  ) {
    return { status: 'failed', code: reported.code, pending };
  }
  return { status: pending ? 'pending' : 'applied', code: null, pending };
}

function bucketNames(spec: Extract<LogSourceSpec, { provider: 'aws' }>): string[] {
  const sources: readonly AwsLogBucketSource[] = ['cloudtrail', 'guardduty', 'waf'];
  return [
    ...new Set(
      sources
        .map((source) => spec.buckets?.[source])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ];
}

function awsStackOf(spec: Extract<LogSourceSpec, { provider: 'aws' }>, node: FakeNode | null): AwsStackView {
  const bucketArns = bucketNames(spec).map((name) => `arn:aws:s3:::${name}`);
  const mismatches: AwsStackMismatchField[] = [];
  if (node !== null) {
    if (node.serviceAccountId !== FAKE_NODE_SERVICE_ACCOUNT_ID) mismatches.push('serviceAccountId');
    if (node.egressIps.join(',') !== FAKE_EGRESS_IPS.join(',')) mismatches.push('egressIps');
    if (node.audience !== AUDIENCE) mismatches.push('audience');
  }
  const region = spec.regions[0] ?? 'sa-east-1';
  return {
    stackName: 'verax-control-reader',
    roleArn: `arn:aws:iam::${spec.accountId}:role/verax/verax-control-reader`,
    nodeServiceAccountId: FAKE_NODE_SERVICE_ACCOUNT_ID,
    egressIps: [...FAKE_EGRESS_IPS],
    audience: AUDIENCE,
    bucketArns,
    deployCommand: [
      'aws cloudformation deploy --stack-name verax-control-reader \\',
      '  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \\',
      '  --parameter-overrides \\',
      `    NodeServiceAccountId=${FAKE_NODE_SERVICE_ACCOUNT_ID} \\`,
      `    NodeEgressIps=${FAKE_EGRESS_IPS.join(',')} \\`,
      `    Audience=${AUDIENCE} \\`,
      '    ReadAwsServiceLogs=true \\',
      '    ReadSecurityFindings=true \\',
      '    ReadTaggedLogGroups=true \\',
      `    LogBucketArns=${bucketArns.length > 0 ? bucketArns.join(',') : '""'}`,
    ].join('\n'),
    consoleUrl: `https://console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create`,
    templateUrl: TEMPLATE_URL,
    mismatch: mismatches.length > 0,
    mismatches,
  };
}

function readKeysOf(spec: LogSourceSpec, node: FakeNode | null): ReadKeysView | null {
  const egressIps = node?.egressIps ?? [];
  if (spec.provider === 'aws') {
    const policy = (name: string) => `arn:aws:iam::${spec.accountId}:policy/verax/${name}`;
    return {
      provider: 'aws',
      userArn: `arn:aws:iam::${spec.accountId}:user/verax/verax-control-reader`,
      readerPolicyName: 'VeraxControlReader',
      readerPolicyFile: 'verax-control-reader.json',
      readerPolicy: {
        Version: '2012-10-17',
        Statement: [
          { Sid: 'LeituraDeTeste', Effect: 'Allow', Action: ['cloudtrail:LookupEvents'], Resource: '*' },
        ],
      },
      guardrailsPolicyName: 'VeraxControlGuardrails',
      guardrailsPolicyFile: 'verax-control-guardrails.json',
      guardrailsPolicy: {
        Version: '2012-10-17',
        Statement: [{ Sid: 'ProtecaoDeTeste', Effect: 'Deny', Action: ['iam:*'], Resource: '*' }],
      },
      commands: [
        'aws iam create-policy --path /verax/ --policy-name VeraxControlReader --policy-document file://verax-control-reader.json',
        'aws iam create-policy --path /verax/ --policy-name VeraxControlGuardrails --policy-document file://verax-control-guardrails.json',
        `aws iam create-user --path /verax/ --user-name verax-control-reader --permissions-boundary ${policy('VeraxControlReader')}`,
        'aws iam create-access-key --user-name verax-control-reader',
      ].join('\n'),
      egressIps: [...egressIps],
    };
  }
  if (spec.provider === 'gcp') {
    const email = `verax-control-reader@${spec.accountId}.iam.gserviceaccount.com`;
    return {
      provider: 'gcp',
      subscription: `projects/${spec.accountId}/subscriptions/verax-control-security`,
      serviceAccountEmail: email,
      role: 'roles/pubsub.subscriber',
      keyFile: 'verax-control-reader.json',
      commands: [
        `gcloud pubsub topics create verax-control-security --project=${spec.accountId}`,
        `gcloud iam service-accounts create verax-control-reader --project=${spec.accountId}`,
        `gcloud iam service-accounts keys create verax-control-reader.json --iam-account=${email}`,
      ].join('\n'),
    };
  }
  return null;
}

function viewOf(
  id: string,
  source: FakeLogSource,
  tenant: TenantDetail,
  node: FakeNode | null,
): LogSourceView {
  const { status, code, pending } = statusOf(source);
  const verax = tenant.hosting === 'verax';
  return {
    id,
    spec: source.spec,
    state: source.state,
    revision: source.revision,
    credential: source.credential,
    report: source.report,
    pending,
    status,
    code,
    awsStack: source.spec.provider === 'aws' && verax ? awsStackOf(source.spec, node) : null,
    readKeys: verax ? null : readKeysOf(source.spec, node),
    cloudflareToken:
      source.spec.provider === 'cloudflare'
        ? {
            templateUrl:
              'https://dash.cloudflare.com/?to=/:account/api-tokens&name=Verax%20Control%20(somente%20leitura)',
            tokenName: 'Verax Control (somente leitura)',
            egressIps: verax ? [...FAKE_EGRESS_IPS] : [...(node?.egressIps ?? [])],
          }
        : null,
    createdAt: source.createdAt,
    createdBy: source.createdBy,
    updatedAt: source.updatedAt,
    updatedBy: source.updatedBy,
  };
}

function credentialKindsOf(tenant: TenantDetail): CredentialKind[] {
  return tenant.hosting === 'verax'
    ? ['cloudflare_api_token']
    : ['cloudflare_api_token', 'aws_access_key', 'gcp_service_account_key'];
}

function overviewOf(state: FakeLogSourcesState, tenant: TenantDetail, now: Date): NodeSyncOverview {
  const sync = syncOf(state, tenant.id);
  const platform = tenant.hosting === 'verax' ? 'gcp' : 'vm';
  const node = sync.node;
  return {
    hosting: tenant.hosting,
    platform,
    credentialKinds: credentialKindsOf(tenant),
    generation: sync.generation,
    node:
      node === null
        ? null
        : {
            ...node,
            stale: now.getTime() - new Date(node.lastSeenAt).getTime() > STALE_AFTER_MS,
            platformMismatch: node.platform !== platform,
          },
    sources: [...sync.sources].map(([id, source]) => viewOf(id, source, tenant, node)),
    templateUrl: TEMPLATE_URL,
    ...nodeUsersOverview(tenant, sync, now),
  };
}

const PARTITION_QUALIFIERS = new Set(['gov', 'iso', 'isob', 'isoe', 'isof']);

const isLower = (part: string): boolean => [...part].every((char) => char >= 'a' && char <= 'z');

/** Região da AWS (`sa-east-1`, `us-gov-west-1`), conferida por partes como no `isAwsRegion` do shared. */
function isAwsRegion(name: string): boolean {
  const parts = name.split('-');
  if (parts.length !== 3 && parts.length !== 4) return false;
  const [country = '', ...rest] = parts;
  const [area = '', number = ''] = rest.slice(-2);
  const qualifierOk = parts.length === 3 || PARTITION_QUALIFIERS.has(rest[0] ?? '');
  return (
    country.length === 2 &&
    isLower(country) &&
    qualifierOk &&
    area.length >= 1 &&
    area.length <= 16 &&
    isLower(area) &&
    number.length === 1 &&
    number >= '0' &&
    number <= '9'
  );
}

/** Uma amostra das regras de `cloudAccountCreateSchema` (o ID da conta de cada provedor e as regiões). */
function specIssues(spec: unknown): ValidationIssue[] {
  if (!isRecord(spec)) return [{ path: 'spec', message: 'Informe o cadastro.' }];
  const accountId = typeof spec['accountId'] === 'string' ? spec['accountId'] : '';
  switch (spec['provider']) {
    case 'aws': {
      const issues: ValidationIssue[] = /^\d{12}$/.test(accountId)
        ? []
        : [{ path: 'spec.accountId', message: 'ID de conta AWS tem 12 dígitos' }];
      const regions = spec['regions'];
      if (!Array.isArray(regions) || regions.length === 0) {
        issues.push({ path: 'spec.regions', message: 'informe ao menos uma região' });
      } else {
        regions.forEach((region: unknown, index) => {
          if (typeof region !== 'string' || !isAwsRegion(region)) {
            issues.push({ path: `spec.regions.${index}`, message: 'região AWS inválida' });
          }
        });
      }
      return issues;
    }
    case 'cloudflare':
      return /^[0-9a-f]{32}$/.test(accountId)
        ? []
        : [{ path: 'spec.accountId', message: 'ID de conta do Cloudflare tem 32 caracteres hexadecimais' }];
    case 'gcp':
      return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(accountId)
        ? []
        : [{ path: 'spec.accountId', message: 'ID de projeto da GCP inválido' }];
    default:
      return [{ path: 'spec.provider', message: 'Escolha o provedor.' }];
  }
}

/** Uma amostra das regras de `cloudCredentialInputSchema` (o tamanho do que foi colado); `prefix` é o do corpo. */
function credentialIssues(credential: Record<string, unknown>, prefix: string): ValidationIssue[] {
  const length = (field: string) => (typeof credential[field] === 'string' ? credential[field].length : 0);
  switch (credential['kind']) {
    case 'cloudflare_api_token':
      return length('token') >= 40
        ? []
        : [
            {
              path: `${prefix}token`,
              message: 'Token do Cloudflare inválido: cole o valor completo do token de API, sem espaços.',
            },
          ];
    case 'aws_access_key': {
      const issues: ValidationIssue[] = [];
      if (length('accessKeyId') !== 20) {
        issues.push({
          path: `${prefix}accessKeyId`,
          message:
            'ID da chave de acesso inválido: cole o ID da chave do usuário IAM (20 caracteres, começa com AKIA).',
        });
      }
      if (length('secretAccessKey') !== 40) {
        issues.push({
          path: `${prefix}secretAccessKey`,
          message: 'Chave secreta inválida: cole os 40 caracteres da chave secreta, sem espaços.',
        });
      }
      return issues;
    }
    case 'gcp_service_account_key':
      return ['projectId', 'clientEmail', 'privateKeyId', 'privateKey'].every((field) => length(field) > 0)
        ? []
        : [
            {
              path: `${prefix}privateKey`,
              message:
                'Chave da conta de serviço inválida: cole o conteúdo inteiro do arquivo JSON que o Google baixou ao criar a chave.',
            },
          ];
    default:
      return [{ path: `${prefix}kind`, message: 'Tipo de credencial inválido.' }];
  }
}

const REFUSALS: Readonly<Record<string, { status: number; message: string; issue?: ValidationIssue }>> = {
  not_allowed: { status: 409, message: 'O contrato deste cliente já terminou (cancelado ou excluído).' },
  gcp_unsupported_managed: {
    status: 422,
    message: 'Projetos da GCP pelo console só no ambiente na VM do cliente, por enquanto.',
    issue: { path: 'spec.provider', message: 'No ambiente na infraestrutura da Verax, só AWS e Cloudflare.' },
  },
  credential_provider_mismatch: {
    status: 422,
    message: 'A credencial é de outro provedor que o da fonte.',
    issue: { path: 'credential.kind', message: 'Escolha a credencial do provedor da fonte.' },
  },
  credential_kind_not_allowed: {
    status: 422,
    message: 'Este tipo de credencial não vale no nó deste cliente.',
    issue: { path: 'credential.kind', message: 'Tipo de credencial que o nó deste cliente não aceita.' },
  },
  source_not_found: { status: 404, message: 'Fonte não encontrada.' },
  source_exists: {
    status: 409,
    message: 'Esta conta já é uma fonte deste cliente.',
    issue: { path: 'spec.accountId', message: 'Esta conta já está cadastrada: altere a fonte que existe.' },
  },
  source_limit: { status: 409, message: 'O cliente já tem o máximo de fontes.' },
  source_removed: { status: 409, message: 'A fonte foi removida: cadastre de novo.' },
  no_change: { status: 409, message: 'Nada muda nesta alteração.' },
  confirmation_mismatch: {
    status: 400,
    message: 'O subdomínio não confere com o do cliente: nada mudou.',
    issue: { path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' },
  },
  node_not_synced: { status: 409, message: 'O nó deste cliente ainda não sincronizou.' },
  vault_disabled: { status: 409, message: 'O nó deste cliente está sem o cofre de credenciais.' },
  platform_mismatch: { status: 409, message: 'O nó informou outra plataforma.' },
  rate_limited: { status: 429, message: 'Muitas operações em pouco tempo. Tente novamente mais tarde.' },
};

function refuse(code: string): FakeResponse {
  const entry = REFUSALS[code] ?? { status: 409, message: 'Recusado.' };
  return error(
    entry.status,
    entry.message,
    code,
    entry.issue === undefined ? undefined : { issues: [entry.issue] },
  );
}

/** As regras da chave para este cliente: o provedor, a plataforma e o nó com o cofre. */
function credentialRefusal(
  tenant: TenantDetail,
  sync: FakeNodeSync,
  provider: LogSourceSpec['provider'],
  kind: CredentialKind,
): string | undefined {
  if (CREDENTIAL_PROVIDERS[kind] !== provider) return 'credential_provider_mismatch';
  if (!credentialKindsOf(tenant).includes(kind)) return 'credential_kind_not_allowed';
  const node = sync.node;
  if (node === null || node.nodeTenantId === null) return 'node_not_synced';
  if (node.platform !== (tenant.hosting === 'verax' ? 'gcp' : 'vm')) return 'platform_mismatch';
  if (!node.vaultReady || node.error === 'vault_unreadable') return 'vault_disabled';
  return undefined;
}

function credentialMeta(kind: CredentialKind, revision: number, now: Date): LogSourceCredentialView {
  return {
    kind,
    revision,
    keyVersion: 1,
    fingerprint: FAKE_VAULT_FINGERPRINT,
    submittedAt: now.toISOString(),
    submittedBy: OWNER,
    envelopeStored: true,
  };
}

function written(
  state: FakeLogSourcesState,
  tenant: TenantDetail,
  sync: FakeNodeSync,
  id: string,
  now: Date,
  status = 200,
): FakeResponse {
  sync.generation += 1;
  const source = sync.sources.get(id);
  if (source === undefined) return refuse('source_not_found');
  return {
    status,
    body: {
      source: overviewOf(state, tenant, now).sources.find((view) => view.id === id),
      generation: sync.generation,
    },
  };
}

function create(
  state: FakeLogSourcesState,
  tenant: TenantDetail,
  sync: FakeNodeSync,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  const credential = isRecord(body['credential']) ? body['credential'] : undefined;
  const issues = [
    ...specIssues(body['spec']),
    ...(credential === undefined ? [] : credentialIssues(credential, 'credential.')),
  ];
  if (issues.length > 0) return invalid(issues);
  const spec = body['spec'] as LogSourceSpec;
  if (spec.provider === 'gcp' && tenant.hosting === 'verax') return refuse('gcp_unsupported_managed');
  const duplicate = [...sync.sources.values()].some(
    (source) =>
      source.state === 'active' &&
      source.spec.provider === spec.provider &&
      source.spec.accountId === spec.accountId,
  );
  if (duplicate) return refuse('source_exists');
  if (sync.sources.size >= MAX_SOURCES) return refuse('source_limit');
  if (credential !== undefined) {
    const refusal = credentialRefusal(tenant, sync, spec.provider, credential['kind'] as CredentialKind);
    if (refusal !== undefined) return refuse(refusal);
  }
  if (state.rateLimited === true) return refuse('rate_limited');
  const id = nextSourceId();
  const at = now.toISOString();
  sync.sources.set(id, {
    spec,
    state: 'active',
    revision: 1,
    // Só os metadados: o texto colado nunca fica no estado simulado.
    credential:
      credential === undefined ? null : credentialMeta(credential['kind'] as CredentialKind, 1, now),
    report: null,
    createdAt: at,
    createdBy: OWNER,
    updatedAt: at,
    updatedBy: OWNER,
  });
  return written(state, tenant, sync, id, now, 201);
}

const PROVIDER_FIELDS: Readonly<Record<LogSourceSpec['provider'], readonly string[]>> = {
  aws: ['regions', 'buckets'],
  gcp: ['pubsubSubscription', 'sinkWriterIdentity'],
  cloudflare: ['zones'],
};

function update(
  state: FakeLogSourcesState,
  tenant: TenantDetail,
  sync: FakeNodeSync,
  id: string,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  const immutable = ['provider', 'accountId'].filter((field) => field in body);
  if (immutable.length > 0) {
    return invalid(
      immutable.map((path) => ({
        path,
        message: 'O provedor e o ID da conta não mudam: outra conta é outra fonte.',
      })),
    );
  }
  if ('status' in body)
    return invalid([{ path: 'status', message: 'Para tirar a fonte do nó, use "Remover".' }]);
  if (Object.keys(body).length === 0) return invalid([{ path: '', message: 'informe ao menos um campo' }]);
  const source = sync.sources.get(id);
  if (source === undefined) return refuse('source_not_found');
  if (source.state === 'removed') return refuse('source_removed');
  const outside = Object.keys(body).filter((field) => !PROVIDER_FIELDS[source.spec.provider].includes(field));
  if (outside.length > 0) {
    return invalid(
      outside.map((path) => ({ path, message: 'Campo que não existe no provedor desta fonte.' })),
    );
  }
  let next: LogSourceSpec;
  switch (source.spec.provider) {
    case 'aws': {
      const buckets = { ...(source.spec.buckets ?? {}), ...((body['buckets'] as object | undefined) ?? {}) };
      const filled = Object.fromEntries(
        Object.entries(buckets).filter(([, value]) => typeof value === 'string'),
      );
      next = {
        provider: 'aws',
        accountId: source.spec.accountId,
        regions: (body['regions'] as string[] | undefined) ?? source.spec.regions,
        ...(Object.keys(filled).length === 0 ? {} : { buckets: filled }),
      };
      break;
    }
    case 'cloudflare':
      next = {
        provider: 'cloudflare',
        accountId: source.spec.accountId,
        zones: (body['zones'] as string[] | undefined) ?? source.spec.zones ?? [],
      };
      break;
    case 'gcp': {
      const subscription =
        'pubsubSubscription' in body
          ? (body['pubsubSubscription'] as string | null)
          : source.spec.pubsubSubscription;
      next = {
        provider: 'gcp',
        accountId: source.spec.accountId,
        ...(typeof subscription === 'string' ? { pubsubSubscription: subscription } : {}),
      };
      break;
    }
  }
  const issues = specIssues(next);
  if (issues.length > 0)
    return invalid(issues.map((issue) => ({ ...issue, path: issue.path.replace(/^spec\./, '') })));
  if (JSON.stringify(next) === JSON.stringify(source.spec)) return refuse('no_change');
  if (state.rateLimited === true) return refuse('rate_limited');
  sync.sources.set(id, {
    ...source,
    spec: next,
    revision: source.revision + 1,
    updatedAt: now.toISOString(),
    updatedBy: OWNER,
  });
  return written(state, tenant, sync, id, now);
}

function putCredential(
  state: FakeLogSourcesState,
  tenant: TenantDetail,
  sync: FakeNodeSync,
  id: string,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  const issues = credentialIssues(body, '');
  if (issues.length > 0) return invalid(issues);
  const source = sync.sources.get(id);
  if (source === undefined) return refuse('source_not_found');
  if (source.state === 'removed') return refuse('source_removed');
  const kind = body['kind'] as CredentialKind;
  const refusal = credentialRefusal(tenant, sync, source.spec.provider, kind);
  if (refusal !== undefined) return refuse(refusal);
  if (state.rateLimited === true) return refuse('rate_limited');
  sync.sources.set(id, {
    ...source,
    credential: credentialMeta(kind, (source.credential?.revision ?? 0) + 1, now),
    updatedAt: now.toISOString(),
    updatedBy: OWNER,
  });
  return written(state, tenant, sync, id, now);
}

function remove(
  state: FakeLogSourcesState,
  tenant: TenantDetail,
  sync: FakeNodeSync,
  id: string,
  body: Record<string, unknown>,
  now: Date,
): FakeResponse {
  if (body['confirmSlug'] !== tenant.slug) return refuse('confirmation_mismatch');
  const source = sync.sources.get(id);
  if (source === undefined) return refuse('source_not_found');
  if (source.state === 'removed') return refuse('source_removed');
  if (state.rateLimited === true) return refuse('rate_limited');
  sync.sources.set(id, {
    ...source,
    state: 'removed',
    revision: source.revision + 1,
    credential: source.credential === null ? null : { ...source.credential, envelopeStored: false },
    updatedAt: now.toISOString(),
    updatedBy: OWNER,
  });
  return written(state, tenant, sync, id, now);
}

/**
 * Atende `.../node-sync`, `.../log-sources[/:id[/credential|/remove]]` e `.../users` de um cliente (`rest` depois do
 * id).
 */
export function handleLogSourcesRequest(
  state: FakeLogSourcesState,
  tenant: TenantDetail,
  now: Date,
  method: string,
  rest: readonly string[],
  body: unknown,
): FakeResponse {
  const [resource, sourceId, action] = rest;
  if (resource === 'node-sync' && rest.length === 1 && method === 'GET') {
    return { status: 200, body: overviewOf(state, tenant, now) };
  }
  if (resource === 'users' && rest.length === 1 && method === 'POST') {
    return createNodeUser(tenant, syncOf(state, tenant.id), now, body);
  }
  if (resource !== 'log-sources') return error(404, 'Recurso não encontrado', 'not_found');
  const sync = syncOf(state, tenant.id);
  const record = isRecord(body) ? body : {};
  const writable = tenant.state !== 'canceled' && tenant.state !== 'deleted';
  if (sourceId === undefined && method === 'POST') {
    return writable ? create(state, tenant, sync, record, now) : refuse('not_allowed');
  }
  if (sourceId === undefined) return error(404, 'Recurso não encontrado', 'not_found');
  if (!SOURCE_ID.test(sourceId)) return refuse('source_not_found');
  if (action === undefined && method === 'PATCH') {
    return writable ? update(state, tenant, sync, sourceId, record, now) : refuse('not_allowed');
  }
  if (action === 'credential' && method === 'PUT') {
    return writable ? putCredential(state, tenant, sync, sourceId, record, now) : refuse('not_allowed');
  }
  if (action === 'remove' && method === 'POST') return remove(state, tenant, sync, sourceId, record, now);
  return error(404, 'Recurso não encontrado', 'not_found');
}

/**
 * A próxima sincronização do nó do cliente: ele aplica cada revisão pendente (ou recusa a conta que o cliente já tem
 * no painel), confere a chave nova (aceita, ou recusa com `rejectCredential`), desativa as removidas e conta de volta.
 */
export function simulateNodeSync(state: FakeLogSourcesState, tenantId: string, now: Date): void {
  const sync = state.tenants.get(tenantId);
  const node = sync?.node;
  if (sync === undefined || node === null || node === undefined) return;
  sync.node = { ...node, lastSeenAt: now.toISOString() };
  const reportedAt = now.toISOString();
  for (const [id, source] of sync.sources) {
    const previous = source.report;
    if (source.state === 'removed') {
      if (previous?.outcome === 'removed' && previous.revision >= source.revision) continue;
      source.report = {
        id,
        revision: source.revision,
        outcome: 'removed',
        code: null,
        credential: previous?.credential ?? null,
        account: null,
        reportedAt,
      };
      continue;
    }
    let report: LogSourceReport =
      previous === null || previous.revision < source.revision
        ? state.panelAccounts.has(`${source.spec.provider}:${source.spec.accountId}`)
          ? {
              id,
              revision: source.revision,
              outcome: 'failed',
              code: 'account_exists_panel',
              credential: null,
              account: null,
              reportedAt,
            }
          : {
              ...appliedReport(id, source.revision, now, source.spec.provider),
              credential: previous?.credential ?? null,
              reportedAt,
            }
        : { ...previous, reportedAt };
    const wanted = source.credential?.revision ?? 0;
    const seen = report.credential?.revision ?? 0;
    if (report.outcome === 'applied' && source.credential !== null && wanted > seen) {
      const rejected = state.rejectCredential;
      report = {
        ...report,
        credential: {
          revision: wanted,
          outcome: rejected === undefined ? 'applied' : 'failed',
          code: rejected ?? null,
          kind: source.credential.kind,
          keyIdSuffix: rejected === undefined ? 'd3m0' : null,
          expiresAt: null,
          verifiedAt: rejected === undefined ? reportedAt : null,
        },
      };
      source.credential = { ...source.credential, envelopeStored: false };
    }
    source.report = report;
  }
}
