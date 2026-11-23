import {
  AWS_WAZUH_AWAITING_APPLY,
  AWS_WAZUH_NO_PROGRESS,
  type AwsCollectionErrorCode,
  type AwsSourceState,
} from '@verax/shared';
import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import {
  findWazuhMarker,
  type WazuhMarkerLookup,
  type WazuhProgress,
  type WazuhSourceMarker,
} from './wazuh-progress.js';
import type { PlannedWazuhSource, WazuhObjectPrefix, WazuhSourceRow } from './wazuh-sources.js';

/**
 * A saúde da coleta de cada fonte da AWS lida pelo Wazuh do nó (onboarding self-service): o estado e os horários que a
 * tela das fontes mostra, gravados pela tarefa `wazuh-config` do worker a partir de três coisas que ela já tem em mãos:
 * a lista que o manager deve ler (`planWazuhSources`), o que o host respondeu da aplicação dela (o sinal `applied` e o
 * do token) e até onde o módulo já leu cada fonte (o sinal `progress`).
 *
 * O caminho de uma fonte autorizada (`AWS_WAZUH_SOURCE_STATE_CODES` em `packages/shared`):
 *
 * 1. `authorized` (`awaiting_collector`): acabou de ser autorizada;
 * 2. `configuring` (`awaiting_apply`): está na lista, e o host ainda não aplicou a lista de agora no manager;
 * 3. `waiting_events`: aplicada, e o módulo ainda não leu nada dela desde o início da coleta (`collectFrom`);
 * 4. `collecting`: o módulo leu um objeto (ou um evento do grupo) dela desde o início da coleta. Aí ficam o horário da
 *    leitura (`lastIngestedAt`), o do evento mais recente (`lastEventAt`) e o atraso entre os dois (`lagSeconds`: quanto
 *    tempo depois de gravado na AWS o evento entrou no nó, medido no último objeto lido, e não quanto tempo faz que
 *    nada chega: uma conta quieta não fica "atrasada");
 * 5. `stalled` (`no_progress`), só nas fontes contínuas (a trilha do CloudTrail e os flow logs): o módulo não lê nada
 *    dela há mais de 2 horas **e** a origem tem objeto novo, de mais de 30 min, que ele não leu (uma listagem barata do
 *    bucket). Sem objeto novo, a conta só está quieta, e a fonte segue como estava.
 *
 * `ingestion_error`: a fonte ficou de fora da lista (o motivo é o código, `AWS_WAZUH_SOURCE_EXCLUSION_CODES`); o token do
 * Google do host parou (`aws_token_stale`, nada é lido sem ele); ou a lista de agora não foi aplicada
 * (`wazuh_apply_failed`) e a fonte ainda não tinha entrado no manager. A fonte que o manager já lia segue pelo marcador
 * dela: o manager continua com a configuração anterior, que a tem.
 *
 * `lastSyncAt` é a última vez que o nó confirmou a fonte na configuração que o manager roda, com o token em dia e o
 * marcador dela lido (o módulo passa por todas as fontes a cada 5 min; ele não registra cada passagem). `permission_error`
 * e `source_missing` não são daqui: a descoberta os grava, e a fonte nesses estados nem chega a este arquivo.
 *
 * Cada mudança é gravada pelo escopo do cliente da fonte, só se a fonte ainda estiver como foi lida (uma revogação ou a
 * descoberta no meio ganham). A trilha de auditoria só recebe o que importa: a primeira coleta de uma fonte, a entrada
 * num erro ou na parada, e a saída deles. O resto (a espera, os horários a cada leitura) não vai para a trilha.
 */

/** A coleta no nó, como a tarefa `wazuh-config` a resume: aplicada, esperando a aplicação, ou o aviso do nó inteiro. */
export type WazuhNodeState = 'ok' | 'pending' | AwsCollectionErrorCode;

/** Depois de quanto tempo sem leitura uma fonte contínua tem a origem conferida. */
export const WAZUH_STALL_AFTER_MS = 2 * 60 * 60 * 1000;
/** O objeto novo só conta como não lido depois disso (o módulo passa a cada 5 min, e a entrega tem o tempo dela). */
export const WAZUH_STALL_OBJECT_AGE_MS = 30 * 60 * 1000;
/** Cada fonte tem a origem conferida no máximo a cada 30 min... */
export const WAZUH_STALL_CHECK_EVERY_MS = 30 * 60 * 1000;
/** ...e no máximo 10 fontes por execução da tarefa. */
export const WAZUH_STALL_CHECKS_PER_RUN = 10;

