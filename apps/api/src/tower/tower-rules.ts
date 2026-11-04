import type {
  CloudAccountConnection,
  CloudProvider,
  FindingSeverity,
  PendingDecisionKind,
  TrafficLight,
  TrafficLightReason,
} from '@verax/shared';

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
  /** Conta sem sinal de vida (evento ou coleta, conforme o provedor) há mais horas que isto aparece como silenciosa. */
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
  /** O provedor decide o sinal de vida da conta (ver `coverage`). */
  provider: CloudProvider;
  /** Estado da coleta, gravado pelo coletor da conta. */
  connection: CloudAccountConnection;
  /** Última leitura bem-sucedida da fonte da conta (com ou sem evento), ou `null` se nunca houve. */
  lastCollectedAt: string | null;
  /** Horário do último alerta recebido da conta, ou `null` se nunca chegou nada. */
  lastEventAt: string | null;
}

export interface Coverage {
  /** Contas no estado "Conectada". */
  connectedAccounts: number;
  /** A coleta bem-sucedida mais recente entre todas as contas. */
  lastCollectedAt: string | null;
  /** O evento mais recente entre todas as contas. */
  lastEventAt: string | null;
  /** Contas sem sinal de vida há mais que o limite (ou que nunca deram sinal), em ordem. */
  silentAccounts: string[];
}

/**
 * Provedores cujas fontes entregam por evento: a AWS, lida pelo Wazuh, e a GCP, pelo Pub/Sub. Uma leitura vazia
 * não prova que os logs chegam (sink apagado, trilha parada), então só o evento conta como sinal de vida.
 */
const EVENT_DELIVERED: ReadonlySet<CloudProvider> = new Set<CloudProvider>(['aws', 'gcp']);

function latest(times: readonly (string | null)[]): string | null {
  return times.reduce<string | null>(
    (newest, time) =>
      time !== null && (newest === null || Date.parse(time) > Date.parse(newest)) ? time : newest,
    null,
  );
}

/** O sinal de vida mais recente da conta, que depende de como o provedor entrega os logs. */
function lastSignOfLife(account: AccountActivity): string | null {
  if (EVENT_DELIVERED.has(account.provider)) return account.lastEventAt;
  return latest([account.lastCollectedAt, account.lastEventAt]);
}

/**
 * Cobertura (fase 2): "conectadas" são as contas no estado `connected`, gravado pelo coletor de cada uma. Conta
 * silenciosa é a que não dá sinal de vida há mais que o limite, e o sinal depende do provedor:
 * - **AWS e GCP** (entregues por evento: Wazuh e Pub/Sub): só o último evento. Uma leitura vazia não prova que os
 *   logs chegam, então uma conta lida sem erro, mas sem evento, fica silenciosa;
 * - **Cloudflare e os demais coletados por API**: o mais recente entre a última coleta e o último evento. A leitura
 *   bem-sucedida prova que a conta está acessível, mesmo sem evento.
 */
export function coverage(
  accounts: readonly AccountActivity[],
  now: Date,
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
): Coverage {
  const limit = now.getTime() - thresholds.silentAfterHours * 60 * 60 * 1000;
  return {
    connectedAccounts: accounts.filter((account) => account.connection === 'connected').length,
    lastCollectedAt: latest(accounts.map((account) => account.lastCollectedAt)),
    lastEventAt: latest(accounts.map((account) => account.lastEventAt)),
    silentAccounts: accounts
      .filter((account) => {
        const alive = lastSignOfLife(account);
        return alive === null || Date.parse(alive) < limit;
      })
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
