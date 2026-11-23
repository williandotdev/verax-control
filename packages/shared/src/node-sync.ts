import { z } from 'zod';
import {
  isNodeEgressIp,
  isNodeServiceAccountId,
  isWebIdentityAudience,
  MAX_AUDIENCE_LENGTH,
} from './aws-reader.js';
import {
  AWS_COLLECTION_ERROR_CODES,
  CLOUD_ACCOUNT_CONNECTIONS,
  CLOUD_ACCOUNT_STATUSES,
  cloudAccountCreateSchema,
  cloudAccountSchema,
} from './cloud-accounts.js';
import {
  ACCEPTED_CREDENTIAL_KINDS,
  CLOUD_CREDENTIAL_KINDS,
  CREDENTIAL_KIND_PROVIDERS,
  NODE_PLATFORMS,
} from './cloud-credentials.js';
import { cloudflareOauthConfigSchema } from './cloudflare-oauth.js';
import { TENANT_ROLES, USER_STATUSES, userCreateSchema } from './users.js';

/**
 * Sincronização do nó dedicado com o plano de controle: o nó chama `POST /v1/node-sync` no `cp-public` a cada 5 minutos
 * (com o token de identidade do Google, no nó da GCP, ou com a chave do nó, na VM própria do cliente), conta o que
 * aplicou e recebe o estado desejado: as fontes de log que o responsável cadastrou no console e os usuários que a
 * Verax criou para o cliente.
 *
 * - O cliente sai sempre da credencial do nó, nunca do corpo: nenhum dos dois lados manda o id do cliente do plano de
 *   controle. O `node.tenantId` é o id do cliente no banco do nó, o do rótulo dos envelopes.
 * - Os segredos (a credencial da fonte, a senha temporária do usuário) só viajam em envelope, cifrados com a chave
 *   pública do cofre do nó (`@verax/vault-envelope`); só o worker do nó abre.
 * - Remoção só por lápide explícita (`state: 'removed'`): uma lista vazia ou incompleta nunca apaga nada no nó.
 * - O plano de controle só responde a seção de uma capacidade que o nó anunciou (`respondsTo`).
 *
 * Tudo é estrito dos dois lados: campo a mais, código desconhecido ou versão diferente recusa a mensagem inteira. Uma
 * mudança no contrato sobe `NODE_SYNC_PROTOCOL` (ou entra como capacidade nova), e o plano de controle sobe antes.
 *
 * Nada aqui usa `node:crypto`: o pacote também vai para o navegador.
 */
export const NODE_SYNC_PROTOCOL = 1 as const;

/** Rota pública do plano de controle. */
export const NODE_SYNC_PATH = '/v1/node-sync' as const;

/**
 * O que o nó sabe aplicar: é a lista que o plano de controle aceita, e cada nó anuncia só o que usa. Uma capacidade entra
 * aqui antes de algum nó a anunciar, porque o plano de controle anterior recusa a chamada inteira com uma que não
 * conhece: o plano de controle sobe antes. `cloudflare_oauth` (a seção `cloudflareOauth`) ainda não é anunciada por nó
 * nenhum. A próxima prevista é `plan_limits`.
 */
export const NODE_SYNC_CAPABILITIES = ['log_sources', 'users', 'cloudflare_oauth'] as const;
export type NodeSyncCapability = (typeof NODE_SYNC_CAPABILITIES)[number];

/** Intervalo da sincronização no nó, em segundos, com uma variação aleatória de até ±30 s. */
export const NODE_SYNC_INTERVAL_SECONDS = 300;
export const NODE_SYNC_JITTER_SECONDS = 30;
/** Limites do `pollAfterSeconds` da resposta: o plano de controle pode espaçar ou apressar a próxima chamada. */
export const NODE_SYNC_POLL_MIN_SECONDS = 60;
export const NODE_SYNC_POLL_MAX_SECONDS = 3600;
/** Diferença aceita entre o `sentAt` do nó e o relógio do plano de controle. */
export const NODE_SYNC_MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
/** O maior corpo do pedido, em bytes (o limite da rota no `cp-public`). */
export const NODE_SYNC_REQUEST_MAX_BYTES = 256 * 1024;
/** O maior corpo da resposta que o nó lê, em bytes. */
export const NODE_SYNC_RESPONSE_MAX_BYTES = 1024 * 1024;