/** As fontes contínuas: numa conta em uso, sempre há objeto novo. As outras ficam quietas sem ser problema. */
const CONTINUOUS_KINDS: readonly string[] = ['cloudtrail', 'vpc_flow_logs'];
/** Os estados em que a fonte já entrou na configuração que o manager roda. */
const APPLIED_STATES: readonly string[] = ['waiting_events', 'collecting', 'stalled'];

export interface WazuhSourceHealthValues {
  state: AwsSourceState;
  stateCode: string | null;
  lastSyncAt: Date | null;
  lastEventAt: Date | null;
  lastIngestedAt: Date | null;
  lagSeconds: number | null;
}

export interface SourceHealthContext {
  now: Date;
  node: WazuhNodeState;
  /** O sinal `progress` de agora; null sem ele, fora do formato ou velho demais. */
  progress: WazuhProgress | null;
}

const time = (date: Date | null): number | null => date?.getTime() ?? null;

function kept(row: WazuhSourceRow): Omit<WazuhSourceHealthValues, 'state' | 'stateCode'> {
  return {
    lastSyncAt: row.lastSyncAt,
    lastEventAt: row.lastEventAt,
    lastIngestedAt: row.lastIngestedAt,
    lagSeconds: row.lagSeconds,
  };
}

/** A fonte já está na configuração que o manager roda: a lista de agora foi aplicada, ou ela já vinha sendo lida. */
function applied(row: WazuhSourceRow, node: WazuhNodeState): boolean {
  return node === 'ok' || APPLIED_STATES.includes(row.state);
}

/** O marcador vale para a coleta de agora: o módulo leu algo da fonte desde o dia em que a coleta dela começou. */
function qualifies(row: WazuhSourceRow, marker: WazuhSourceMarker | null): marker is WazuhSourceMarker {
  if (marker === null) return false;
  const from = row.collectFrom?.getTime() ?? 0;
  // S3: quando o objeto foi lido. CloudWatch Logs: o horário do evento (o módulo só lê a partir do início da coleta).
  const at = marker.ingestedAt ?? marker.eventAt;
  return at !== null && at.getTime() >= from;
}

/** O que o sinal diz da fonte; null quando ela não está na lista, não foi aplicada ou não há sinal. */
export function sourceMarker(
  source: PlannedWazuhSource,
  context: SourceHealthContext,
): WazuhMarkerLookup | null {
  if (!source.outcome.included || context.node === 'aws_token_stale') return null;
  if (!applied(source.row, context.node) || context.progress === null) return null;
  return findWazuhMarker(context.progress, source.outcome.marker);
}

/**
 * O estado e os horários que a fonte deve ter agora. `stalled` é o resultado da conferência da origem (`true`: há
 * objeto novo que o módulo não leu; `null`: não conferida), e só vale para as fontes contínuas.
 */
