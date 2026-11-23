import {
  AWS_MAX_SOURCES_PER_ACCOUNT,
  AWS_SOURCE_KIND_INFO,
  type AwsSourceState,
  awsSourceDetailsSchema,
  awsSourceIdleState,
  isAwsSourcePermissionDetail,
  isAwsSourceRegion,
} from '@verax/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { isAuthorizedRow, SOURCE_SELECT, type SourceRow } from '../onboarding/onboarding-view.js';
import type { DiscoveredSource } from './catalogue.js';
import { scopeKey } from './discovery.js';

/**
 * A gravação do que a descoberta viu nas fontes da conta (`AwsSource`, `origin = discovered`), na transação da tarefa e
 * pelo escopo do cliente da conta. As linhas dos buckets cadastrados (`legacy`) não são tocadas aqui: elas espelham o
 * cadastro (`onboarding/legacy-sources.ts`).
 *
 * - **Fonte nova:** entra `available`, `needs_permission` ou `unavailable`, pelo que foi visto.
 * - **Fonte já conhecida, sem autorização:** os dados e o estado acompanham o que foi visto agora.
 * - **Fonte autorizada:** os dados acompanham; o estado só muda de forma declarada. Sem a permissão, vira
 *   `permission_error`; com a permissão de volta, `authorized`; se o destino dela deixou de ser lido (o log foi para o
 *   Firehose, o serviço foi desligado), `source_missing` com o motivo. A autorização (quem, quando, a partir de quando)
 *   nunca é mexida.
 * - **Fonte que sumiu**, só nos escopos que a descoberta leu por inteiro: a autorizada vira `source_missing`; a revogada
 *   fica revogada, com a data do sumiço; a que nunca foi autorizada sai da lista.
 * - **Fonte revogada:** fica revogada (os dados acompanham).
 *
 * A sondagem que não terminou (`probe_failed`) não apaga uma permissão já conhecida.
 *
 * O "Tentar de novo" de uma fonte (`applySourceReading`) grava a releitura dela com as mesmas regras de uma fonte já
 * conhecida (`knownChange`), numa linha só. O que some ou aparece continua sendo só da descoberta.
 */

export interface ApplyReport {
  created: number;
  updated: number;
  /** Autorizadas que sumiram (ou cujo destino deixou de ser lido). */
  missing: number;
  /** Autorizadas que voltaram a aparecer. */
  reappeared: number;
  /** Nunca autorizadas que sumiram: saíram da lista. */
  removed: number;
  /** Fora do contrato (detalhes, região, tamanho do identificador): ficaram de fora. */
  invalid: number;
  /** Além do teto de fontes por conta. */
  overLimit: number;
}

const keyOf = (source: Pick<SourceRow, 'kind' | 'region' | 'resourceId'>): string =>
  `${source.kind}|${source.region}|${source.resourceId}`;

interface Seen {
  permission: string;
  permissionDetail: string | null;
  availability: DiscoveredSource['availability'];
  kind: DiscoveredSource['kind'];
}

/**
 * O estado de uma fonte já conhecida depois de uma leitura (a descoberta ou a sondagem pedida no painel); null quando
 * ele fica como está.
 */
export function nextSourceState(
  row: Pick<SourceRow, 'state' | 'stateCode' | 'authorizedAt' | 'revokedAt'>,
  seen: Seen,
): { state: AwsSourceState; stateCode: string | null } | null {
  if (row.revokedAt !== null) return null;
  const changed = (state: AwsSourceState, stateCode: string | null) =>
    state === row.state && stateCode === row.stateCode ? null : { state, stateCode };
  if (!isAuthorizedRow(row)) {
    const idle = awsSourceIdleState(
      seen.kind,
      seen.availability,
      seen.permission as 'granted' | 'missing' | 'unknown',
    );
    return changed(idle.state, idle.stateCode);
  }
  // Autorizada: o destino que deixou de ser lido é uma fonte que sumiu, com o motivo.
  if (seen.availability !== 'available') return changed('source_missing', seen.availability);
  if (seen.permission === 'missing') return changed('permission_error', seen.permissionDetail);
  if (row.state === 'source_missing' || (row.state === 'permission_error' && seen.permission === 'granted')) {
    return changed('authorized', 'awaiting_collector');
  }
  return null;
}

/** A sondagem decidiu algo (concedida, faltando, ou sem conferir por um motivo que não é a falha dela)? */
function probed(source: Pick<DiscoveredSource, 'permission' | 'permissionDetail'>): boolean {
  return (
    source.permission !== 'unknown' ||
    (source.permissionDetail !== null && source.permissionDetail !== 'probe_failed')
  );
}

type ValidatedSource = DiscoveredSource & { detailsJson: Prisma.InputJsonObject };

