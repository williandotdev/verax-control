import {
  ACCEPTED_CREDENTIAL_KINDS,
  cloudAccountCreateSchema,
  NODE_PLATFORMS,
  NODE_SYNC_CAPABILITIES,
  type NodeSyncCapability,
  NODE_SYNC_ENVELOPE_PATTERN,
  NODE_SYNC_MAX_CAPABILITIES,
  NODE_SYNC_MAX_ENVELOPE_LENGTH,
  NODE_SYNC_MAX_REVISION,
  nodeSyncDesiredUserSchema,
  nodeSyncNodeSchema,
  nodeSyncSourceReportSchema,
  nodeSyncUserReportSchema,
  nodeSyncVaultKeySchema,
} from '@verax/shared';
import { z } from 'zod';
import { auditActorSchema } from '../audit/audit.service.js';

/**
 * Os documentos da sincronização do nó no Firestore, sob `tenants/{id}` (`COLLECTIONS.nodeSync`, `logSources` etc.;
 * docs/ARQUITETURA.md, "Sincronização com o plano de controle"). Estritos: campo a mais ou fora do formato é documento
 * inválido (`parseDocument`), e a sincronização daquele cliente para com 503 até alguém olhar, em vez de mandar ao nó
 * algo que ninguém conferiu.
 *
 * Quem grava o quê:
 * - o cp-worker (a cada chamada do nó): `nodeSync/state`, os relatos (`logSourceReports`, `nodeUserReports`) e a
 *   remoção dos envelopes consumidos (`logSourceSecrets`, `nodeUserSecrets`);
 * - o console (`cp-admin`, PR seguinte): `nodeSync/desired`, `logSources`, `nodeUsers` e os envelopes.
 *
 * Nenhum documento guarda texto claro de segredo: só o envelope cifrado com a chave pública do cofre do nó, que só o
 * worker do nó abre (`@verax/vault-envelope`).
 */

/** Os ids dos dois documentos de `tenants/{id}/nodeSync`. */
export const NODE_SYNC_STATE_DOC = 'state';
export const NODE_SYNC_DESIRED_DOC = 'desired';
/** O terceiro, só de quem anuncia `cloudflare_oauth` (`nodeCloudflareOauthSchema`). */
export const NODE_SYNC_CLOUDFLARE_OAUTH_DOC = 'cloudflareOauth';

/**
 * As capacidades gravadas em `nodeSync/state`: só as que toda versão do plano de controle em uso sabe ler. O documento é
 * estrito, e uma capacidade nova ali faria a versão anterior, numa volta de versão, recusar o estado inteiro do nó (a
 * sincronização e as telas dele). As novas ficam em documento próprio, que a versão anterior nunca lê.
 */
export const STORED_NODE_CAPABILITIES: ReadonlySet<NodeSyncCapability> = new Set(['log_sources', 'users']);

/** Os envelopes de fonte valem 7 dias no Firestore (o TTL de `expiresAt`); o cp-worker apaga antes. */
export const LOG_SOURCE_SECRET_TTL_MS = 7 * 24 * 60 * 60_000;
/** O envelope do usuário vale até 1 dia depois do prazo do pedido (`notAfter`). */
export const NODE_USER_SECRET_GRACE_MS = 24 * 60 * 60_000;

const revisionSchema = z.number().int().min(1).max(NODE_SYNC_MAX_REVISION);
const envelopeSchema = z.string().max(NODE_SYNC_MAX_ENVELOPE_LENGTH).regex(NODE_SYNC_ENVELOPE_PATTERN);
const lowerUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const fingerprintSchema = nodeSyncVaultKeySchema.shape.fingerprint;
const node = nodeSyncNodeSchema.shape;

/** Como o nó se autenticou na última chamada. */
export const NODE_SYNC_AUTH_KINDS = ['gcp_identity', 'node_key'] as const;
export type NodeSyncAuthKind = (typeof NODE_SYNC_AUTH_KINDS)[number];

/**
 * `nodeSync/state`: o que o nó disse de si na última chamada aceita (gravado a cada chamada pelo cp-worker). A chave do
 * cofre leva `since`, quando o plano de controle a viu pela primeira vez (muda com a impressão digital). `lastSentAt` é o
 * `sentAt` da última chamada aceita: uma instalação nova (outra identidade) só é aceita com um `sentAt` mais novo que
 * ele, para um pedido capturado da instalação anterior não trocar a identidade de volta.
 */
export const nodeSyncStateSchema = z.strictObject({
  lastSeenAt: z.date(),
  lastSentAt: z.date(),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  authKind: z.enum(NODE_SYNC_AUTH_KINDS),
  platform: z.enum(NODE_PLATFORMS),
  commit: node.commit,
  capabilities: z.array(z.enum(NODE_SYNC_CAPABILITIES)).max(NODE_SYNC_MAX_CAPABILITIES),
  nodeTenantId: node.tenantId,
  vaultKey: z.strictObject({ ...nodeSyncVaultKeySchema.shape, since: z.date() }).nullable(),
  serviceAccountId: node.serviceAccountId,
  egressIps: node.egressIps,
  audience: node.audience,
  error: node.error,
});
export type NodeSyncState = z.infer<typeof nodeSyncStateSchema>;

