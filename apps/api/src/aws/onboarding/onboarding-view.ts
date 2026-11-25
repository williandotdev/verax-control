import {
  AWS_BUCKET_ERROR_CODES,
  AWS_DISCOVERY_MAX_ERRORS,
  AWS_READER_CAPABILITIES,
  AWS_SOURCE_ACTIVE_STATES,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_NOTES,
  type AwsDiscoveryError,
  type AwsDiscoveryRun,
  type AwsDiscoveryStatus,
  type AwsDiscoveryTrigger,
  awsDiscoveryErrorSchema,
  type AwsInfrastructureSummary,
  awsInfrastructureSummarySchema,
  type AwsReaderCapability,
  type AwsSource,
  type AwsSourceAvailability,
  type AwsSourceDetails,
  awsSourceDetailsSchema,
  type AwsSourceFeatures,
  type AwsSourceKind,
  type AwsSourceLoggingState,
  type AwsSourceMethod,
  type AwsSourceNote,
  type AwsSourceOrigin,
  type AwsSourcePermission,
  type AwsSourceState,
  type CloudAccountConnection,
  isAwsSourceCollectable,
  isAwsSourcePermissionDetail,
  NO_AWS_SOURCE_FEATURES,
  parseAwsConnectionError,
} from '@verax/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { DiscoveryRunRow } from '../discovery/discovery-runs.js';
import { apiSourceLagSeconds } from '../findings/finding-health.js';
import type { OnboardingSourceFacts } from './onboarding-state.js';

/**
 * As fontes e as execuções da descoberta como a API as devolve (o contrato de `packages/shared/src/aws-onboarding.ts`).
 * O que está no banco é conferido de novo na saída: os detalhes fora do contrato saem vazios, e uma nota ou um código
 * desconhecido fica de fora, em vez de quebrar a resposta.
 */

export const SOURCE_SELECT = {
  id: true,
  tenantId: true,
  cloudAccountId: true,
  kind: true,
  region: true,
  resourceId: true,
  name: true,
  details: true,
  method: true,
  availability: true,
  loggingState: true,
  permission: true,
  permissionDetail: true,
  permissionCheckedAt: true,
  probeRequestedAt: true,
  lastProbeRequestAt: true,
  sensitive: true,
  notes: true,
  origin: true,
  firstSeenAt: true,
  lastSeenAt: true,
  missingSince: true,
  authorizedAt: true,
  authorizedBy: true,
  revokedAt: true,
  collectFrom: true,
  state: true,
  stateCode: true,
  stateSince: true,
  lastSyncAt: true,
  lastEventAt: true,
  lastIngestedAt: true,
  lagSeconds: true,
  eventsLast24h: true,
  bytesLast24h: true,
  updatedAt: true,
} as const satisfies Prisma.AwsSourceSelect;
export type SourceRow = Prisma.AwsSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
const NOTES: readonly string[] = AWS_SOURCE_NOTES;
const BUCKET_ERRORS: readonly string[] = AWS_BUCKET_ERROR_CODES;

/** A autorização da fonte está valendo (autorizada e não revogada)? */
export function isAuthorizedRow(row: Pick<SourceRow, 'authorizedAt' | 'revokedAt'>): boolean {
  return row.authorizedAt !== null && row.revokedAt === null;
}