export const NODE_SYNC_MAX_CAPABILITIES = 8;
export const NODE_SYNC_MAX_SOURCES = 500;
export const NODE_SYNC_MAX_USERS = 200;
export const NODE_SYNC_MAX_EGRESS_IPS = 16;
/** O maior envelope: o tamanho da coluna `CloudCredential.ciphertext` do nó. */
export const NODE_SYNC_MAX_ENVELOPE_LENGTH = 8192;
/** A chave pública do cofre em base64 do PEM (SPKI): a RSA-4096 dá cerca de 1.070 caracteres. */
export const NODE_SYNC_MAX_PUBLIC_KEY_LENGTH = 1400;
/** A maior revisão de uma fonte (cabe no `Int` do banco do nó). */
export const NODE_SYNC_MAX_REVISION = 2_147_483_647;
const MAX_KEY_VERSION = 999_999_999;

/** `v<versão da chave>:<base64>`, o formato do envelope do cofre do nó (`@verax/vault-envelope`). */
export const NODE_SYNC_ENVELOPE_PATTERN = /^v[1-9][0-9]{0,8}:[A-Za-z0-9+/]+={0,2}$/;

/** A resposta tem a seção desta capacidade? Só se o nó a anunciou no pedido. */
export function respondsTo(capabilities: readonly string[], capability: NodeSyncCapability): boolean {
  return capabilities.includes(capability);
}

/**
 * Por que uma fonte (ou a credencial dela) não foi aplicada no nó:
 * - `invalid_spec`: o cadastro não passa nas regras do nó;
 * - `immutable_changed`: a revisão nova troca o provedor ou o ID da conta (outra conta é outra fonte);
 * - `tenant_ambiguous`: o banco do nó tem mais de um cliente;
 * - `plan_limit_reached` / `tenant_plan_missing`: sem vaga no plano do cliente, ou o nó ainda sem o plano;
 * - `account_exists_panel`: a conta já foi cadastrada pelo cliente no painel (o nó nunca mexe nela);
 * - `origin_conflict`: um bucket, assinatura ou zona já é de outra conta;
 * - `vault_disabled`: o nó está sem o cofre de credenciais;
 * - `credential_kind_not_allowed`: o tipo de credencial não vale na plataforma do nó;
 * - `credential_unreadable`: o envelope não abre (versão da chave ausente, outra amarração);
 * - `credential_rejected_<motivo>`: a origem recusou a credencial na conferência;
 * - `deleted_in_panel`: o cliente excluiu a conta no painel dele; o nó só a cadastra de novo com uma revisão maior;
 * - `source_unavailable`: a origem não respondeu (o nó tenta de novo, com espera crescente);
 * - `internal_error`: qualquer outra falha (detalhe só no log do nó).
 */
export const NODE_SYNC_SOURCE_CODES = [
  'invalid_spec',
  'immutable_changed',
  'tenant_ambiguous',
  'plan_limit_reached',
  'tenant_plan_missing',
  'account_exists_panel',
  'origin_conflict',
  'vault_disabled',
  'credential_kind_not_allowed',
  'credential_unreadable',
  'credential_rejected_invalid',
  'credential_rejected_inactive',
  'credential_rejected_expired',
  'credential_rejected_not_yet_valid',
  'credential_rejected_no_account_access',
  'credential_rejected_wrong_identity',
  'deleted_in_panel',
  'source_unavailable',
  'internal_error',
] as const;
export type NodeSyncSourceCode = (typeof NODE_SYNC_SOURCE_CODES)[number];

/**
 * Por que um usuário pedido pela Verax não foi criado no nó: e-mail já usado, sem vaga no plano (ou o nó sem o plano),
 * pedido vencido (`notAfter` no passado), cofre desligado, envelope que não abre, mais de um cliente no banco, a
 * criação de usuários desligada no nó (`CONTROL_PLANE_USERS=false`) ou outra falha.
 */