/** O que a fonte vista vale para o banco, ou null fora do contrato. */
function validated(source: DiscoveredSource): ValidatedSource | null {
  if (source.resourceId.length === 0 || source.resourceId.length > 512) return null;
  if (!isAwsSourceRegion(source.region)) return null;
  if (source.permissionDetail !== null && !isAwsSourcePermissionDetail(source.permissionDetail)) return null;
  const details = awsSourceDetailsSchema.safeParse(source.details);
  if (!details.success) return null;
  return {
    ...source,
    name: source.name.slice(0, 512),
    details: details.data,
    detailsJson: details.data,
  };
}

/** Os campos que a descoberta descreve, para comparar o visto com o gravado. */
function described(source: {
  name: string;
  details: unknown;
  availability: string;
  loggingState: string | null;
  notes: readonly string[];
  permission: string;
  permissionDetail: string | null;
}): string {
  return JSON.stringify([
    source.name,
    stable(source.details),
    source.availability,
    source.loggingState,
    [...source.notes].sort(),
    source.permission,
    source.permissionDetail,
  ]);
}

/** O JSON com as chaves em ordem: o Postgres devolve o JSONB em outra ordem que a gravada. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, stable(item)]),
  );
}

interface KnownChange {
  /** Nada do que a leitura descreve mudou, nem o estado. */
  same: boolean;
  /** A sondagem decidiu algo agora: a data da conferência da permissão anda. */
  checked: boolean;
  /** O estado novo; null quando fica como está. */
  next: { state: AwsSourceState; stateCode: string | null } | null;
  /** O que gravar na linha quando algo mudou. */
  data: Prisma.AwsSourceUncheckedUpdateInput;
}

/** O que muda numa fonte já conhecida com o que foi visto dela agora (na descoberta, ou na releitura dela). */
function knownChange(row: SourceRow, source: ValidatedSource, now: Date): KnownChange {
  // A sondagem que não terminou não apaga o que já se sabia da permissão.
  const keepPermission = source.permissionDetail === 'probe_failed' && row.permission !== 'unknown';
  const permission = keepPermission ? row.permission : source.permission;
  const permissionDetail = keepPermission ? row.permissionDetail : source.permissionDetail;
  const next = nextSourceState(row, {
    kind: source.kind,
    availability: source.availability,
    permission,
    permissionDetail,
  });
  const same =
    described({ ...source, permission, permissionDetail }) === described(row) &&
    next === null &&
    row.missingSince === null;
  const checked = !keepPermission && probed(source);
  return {
    same,
    checked,
    next,
    data: {
      name: source.name,
      details: source.detailsJson,
      availability: source.availability,
      loggingState: source.loggingState,
      notes: source.notes,
      permission,
      permissionDetail,
      ...(checked && { permissionCheckedAt: now }),
      lastSeenAt: now,
      // A fonte cujo destino deixou de ser lido conta como sumida desde agora; a que voltou, não mais.
      missingSince: next?.state === 'source_missing' ? (row.missingSince ?? now) : null,
      ...(next !== null && { state: next.state, stateCode: next.stateCode, stateSince: now }),
    },
  };
}

/**
 * Grava numa fonte já conhecida o que a releitura dela viu agora (o "Tentar de novo" do painel) e desfaz o pedido: os
 * dados, a permissão e o estado, pelas mesmas regras da descoberta. `db` é o cliente do banco no escopo do cliente da
 * conta, numa transação. A leitura fora do contrato, ou de outra fonte, só desfaz o pedido.
 */
export async function applySourceReading(
  db: Prisma.TransactionClient,
  row: SourceRow,
  candidate: DiscoveredSource,
  now: Date,
): Promise<'updated' | 'unchanged' | 'invalid'> {
  const source = validated(candidate);
  if (source === null || keyOf(source) !== keyOf(row)) {
    await db.awsSource.update({
      where: { id: row.id },
      data: { probeRequestedAt: null },
      select: { id: true },
    });
    return 'invalid';
  }
  const change = knownChange(row, source, now);
  await db.awsSource.update({
    where: { id: row.id },
    data: change.same
      ? { probeRequestedAt: null, lastSeenAt: now, ...(change.checked && { permissionCheckedAt: now }) }
      : { ...change.data, probeRequestedAt: null },
    select: { id: true },
  });
  return change.same ? 'unchanged' : 'updated';
}

export interface ApplyInput {
  tenantId: string;
  cloudAccountId: string;
  sources: readonly DiscoveredSource[];
  /** Os escopos (`tipo:região`) lidos por inteiro. */
  covered: readonly string[];
  now: Date;
}

