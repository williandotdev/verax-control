import {
  type CloudAccount,
  type CloudAccountCreate,
  type CloudAccountManager,
  awsReaderRoleArn,
  credentialStatus,
  isAwsCollectionErrorCode,
  isAwsConnectionWarningCode,
  LOG_SOURCES,
  type LogBuckets,
  type LogSource,
} from '@verax/shared';
import type { ManagedOrigin, Prisma } from '../generated/prisma/client.js';

/**
 * O cadastro da conta cloud como o banco o guarda e como a API o devolve: o que o `CloudAccountsService` (o painel) e a
 * sincronização com o plano de controle (a tarefa `control-plane-sync` do worker, que cria e altera as contas que a
 * Verax cadastra no console) gravam e mostram do mesmo jeito. Nada aqui depende da requisição.
 */

export const accountSelect = {
  id: true,
  tenantId: true,
  provider: true,
  accountId: true,
  regions: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  pubsubSubscription: true,
  sinkWriterIdentity: true,
  zones: true,
  lastEventAt: true,
  connection: true,
  connectionError: true,
  collectionError: true,
  lastCollectedAt: true,
  checkRequestedAt: true,
  ingestFrom: true,
  status: true,
  origin: true,
  controlPlaneRevision: true,
  createdAt: true,
  updatedAt: true,
  // Do cofre, só os metadados: nunca o texto cifrado nem a versão da chave do nó.
  credential: {
    select: { kind: true, keyIdSuffix: true, issuedAt: true, expiresAt: true, verifiedAt: true },
  },
} as const satisfies Prisma.CloudAccountSelect;

export type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof accountSelect }>;

export const BUCKET_COLUMN = {
  cloudtrail: 'cloudtrailBucket',
  guardduty: 'guarddutyBucket',
  waf: 'wafBucket',
} as const satisfies Record<LogSource, keyof AccountRow>;

/** O que vem da configuração do nó, igual para todas as contas. Nada disso é segredo. */
export interface NodeFacts {
  /** Começo do nome dos tópicos do nó (`GCP_SINK_TOPIC_PREFIX`). */
  sinkTopicPrefix?: string | undefined;
  /** IPs de saída do nó (`NODE_EGRESS_IPS`). */
  egressIps: readonly string[];
  /** ID único da conta de serviço do nó no Google (`NODE_SA_UNIQUE_ID`); null quando o nó não informa. */
  serviceAccountId: string | null;
  /** Audience do token do nó (`AWS_WEB_IDENTITY_AUDIENCE`, ou o padrão do template). */
  audience: string;
}

/** Os buckets de log gravados na conta, por fonte. */
export function bucketsOf(row: Pick<AccountRow, (typeof BUCKET_COLUMN)[LogSource]>): LogBuckets {
  return { cloudtrail: row.cloudtrailBucket, guardduty: row.guarddutyBucket, waf: row.wafBucket };
}

/** O dia de uma coluna `DATE` (o Prisma a devolve como meia-noite UTC): `AAAA-MM-DD`. */
export function isoDate(day: Date | null): string | null {
  return day === null ? null : day.toISOString().slice(0, 10);
}

/** Quem cadastrou a conta, como o painel o vê. */
export function managedByOf(origin: ManagedOrigin): CloudAccountManager {
  return origin === 'control_plane' ? 'verax' : 'panel';
}

/**
 * Como a conta sai da API. Com o prefixo dos tópicos do nó, o projeto da GCP ganha o tópico do comando do sink; sem
 * ele (ambiente local), o tópico fica null. A conta AWS leva os três valores do nó que a pilha do papel de leitura pede
 * (o ID da conta de serviço, o audience e os IPs de saída) e o ARN do papel, derivado do ID; a do Cloudflare, os IPs de
 * saída, o filtro de IP recomendado para o token. Nenhum ExternalId: o papel não tem.
 */