export const NODE_SYNC_USER_CODES = [
  'email_taken',
  'plan_limit_reached',
  'tenant_plan_missing',
  'expired',
  'vault_disabled',
  'envelope_unreadable',
  'tenant_ambiguous',
  'users_disabled',
  'internal_error',
] as const;
export type NodeSyncUserCode = (typeof NODE_SYNC_USER_CODES)[number];

/** Problema do nó inteiro, que impede aplicar qualquer item: mais de um cliente no banco ou o cofre ilegível. */
export const NODE_SYNC_NODE_ERRORS = ['tenant_ambiguous', 'vault_unreadable'] as const;
export type NodeSyncNodeError = (typeof NODE_SYNC_NODE_ERRORS)[number];

/** UUID em minúsculas (o id do cliente no banco do nó e o id da fonte), como vai no rótulo do envelope. */
const lowerUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, { error: 'id inválido' });

/** Id do pedido de criação de usuário no plano de controle: ULID. */
const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, { error: 'id inválido' });

/** Instante em UTC, ISO 8601 com `Z` (como `Date.toISOString()`). */
const instantSchema = z.iso.datetime({ error: 'instante inválido: use ISO 8601 em UTC' });

const revisionSchema = z.number().int().min(1).max(NODE_SYNC_MAX_REVISION);

const envelopeSchema = z
  .string()
  .max(NODE_SYNC_MAX_ENVELOPE_LENGTH)
  .regex(NODE_SYNC_ENVELOPE_PATTERN, { error: 'envelope inválido' });

/** Sem repetição: dois itens com o mesmo id na mesma mensagem recusam a mensagem. */
function unique<T>(key: (item: T) => string) {
  return (items: readonly T[]) => new Set(items.map(key)).size === items.length;
}

/** O código acompanha a falha: presente em `failed`, ausente nos demais resultados. */
function codeMatchesOutcome(item: { outcome: string; code: string | null }): boolean {
  return (item.outcome === 'failed') === (item.code !== null);
}

/** A chave pública corrente do cofre do nó, o que o plano de controle usa para cifrar para ele. */
export const nodeSyncVaultKeySchema = z.strictObject({
  version: z.number().int().min(1).max(MAX_KEY_VERSION),
  /** O PEM da chave pública (SPKI, `BEGIN PUBLIC KEY`) em base64, numa linha. */
  publicKey: z
    .string()
    .max(NODE_SYNC_MAX_PUBLIC_KEY_LENGTH)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, { error: 'chave pública inválida' }),
  /** SHA-256 do DER do SPKI, em hexadecimal minúsculo. */
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, { error: 'impressão digital inválida' }),
});
export type NodeSyncVaultKey = z.infer<typeof nodeSyncVaultKeySchema>;

/** O que o nó informa de si a cada chamada. */
export const nodeSyncNodeSchema = z.strictObject({
  /** O commit da versão do nó (40 hexadecimais). */
  commit: z.string().regex(/^[0-9a-f]{40}$/, { error: 'commit inválido' }),
  platform: z.enum(NODE_PLATFORMS),
  /** Só o nó dedicado sincroniza; a célula compartilhada tem o canal dela (`cell-protocol.ts`). */
  mode: z.literal('dedicated'),
  /** O id do cliente no banco do nó (o do rótulo dos envelopes); null antes do primeiro cliente ou com mais de um. */
  tenantId: lowerUuidSchema.nullable(),
  /** Null no nó sem o cofre de credenciais. */
  vaultKey: nodeSyncVaultKeySchema.nullable(),
  /** O ID único da conta de serviço do nó no Google (21 dígitos); null na VM própria do cliente. */
  serviceAccountId: z
    .string()
    .refine(isNodeServiceAccountId, { error: 'conta de serviço inválida' })
    .nullable(),
  /** IPs de saída do nó (IPv4 com /32). */
  egressIps: z
    .array(z.string().max(18).refine(isNodeEgressIp, { error: 'IP de saída inválido' }))
    .max(NODE_SYNC_MAX_EGRESS_IPS),
  /** O audience do token do nó para a AWS (`Audience` da pilha de leitura). */
  audience: z.string().max(MAX_AUDIENCE_LENGTH).refine(isWebIdentityAudience, { error: 'audience inválido' }),
  error: z.enum(NODE_SYNC_NODE_ERRORS).nullable(),
});
export type NodeSyncNode = z.infer<typeof nodeSyncNodeSchema>;