export function deriveSourceHealth(
  source: PlannedWazuhSource,
  context: SourceHealthContext,
  stalled: boolean | null = null,
): WazuhSourceHealthValues {
  const { row, outcome } = source;
  const { node, progress } = context;
  if (!outcome.included) return { state: 'ingestion_error', stateCode: outcome.code, ...kept(row) };
  // Sem o token do Google, o manager não entra em papel nenhum: nada é lido, de fonte nenhuma.
  if (node === 'aws_token_stale') return { state: 'ingestion_error', stateCode: node, ...kept(row) };
  if (!applied(row, node)) {
    return node === 'wazuh_apply_failed'
      ? { state: 'ingestion_error', stateCode: node, ...kept(row) }
      : { state: 'configuring', stateCode: AWS_WAZUH_AWAITING_APPLY, ...kept(row) };
  }
  const lookup = progress === null ? null : findWazuhMarker(progress, outcome.marker);
  if (progress === null || lookup === null || !lookup.known) {
    // Sem saber o que o módulo leu, a fonte que já estava aplicada fica como está; a recém-aplicada espera os eventos.
    return APPLIED_STATES.includes(row.state)
      ? { state: row.state as AwsSourceState, stateCode: row.stateCode, ...kept(row) }
      : { state: 'waiting_events', stateCode: null, ...kept(row) };
  }
  const halted = stalled === true && CONTINUOUS_KINDS.includes(row.kind);
  const state = (collecting: boolean): Pick<WazuhSourceHealthValues, 'state' | 'stateCode'> =>
    halted
      ? { state: 'stalled', stateCode: AWS_WAZUH_NO_PROGRESS }
      : { state: collecting ? 'collecting' : 'waiting_events', stateCode: null };
  const { marker } = lookup;
  if (!qualifies(row, marker)) return { ...state(false), ...kept(row), lastSyncAt: progress.at };

  const eventAt = marker.eventAt ?? row.lastEventAt;
  // O CloudWatch Logs não guarda quando o módulo leu: vale o momento em que o nó viu o marcador andar.
  const ingestedAt =
    marker.ingestedAt ??
    (row.lastIngestedAt !== null && time(row.lastEventAt) === time(eventAt)
      ? row.lastIngestedAt
      : progress.at);
  const lagSeconds =
    eventAt === null
      ? row.lagSeconds
      : Math.max(0, Math.round((ingestedAt.getTime() - eventAt.getTime()) / 1000));
  return {
    ...state(true),
    lastSyncAt: progress.at,
    lastEventAt: eventAt,
    lastIngestedAt: ingestedAt,
    lagSeconds,
  };
}

/** O que a conferência da origem lista: os objetos da fonte numa pasta de dia, depois do último lido. */
export interface StallQuestion {
  /** O ID do cadastro da conta (para a sessão de leitura) e a região de partida do S3. */
  tenantId: string;
  cloudAccountId: string;
  accountId: string;
  homeRegion: string;
  bucket: string;
  /** As pastas de dia a olhar, a mais antiga primeiro, com o começo do nome dos objetos da fonte. */
  prefixes: string[];
  /** O último objeto que o módulo leu; null sem marcador. */
  afterKey: string | null;
  /** Só conta o objeto gravado antes disso. */
  olderThan: Date;
}

/** Quem pergunta à AWS se há objeto novo (o do worker, com a sessão de leitura da conta; um falso nos testes). */
export interface WazuhStallProbe {
  /** `true`: há objeto novo, de antes de `olderThan`, que o módulo não leu; `null`: não deu para conferir. */
  hasUnreadObjects(question: StallQuestion, signal: AbortSignal): Promise<boolean | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (value: number): string => String(value).padStart(2, '0');
const dayFolder = (day: Date): string =>
  `${day.getUTCFullYear()}/${pad(day.getUTCMonth() + 1)}/${pad(day.getUTCDate())}/`;

/**
 * A pergunta da conferência de uma fonte contínua, ou null quando não é hora de conferir: a fonte não é contínua, não
 * está aplicada, o marcador não é conhecido, ou o módulo leu algo dela há menos de 2 horas.
 */
export function stallQuestion(
  source: PlannedWazuhSource,
  context: SourceHealthContext,
): StallQuestion | null {
  const { row, outcome } = source;
  if (!outcome.included || outcome.objects === null || !CONTINUOUS_KINDS.includes(row.kind)) return null;
  const lookup = sourceMarker(source, context);
  if (lookup === null || !lookup.known) return null;
  const now = context.now.getTime();
  const marker = qualifies(row, lookup.marker) ? lookup.marker : null;
  if (marker?.ingestedAt != null) {
    // Com marcador, conta de quando o módulo leu por último: uma leitura recente tira a fonte da parada.
    if (now - marker.ingestedAt.getTime() <= WAZUH_STALL_AFTER_MS) return null;
  } else if (row.state === 'waiting_events') {
    // Sem marcador, de quando a fonte passou a esperar os eventos.
    if (now - row.stateSince.getTime() <= WAZUH_STALL_AFTER_MS) return null;
  } else if (row.state !== 'stalled') {
    // Só a fonte que já esperava (ou já parada, conferida de novo para poder voltar).
    return null;
  }
  const listed = outcome.marker.method === 's3' ? outcome.marker.regions?.[0] : undefined;
  const region = marker?.region ?? listed ?? row.region;
  const chosen = region === 'global' ? source.homeRegion : region;
  const objects: WazuhObjectPrefix = outcome.objects;
  // Ontem e hoje, e nunca antes do dia em que a coleta começa (o módulo não lê o que é anterior a ele).
  const from = row.collectFrom?.getTime() ?? 0;
  const days = [new Date(now - DAY_MS), new Date(now)].filter(
    (day) => Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) >= from,
  );
  if (days.length === 0) return null;
  const head = objects.regionPrefix(chosen);
  return {
    tenantId: row.tenantId,
    cloudAccountId: row.cloudAccountId,
    accountId: source.accountId,
    homeRegion: source.homeRegion,
    bucket: objects.bucket,
    prefixes: days.map((day) => `${head}${dayFolder(day)}${objects.fileHead(chosen)}`),
    afterKey: marker?.lastKey ?? null,
    olderThan: new Date(now - WAZUH_STALL_OBJECT_AGE_MS),
  };
}

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface WazuhSourceHealthReport {
  /** Fontes da coleta (na lista ou fora dela). */
  sources: number;
  /** Fontes que mudaram de estado. */
  transitions: number;
  /** Fontes só com os horários atualizados. */
  refreshed: number;
  /** Conferências da origem feitas nesta execução. */
  stallChecks: number;
}