/**
 * `nodeSync/cloudflareOauth`: o nó anunciou `cloudflare_oauth` na chamada desta `sequence`, aceita em `seenAt`. Só vale
 * junto do `nodeSync/state` da mesma chamada (`announcesCloudflareOauth`): um nó que voltou à versão anterior, ou um
 * plano de controle que a versão anterior atendeu no meio, deixam o documento para trás.
 */
export const nodeCloudflareOauthSchema = z.strictObject({
  sequence: nodeSyncStateSchema.shape.sequence,
  seenAt: z.date(),
});

/** O nó anunciou `cloudflare_oauth` na última chamada aceita? Documento ausente, velho ou fora do formato: não. */
export function announcesCloudflareOauth(state: NodeSyncState | undefined, data: unknown): boolean {
  const parsed = nodeCloudflareOauthSchema.safeParse(data);
  return (
    state !== undefined &&
    parsed.success &&
    parsed.data.sequence === state.sequence &&
    parsed.data.seenAt.getTime() === state.lastSeenAt.getTime()
  );
}

/** `nodeSync/desired`: a geração do estado desejado, que o console sobe na mesma transação de cada mudança. */
export const nodeSyncDesiredSchema = z.strictObject({
  generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.date(),
});
export type NodeSyncDesired = z.infer<typeof nodeSyncDesiredSchema>;

/** Quem agiu no console, como na auditoria (`owner:<e-mail>`). */
const actorSchema = auditActorSchema;

/**
 * `logSources/{id}` (id = UUID em minúsculas, o mesmo da conta no banco do nó): o cadastro desejado da fonte, a
 * revisão (sobe a cada mudança) e, quando o responsável colou a credencial no console, os metadados dela (o envelope
 * fica em `logSourceSecrets`). A lápide (`removed`) fica: é ela que tira a conta do nó.
 */
export const logSourceSchema = z.strictObject({
  spec: cloudAccountCreateSchema,
  state: z.enum(['active', 'removed']),
  revision: revisionSchema,
  credentialMeta: z
    .strictObject({
      revision: revisionSchema,
      kind: z.enum(ACCEPTED_CREDENTIAL_KINDS),
      keyVersion: nodeSyncVaultKeySchema.shape.version,
      fingerprint: fingerprintSchema,
      submittedAt: z.date(),
      submittedBy: actorSchema,
    })
    .nullable(),
  createdAt: z.date(),
  createdBy: actorSchema,
  updatedAt: z.date(),
  updatedBy: actorSchema,
});
export type LogSource = z.infer<typeof logSourceSchema>;

/**
 * `logSourceSecrets/{id}`: o envelope da credencial (cifrado com a chave do cofre do nó de impressão digital
 * `fingerprint`, amarrado ao cliente do banco do nó `nodeTenantId` e ao id da fonte). Apagado pelo cp-worker quando o
 * nó conta que aplicou esta revisão (ou que ela falhou de vez), quando a fonte sai ou quando o nó muda de identidade.
 */
export const logSourceSecretSchema = z.strictObject({
  revision: revisionSchema,
  kind: z.enum(ACCEPTED_CREDENTIAL_KINDS),
  envelope: envelopeSchema,
  fingerprint: fingerprintSchema,
  nodeTenantId: lowerUuidSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
});
export type LogSourceSecret = z.infer<typeof logSourceSecretSchema>;

/** `logSourceReports/{id}`: o último relato do nó sobre a fonte, gravado quando muda (`reportedAt`). */
export const logSourceReportSchema = z.strictObject({
  report: nodeSyncSourceReportSchema,
  reportedAt: z.date(),
});
export type LogSourceReport = z.infer<typeof logSourceReportSchema>;

/** `nodeUsers/{requestId}` (ULID): o usuário que a Verax pediu ao nó, válido até `notAfter`. */
export const nodeUserSchema = z.strictObject({
  name: nodeSyncDesiredUserSchema.shape.name,
  email: nodeSyncDesiredUserSchema.shape.email,
  role: nodeSyncDesiredUserSchema.shape.role,
  notAfter: z.date(),
  createdAt: z.date(),
  createdBy: actorSchema,
});
export type NodeUser = z.infer<typeof nodeUserSchema>;

/** `nodeUserSecrets/{requestId}`: a senha temporária no envelope, apagada quando o nó conta o resultado. */
export const nodeUserSecretSchema = z.strictObject({
  envelope: envelopeSchema,
  fingerprint: fingerprintSchema,
  nodeTenantId: lowerUuidSchema,
  createdAt: z.date(),
  expiresAt: z.date(),
});
export type NodeUserSecret = z.infer<typeof nodeUserSecretSchema>;

/** `nodeUserReports/{requestId}`: o último relato do nó sobre o pedido (a senha nunca volta). */
export const nodeUserReportSchema = z.strictObject({
  report: nodeSyncUserReportSchema,
  reportedAt: z.date(),
});
export type NodeUserReport = z.infer<typeof nodeUserReportSchema>;
