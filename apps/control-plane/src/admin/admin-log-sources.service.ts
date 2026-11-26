import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type AcceptedCredentialKind,
  ACCEPTED_CREDENTIAL_KINDS,
  AWS_GUARDRAILS_POLICY_FILE,
  AWS_GUARDRAILS_POLICY_NAME,
  AWS_READER_AUDIENCE,
  AWS_READER_POLICY_FILE,
  AWS_READER_POLICY_NAME,
  AWS_READER_STACK_NAME,
  awsGuardrailsPolicy,
  awsLogBucketArns,
  awsReaderDeployCommand,
  awsReaderRoleArn,
  awsReaderUserArn,
  awsReaderUserCommands,
  awsReaderUserPolicy,
  type CloudAccountCreate,
  cloudAccountCreateSchema,
  type CloudAccountUpdate,
  cloudAccountUpdateSchema,
  type CloudCredentialInput,
  cloudCredentialInputSchema,
  CLOUDFLARE_TOKEN_NAME,
  cloudflareTokenTemplateUrl,
  cloudFormationConsoleUrl,
  CREDENTIAL_KIND_PROVIDERS,
  credentialKindAllowed,
  fieldsOutsideProvider,
  GCP_READER_KEY_FILE,
  GCP_READER_ROLE,
  gcpReaderCommands,
  gcpReaderServiceAccountEmail,
  gcpReaderSubscription,
  isNodeEgressIp,
  isNodeServiceAccountId,
  LOG_SOURCES,
  NODE_SYNC_MAX_SOURCES,
  type NodePlatform,
  type NodeSyncSourceCode,
  type NodeSyncSourceReport,
} from '@verax/shared';
import { type CredentialPayload, sealCredential } from '@verax/vault-envelope';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import { cloudflareOauthSettings, isTenantReleased } from '../cloudflare-oauth/cloudflare-oauth-settings.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { isUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  type DocumentTransaction,
  equalValues,
  parseDocument,
} from '../firestore/document-store.js';
import {
  announcesCloudflareOauth,
  LOG_SOURCE_SECRET_TTL_MS,
  type LogSource,
  type LogSourceReport,
  logSourceReportSchema,
  logSourceSchema,
  logSourceSecretSchema,
  NODE_SYNC_CLOUDFLARE_OAUTH_DOC,
  NODE_SYNC_DESIRED_DOC,
  NODE_SYNC_STATE_DOC,
  nodeSyncDesiredSchema,
  type NodeSyncState,
  nodeSyncStateSchema,
} from '../node-sync/node-sync.schema.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { hostingOf, type TenantRecord } from '../tenants/tenant.schema.js';
import {
  AWS_READER_TEMPLATE_PATH,
  type AwsStackMismatchField,
  type AwsStackView,
  type CloudflareTokenView,
  LOG_SOURCE_ID_PATTERN,
  type LogSourceCreateRequest,
  logSourceCreateRequestSchema,
  type LogSourceCredentialView,
  logSourceRemoveRequestSchema,
  type LogSourceStatus,
  type LogSourceView,
  type LogSourceWriteResult,
  NODE_STALE_AFTER_MS,
  type NodeSyncOverview,
  type NodeSyncView,
  type ReadKeysView,
} from './admin-log-sources.schema.js';
import type { NodeUserBlock } from './admin-node-users.schema.js';
import { ADMIN_TENANT_LIMITS, type AdminTenantLimits } from './admin-tenants.service.js';
import { nodeVaultOf, platformOf, readCollection } from './admin-node-sync-common.js';
import {
  nodeUserBlockOf,
  nodeUserViewsOf,
  readNodeUsers,
  usersSupportedBy,
} from './admin-node-users.service.js';
import { type FieldIssue, invalidFields, invalidRequest } from './validation.js';

/** As operações das fontes de log, como vão à auditoria (`details.operation`). */
type LogSourceOperation =
  'log_source.create' | 'log_source.update' | 'log_source.credential' | 'log_source.remove';

/** Por que uma escrita foi recusada (o código da resposta e da auditoria). */
export type LogSourceRefusalCode =
  | 'not_allowed'
  | 'placement_unsupported'
  | 'gcp_unsupported_managed'
  | 'credential_provider_mismatch'
  | 'credential_kind_not_allowed'
  | 'cloudflare_oauth_only'
  | 'source_not_found'
  | 'source_exists'
  | 'source_limit'
  | 'source_removed'
  | 'immutable_field'
  | 'no_change'
  | 'confirmation_mismatch'
  | 'node_not_synced'
  | 'vault_disabled'
  | 'platform_mismatch'
  | 'vault_key_invalid'
  | 'rate_limited';

const REFUSALS: Readonly<
  Record<LogSourceRefusalCode, { status: HttpStatus; message: string; issue?: FieldIssue }>
