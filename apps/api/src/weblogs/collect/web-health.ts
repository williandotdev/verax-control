import type { WebSourceStateCode } from '@verax/shared';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * O estado e a saúde de um balanceador (`AwsSource`, `elb_logs`) depois de cada passagem da tarefa `web-logs`. Função pura:
 * quem grava é a tarefa.
 *
 * - `authorized` → `waiting_events`: a listagem deu certo, e nenhum arquivo foi lido desde a autorização;
 * - `collecting`: algum arquivo já foi lido. Um site sem visita não "para": o que conta é a listagem dar certo. Com arquivo
 *   recusado nas últimas 24 h, o código é `web_quarantined`;
 * - `stalled` (`web_unread`): há arquivo mais novo à espera e nada foi lido nas últimas 2 h;
 * - `ingestion_error` (`web_gap`): nas últimas 24 h, arquivos com mais de 24 h ficaram sem leitura (quantos e de quando está
 *   no registro dos objetos); ou um erro que não é de permissão, na terceira passagem seguida com ele; ou o que a descoberta
 *   guardou não serve (`invalid_details`, `web_prefix_unsupported`), já na primeira;
 * - `permission_error`: o S3 recusou, com o motivo.
 *
 * O atraso (`lagSeconds`) é de agora ao fim do último intervalo fechado que já foi lido: de 10 a 15 min quando em dia.
 */

/** Falhas seguidas a partir das quais a fonte vira `ingestion_error`. */
export const WEB_ERROR_AFTER = 3;
/** Sem ler nada por este tempo, com arquivo à espera: parada. */
export const WEB_STALL_AFTER_MS = 2 * 60 * 60_000;

/** A permissão que uma listagem que deu certo desmente. */
const LIST_DENIALS: ReadonlySet<string> = new Set([
  'bucket_denied',
  'bucket_missing',
  'outside_awslogs_prefix',
  's3:ListBucket',
]);

const MAX_INT = 2_147_483_647;

export interface WebSourceFacts {
  state: string;
  stateCode: string | null;
  permission: string;
  permissionDetail: string | null;
  authorizedAt: Date | null;
  lastEventAt: Date | null;
  lastIngestedAt: Date | null;
}

export type WebOutcome =
  | {
      type: 'synced';
      /** Algum arquivo novo entrou no nó nesta passagem. */
      ingested: boolean;
      /** O S3 entregou o conteúdo de algum arquivo (a prova da permissão). */
      opened: boolean;
      newestEventAt: Date | null;
      /** Arquivos à espera, pelo que foi listado. */
      unread: number;
      /** Arquivos deixados para trás, e recusados, nas últimas 24 h. */
      gap: boolean;
      quarantined: boolean;
      volume: { events: number; bytes: number };
      lagSeconds: number;
    }
  | { type: 'permission'; detail: string; lagSeconds: number | null }
  /** `immediate`: o que está guardado não serve; não adianta esperar a terceira vez. */
  | { type: 'failed'; code: string; failures: number; immediate?: boolean; lagSeconds: number | null };

export interface WebSourceChange {
  data: Prisma.AwsSourceUpdateManyMutationInput;
  /** A mudança de estado (não só de código), que vai para a trilha; null sem mudança. */
  transition: {
    from: { state: string; stateCode: string | null };
    to: { state: string; stateCode: string | null };
  } | null;
}

/** De agora ao fim do último intervalo lido, em segundos. */
export function webLagSeconds(position: Date | null, now: Date): number | null {
  if (position === null) return null;
  return Math.min(MAX_INT, Math.max(0, Math.floor((now.getTime() - position.getTime()) / 1000)));
}

type SyncedOutcome = Extract<WebOutcome, { type: 'synced' }>;

function syncedState(
  current: WebSourceFacts,
  outcome: SyncedOutcome,
  now: Date,
): { state: string; stateCode: WebSourceStateCode | null } {
  if (outcome.gap) return { state: 'ingestion_error', stateCode: 'web_gap' };
  const since = current.authorizedAt ?? now;
  // O que foi lido antes desta autorização não diz nada da coleta de agora.
  const last =
    current.lastIngestedAt !== null && current.lastIngestedAt >= since ? current.lastIngestedAt : null;
  const quietFrom = outcome.ingested ? now : (last ?? since);
  if (outcome.unread > 0 && quietFrom.getTime() < now.getTime() - WEB_STALL_AFTER_MS) {
    return { state: 'stalled', stateCode: 'web_unread' };
  }
  if (!outcome.ingested && last === null) return { state: 'waiting_events', stateCode: null };
  return { state: 'collecting', stateCode: outcome.quarantined ? 'web_quarantined' : null };
}

/** O que muda na fonte depois de uma passagem. */
export function webSourceChange(current: WebSourceFacts, outcome: WebOutcome, now: Date): WebSourceChange {
  const moved = (state: string, stateCode: string | null): WebSourceChange => ({
    data: { state, stateCode, ...(state !== current.state && { stateSince: now }) },
    transition:
      state === current.state
        ? null
        : { from: { state: current.state, stateCode: current.stateCode }, to: { state, stateCode } },
  });
  const lag = outcome.lagSeconds === null ? {} : { lagSeconds: outcome.lagSeconds };

  if (outcome.type === 'permission') {
    const next = moved('permission_error', outcome.detail);
    return {
      ...next,
      data: {
        ...next.data,
        ...lag,
        ...((current.permission !== 'missing' || current.permissionDetail !== outcome.detail) && {
          permission: 'missing',
          permissionDetail: outcome.detail,
          permissionCheckedAt: now,
        }),
      },
    };
  }
  if (outcome.type === 'failed') {
    if (outcome.immediate !== true && outcome.failures < WEB_ERROR_AFTER)
      return { data: lag, transition: null };
    const next = moved('ingestion_error', outcome.code);
    return { ...next, data: { ...next.data, ...lag } };
  }

  // A permissão que faltava só volta com a prova dela: a listagem desmente a falta da listagem; a leitura, qualquer uma.
  const listed = current.permissionDetail !== null && LIST_DENIALS.has(current.permissionDetail);
  const denied = current.permission === 'missing' && !outcome.opened && !listed;
  const granted = current.permission !== 'granted' && !denied && (outcome.opened || listed);
  const target = syncedState(current, outcome, now);
  const next =
    denied && current.state === 'permission_error'
      ? moved(current.state, current.stateCode)
      : moved(target.state, target.stateCode);
  const lastEventAt =
    outcome.newestEventAt !== null &&
    (current.lastEventAt === null || outcome.newestEventAt > current.lastEventAt)
      ? outcome.newestEventAt
      : current.lastEventAt;
  return {
    ...next,
    data: {
      ...next.data,
      ...lag,
      lastSyncAt: now,
      lastEventAt,
      ...(outcome.ingested && { lastIngestedAt: now }),
      eventsLast24h: Math.min(MAX_INT, outcome.volume.events),
      bytesLast24h: BigInt(outcome.volume.bytes),
      ...(granted && { permission: 'granted', permissionDetail: null, permissionCheckedAt: now }),
    },
  };
}
