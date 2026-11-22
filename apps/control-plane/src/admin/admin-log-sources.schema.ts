import {
  type AcceptedCredentialKind,
  type CloudAccountCreate,
  cloudAccountCreateSchema,
  cloudCredentialInputSchema,
  type NodePlatform,
  type NodeSyncNodeError,
  type NodeSyncSourceCode,
  type NodeSyncSourceReport,
} from '@verax/shared';
import { z } from 'zod';
import type { Hosting } from '../tenants/tenant.schema.js';

/**
 * As formas da API das fontes de log no console do responsável (`/v1/admin/tenants/:id/node-sync` e
 * `/v1/admin/tenants/:id/log-sources...`, só no cp-admin): o que o nó do cliente disse de si, as fontes que o
 * responsável cadastrou (o desejado, com o relato do nó) e, por fonte, o que mandar ao cliente (a pilha do papel de
 * leitura da AWS no gerenciado, as chaves de leitura na VM do cliente). As telas (PR do console) leem estes tipos.
 *
 * Nenhuma resposta leva segredo: a credencial colada no console só aparece como metadados (o tipo, a revisão, quando
 * e por quem, a impressão digital da chave do cofre que a cifrou); o envelope fica no Firestore até o nó consumir.
 */

/** O id de uma fonte: UUID em minúsculas (o mesmo da conta no banco do nó). */
export const LOG_SOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** O nó é dado como parado quando a última chamada aceita tem mais de 15 minutos (o intervalo é de 5). */
export const NODE_STALE_AFTER_MS = 15 * 60_000;

/** O caminho fixo onde o cp-admin serve o template do papel de leitura da AWS (`aws-reader-template.ts`). */
export const AWS_READER_TEMPLATE_PATH = '/v1/admin/aws-reader/verax-control-reader.yaml';

/**
 * `POST /v1/admin/tenants/:id/log-sources`: o cadastro da fonte, com as regras do painel do nó
 * (`cloudAccountCreateSchema`), e a credencial de leitura opcional (as regras do `PUT .../credential` do painel: a
 * Global API Key do Cloudflare é recusada, a chave temporária da AWS também). Sem ela, o cliente cola no painel dele.
 */
export const logSourceCreateRequestSchema = z.strictObject({
  spec: cloudAccountCreateSchema,
  credential: cloudCredentialInputSchema.optional(),
});
export type LogSourceCreateRequest = z.infer<typeof logSourceCreateRequestSchema>;

/** `POST /v1/admin/tenants/:id/log-sources/:sourceId/remove`: o subdomínio do cliente, digitado de novo. */
export const logSourceRemoveRequestSchema = z.strictObject({ confirmSlug: z.string().max(64) });

/** O que o nó disse de si na última chamada aceita (`nodeSync/state`): nada aqui é segredo. */
export interface NodeSyncView {
  lastSeenAt: Date;
  /** Mais de 15 minutos sem chamada aceita. */
  stale: boolean;
  platform: NodePlatform;
  /** A plataforma informada não é a do lugar do cliente (gerenciado: `gcp`; VM do cliente: `vm`). */
  platformMismatch: boolean;
  commit: string;
  capabilities: string[];
  authKind: 'gcp_identity' | 'node_key';
  /** O id do cliente no banco do nó (o do rótulo dos envelopes); null antes do primeiro cliente ou com mais de um. */
  nodeTenantId: string | null;
  /** O nó tem o cofre de credenciais com a chave pública conferida: o console pode cifrar para ele. */
  vaultReady: boolean;
  keyVersion: number | null;
  /** SHA-256 do DER da chave pública do cofre (o painel do cliente mostra a mesma). */
  fingerprint: string | null;
  /** Quando o plano de controle viu esta chave pela primeira vez. */
  keySince: Date | null;
  serviceAccountId: string | null;
  egressIps: string[];
  audience: string;
  error: NodeSyncNodeError | null;
}

/** Os metadados da credencial colada no console; nunca o envelope nem o texto claro. */
export interface LogSourceCredentialView {
  kind: AcceptedCredentialKind;
  revision: number;
  keyVersion: number;
  fingerprint: string;
  submittedAt: Date;
  submittedBy: string;
  /** O envelope ainda espera o nó no Firestore (falso: consumido, descartado ou vencido; "reenviar" cola de novo). */
  envelopeStored: boolean;
}

/**
 * A situação da fonte para o console:
 * - `pending`: o nó ainda não processou a revisão desejada (ou a credencial nova);
 * - `applied`: aplicada na revisão atual;
 * - `failed`: o nó recusou a revisão atual ou a credencial atual (o código em `code`);
 * - `removing` / `removed`: a lápide ainda não chegou ao nó, ou já chegou.
 */