> = {
  not_allowed: {
    status: HttpStatus.CONFLICT,
    message:
      'O contrato deste cliente já terminou (cancelado ou excluído): não há fonte para cadastrar ou alterar.',
  },
  placement_unsupported: {
    status: HttpStatus.CONFLICT,
    message: 'Cliente da célula compartilhada: as fontes de log ainda não são cadastradas pelo console.',
  },
  gcp_unsupported_managed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Projetos da GCP pelo console só no ambiente na VM do cliente, por enquanto: o nó gerenciado ainda não recebe projetos de cliente.',
    issue: { path: 'spec.provider', message: 'No ambiente na infraestrutura da Verax, só AWS e Cloudflare.' },
  },
  credential_provider_mismatch: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A credencial é de outro provedor que o da fonte.',
    issue: { path: 'credential.kind', message: 'Escolha a credencial do provedor da fonte.' },
  },
  credential_kind_not_allowed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Este tipo de credencial não vale no nó deste cliente: no nó gerenciado, a AWS é lida pelo papel sem chave (a pilha do CloudFormation).',
    issue: { path: 'credential.kind', message: 'Tipo de credencial que o nó deste cliente não aceita.' },
  },
  cloudflare_oauth_only: {
    status: HttpStatus.CONFLICT,
    message:
      'Neste cliente o Cloudflare é conectado pelo próprio cliente, no painel dele ("Conectar com Cloudflare"): o console não envia token novo. A conta que já coleta com token segue coletando.',
    issue: { path: 'credential.kind', message: 'O cliente conecta o Cloudflare no painel dele.' },
  },
  source_not_found: { status: HttpStatus.NOT_FOUND, message: 'Fonte não encontrada.' },
  source_exists: {
    status: HttpStatus.CONFLICT,
    message: 'Esta conta já é uma fonte deste cliente.',
    issue: { path: 'spec.accountId', message: 'Esta conta já está cadastrada: altere a fonte que existe.' },
  },
  source_limit: {
    status: HttpStatus.CONFLICT,
    message: `O cliente já tem ${NODE_SYNC_MAX_SOURCES} fontes cadastradas (contando as removidas), o máximo da sincronização.`,
  },
  source_removed: { status: HttpStatus.CONFLICT, message: 'A fonte foi removida: cadastre de novo.' },
  immutable_field: {
    status: HttpStatus.BAD_REQUEST,
    message: 'O provedor e o ID da conta não mudam: outra conta é outra fonte.',
  },
  no_change: { status: HttpStatus.CONFLICT, message: 'Nada muda nesta alteração.' },
  confirmation_mismatch: {
    status: HttpStatus.BAD_REQUEST,
    message: 'O subdomínio não confere com o do cliente: nada mudou.',
    issue: { path: 'confirmSlug', message: 'Digite o subdomínio do cliente, igual, para confirmar.' },
  },
  node_not_synced: {
    status: HttpStatus.CONFLICT,
    message:
      'O nó deste cliente ainda não sincronizou com o plano de controle: a credencial só pode ser cifrada para ele depois disso. O cliente pode colá-la no painel.',
  },
  vault_disabled: {
    status: HttpStatus.CONFLICT,
    message:
      'O nó deste cliente está sem o cofre de credenciais (ou não consegue lê-lo): não há para quem cifrar a credencial.',
  },
  platform_mismatch: {
    status: HttpStatus.CONFLICT,
    message:
      'O nó informou outra plataforma que a do lugar deste cliente: nada foi cifrado. Confira a instalação.',
  },
  vault_key_invalid: {
    status: HttpStatus.CONFLICT,
    message:
      'A chave do cofre que o nó informou não confere (formato ou impressão digital): nada foi cifrado.',
  },
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Muitas operações em pouco tempo. Tente novamente mais tarde.',
  },
};

/** A recusa de dentro da leitura ou da transação, levada até a auditoria e a resposta. */
class LogSourceRefusal extends Error {
  constructor(
    readonly code: LogSourceRefusalCode,
    readonly sourceId?: string,
  ) {
    super(`fonte recusada: ${code}`);
    this.name = 'LogSourceRefusal';
  }
}

function refusalError(code: LogSourceRefusalCode): ApiError {
  const entry = REFUSALS[code];
  return new ApiError(
    entry.status,
    entry.message,
    code,
    entry.issue === undefined ? undefined : { issues: [entry.issue] },
  );
}

function notFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'Cliente não encontrado.', 'tenant_not_found');
}

/** Os segredos do corpo, para a máscara do logger: registrados antes de qualquer `await`, esquecidos no fim. */
function secretValuesOf(credential: CloudCredentialInput | undefined): string[] {
  if (credential === undefined) return [];
  switch (credential.kind) {
    case 'cloudflare_api_token':
      return [credential.token];
    case 'aws_access_key':
      return [credential.accessKeyId, credential.secretAccessKey];
    case 'gcp_service_account_key':
      return [credential.privateKey];
  }
}

/** O texto claro no formato curto do envelope (`@verax/vault-envelope`). */
function payloadOf(credential: CloudCredentialInput): CredentialPayload {
  switch (credential.kind) {
    case 'cloudflare_api_token':
      return { t: credential.token };
    case 'aws_access_key':
      return { i: credential.accessKeyId, s: credential.secretAccessKey };
    case 'gcp_service_account_key':
      return {
        p: credential.projectId,
        e: credential.clientEmail,
        d: credential.privateKeyId,
        k: credential.privateKey,
      };
  }
}