/** A credencial da fonte como está no nó: a do console (com a revisão) ou a colada no painel (revisão null). */
export const nodeSyncCredentialReportSchema = z
  .strictObject({
    /** A revisão da credencial do console que o nó processou; null quando a vigente foi colada no painel. */
    revision: revisionSchema.nullable(),
    outcome: z.enum(['applied', 'failed']),
    code: z.enum(NODE_SYNC_SOURCE_CODES).nullable(),
    kind: z.enum(CLOUD_CREDENTIAL_KINDS).nullable(),
    /** Os 4 últimos caracteres do ID da credencial na origem, nunca do segredo. */
    keyIdSuffix: z
      .string()
      .regex(/^[A-Za-z0-9_-]{4}$/)
      .nullable(),
    expiresAt: instantSchema.nullable(),
    verifiedAt: instantSchema.nullable(),
  })
  .refine(codeMatchesOutcome, { error: 'código incompatível com o resultado' });
export type NodeSyncCredentialReport = z.infer<typeof nodeSyncCredentialReportSchema>;

/** A conta como está no nó: os mesmos campos (e regras) de `cloudAccountSchema`. */
export const nodeSyncAccountReportSchema = z.strictObject({
  status: z.enum(CLOUD_ACCOUNT_STATUSES),
  connection: z.enum(CLOUD_ACCOUNT_CONNECTIONS),
  connectionError: cloudAccountSchema.shape.connectionError,
  collectionError: z.enum(AWS_COLLECTION_ERROR_CODES).nullable(),
  ingestFrom: cloudAccountSchema.shape.ingestFrom,
  lastEventAt: instantSchema.nullable(),
  lastCollectedAt: cloudAccountSchema.shape.lastCollectedAt,
  checkRequestedAt: cloudAccountSchema.shape.checkRequestedAt,
});
export type NodeSyncAccountReport = z.infer<typeof nodeSyncAccountReportSchema>;

/** O que o nó fez com a última revisão que recebeu de uma fonte. */
export const nodeSyncSourceReportSchema = z
  .strictObject({
    id: lowerUuidSchema,
    /** A última revisão desejada que o nó processou. */
    revision: revisionSchema,
    outcome: z.enum(['applied', 'failed', 'removed']),
    code: z.enum(NODE_SYNC_SOURCE_CODES).nullable(),
    credential: nodeSyncCredentialReportSchema.nullable(),
    account: nodeSyncAccountReportSchema.nullable(),
  })
  .refine(codeMatchesOutcome, { error: 'código incompatível com o resultado' });
export type NodeSyncSourceReport = z.infer<typeof nodeSyncSourceReportSchema>;

/** O que o nó fez com um pedido de usuário. A senha nunca volta. */
export const nodeSyncUserReportSchema = z
  .strictObject({
    requestId: ulidSchema,
    outcome: z.enum(['created', 'failed']),
    code: z.enum(NODE_SYNC_USER_CODES).nullable(),
    user: z
      .strictObject({
        status: z.enum(USER_STATUSES),
        mfaEnabled: z.boolean(),
        mustChangePassword: z.boolean(),
      })
      .nullable(),
  })
  .refine(codeMatchesOutcome, { error: 'código incompatível com o resultado' })
  .refine((report) => report.outcome !== 'created' || report.user !== null, {
    error: 'usuário criado sem a situação dele',
  });
export type NodeSyncUserReport = z.infer<typeof nodeSyncUserReportSchema>;