export const LOG_SOURCE_STATUSES = ['pending', 'applied', 'failed', 'removing', 'removed'] as const;
export type LogSourceStatus = (typeof LOG_SOURCE_STATUSES)[number];

/** Os campos da pilha que diferem do que o nó informou (o nó pode estar com outro valor que o plano de controle). */
export const AWS_STACK_MISMATCH_FIELDS = ['serviceAccountId', 'egressIps', 'audience'] as const;
export type AwsStackMismatchField = (typeof AWS_STACK_MISMATCH_FIELDS)[number];

/**
 * A pilha do papel de leitura sem chave (nó gerenciado), com os valores que o plano de controle conhece por conta
 * própria (o ID da conta de serviço e o IP do Cloud NAT gravados pelo provisionamento, o audience do produto), nunca
 * os que o nó informa. O nó só serve para a conferência (`mismatch`).
 */
export interface AwsStackView {
  stackName: string;
  roleArn: string;
  /** null: o provisionamento ainda não gravou (o comando leva o marcador). */
  nodeServiceAccountId: string | null;
  egressIps: string[];
  audience: string;
  bucketArns: string[];
  /** O `aws cloudformation deploy` com os valores acima (cria ou atualiza a pilha). */
  deployCommand: string;
  /** O CloudFormation no console da AWS, na primeira região da fonte. */
  consoleUrl: string;
  templateUrl: string;
  mismatch: boolean;
  mismatches: AwsStackMismatchField[];
}

/** As chaves de leitura que o cliente cria na conta dele (VM do cliente, sem identidade de nuvem). */
export type ReadKeysView =
  | {
      provider: 'aws';
      userArn: string;
      readerPolicyName: string;
      readerPolicyFile: string;
      readerPolicy: unknown;
      guardrailsPolicyName: string;
      guardrailsPolicyFile: string;
      guardrailsPolicy: unknown;
      /** Os comandos da CLI (as políticas dos arquivos acima, o usuário, o limite de permissões e a chave). */
      commands: string;
      /** Os IPs de saída que o nó informou (na VM do cliente, o plano de controle não tem outra fonte). */
      egressIps: string[];
    }
  | {
      provider: 'gcp';
      subscription: string;
      serviceAccountEmail: string;
      role: string;
      keyFile: string;
      /** Os comandos do Cloud Shell (tópico, assinatura, sink, conta de serviço e a chave). */
      commands: string;
    };

/** O token de leitura do Cloudflare: o link que já marca as permissões e os IPs para o filtro do token. */
export interface CloudflareTokenView {
  templateUrl: string;
  tokenName: string;
  /** Gerenciado: o IP do Cloud NAT gravado pelo provisionamento; VM do cliente: o que o nó informou. */
  egressIps: string[];
}

export interface LogSourceView {
  id: string;
  spec: CloudAccountCreate;
  state: 'active' | 'removed';
  revision: number;
  credential: LogSourceCredentialView | null;
  /** O último relato do nó sobre a fonte (com quando chegou); null antes do primeiro. */
  report: (NodeSyncSourceReport & { reportedAt: Date }) | null;
  /** A revisão desejada é mais nova que a relatada, ou a credencial do console mais nova que a aplicada. */
  pending: boolean;
  status: LogSourceStatus;
  code: NodeSyncSourceCode | null;
  /** Só AWS no nó gerenciado. */
  awsStack: AwsStackView | null;
  /** Só AWS e GCP na VM do cliente. */
  readKeys: ReadKeysView | null;
  /** Só Cloudflare. */
  cloudflareToken: CloudflareTokenView | null;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

/** `GET /v1/admin/tenants/:id/node-sync`. */
export interface NodeSyncOverview {
  hosting: Hosting;
  /** A plataforma do nó deste cliente: `gcp` no gerenciado, `vm` na VM do cliente. */
  platform: NodePlatform;
  /** Os tipos de credencial que o console aceita colar para este cliente. */
  credentialKinds: AcceptedCredentialKind[];
  /** A geração do estado desejado (sobe a cada mudança no console). */
  generation: number;
  /** null: o nó nunca sincronizou. */
  node: NodeSyncView | null;
  sources: LogSourceView[];
  templateUrl: string;
}

/** O resultado de toda escrita: a fonte como ficou e a geração nova. */
export interface LogSourceWriteResult {
  source: LogSourceView;
  generation: number;
}