/** Os buckets sem as fontes vazias (`null` tira o bucket); sem nenhum, o campo sai. */
function normalizedBuckets(
  buckets: Partial<Record<(typeof LOG_SOURCES)[number], string | null | undefined>> | undefined,
): Partial<Record<(typeof LOG_SOURCES)[number], string>> | undefined {
  const result: Partial<Record<(typeof LOG_SOURCES)[number], string>> = {};
  for (const source of LOG_SOURCES) {
    const value = buckets?.[source];
    if (typeof value === 'string') result[source] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** O cadastro como fica gravado: só os campos presentes, os buckets sem as fontes vazias. */
export function normalizedSpec(spec: CloudAccountCreate): CloudAccountCreate {
  switch (spec.provider) {
    case 'aws': {
      const buckets = normalizedBuckets(spec.buckets);
      return {
        provider: 'aws',
        accountId: spec.accountId,
        regions: [...spec.regions],
        ...(buckets === undefined ? {} : { buckets }),
      };
    }
    case 'gcp':
      return {
        provider: 'gcp',
        accountId: spec.accountId,
        ...(spec.pubsubSubscription === undefined ? {} : { pubsubSubscription: spec.pubsubSubscription }),
        ...(spec.sinkWriterIdentity === undefined ? {} : { sinkWriterIdentity: spec.sinkWriterIdentity }),
      };
    case 'cloudflare':
      return {
        provider: 'cloudflare',
        accountId: spec.accountId,
        ...(spec.zones === undefined ? {} : { zones: [...spec.zones] }),
      };
  }
}

/** O cadastro depois de uma alteração (os campos do provedor; os buckets fonte a fonte, como no painel). */
export function mergedSpec(spec: CloudAccountCreate, update: CloudAccountUpdate): CloudAccountCreate {
  switch (spec.provider) {
    case 'aws':
      return normalizedSpec({
        ...spec,
        regions: update.regions ?? spec.regions,
        buckets: { ...(spec.buckets ?? {}), ...(update.buckets ?? {}) },
      });
    case 'gcp':
      return normalizedSpec({
        ...spec,
        ...(update.pubsubSubscription === undefined ? {} : { pubsubSubscription: update.pubsubSubscription }),
        ...(update.sinkWriterIdentity === undefined ? {} : { sinkWriterIdentity: update.sinkWriterIdentity }),
      });
    case 'cloudflare':
      return normalizedSpec({ ...spec, zones: update.zones ?? spec.zones });
  }
}

/** A última revisão da credencial do console que o nó disse ter aplicado (0: nenhuma). */
function appliedCredentialRevision(report: NodeSyncSourceReport | undefined): number {
  const credential = report?.credential;
  if (credential === null || credential === undefined || credential.revision === null) return 0;
  return credential.outcome === 'applied' ? credential.revision : 0;
}

/** A situação da fonte, o código do problema e se há algo que o nó ainda não processou. */
export function sourceStatusOf(
  source: Pick<LogSource, 'state' | 'revision' | 'credentialMeta'>,
  report: NodeSyncSourceReport | undefined,
): { status: LogSourceStatus; code: NodeSyncSourceCode | null; pending: boolean } {
  const specPending = report === undefined || report.revision < source.revision;
  const wanted = source.credentialMeta?.revision ?? 0;
  const pending = specPending || wanted > appliedCredentialRevision(report);
  if (source.state === 'removed') {
    const removed = !specPending && report.outcome === 'removed';
    return { status: removed ? 'removed' : 'removing', code: null, pending: !removed };
  }
  if (!specPending && report.outcome === 'failed') {
    return { status: 'failed', code: report.code, pending };
  }
  const credential = report?.credential;
  if (
    wanted > 0 &&
    credential !== null &&
    credential !== undefined &&
    credential.revision !== null &&
    credential.revision >= wanted &&
    credential.outcome === 'failed'
  ) {
    return { status: 'failed', code: credential.code, pending };
  }
  return { status: pending ? 'pending' : 'applied', code: null, pending };
}

/** O IP de saída gravado pelo provisionamento (o do Cloud NAT), com /32; vazio fora do formato. */
function natEgressIps(tenant: TenantRecord): string[] {
  const natIp = tenant.resources?.natIp;
  if (natIp === undefined) return [];
  const withPrefix = natIp.includes('/') ? natIp : `${natIp}/32`;
  return isNodeEgressIp(withPrefix) ? [withPrefix] : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/** Os nomes dos buckets cadastrados numa fonte AWS. */
function bucketNamesOf(spec: Extract<CloudAccountCreate, { provider: 'aws' }>): string[] {
  return LOG_SOURCES.map((source) => spec.buckets?.[source]).filter(
    (name): name is string => typeof name === 'string',
  );
}

/** A pilha do papel de leitura com os valores do plano de controle, conferida com o que o nó informou. */
export function awsStackOf(
  spec: Extract<CloudAccountCreate, { provider: 'aws' }>,
  tenant: TenantRecord,
  state: NodeSyncState | undefined,
): AwsStackView {
  const unique = tenant.resources?.serviceAccountUniqueId;
  const nodeServiceAccountId = unique !== undefined && isNodeServiceAccountId(unique) ? unique : null;
  const egressIps = natEgressIps(tenant);
  const buckets = bucketNamesOf(spec);
  const mismatches: AwsStackMismatchField[] = [];
  if (state !== undefined) {
    if (state.serviceAccountId !== nodeServiceAccountId) mismatches.push('serviceAccountId');
    if (!sameSet(state.egressIps, egressIps)) mismatches.push('egressIps');
    if (state.audience !== AWS_READER_AUDIENCE) mismatches.push('audience');
  }
  return {
    stackName: AWS_READER_STACK_NAME,
    roleArn: awsReaderRoleArn(spec.accountId),
    nodeServiceAccountId,
    egressIps,
    audience: AWS_READER_AUDIENCE,
    bucketArns: awsLogBucketArns(buckets),
    deployCommand: awsReaderDeployCommand({
      nodeServiceAccountId,
      egressIps,
      audience: AWS_READER_AUDIENCE,
      buckets,
    }),
    consoleUrl: cloudFormationConsoleUrl(spec.regions[0]),
    templateUrl: AWS_READER_TEMPLATE_PATH,
    mismatch: mismatches.length > 0,
    mismatches,
  };
}

/** As chaves de leitura que o cliente cria (VM do cliente): AWS e GCP; o Cloudflare tem o bloco dele. */
export function readKeysOf(spec: CloudAccountCreate, nodeEgressIps: readonly string[]): ReadKeysView | null {
  switch (spec.provider) {
    case 'aws': {
      const egressIps = nodeEgressIps.filter(isNodeEgressIp);
      return {
        provider: 'aws',
        userArn: awsReaderUserArn(spec.accountId),
        readerPolicyName: AWS_READER_POLICY_NAME,
        readerPolicyFile: AWS_READER_POLICY_FILE,
        readerPolicy: awsReaderUserPolicy({
          accountId: spec.accountId,
          buckets: bucketNamesOf(spec),
          egressIps,
        }),
        guardrailsPolicyName: AWS_GUARDRAILS_POLICY_NAME,
        guardrailsPolicyFile: AWS_GUARDRAILS_POLICY_FILE,
        guardrailsPolicy: awsGuardrailsPolicy({ egressIps }),
        commands: awsReaderUserCommands(spec.accountId),
        egressIps,
      };
    }
    case 'gcp':
      return {
        provider: 'gcp',
        subscription: gcpReaderSubscription(spec.accountId),
        serviceAccountEmail: gcpReaderServiceAccountEmail(spec.accountId),
        role: GCP_READER_ROLE,
        keyFile: GCP_READER_KEY_FILE,
        commands: gcpReaderCommands(spec.accountId),
      };
    case 'cloudflare':
      return null;
  }
}

/** O que a leitura das fontes de um cliente traz (o mesmo dentro e fora da transação). */
interface Snapshot {
  state: NodeSyncState | undefined;
  /** O nó anunciou a conexão do Cloudflare por OAuth na última chamada. */
  cloudflareOauth: boolean;
  generation: number;
  sources: Map<string, LogSource>;
}

/** O envelope pronto para gravar, e o que vai nos metadados da fonte. */
interface Sealed {
  kind: AcceptedCredentialKind;
  envelope: string;
  keyVersion: number;
  fingerprint: string;
  nodeTenantId: string;
}

/**
 * As fontes de log de um cliente no console do responsável (só no cp-admin; docs/ARQUITETURA.md, "Sincronização com o
 * plano de controle"): o que o nó disse de si e de cada fonte, e as escritas do estado desejado que o cp-worker
 * entrega ao nó na próxima chamada dele. Cada escrita é uma transação só: a fonte (`logSources`, a revisão sobe), o
 * envelope quando há credencial (`logSourceSecrets`), a geração (`nodeSync/desired`) e a auditoria.
 *
 * A credencial colada no console é conferida com as regras do painel do nó (`cloudCredentialInputSchema`: a Global
 * API Key do Cloudflare e a chave temporária da AWS são recusadas), o tipo tem de valer na plataforma do nó
 * (`credentialKindAllowed`: no gerenciado, só o Cloudflare) e só é cifrada para o nó que já sincronizou com o cofre:
 * a chave pública do cofre que o nó informou (com a impressão digital conferida de novo aqui), amarrada ao id do
 * cliente no banco do nó, ao id da fonte, ao tipo e à conta (`@verax/vault-envelope`). O token do Cloudflare é recusado
 * no cliente que o conecta por OAuth (`isOauthOnly`). O texto claro fica na memória
 * deste pedido, na máscara do logger desde antes do primeiro `await`, e nunca vai à resposta, à auditoria, ao log nem
 * ao Firestore: só o envelope e os metadados.
 *
 * Toda escrita e toda recusa (depois do cliente encontrado) vão à auditoria com `owner:<e-mail>`; os logs levam só
 * ids, o provedor, as revisões e os códigos.
 */
@Injectable()
export class AdminLogSourcesService {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    @Inject(ADMIN_TENANT_LIMITS) private readonly limits: AdminTenantLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(AdminLogSourcesService.name) private readonly logger: PinoLogger,
  ) {}

  /** `GET .../node-sync`: o nó e as fontes, com o que mandar ao cliente em cada uma. */
  async overview(tenantId: string): Promise<NodeSyncOverview> {
    const tenant = await this.tenant(tenantId);
    const hosting = hostingOf(tenant);
    const platform = platformOf(hosting);
    // Uma leitura só, numa transação: o cp-worker grava o relato e apaga o envelope juntos, então relatos e envelopes
    // lidos em momentos diferentes poderiam mostrar um pedido concluído como vencido (relato antigo, envelope já apagado).
    const { snapshot, reports, secrets, users } = await this.store.runTransaction(async (tx) => ({
      snapshot: await this.snapshot(tx, tenant.id),
      reports: await readCollection(tx, COLLECTIONS.logSourceReports(tenant.id), logSourceReportSchema),
      // Só os ids interessam (o envelope ainda espera o nó?): o envelope nunca sai daqui.
      secrets: await tx.query(COLLECTIONS.logSourceSecrets(tenant.id)),
      users: await readNodeUsers(tx, tenant.id),
    }));
    const stored = new Set(secrets.map((doc) => doc.id));
    const now = this.clock.now();
    const sources = [...snapshot.sources].map(([id, source]) =>
      this.sourceView(id, source, reports.get(id), stored.has(id), tenant, snapshot),
    );
    return {
      hosting,
      platform,
      credentialKinds: ACCEPTED_CREDENTIAL_KINDS.filter(
        (kind) => credentialKindAllowed(kind, platform) && !this.isOauthOnly(tenant, snapshot, kind),
      ),
      generation: snapshot.generation,
      node: snapshot.state === undefined ? null : nodeViewOf(snapshot.state, platform, now),
      sources,
      templateUrl: AWS_READER_TEMPLATE_PATH,
      users: nodeUserViewsOf(users, now),
      usersSupported: usersSupportedBy(snapshot.state),
      usersBlockedBy: blockOf(nodeUserBlockOf(tenant, snapshot.state)),
    };
  }

  /** `POST .../log-sources`: a fonte nova (revisão 1), com a credencial cifrada para o nó quando veio. */
  async create(tenantId: string, body: unknown, owner: OwnerContext): Promise<LogSourceWriteResult> {
    const parsed = logSourceCreateRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const request = parsed.data;
    const secrets = secretValuesOf(request.credential);
    for (const value of secrets) registerLiveSecret(value);
    try {
      const tenant = await this.tenant(tenantId);
      const operation = 'log_source.create';
      return await this.guarded(tenant, owner, operation, undefined, async () => {
        this.assertWritable(tenant);
        const spec = normalizedSpec(request.spec);
        if (spec.provider === 'gcp' && hostingOf(tenant) === 'verax') {
          throw new LogSourceRefusal('gcp_unsupported_managed');
        }
        const sourceId = randomUUID();
        // A conferência fora da transação, sem cifrar: o limite só gasta com um pedido que pode dar certo.
        this.planCreate(tenant, await this.snapshot(this.store, tenant.id), spec, request, sourceId, false);
        this.take(owner);
        return this.store.runTransaction(async (tx) => {
          const snapshot = await this.snapshot(tx, tenant.id);
          const sealed = this.planCreate(tenant, snapshot, spec, request, sourceId, true);
          const now = this.clock.now();
          const actor = `owner:${owner.email}`;
          const source: LogSource = logSourceSchema.parse({
            spec,
            state: 'active',
            revision: 1,
            credentialMeta: sealed === undefined ? null : credentialMetaOf(sealed, 1, now, actor),
            createdAt: now,
            createdBy: actor,
            updatedAt: now,
            updatedBy: actor,
          });
          tx.set(COLLECTIONS.logSources(tenant.id), sourceId, source);
          if (sealed !== undefined) this.writeSecret(tx, tenant.id, sourceId, sealed, 1, now);
          const generation = this.bump(tx, tenant.id, snapshot, now);
          this.recordOk(tx, tenant, owner, operation, {
            sourceId,
            provider: spec.provider,
            accountId: spec.accountId,
            revision: 1,
            generation,
            ...(sealed === undefined ? {} : sealedDetails(sealed, 1)),
          });
          return {
            source: this.sourceView(sourceId, source, undefined, sealed !== undefined, tenant, snapshot),
            generation,
          };
        });
      });
    } finally {
      for (const value of secrets) forgetLiveSecret(value);
    }
  }

  /** `PATCH .../log-sources/:sourceId`: os campos do provedor (o provedor e o ID da conta não mudam). */
  async update(
    tenantId: string,
    sourceId: string,
    body: unknown,
    owner: OwnerContext,
  ): Promise<LogSourceWriteResult> {
    const raw = body ?? {};
    if (typeof raw === 'object' && raw !== null && ('provider' in raw || 'accountId' in raw)) {
      throw invalidFields(
        ['provider', 'accountId']
          .filter((field) => field in raw)
          .map((path) => ({ path, message: REFUSALS.immutable_field.message })),
      );
    }
    const parsed = cloudAccountUpdateSchema.safeParse(raw);
    if (!parsed.success) throw invalidRequest(parsed.error);
    const update = parsed.data;
    if (update.status !== undefined) {
      // Desativar é remover (a lápide, com o subdomínio digitado): o console não pausa uma fonte.
      throw invalidFields([{ path: 'status', message: 'Para tirar a fonte do nó, use "Remover".' }]);
    }
    const tenant = await this.tenant(tenantId);
    const operation = 'log_source.update';
    return this.guarded(tenant, owner, operation, sourceId, async () => {
      this.assertWritable(tenant);
      const plan = (snapshot: Snapshot): { source: LogSource; spec: CloudAccountCreate } => {
        const source = activeSource(snapshot, sourceId);
        const outside = fieldsOutsideProvider(source.spec.provider, update);
        if (outside.length > 0) {
          throw invalidFields(
            outside.map((path) => ({ path, message: 'Campo que não existe no provedor desta fonte.' })),
          );
        }
        const next = cloudAccountCreateSchema.safeParse(mergedSpec(source.spec, update));
        if (!next.success) throw invalidRequest(next.error);
        const spec = normalizedSpec(next.data);
        if (equalValues(spec, source.spec)) throw new LogSourceRefusal('no_change', sourceId);
        return { source, spec };
      };
      plan(await this.snapshot(this.store, tenant.id));
      this.take(owner);
      return this.store.runTransaction(async (tx) => {
        const snapshot = await this.snapshot(tx, tenant.id);
        // Todas as leituras antes da primeira escrita (regra da transação do Firestore).
        const report = await tx.get(COLLECTIONS.logSourceReports(tenant.id), sourceId);
        const secret = await tx.get(COLLECTIONS.logSourceSecrets(tenant.id), sourceId);
        const { source, spec } = plan(snapshot);
        const now = this.clock.now();
        const next: LogSource = logSourceSchema.parse({
          ...source,
          spec,
          revision: source.revision + 1,
          updatedAt: now,
          updatedBy: `owner:${owner.email}`,
        });
        tx.set(COLLECTIONS.logSources(tenant.id), sourceId, next);
        const generation = this.bump(tx, tenant.id, snapshot, now);
        this.recordOk(tx, tenant, owner, operation, {
          sourceId,
          provider: spec.provider,
          accountId: spec.accountId,
          revision: next.revision,
          generation,
          fields: Object.keys(update).sort(),
        });
        return {
          source: this.sourceView(
            sourceId,
            next,
            reportOf(tenant.id, sourceId, report),
            secret !== undefined,
            tenant,
            snapshot,
          ),
          generation,
        };
      });
    });
  }

  /** `PUT .../log-sources/:sourceId/credential`: a credencial cifrada para o nó, numa revisão nova. */
  async credential(
    tenantId: string,
    sourceId: string,
    body: unknown,
    owner: OwnerContext,
  ): Promise<LogSourceWriteResult> {
    const parsed = cloudCredentialInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const input = parsed.data;
    const secrets = secretValuesOf(input);
    for (const value of secrets) registerLiveSecret(value);
    try {
      const tenant = await this.tenant(tenantId);
      const operation = 'log_source.credential';
      return await this.guarded(tenant, owner, operation, sourceId, async () => {
        this.assertWritable(tenant);
        const plan = (snapshot: Snapshot, seal: boolean) => {
          const source = activeSource(snapshot, sourceId);
          const sealed = this.seal(tenant, snapshot, sourceId, source.spec, input, seal);
          return { source, sealed, revision: (source.credentialMeta?.revision ?? 0) + 1 };
        };
        plan(await this.snapshot(this.store, tenant.id), false);
        this.take(owner);
        return this.store.runTransaction(async (tx) => {
          const snapshot = await this.snapshot(tx, tenant.id);
          const report = await tx.get(COLLECTIONS.logSourceReports(tenant.id), sourceId);
          const { source, sealed, revision } = plan(snapshot, true);
          if (sealed === undefined) throw new Error('credencial sem envelope');
          const now = this.clock.now();
          const actor = `owner:${owner.email}`;
          const next: LogSource = logSourceSchema.parse({
            ...source,
            credentialMeta: credentialMetaOf(sealed, revision, now, actor),
            updatedAt: now,
            updatedBy: actor,
          });
          tx.set(COLLECTIONS.logSources(tenant.id), sourceId, next);
          this.writeSecret(tx, tenant.id, sourceId, sealed, revision, now);
          const generation = this.bump(tx, tenant.id, snapshot, now);
          this.recordOk(tx, tenant, owner, operation, {
            sourceId,
            provider: source.spec.provider,
            accountId: source.spec.accountId,
            revision: source.revision,
            generation,
            ...sealedDetails(sealed, revision),
          });
          return {
            source: this.sourceView(
              sourceId,
              next,
              reportOf(tenant.id, sourceId, report),
              true,
              tenant,
              snapshot,
            ),
            generation,
          };
        });
      });
    } finally {
      for (const value of secrets) forgetLiveSecret(value);
    }
  }

  /** `POST .../log-sources/:sourceId/remove`: a lápide (o nó desativa a conta), com o subdomínio digitado. */
  async remove(
    tenantId: string,
    sourceId: string,
    body: unknown,
    owner: OwnerContext,
  ): Promise<LogSourceWriteResult> {
    const parsed = logSourceRemoveRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const tenant = await this.tenant(tenantId);
    const operation = 'log_source.remove';
    return this.guarded(tenant, owner, operation, sourceId, async () => {
      if (parsed.data.confirmSlug !== tenant.slug)
        throw new LogSourceRefusal('confirmation_mismatch', sourceId);
      activeSource(await this.snapshot(this.store, tenant.id), sourceId);
      this.take(owner);
      return this.store.runTransaction(async (tx) => {
        const snapshot = await this.snapshot(tx, tenant.id);
        const report = await tx.get(COLLECTIONS.logSourceReports(tenant.id), sourceId);
        const source = activeSource(snapshot, sourceId);
        const now = this.clock.now();
        const next: LogSource = logSourceSchema.parse({
          ...source,
          state: 'removed',
          revision: source.revision + 1,
          updatedAt: now,
          updatedBy: `owner:${owner.email}`,
        });
        tx.set(COLLECTIONS.logSources(tenant.id), sourceId, next);
        // O envelope pendente sai junto: a fonte removida nunca recebe credencial.
        tx.delete(COLLECTIONS.logSourceSecrets(tenant.id), sourceId);
        const generation = this.bump(tx, tenant.id, snapshot, now);
        this.recordOk(tx, tenant, owner, operation, {
          sourceId,
          provider: source.spec.provider,
          accountId: source.spec.accountId,
          revision: next.revision,
          generation,
        });
        return {
          source: this.sourceView(
            sourceId,
            next,
            reportOf(tenant.id, sourceId, report),
            false,
            tenant,
            snapshot,
          ),
          generation,
        };
      });
    });
  }

  private async tenant(tenantId: string): Promise<TenantRecord> {
    if (!isUlid(tenantId)) throw notFound();
    const tenant = await this.tenants.get(tenantId);
    if (tenant === undefined) throw notFound();
    return tenant;
  }

  /** O contrato ainda vale e o cliente não é da célula (as fontes da célula têm outro caminho). */
  private assertWritable(tenant: TenantRecord): void {
    if (tenant.placement !== undefined) throw new LogSourceRefusal('placement_unsupported');
    if (tenant.state === 'canceled' || tenant.state === 'deleted') throw new LogSourceRefusal('not_allowed');
  }

  private take(owner: OwnerContext): void {
    if (!this.limits.operations.take(owner.email).allowed) throw new LogSourceRefusal('rate_limited');
  }

  /** Roda a escrita; uma recusa (ou um 400 depois do cliente encontrado) vai à auditoria antes da resposta. */
  private async guarded<T>(
    tenant: TenantRecord,
    owner: OwnerContext,
    operation: LogSourceOperation,
    sourceId: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof LogSourceRefusal) {
        await this.refuse(tenant, owner, operation, error.code, error.sourceId ?? sourceId);
        throw refusalError(error.code);
      }
      if (error instanceof ApiError && error.code === 'invalid_request') {
        await this.refuse(tenant, owner, operation, 'invalid_request', sourceId);
      }
      throw error;
    }
  }

  private async snapshot(reader: DocumentReader, tenantId: string): Promise<Snapshot> {
    const collection = COLLECTIONS.nodeSync(tenantId);
    const stateData = await reader.get(collection, NODE_SYNC_STATE_DOC);
    const desiredData = await reader.get(collection, NODE_SYNC_DESIRED_DOC);
    const oauthData = await reader.get(collection, NODE_SYNC_CLOUDFLARE_OAUTH_DOC);
    const sources = await readCollection(reader, COLLECTIONS.logSources(tenantId), logSourceSchema);
    const state =
      stateData === undefined
        ? undefined
        : parseDocument(nodeSyncStateSchema, collection, NODE_SYNC_STATE_DOC, stateData);
    return {
      state,
      cloudflareOauth: announcesCloudflareOauth(state, oauthData),
      generation:
        desiredData === undefined
          ? 0
          : parseDocument(nodeSyncDesiredSchema, collection, NODE_SYNC_DESIRED_DOC, desiredData).generation,
      sources,
    };
  }

  /** As regras do cadastro sobre a leitura (fora ou dentro da transação); com `seal`, o envelope pronto. */
  private planCreate(
    tenant: TenantRecord,
    snapshot: Snapshot,
    spec: CloudAccountCreate,
    request: LogSourceCreateRequest,
    sourceId: string,
    seal: boolean,
  ): Sealed | undefined {
    const duplicate = [...snapshot.sources.values()].some(
      (source) =>
        source.state === 'active' &&
        source.spec.provider === spec.provider &&
        source.spec.accountId === spec.accountId,
    );
    if (duplicate) throw new LogSourceRefusal('source_exists');
    if (snapshot.sources.size >= NODE_SYNC_MAX_SOURCES) throw new LogSourceRefusal('source_limit');
    if (request.credential === undefined) return undefined;
    return this.seal(tenant, snapshot, sourceId, spec, request.credential, seal);
  }

  /**
   * A credencial para o nó deste cliente: o tipo do provedor da fonte e da plataforma do nó, o nó sincronizado com o
   * cofre, a chave pública conferida pela impressão digital. Sem `seal`, só confere.
   */
  private seal(
    tenant: TenantRecord,
    snapshot: Snapshot,
    sourceId: string,
    spec: CloudAccountCreate,
    input: CloudCredentialInput,
    seal: boolean,
  ): Sealed | undefined {
    if (CREDENTIAL_KIND_PROVIDERS[input.kind] !== spec.provider) {
      throw new LogSourceRefusal('credential_provider_mismatch', sourceId);
    }
    const platform = platformOf(hostingOf(tenant));
    if (!credentialKindAllowed(input.kind, platform)) {
      throw new LogSourceRefusal('credential_kind_not_allowed', sourceId);
    }
    if (this.isOauthOnly(tenant, snapshot, input.kind)) {
      throw new LogSourceRefusal('cloudflare_oauth_only', sourceId);
    }
    const { state } = snapshot;
    const checked = nodeVaultOf(state, platform);
    if (!checked.ok) {
      if (checked.code === 'vault_key_invalid') {
        this.logger.error(
          {
            event: 'admin_log_source_vault_key_invalid',
            tenantId: tenant.id,
            keyVersion: state?.vaultKey?.version,
          },
          'a chave do cofre informada pelo nó não confere',
        );
      }
      throw new LogSourceRefusal(checked.code, sourceId);
    }
    const { vault } = checked;
    if (!seal) return undefined;
    const binding = {
      tenantId: vault.nodeTenantId,
      cloudAccountId: sourceId,
      kind: input.kind,
      accountId: spec.accountId,
    };
    const sealed = sealCredential(vault.publicKey, binding, payloadOf(input));
    return {
      kind: input.kind,
      envelope: sealed.ciphertext,
      keyVersion: sealed.keyVersion,
      fingerprint: vault.fingerprint,
      nodeTenantId: vault.nodeTenantId,
    };
  }

  /**
   * Token colado do Cloudflare num cliente que conecta por OAuth: liberado na configuração, no servidor gerenciado, e com
   * o nó anunciando a conexão. Um nó que ainda não a conhece segue no token, como sempre.
   */
  private isOauthOnly(tenant: TenantRecord, snapshot: Snapshot, kind: CloudCredentialInput['kind']): boolean {
    const settings = cloudflareOauthSettings(this.config);
    return (
      kind === 'cloudflare_api_token' &&
      settings !== null &&
      snapshot.cloudflareOauth &&
      isTenantReleased(settings, tenant)
    );
  }

  private writeSecret(
    tx: DocumentTransaction,
    tenantId: string,
    sourceId: string,
    sealed: Sealed,
    revision: number,
    now: Date,
  ): void {
    tx.set(
      COLLECTIONS.logSourceSecrets(tenantId),
      sourceId,
      logSourceSecretSchema.parse({
        revision,
        kind: sealed.kind,
        envelope: sealed.envelope,
        fingerprint: sealed.fingerprint,
        nodeTenantId: sealed.nodeTenantId,
        createdAt: now,
        expiresAt: new Date(now.getTime() + LOG_SOURCE_SECRET_TTL_MS),
      }),
    );
  }

  /** A geração do estado desejado, um passo acima, na mesma transação da mudança. */
  private bump(tx: DocumentTransaction, tenantId: string, snapshot: Snapshot, now: Date): number {
    const generation = snapshot.generation + 1;
    tx.set(
      COLLECTIONS.nodeSync(tenantId),
      NODE_SYNC_DESIRED_DOC,
      nodeSyncDesiredSchema.parse({ generation, updatedAt: now }),
    );
    return generation;
  }

  private recordOk(
    tx: DocumentTransaction,
    tenant: TenantRecord,
    owner: OwnerContext,
    operation: LogSourceOperation,
    details: Record<string, unknown>,
  ): void {
    this.audit.record(tx, {
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request',
      tenantId: tenant.id,
      // Nunca o texto claro nem o envelope: o tipo, a revisão e a impressão digital da chave do cofre.
      details: { operation, outcome: 'ok', ...details },
      requestId: owner.requestId,
    });
    this.logger.info(
      {
        event: 'admin_log_source',
        tenantId: tenant.id,
        operation,
        sourceId: details['sourceId'],
        provider: details['provider'],
        revision: details['revision'],
        generation: details['generation'],
      },
      'fonte de log gravada no estado desejado',
    );
  }

  private async refuse(
    tenant: TenantRecord,
    owner: OwnerContext,
    operation: LogSourceOperation,
    code: LogSourceRefusalCode | 'invalid_request',
    sourceId: string | undefined,
  ): Promise<void> {
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request_refused',
      tenantId: tenant.id,
      details: {
        operation,
        code,
        state: tenant.state,
        ...(sourceId === undefined || !LOG_SOURCE_ID_PATTERN.test(sourceId) ? {} : { sourceId }),
      },
      requestId: owner.requestId,
    });
    this.logger.info(
      { event: 'admin_log_source_refused', tenantId: tenant.id, operation, code },
      'escrita de fonte de log recusada',
    );
  }

  private sourceView(
    id: string,
    source: LogSource,
    stored: LogSourceReport | undefined,
    envelopeStored: boolean,
    tenant: TenantRecord,
    snapshot: Snapshot,
  ): LogSourceView {
    const { state } = snapshot;
    const hosting = hostingOf(tenant);
    const { status, code, pending } = sourceStatusOf(source, stored?.report);
    const spec = source.spec;
    const meta = source.credentialMeta;
    const credential: LogSourceCredentialView | null =
      meta === null
        ? null
        : {
            kind: meta.kind,
            revision: meta.revision,
            keyVersion: meta.keyVersion,
            fingerprint: meta.fingerprint,
            submittedAt: meta.submittedAt,
            submittedBy: meta.submittedBy,
            envelopeStored,
          };
    const egressIps =
      hosting === 'verax' ? natEgressIps(tenant) : (state?.egressIps ?? []).filter(isNodeEgressIp);
    const cloudflareToken: CloudflareTokenView | null =
      spec.provider === 'cloudflare' && !this.isOauthOnly(tenant, snapshot, 'cloudflare_api_token')
        ? { templateUrl: cloudflareTokenTemplateUrl(), tokenName: CLOUDFLARE_TOKEN_NAME, egressIps }
        : null;
    return {
      id,
      spec,
      state: source.state,
      revision: source.revision,
      credential,
      report: stored === undefined ? null : { ...stored.report, reportedAt: stored.reportedAt },
      pending,
      status,
      code,
      awsStack: spec.provider === 'aws' && hosting === 'verax' ? awsStackOf(spec, tenant, state) : null,
      readKeys: hosting === 'customer' ? readKeysOf(spec, state?.egressIps ?? []) : null,
      cloudflareToken,
      createdAt: source.createdAt,
      createdBy: source.createdBy,
      updatedAt: source.updatedAt,
      updatedBy: source.updatedBy,
    };
  }
}

