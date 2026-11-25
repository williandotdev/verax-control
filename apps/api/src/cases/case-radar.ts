import {
  awsAccountIdSchema,
  type FindingSeverity,
  type FindingSource,
  type RadarCase,
  type RadarSector,
  radarSectorOf,
  wazuhAgentRefSchema,
} from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { sourcesOfCase } from './case-sources.js';
import { partsOf } from './case-store.js';

/** Um caso como o radar da Torre o desenha. Sem banco. */

export const radarCaseSelect = {
  id: true,
  family: true,
  title: true,
  keyParts: true,
  ruleIds: true,
  accounts: true,
  lastSeenAt: true,
  lastAlertAt: true,
  total: true,
  newCount: true,
  investigatingCount: true,
  pendingCritical: true,
  pendingHigh: true,
  pendingMedium: true,
  pendingLow: true,
  incidentId: true,
} as const satisfies Prisma.AlertCaseSelect;

type RadarCaseRow = Prisma.AlertCaseGetPayload<{ select: typeof radarCaseSelect }>;

/** Uma zona ou conta do Cloudflare: 32 dígitos hexadecimais. */
function isCloudflareId(account: string): boolean {
  return account.length === 32 && [...account].every((char) => '0123456789abcdef'.includes(char));
}

/**
 * O setor do radar de um caso: o da primeira fonte dele. O caso de uma fonte que não se conhece fica no setor da conta
 * (o agente, os 12 dígitos da AWS, o id do Cloudflare; senão, um projeto da GCP).
 */
export function radarSectorOfCase(
  sources: readonly FindingSource[],
  accounts: readonly string[],
): RadarSector {
  const [source] = sources;
  if (source !== undefined) return radarSectorOf(source);
  const [account] = accounts;
  if (account === undefined || awsAccountIdSchema.safeParse(account).success) return 'aws';
  if (wazuhAgentRefSchema.safeParse(account).success) return 'agents';
  return isCloudflareId(account) ? 'cloudflare' : 'gcp';
}

/**
 * A atividade mais recente: o horário do evento do último alerta ou, se ele é de antes da janela (o alerta que chegou
 * atrasado), o da chegada. Um horário no futuro (o do log é de quem o escreve) vale agora.
 */
export function lastActivityOf(
  row: Pick<RadarCaseRow, 'lastSeenAt' | 'lastAlertAt'>,
  since: Date,
  now: Date,
): Date {
  const at = row.lastSeenAt >= since ? row.lastSeenAt : row.lastAlertAt;
  return at > now ? now : at;
}

/** A pior severidade entre os alertas pendentes do caso; null sem nada pendente. */
export function worstPending(
  row: Pick<RadarCaseRow, 'pendingCritical' | 'pendingHigh' | 'pendingMedium' | 'pendingLow'>,
): FindingSeverity | null {
  if (row.pendingCritical > 0) return 'critical';
  if (row.pendingHigh > 0) return 'high';
  if (row.pendingMedium > 0) return 'medium';
  return row.pendingLow > 0 ? 'low' : null;
}

export function toRadarCase(
  row: RadarCaseRow,
  {
    recent,
    openIncidentId,
    since,
    now,
    incidents,
  }: {
    recent: number;
    /** O incidente aberto mais grave em que há alerta do caso. */
    openIncidentId: string | null;
    since: Date;
    now: Date;
    /** Os incidentes, pelo id. */
    incidents: ReadonlyMap<string, { open: boolean; severity: FindingSeverity }>;
  },
): RadarCase {
  const sources = sourcesOfCase({
    family: row.family,
    ruleIds: row.ruleIds,
    keyParts: partsOf(row.keyParts),
  });
  const incidentId = openIncidentId ?? row.incidentId;
  const incident = incidentId === null ? undefined : incidents.get(incidentId);
  return {
    id: row.id,
    title: row.title,
    severity: worstPending(row),
    sources,
    sector: radarSectorOfCase(sources, row.accounts),
    total: row.total,
    pending: row.newCount + row.investigatingCount,
    recent,
    lastActivityAt: lastActivityOf(row, since, now).toISOString(),
    incident: incidentId !== null && incident !== undefined ? { id: incidentId, ...incident } : null,
  };
}