/** Os detalhes gravados, conferidos pelo contrato; fora dele, vazios. */
export function sourceDetails(value: unknown): AwsSourceDetails {
  const parsed = awsSourceDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

const ACTIVE_STATES: readonly string[] = AWS_SOURCE_ACTIVE_STATES;

/**
 * A linha como este nó a mostra. O tipo que depende de uma funcionalidade desligada nele (o balanceador, sem os ataques web)
 * aparece como no nó que nunca a teve, na hora em que ela é desligada e não só na descoberta seguinte: descoberto, ainda não
 * coletado, sem nota nem detalhe que um painel de antes não conheça. A linha que aquele nó nem teria (o balanceador sem log,
 * o NLB) fica de fora: null.
 *
 * O que está gravado não muda. A autorização continua à vista (e pode ser retirada), num estado que não finge coleta: ninguém
 * lê a fonte, e a conta não fica "coletando" por causa dela.
 */
export function gatedSource(
  row: SourceRow,
  features: Readonly<AwsSourceFeatures> = NO_AWS_SOURCE_FEATURES,
): SourceRow | null {
  const kind = row.kind as AwsSourceKind;
  if (AWS_SOURCE_KIND_INFO[kind].feature === undefined || isAwsSourceCollectable(kind, features)) return row;
  if (row.authorizedAt === null && row.availability !== 'available') return null;
  const { internetFacing: _unknown, ...details } = sourceDetails(row.details);
  const shown: SourceRow = {
    ...row,
    details,
    notes: ['not_collected_yet'],
    // Desligada, a fonte não é sondada: o que se sabia da permissão não diz nada.
    permission: 'unknown',
    permissionDetail: null,
    permissionCheckedAt: null,
  };
  if (isAuthorizedRow(row)) {
    return ACTIVE_STATES.includes(row.state)
      ? { ...shown, state: 'authorized', stateCode: 'not_collectable_yet' }
      : shown;
  }
  return row.revokedAt !== null
    ? shown
    : { ...shown, state: 'unavailable', stateCode: 'not_collectable_yet' };
}

/** O que a conta diz da leitura dos buckets cadastrados (a conferência da conexão, tarefa `aws-check`). */
export interface LegacyAccountFacts {
  status: 'active' | 'inactive';
  connection: CloudAccountConnection;
  connectionError: string | null;
  checkRequestedAt: Date | null;
}

/**
 * A permissão e o estado da linha de um bucket cadastrado, pelo que a conferência da conexão gravou na conta: ela lê
 * cada bucket a cada 15 min, com mais cuidado do que uma sondagem (o prefixo da pilha, o bucket de organização).
 * Conectada, a leitura está provada; com o erro do bucket desta linha, falta a permissão; no resto, não se sabe.
 */
export function legacyPermission(
  row: Pick<SourceRow, 'origin' | 'details' | 'permission' | 'permissionDetail' | 'state' | 'stateCode'>,
  account: LegacyAccountFacts,
): Pick<SourceRow, 'permission' | 'permissionDetail' | 'state' | 'stateCode'> {
  const stored = {
    permission: row.permission,
    permissionDetail: row.permissionDetail,
    state: row.state,
    stateCode: row.stateCode,
  };
  if (row.origin !== 'legacy') return stored;
  const unknown = { ...stored, permission: 'unknown', permissionDetail: null };
  if (account.status !== 'active' || account.checkRequestedAt !== null) return unknown;
  if (account.connection === 'connected') return { ...stored, permission: 'granted', permissionDetail: null };
  if (account.connection !== 'error' || account.connectionError === null) return unknown;
  const parsed = parseAwsConnectionError(account.connectionError);
  if (parsed === null || !BUCKET_ERRORS.includes(parsed.code)) return unknown;
  // A conferência para no primeiro bucket com erro: os outros ficam sem resposta.
  const own = sourceDetails(row.details).legacySource;
  if (parsed.source !== null && parsed.source !== own) return unknown;
  return {
    permission: 'missing',
    permissionDetail: parsed.code,
    state: 'permission_error',
    stateCode: parsed.code,
  };
}

/**
 * O atraso de uma fonte na hora da leitura. Na fonte lida por API (achados), é o tempo desde a última leitura sem erro
 * do coletor (`aws-findings`), calculado agora; nas outras, o que o coletor delas gravou.
 */
function lagSecondsOf(row: SourceRow, now: Date): number | null {
  return apiSourceLagSeconds(row, now) ?? row.lagSeconds;
}

/** O que a derivação do estado da conta lê de uma fonte, já com a permissão da linha de um bucket cadastrado. */
export function sourceFacts(
  row: SourceRow,
  account: LegacyAccountFacts,
  now: Date = new Date(),
): OnboardingSourceFacts {
  const { permission, permissionDetail, state, stateCode } = legacyPermission(row, account);
  return {
    id: row.id,
    state: state as AwsSourceState,
    stateCode,
    method: row.method as AwsSourceMethod,
    permission: permission as AwsSourcePermission,
    permissionDetail,
    authorizedAt: row.authorizedAt,
    revokedAt: row.revokedAt,
    lastSyncAt: row.lastSyncAt,
    lagSeconds: lagSecondsOf(row, now),
  };
}

export function toSource(
  row: SourceRow,
  account: LegacyAccountFacts,
  now: Date = new Date(),
  features: Readonly<AwsSourceFeatures> = NO_AWS_SOURCE_FEATURES,
): AwsSource {
  const kind = row.kind as AwsSourceKind;
  const { permission, permissionDetail, state, stateCode } = legacyPermission(row, account);
  return {
    id: row.id,
    kind,
    region: row.region,
    resourceId: row.resourceId,
    name: row.name,
    method: row.method as AwsSourceMethod,
    origin: row.origin as AwsSourceOrigin,
    collectable: isAwsSourceCollectable(kind, features),
    sensitive: row.sensitive,
    availability: row.availability as AwsSourceAvailability,
    loggingState: row.loggingState as AwsSourceLoggingState | null,
    permission: permission as AwsSourcePermission,
    permissionDetail:
      permissionDetail !== null && isAwsSourcePermissionDetail(permissionDetail) ? permissionDetail : null,
    permissionCheckedAt: iso(row.permissionCheckedAt),
    probeRequestedAt: iso(row.probeRequestedAt),
    notes: row.notes.filter((note): note is AwsSourceNote => NOTES.includes(note)),
    details: sourceDetails(row.details),
    state: state as AwsSourceState,
    stateCode: stateCode !== null && CODE.test(stateCode) ? stateCode : null,
    stateSince: row.stateSince.toISOString(),
    authorization: {
      authorizedAt: iso(row.authorizedAt),
      authorizedBy: row.authorizedBy,
      revokedAt: iso(row.revokedAt),
    },
    collectFrom: row.collectFrom === null ? null : row.collectFrom.toISOString().slice(0, 10),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    missingSince: iso(row.missingSince),
    health: {
      lastSyncAt: iso(row.lastSyncAt),
      lastEventAt: iso(row.lastEventAt),
      lastIngestedAt: iso(row.lastIngestedAt),
      lagSeconds: lagSecondsOf(row, now),
      eventsLast24h: row.eventsLast24h,
      // O volume de um dia cabe com folga num número (o BIGINT é só a coluna).
      bytesLast24h: row.bytesLast24h === null ? null : Number(row.bytesLast24h),
    },
  };
}

/** Os erros gravados de uma execução, conferidos um a um; o que não segue o contrato fica de fora. */
export function runErrors(value: unknown): AwsDiscoveryError[] {
  if (!Array.isArray(value)) return [];
  const errors: AwsDiscoveryError[] = [];
  for (const item of value.slice(0, AWS_DISCOVERY_MAX_ERRORS)) {
    const parsed = awsDiscoveryErrorSchema.safeParse(item);
    if (parsed.success) errors.push(parsed.data);
  }
  return errors;
}

export function toRun(row: DiscoveryRunRow): AwsDiscoveryRun {
  return {
    id: row.id,
    trigger: row.trigger as AwsDiscoveryTrigger,
    status: row.status as AwsDiscoveryStatus,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    regions: row.regions.slice(0, 64),
    errors: runErrors(row.errors),
    requestedBy: row.requestedBy,
  };
}

/** O retrato gravado de uma execução; null sem ele ou fora do contrato. */
export function runSummary(value: unknown): AwsInfrastructureSummary | null {
  const parsed = awsInfrastructureSummarySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** As capacidades gravadas na conta, na ordem do catálogo; um nome desconhecido fica de fora. */
export function accountCapabilities(stored: readonly string[]): AwsReaderCapability[] {
  return AWS_READER_CAPABILITIES.filter((capability) => stored.includes(capability));
}