/** O motivo do bloqueio da criação de usuários, sem a chave do cofre. */
function blockOf(result: ReturnType<typeof nodeUserBlockOf>): NodeUserBlock | null {
  return result.ok ? null : result.code;
}

/** A fonte ativa da leitura: inexistente (ou de id fora do formato), 404; removida, 409. */
function activeSource(snapshot: Snapshot, sourceId: string): LogSource {
  const source = LOG_SOURCE_ID_PATTERN.test(sourceId) ? snapshot.sources.get(sourceId) : undefined;
  if (source === undefined) throw new LogSourceRefusal('source_not_found');
  if (source.state === 'removed') throw new LogSourceRefusal('source_removed', sourceId);
  return source;
}

function credentialMetaOf(
  sealed: Sealed,
  revision: number,
  now: Date,
  actor: string,
): LogSource['credentialMeta'] {
  return {
    revision,
    kind: sealed.kind,
    keyVersion: sealed.keyVersion,
    fingerprint: sealed.fingerprint,
    submittedAt: now,
    submittedBy: actor,
  };
}

/** Os metadados da credencial na auditoria (os nomes fogem da máscara por nome de campo, que ocultaria o valor). */
function sealedDetails(sealed: Sealed, revision: number): Record<string, unknown> {
  return {
    keyKind: sealed.kind,
    keyRevision: revision,
    keyVersion: sealed.keyVersion,
    fingerprint: sealed.fingerprint,
  };
}

function reportOf(
  tenantId: string,
  sourceId: string,
  data: Record<string, unknown> | undefined,
): LogSourceReport | undefined {
  if (data === undefined) return undefined;
  return parseDocument(logSourceReportSchema, COLLECTIONS.logSourceReports(tenantId), sourceId, data);
}

function nodeViewOf(state: NodeSyncState, platform: NodePlatform, now: Date): NodeSyncView {
  const vaultKey = state.vaultKey;
  return {
    lastSeenAt: state.lastSeenAt,
    stale: now.getTime() - state.lastSeenAt.getTime() > NODE_STALE_AFTER_MS,
    platform: state.platform,
    platformMismatch: state.platform !== platform,
    commit: state.commit,
    capabilities: [...state.capabilities],
    authKind: state.authKind,
    nodeTenantId: state.nodeTenantId,
    vaultReady: vaultKey !== null && state.nodeTenantId !== null && state.error !== 'vault_unreadable',
    keyVersion: vaultKey?.version ?? null,
    fingerprint: vaultKey?.fingerprint ?? null,
    keySince: vaultKey?.since ?? null,
    serviceAccountId: state.serviceAccountId,
    egressIps: [...state.egressIps],
    audience: state.audience,
    error: state.error,
  };
}
