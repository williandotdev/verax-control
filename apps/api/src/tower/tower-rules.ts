import type { FindingSeverity, PendingDecisionKind, TrafficLight, TrafficLightReason } from '@verax/shared';

// Os tipos do resumo vêm do contrato compartilhado com o painel (`packages/shared/src/tower.ts`).
export type { PendingDecisionKind, TrafficLight, TrafficLightReason };

/**
 * Regras do resumo da Torre (T5.10).
 *
 * Semáforo (pendência 9, aprovada):
 * - **vermelho** quando há incidente crítico aberto;
 * - **amarelo** quando há incidente alto aberto ou a nota de postura está abaixo de 70;
 * - **verde** nos demais casos.
 * Sem nota de postura (nenhuma varredura ainda), a postura não pesa. Os limites ficam em configuração, e os
 * motivos vão junto, para a tela dizer por que a cor é aquela.
 */

export interface TowerThresholds {
  /** Nota de postura abaixo disto deixa a Torre amarela. */
  postureWarning: number;
  /** Conta sem evento há mais horas que isto aparece como silenciosa na cobertura. */
  silentAfterHours: number;
}

export const DEFAULT_TOWER_THRESHOLDS: Readonly<TowerThresholds> = {
  postureWarning: 70,
  silentAfterHours: 24,
};

export function trafficLight(
  input: { openIncidents: Readonly<Record<FindingSeverity, number>>; postureScore: number | null },
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
): { light: TrafficLight; reasons: TrafficLightReason[] } {
  const reasons: TrafficLightReason[] = [];
  if (input.openIncidents.critical > 0) reasons.push('critical_incident');
  if (input.openIncidents.high > 0) reasons.push('high_incident');
  if (input.postureScore !== null && input.postureScore < thresholds.postureWarning) {
    reasons.push('low_posture');
  }
  const light: TrafficLight = reasons.includes('critical_incident')
    ? 'red'
    : reasons.length > 0
      ? 'yellow'
      : 'green';
  return { light, reasons };
}

export interface AccountActivity {
  accountId: string;
  /** Horário do último alerta recebido da conta, ou `null` se nunca chegou nada. */
  lastEventAt: string | null;
}

export interface Coverage {
  connectedAccounts: number;
  /** O evento mais recente entre todas as contas. */
  lastEventAt: string | null;
  /** Contas sem evento há mais que o limite (ou que nunca mandaram nada), em ordem. */
  silentAccounts: string[];
}

export function coverage(
  accounts: readonly AccountActivity[],
  now: Date,
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
): Coverage {
  const limit = now.getTime() - thresholds.silentAfterHours * 60 * 60 * 1000;
  const times = accounts
    .flatMap((account) => (account.lastEventAt === null ? [] : [account.lastEventAt]))
    .sort();
  return {
    connectedAccounts: accounts.length,
    lastEventAt: times[times.length - 1] ?? null,
    silentAccounts: accounts
      .filter((account) => account.lastEventAt === null || Date.parse(account.lastEventAt) < limit)
      .map((account) => account.accountId)
      .sort(),
  };
}

export interface PendingDecision {
  kind: PendingDecisionKind;
  count: number;
}

/**
 * Decisões pendentes (premissa aprovada): incidente aberto sem responsável, achado alto ou crítico em "novo" fora de
 * incidente e, só para `admin_verax`, alertas sem dono. Só entram as que existem, nessa ordem de prioridade.
 */
export function pendingDecisions(
  counts: { unassignedIncidents: number; untriagedFindings: number; unownedAlerts: number },
  options: { includeUnowned: boolean },
): PendingDecision[] {
  const decisions: PendingDecision[] = [
    { kind: 'unassigned_incident', count: counts.unassignedIncidents },
    { kind: 'untriaged_finding', count: counts.untriagedFindings },
  ];
  if (options.includeUnowned) decisions.push({ kind: 'unowned_alert', count: counts.unownedAlerts });
  return decisions.filter((decision) => decision.count > 0);
}
