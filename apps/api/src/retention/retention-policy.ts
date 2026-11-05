import { PLAN_LIMIT_BOUNDS } from '@verax/shared';

/**
 * Regras do expurgo diário (fase 2, PR-19), sem banco: os cortes de cada tabela, a janela do dia e a carência quando o
 * plano diminui o prazo de histórico. O job (`retention-job.ts`) só aplica.
 *
 * Os pisos de idade da auditoria (13 meses) e dos comentários (30 dias) também estão no banco, na migration
 * `20261109120000_history_retention`: a função e o trigger recusam um corte mais novo, mesmo que este arquivo mude.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

/** O expurgo roda depois das 04:00 UTC (01:00 de Brasília), uma vez por dia. */
export const RETENTION_START_HOUR_UTC = 4;
/**
 * Folga de um dia nos cortes de histórico e de auditoria: apaga só o que passou do prazo mais um dia, para o relatório
 * do período sair completo e para a diferença entre o relógio do worker e o do banco nunca bater no piso.
 */
export const RETENTION_SLACK_DAYS = 1;
/** Quando o plano diminui o prazo, o anterior continua valendo por este tempo (para o cliente exportar). */
export const RETENTION_GRACE_DAYS = 30;
/** Auditoria: 13 meses (Marco Civil, art. 15, pede 6; 13 cobrem um ciclo anual de auditoria), ou o histórico, se maior. */
export const AUDIT_RETENTION_MONTHS = 13;
/** Inventário: 30 dias, sempre com o retrato mais recente de cada conta (conflito C7 do plano da fase 2). */
export const INVENTORY_RETENTION_DAYS = 30;
/** Fila de alertas sem dono (só a Verax vê): 90 dias. */
export const UNOWNED_RETENTION_DAYS = 90;
/**
 * Avisos por e-mail já resolvidos (enviados, com falha ou pulados; PR-16): 90 dias desde a última mudança. Ficam o
 * bastante para a chave de deduplicação (`usage:<AAAA-MM>:80`, por exemplo) não deixar o mesmo aviso sair de novo. O
 * aviso pendente nunca sai, e o de um incidente ou achado que sai vai junto com ele (chave estrangeira em cascata).
 */
export const NOTIFICATION_RETENTION_DAYS = 90;
/**
 * Tabelas de operação (sessões, links, tentativas de login, códigos TOTP usados e limite por IP): um dia além da
 * validade ou da janela de cada uma, que vão de 2 minutos a 12 horas.
 */
export const OPERATIONAL_SLACK_MS = DAY_MS;

const daysBefore = (at: Date, days: number): Date => new Date(at.getTime() - days * DAY_MS);

/** Começo da janela do dia de `now`: 04:00 UTC da mesma data UTC. */
export function retentionWindowStart(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RETENTION_START_HOUR_UTC),
  );
}

/**
 * Subtrai meses no calendário UTC, como o Postgres faz com `timestamptz - interval 'N months'` em UTC: o dia que não
 * existe no mês de destino vira o último dia dele (31/03 menos um mês é 28/02 ou 29/02), e a hora fica igual.
 */
export function subtractUtcMonths(at: Date, months: number): Date {
  const first = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - months, 1));
  const year = first.getUTCFullYear();
  const month = first.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(at.getUTCDate(), lastDay),
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );
}

/** Cortes de uma execução: apaga o que é anterior a cada um (o próprio corte fica). `null` é "não apaga". */
export interface RetentionCutoffs {
  /** Achados, incidentes e postura: o prazo do plano mais a folga. Null sem limite (plano interno). */
  history: Date | null;
  /** Retratos do inventário (o mais recente de cada conta fica sempre). */
  inventory: Date;
  /** Auditoria: o mais antigo entre 13 meses e o histórico, mais a folga. Null quando o histórico não tem limite. */
  audit: Date | null;
  /** Fila sem dono. */
  unowned: Date;
  /** Avisos por e-mail resolvidos. */
  notifications: Date;
  /** Tabelas de operação. */
  operational: Date;
}

/**
 * Cortes para o prazo de histórico em vigor (`historyDays`, já com a carência; null é sem limite). A auditoria nunca
 * sai antes do histórico que ela descreve: com histórico sem limite, ela também fica.
 */
export function retentionCutoffs(now: Date, historyDays: number | null): RetentionCutoffs {
  const { min, max } = PLAN_LIMIT_BOUNDS.historyDays;
  if (historyDays !== null && (!Number.isInteger(historyDays) || historyDays < min || historyDays > max)) {
    throw new Error(`dias de histórico fora da faixa de ${min} a ${max}`);
  }
  const history = historyDays === null ? null : daysBefore(now, historyDays + RETENTION_SLACK_DAYS);
  const auditFloor = daysBefore(subtractUtcMonths(now, AUDIT_RETENTION_MONTHS), RETENTION_SLACK_DAYS);
  return {
    history,
    inventory: daysBefore(now, INVENTORY_RETENTION_DAYS + RETENTION_SLACK_DAYS),
    audit: history === null ? null : new Date(Math.min(auditFloor.getTime(), history.getTime())),
    unowned: daysBefore(now, UNOWNED_RETENTION_DAYS),
    notifications: daysBefore(now, NOTIFICATION_RETENTION_DAYS),
    operational: new Date(now.getTime() - OPERATIONAL_SLACK_MS),
  };
}

/** Prazo guardado entre execuções (`RetentionState`). `null` em `appliedDays` é sem limite. */
export interface HistoryState {
  appliedDays: number | null;
  pendingSince: Date | null;
}

/** Prazo em vigor nesta execução, o estado a guardar e, durante a carência, quando ela acaba. */
export interface HistoryDecision {
  days: number | null;
  state: HistoryState;
  graceUntil: Date | null;
}

/** `a` guarda pelo menos tanto quanto `b` (null é sem limite). */
const keepsAtLeast = (a: number | null, b: number | null): boolean => a === null || (b !== null && a >= b);

/**
 * Prazo de histórico em vigor. O plano manda, com uma proteção: quando ele diminui o prazo (do Profissional para o
 * Essencial, por exemplo), o expurgo continua com o prazo aplicado até 30 dias depois da primeira execução que viu a
 * redução, e só então passa ao novo. Aumentar vale na hora e cancela a redução pendente. Sem estado (primeira
 * execução do nó), vale o plano.
 */
export function decideHistoryDays(
  planDays: number | null,
  state: HistoryState | null,
  now: Date,
): HistoryDecision {
  const adopt = (): HistoryDecision => ({
    days: planDays,
    state: { appliedDays: planDays, pendingSince: null },
    graceUntil: null,
  });
  if (state === null || keepsAtLeast(planDays, state.appliedDays)) return adopt();
  const since = state.pendingSince ?? now;
  const graceUntil = new Date(since.getTime() + RETENTION_GRACE_DAYS * DAY_MS);
  if (now.getTime() >= graceUntil.getTime()) return adopt();
  return {
    days: state.appliedDays,
    state: { appliedDays: state.appliedDays, pendingSince: since },
    graceUntil,
  };
}