/** Corpo do `POST /v1/node-sync`. */
export const nodeSyncRequestSchema = z.strictObject({
  protocol: z.literal(NODE_SYNC_PROTOCOL),
  /** Cresce a cada chamada (guardado no banco do nó): o plano de controle recusa repetição (`stale_sequence`). */
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sentAt: instantSchema,
  capabilities: z
    .array(z.enum(NODE_SYNC_CAPABILITIES))
    .max(NODE_SYNC_MAX_CAPABILITIES)
    .refine(
      unique((capability: string) => capability),
      { error: 'capacidade repetida' },
    ),
  node: nodeSyncNodeSchema,
  sources: z
    .array(nodeSyncSourceReportSchema)
    .max(NODE_SYNC_MAX_SOURCES)
    .refine(
      unique((source: { id: string }) => source.id),
      { error: 'fonte repetida' },
    ),
  users: z
    .array(nodeSyncUserReportSchema)
    .max(NODE_SYNC_MAX_USERS)
    .refine(
      unique((user: { requestId: string }) => user.requestId),
      { error: 'pedido repetido' },
    ),
});
export type NodeSyncRequest = z.infer<typeof nodeSyncRequestSchema>;

/** A credencial desejada de uma fonte, cifrada para o cofre do nó. */
export const nodeSyncDesiredCredentialSchema = z.strictObject({
  revision: revisionSchema,
  kind: z.enum(ACCEPTED_CREDENTIAL_KINDS),
  envelope: envelopeSchema,
});
export type NodeSyncDesiredCredential = z.infer<typeof nodeSyncDesiredCredentialSchema>;

/**
 * Uma fonte desejada: o cadastro como o painel o aceita (`cloudAccountCreateSchema`), a revisão e, quando o
 * responsável colou no console, a credencial. A lápide (`removed`) mantém o cadastro e não leva credencial.
 */
export const nodeSyncDesiredSourceSchema = z
  .strictObject({
    /** O id da fonte, escolhido pelo plano de controle: vira o id da conta no banco do nó. */
    id: lowerUuidSchema,
    revision: revisionSchema,
    state: z.enum(['active', 'removed']),
    spec: cloudAccountCreateSchema,
    credential: nodeSyncDesiredCredentialSchema.nullable(),
  })
  .refine((source) => source.state === 'active' || source.credential === null, {
    error: 'fonte removida não leva credencial',
  })
  .refine(
    (source) =>
      source.credential === null ||
      CREDENTIAL_KIND_PROVIDERS[source.credential.kind] === source.spec.provider,
    { error: 'o tipo da credencial não é do provedor da fonte' },
  );
export type NodeSyncDesiredSource = z.infer<typeof nodeSyncDesiredSourceSchema>;

/** Um usuário que a Verax pediu: a senha temporária só no envelope, que vale até `notAfter`. */
export const nodeSyncDesiredUserSchema = z.strictObject({
  requestId: ulidSchema,
  name: userCreateSchema.shape.name,
  email: userCreateSchema.shape.email,
  role: z.enum(TENANT_ROLES),
  envelope: envelopeSchema,
  notAfter: instantSchema,
});
export type NodeSyncDesiredUser = z.infer<typeof nodeSyncDesiredUserSchema>;

/** Resposta do `POST /v1/node-sync`. Cada seção só vem quando o nó anunciou a capacidade dela. */
export const nodeSyncResponseSchema = z.strictObject({
  protocol: z.literal(NODE_SYNC_PROTOCOL),
  /** Cresce a cada mudança do estado desejado no console. */
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  pollAfterSeconds: z.number().int().min(NODE_SYNC_POLL_MIN_SECONDS).max(NODE_SYNC_POLL_MAX_SECONDS),
  sources: z
    .array(nodeSyncDesiredSourceSchema)
    .max(NODE_SYNC_MAX_SOURCES)
    .refine(
      unique((source: { id: string }) => source.id),
      { error: 'fonte repetida' },
    )
    .optional(),
  users: z
    .array(nodeSyncDesiredUserSchema)
    .max(NODE_SYNC_MAX_USERS)
    .refine(
      unique((user: { requestId: string }) => user.requestId),
      { error: 'pedido repetido' },
    )
    .optional(),
  /**
   * A configuração do app do Cloudflare (sem segredo) ou null, desligada: novas conexões só pelo token colado. Desligar
   * não derruba as conexões já feitas. Sem a seção, o nó não anunciou a capacidade.
   */
  cloudflareOauth: cloudflareOauthConfigSchema.nullable().optional(),
});
export type NodeSyncResponse = z.infer<typeof nodeSyncResponseSchema>;