export function toAccount(row: AccountRow, node: NodeFacts): CloudAccount {
  const aws = row.provider === 'aws';
  const gcp = row.provider === 'gcp';
  const { credential } = row;
  return {
    id: row.id,
    provider: row.provider,
    accountId: row.accountId,
    regions: aws ? row.regions : [],
    readerRoleArn: aws ? awsReaderRoleArn(row.accountId) : null,
    nodeServiceAccountId: aws ? node.serviceAccountId : null,
    webIdentityAudience: aws ? node.audience : null,
    buckets: bucketsOf(row),
    pubsubSubscription: row.pubsubSubscription,
    sinkTopic: gcp && node.sinkTopicPrefix ? `${node.sinkTopicPrefix}${row.accountId}` : null,
    sinkWriterIdentity: gcp ? row.sinkWriterIdentity : null,
    zones: row.zones,
    keyStatus: credential
      ? {
          kind: credential.kind,
          keyIdSuffix: credential.keyIdSuffix,
          issuedAt: credential.issuedAt?.toISOString() ?? null,
          expiresAt: credential.expiresAt?.toISOString() ?? null,
          verifiedAt: credential.verifiedAt.toISOString(),
          status: credentialStatus(credential.expiresAt),
        }
      : null,
    egressIps: gcp ? [] : [...node.egressIps],
    status: row.status,
    // Gravados pelo coletor da conta: só o worker escreve, nunca o request. O "Verificar" da AWS só pede. Na AWS, uma
    // conta conectada pode ter um aviso que não para a coleta (PR-V5': trilha, export, permissão demais, STS da região).
    connection: row.connection,
    connectionError:
      row.connection === 'error' ||
      (aws && row.connection === 'connected' && isAwsConnectionWarningCode(row.connectionError))
        ? row.connectionError
        : null,
    // AWS: o aviso da coleta pelo Wazuh do nó (PR-V4'), à parte da conexão; só a tarefa wazuh-config o grava.
    collectionError:
      aws && row.status === 'active' && isAwsCollectionErrorCode(row.collectionError)
        ? row.collectionError
        : null,
    checkRequestedAt: aws ? (row.checkRequestedAt?.toISOString() ?? null) : null,
    ingestFrom: aws ? isoDate(row.ingestFrom) : null,
    lastCollectedAt: row.lastCollectedAt?.toISOString() ?? null,
    // Gravado pelo sync de alertas (T5.3).
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    managedBy: managedByOf(row.origin),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Colunas de bucket a gravar: só as fontes informadas; `null` apaga. */
type BucketColumn = (typeof BUCKET_COLUMN)[LogSource];

export type AwsBuckets = Extract<CloudAccountCreate, { provider: 'aws' }>['buckets'];

export function bucketData(buckets: AwsBuckets): Partial<Record<BucketColumn, string | null>> {
  const data: Partial<Record<BucketColumn, string | null>> = {};
  for (const source of LOG_SOURCES) {
    const value = buckets?.[source];
    if (value !== undefined) data[BUCKET_COLUMN[source]] = value;
  }
  return data;
}

/**
 * A conexão recomeça (outra fonte, como a assinatura do Pub/Sub ou a lista de buckets da AWS; credencial nova ou
 * removida; conta desativada ou reativada): aguardando, sem erro e sem "Verificar" pendente (a AWS pede de novo). A
 * última coleta é história.
 */
export const RESET_CONNECTION = {
  connection: 'waiting',
  connectionError: null,
  checkRequestedAt: null,
} as const satisfies Prisma.CloudAccountUpdateInput;

/** Dados próprios de cada provedor no cadastro. Os campos dos outros provedores ficam vazios. */
export function providerData(input: CloudAccountCreate): Prisma.CloudAccountUncheckedCreateInput {
  const base = {
    provider: input.provider,
    accountId: input.accountId,
  } as Prisma.CloudAccountUncheckedCreateInput;
  switch (input.provider) {
    case 'aws':
      return { ...base, regions: input.regions, ...bucketData(input.buckets) };
    case 'gcp':
      return {
        ...base,
        regions: [],
        pubsubSubscription: input.pubsubSubscription ?? null,
        sinkWriterIdentity: input.sinkWriterIdentity ?? null,
      };
    case 'cloudflare':
      return { ...base, regions: [], zones: input.zones ?? [] };
  }
}