/** Grava o resultado de uma descoberta. `db` é o cliente do banco no escopo do cliente da conta, numa transação. */
export async function applyDiscovery(db: Prisma.TransactionClient, input: ApplyInput): Promise<ApplyReport> {
  const { now, cloudAccountId } = input;
  const report: ApplyReport = {
    created: 0,
    updated: 0,
    missing: 0,
    reappeared: 0,
    removed: 0,
    invalid: 0,
    overLimit: 0,
  };
  const rows = await db.awsSource.findMany({
    where: { cloudAccountId, origin: 'discovered' },
    select: SOURCE_SELECT,
  });
  const known = new Map(rows.map((row) => [keyOf(row), row]));
  const total = await db.awsSource.count({ where: { cloudAccountId } });
  let room = Math.max(0, AWS_MAX_SOURCES_PER_ACCOUNT - total);

  const seenKeys = new Set<string>();
  const creates: Prisma.AwsSourceCreateManyInput[] = [];
  const unchangedProbed: string[] = [];
  const unchanged: string[] = [];
  // Os grupos de logs por último: são os que podem estourar o teto, e as outras fontes entram antes.
  const ordered = [...input.sources].sort(
    (a, b) => Number(a.kind === 'cloudwatch_log_group') - Number(b.kind === 'cloudwatch_log_group'),
  );
  for (const candidate of ordered) {
    const source = validated(candidate);
    if (source === null) {
      report.invalid += 1;
      continue;
    }
    const key = keyOf(source);
    if (seenKeys.has(key)) continue;
    const info = AWS_SOURCE_KIND_INFO[source.kind];
    const row = known.get(key);
    if (row === undefined) {
      if (room === 0) {
        report.overLimit += 1;
        continue;
      }
      room -= 1;
      seenKeys.add(key);
      const idle = awsSourceIdleState(source.kind, source.availability, source.permission);
      creates.push({
        tenantId: input.tenantId,
        cloudAccountId,
        kind: source.kind,
        region: source.region,
        resourceId: source.resourceId,
        name: source.name,
        details: source.detailsJson,
        method: info.method,
        availability: source.availability,
        loggingState: source.loggingState,
        permission: source.permission,
        permissionDetail: source.permissionDetail,
        permissionCheckedAt: probed(source) ? now : null,
        sensitive: info.sensitive,
        notes: source.notes,
        origin: 'discovered',
        firstSeenAt: now,
        lastSeenAt: now,
        state: idle.state,
        stateCode: idle.stateCode,
        stateSince: now,
      });
      continue;
    }
    seenKeys.add(key);
    const change = knownChange(row, source, now);
    if (change.same) {
      (change.checked ? unchangedProbed : unchanged).push(row.id);
      continue;
    }
    if (change.next !== null && isAuthorizedRow(row)) {
      if (change.next.state === 'source_missing') report.missing += 1;
      else if (row.state === 'source_missing') report.reappeared += 1;
    }
    report.updated += 1;
    await db.awsSource.update({ where: { id: row.id }, data: change.data, select: { id: true } });
  }

  if (creates.length > 0) {
    const { count } = await db.awsSource.createMany({ data: creates, skipDuplicates: true });
    report.created = count;
  }
  if (unchanged.length > 0) {
    await db.awsSource.updateMany({ where: { id: { in: unchanged } }, data: { lastSeenAt: now } });
  }
  if (unchangedProbed.length > 0) {
    await db.awsSource.updateMany({
      where: { id: { in: unchangedProbed } },
      data: { lastSeenAt: now, permissionCheckedAt: now },
    });
  }

  // O que não apareceu, só nos escopos lidos por inteiro.
  const covered = new Set(input.covered);
  const gone = rows.filter(
    (row) =>
      !seenKeys.has(keyOf(row)) && covered.has(scopeKey(row.kind as DiscoveredSource['kind'], row.region)),
  );
  const forgotten: string[] = [];
  for (const row of gone) {
    if (isAuthorizedRow(row)) {
      if (row.state === 'source_missing') continue;
      report.missing += 1;
      await db.awsSource.update({
        where: { id: row.id },
        data: {
          state: 'source_missing',
          stateCode: 'not_found',
          stateSince: now,
          missingSince: row.missingSince ?? now,
        },
        select: { id: true },
      });
    } else if (row.revokedAt !== null) {
      if (row.missingSince === null) {
        await db.awsSource.update({
          where: { id: row.id },
          data: { missingSince: now },
          select: { id: true },
        });
      }
    } else forgotten.push(row.id);
  }
  if (forgotten.length > 0) {
    const { count } = await db.awsSource.deleteMany({
      // A condição repete a regra no banco: uma autorização que entrou no meio não é apagada.
      where: { id: { in: forgotten }, authorizedAt: null },
    });
    report.removed = count;
  }
  return report;
}