export interface WazuhSourceHealthOptions {
  audit?: AuditService;
  /** A conferência da origem; sem ela (o nó sem a sessão de leitura), nenhuma fonte é marcada como parada. */
  stallProbe?: WazuhStallProbe | null;
  checkEveryMs?: number;
  checksPerRun?: number;
}

const ERROR_STATES: readonly string[] = ['ingestion_error', 'stalled'];

/** A mudança de estado vai para a trilha do cliente: a primeira coleta, a entrada num erro ou na parada, e a saída. */
function audited(row: WazuhSourceRow, next: WazuhSourceHealthValues): boolean {
  if (ERROR_STATES.includes(next.state) || ERROR_STATES.includes(row.state)) return true;
  return next.state === 'collecting' && row.lastIngestedAt === null;
}

function sameHealth(row: WazuhSourceRow, next: WazuhSourceHealthValues): boolean {
  return (
    time(row.lastEventAt) === time(next.lastEventAt) &&
    time(row.lastIngestedAt) === time(next.lastIngestedAt) &&
    row.lagSeconds === next.lagSeconds
  );
}

/** Grava a saúde das fontes lidas pelo Wazuh (a segunda metade da tarefa `wazuh-config`). */
export class WazuhSourceHealth {
  private readonly audit: AuditService;
  private readonly stallProbe: WazuhStallProbe | null;
  private readonly checkEveryMs: number;
  private readonly checksPerRun: number;
  /** A última conferência da origem de cada fonte (memória do worker: uma partida nova só confere de novo). */
  private readonly checks = new Map<string, { at: number; stalled: boolean | null }>();

  constructor(
    private readonly prisma: PrismaService,
    {
      audit = new AuditService(),
      stallProbe = null,
      checkEveryMs = WAZUH_STALL_CHECK_EVERY_MS,
      checksPerRun = WAZUH_STALL_CHECKS_PER_RUN,
    }: WazuhSourceHealthOptions = {},
  ) {
    this.audit = audit;
    this.stallProbe = stallProbe;
    this.checkEveryMs = checkEveryMs;
    this.checksPerRun = checksPerRun;
  }

  async apply(
    sources: readonly PlannedWazuhSource[],
    context: SourceHealthContext,
    signal: AbortSignal,
  ): Promise<WazuhSourceHealthReport> {
    const report: WazuhSourceHealthReport = {
      sources: sources.length,
      transitions: 0,
      refreshed: 0,
      stallChecks: 0,
    };
    /** As fontes em que só a última confirmação mudou, por cliente: uma gravação para todas. */
    const confirmed = new Map<string, string[]>();
    const known = new Set<string>();
    for (const source of sources) {
      signal.throwIfAborted();
      const { row } = source;
      known.add(row.id);
      const stalled = await this.stalled(source, context, report, signal);
      const next = deriveSourceHealth(source, context, stalled);
      const sameState = row.state === next.state && row.stateCode === next.stateCode;
      if (sameState && sameHealth(row, next)) {
        if (time(row.lastSyncAt) !== time(next.lastSyncAt)) {
          confirmed.set(row.tenantId, [...(confirmed.get(row.tenantId) ?? []), row.id]);
        }
        continue;
      }
      if (!(await this.record(row, next, context.now))) continue;
      if (sameState) report.refreshed += 1;
      else report.transitions += 1;
    }
    const syncedAt = context.progress?.at ?? null;
    if (syncedAt !== null) {
      for (const [tenantId, ids] of confirmed) {
        signal.throwIfAborted();
        const { count } = await this.prisma.forTenant(tenantId).awsSource.updateMany({
          // Só a fonte que continua autorizada; a revogada no meio fica como está.
          where: { id: { in: ids }, authorizedAt: { not: null }, revokedAt: null },
          data: { lastSyncAt: syncedAt },
        });
        report.refreshed += count;
      }
    }
    // A fonte que saiu da coleta (revogada, a conta desativada) não guarda conferência.
    for (const id of this.checks.keys()) if (!known.has(id)) this.checks.delete(id);
    return report;
  }

  /** O resultado da conferência da origem de uma fonte contínua: a de agora, a guardada, ou null. */
  private async stalled(
    source: PlannedWazuhSource,
    context: SourceHealthContext,
    report: WazuhSourceHealthReport,
    signal: AbortSignal,
  ): Promise<boolean | null> {
    const { id } = source.row;
    const question = this.stallProbe === null ? null : stallQuestion(source, context);
    if (question === null || this.stallProbe === null) {
      // Não é hora de conferir (o módulo leu algo, ou a fonte saiu da espera): a conferência anterior não vale mais.
      this.checks.delete(id);
      return null;
    }
    const last = this.checks.get(id);
    const now = context.now.getTime();
    if (last !== undefined && now - last.at < this.checkEveryMs) return last.stalled;
    // Além do teto da execução, vale o que já se sabia; a próxima execução confere.
    if (report.stallChecks >= this.checksPerRun) return last?.stalled ?? null;
    report.stallChecks += 1;
    let stalled: boolean | null;
    try {
      stalled = await this.stallProbe.hasUnreadObjects(question, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      // A AWS não respondeu, ou a sessão caiu: não se sabe. A conferência da conexão é quem mostra esse problema.
      stalled = null;
    }
    this.checks.set(id, { at: now, stalled });
    return stalled;
  }

  /**
   * Grava o estado e os horários novos de uma fonte, se ela ainda for a lida (outra execução, uma revogação ou a
   * descoberta no meio descartam a gravação), com a auditoria na trilha do cliente quando a mudança importa.
   */
  private record(row: WazuhSourceRow, next: WazuhSourceHealthValues, now: Date): Promise<boolean> {
    const changed = row.state !== next.state || row.stateCode !== next.stateCode;
    return this.prisma.$transaction(async (tx) => {
      const db = scopeToTenant(tx, row.tenantId);
      const { count } = await db.awsSource.updateMany({
        where: {
          id: row.id,
          state: row.state,
          stateCode: row.stateCode,
          authorizedAt: { not: null },
          revokedAt: null,
        },
        data: {
          state: next.state,
          stateCode: next.stateCode,
          ...(changed && { stateSince: now }),
          lastSyncAt: next.lastSyncAt,
          lastEventAt: next.lastEventAt,
          lastIngestedAt: next.lastIngestedAt,
          lagSeconds: next.lagSeconds,
        },
      });
      if (count === 0) return false;
      if (changed && audited(row, next)) {
        const identity = { sourceId: row.id, kind: row.kind, region: row.region };
        await this.audit.write(tx, {
          actor: { type: 'system', tenantId: row.tenantId },
          action: 'cloud_account.aws_source_collection',
          outcome: 'success',
          resourceType: 'cloud_account',
          resourceId: row.cloudAccountId,
          before: { ...identity, state: row.state, stateCode: row.stateCode },
          after: { ...identity, state: next.state, stateCode: next.stateCode },
        });
      }
      return true;
    });
  }
}
