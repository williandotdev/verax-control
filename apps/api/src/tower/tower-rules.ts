import {
  type CloudAccountConnection,
  type CloudProvider,
  COLLECTION_SOURCES,
  type CollectionSource,
  type CollectionState,
  type FindingSeverity,
  type PendingDecisionKind,
  PULSE_HOURS,
  type TrafficLight,
  type TrafficLightReason,
} from '@verax/shared';

// Os tipos do resumo vêm do contrato compartilhado com o painel (`packages/shared/src/tower.ts`).
export type { PendingDecisionKind, TrafficLight, TrafficLightReason };

/**
 * Regras do resumo da Torre (T5.10, com a saúde da coleta do OP-01 e do OP-02).
 *
 * Semáforo (pendência 9, aprovada, mais a coleta parada, decisão de 05/11/2026):
 * - **vermelho** quando há incidente crítico aberto;
 * - **amarelo** quando há incidente alto aberto, a nota de postura está abaixo de 70 ou uma fonte configurada está com
 *   a coleta parada (`collection_stalled`: sem dado novo há mais que o prazo de parada dela, ver `collectionHealth`).
 *   Fonte não configurada (cliente sem Cloudflare, sem agentes) ou ainda sem nenhum dado nunca deixa a Torre amarela;
 * - **verde** nos demais casos.
 * Sem nota de postura (nenhuma varredura ainda), a postura não pesa. Os limites ficam em configuração, e os
 * motivos vão junto, para a tela dizer por que a cor é aquela.
 */

/** Prazos da saúde de uma fonte: sem dado novo há mais que o primeiro, atrasada; há mais que o segundo, parada. */
export interface CollectionWindow {
  delayedAfterMinutes: number;
  stalledAfterMinutes: number;
}

export interface TowerThresholds {
  /** Nota de postura abaixo disto deixa a Torre amarela. */
  postureWarning: number;
  /** Conta sem sinal de vida (evento ou coleta, conforme o provedor) há mais horas que isto aparece como silenciosa. */
  silentAfterHours: number;
  /**
   * Com conta AWS conectada, o contador de eventos da AWS do Wazuh do nó parado há mais horas que isto: "Sem logs novos
   * da AWS" (PR-V6). O mesmo prazo vale para o aviso por e-mail da tarefa `wazuh-usage` e é o prazo de parada da fonte
   * `aws` em `collection`.
   */
  awsStalledAfterHours: number;
  /** "Saúde da coleta" (OP-02): os prazos de cada fonte, pela cadência em que ela entrega dado. */
  collection: Readonly<Record<CollectionSource, Readonly<CollectionWindow>>>;
}

const AWS_STALLED_AFTER_HOURS = 2;
const HOUR_MINUTES = 60;

export const DEFAULT_TOWER_THRESHOLDS: Readonly<TowerThresholds> = {
  postureWarning: 70,
  silentAfterHours: 24,
  awsStalledAfterHours: AWS_STALLED_AFTER_HOURS,
  collection: {
    // O wodle lê os buckets a cada 5 min, a tarefa `wazuh-usage` lê os contadores a cada 5 min, e a própria conferência
    // da conexão (a cada 15 min) põe eventos no CloudTrail: numa conta conectada, o contador anda várias vezes por hora.
    aws: { delayedAfterMinutes: 30, stalledAfterMinutes: AWS_STALLED_AFTER_HOURS * HOUR_MINUTES },
    // A auditoria de um projeto calmo pode passar a noite sem entrada nenhuma: o prazo é o da conta silenciosa.
    gcp: { delayedAfterMinutes: 12 * HOUR_MINUTES, stalledAfterMinutes: 24 * HOUR_MINUTES },
    // A auditoria é lida a cada 5 min e os eventos de segurança, em janelas de 15 min: a leitura vale como dado.
    cloudflare: { delayedAfterMinutes: 30, stalledAfterMinutes: 2 * HOUR_MINUTES },
    // O manager recebe o keepalive dos agentes em segundos, e a lista chega ao banco a cada minuto.
    agents: { delayedAfterMinutes: 15, stalledAfterMinutes: HOUR_MINUTES },
    // Uma leitura por conta a cada 24 h, mais um sorteio de até 1 h: atrasada com uma volta perdida, parada com duas.
    posture: { delayedAfterMinutes: 26 * HOUR_MINUTES, stalledAfterMinutes: 50 * HOUR_MINUTES },
  },
};

/**
 * Desde quando o cliente está sem logs novos da AWS (fase 2, PR-V6), ou null. Vale só com conta AWS conectada e a saúde
 * da ingestão observada (`IngestHealth.lastProgressAt`, a última vez que os eventos do módulo da AWS andaram no
 * analysisd, ou o começo da observação): parada há mais de `awsStalledAfterHours` horas, devolve esse momento. A regra é
 * uma só para a Torre e para o aviso por e-mail.
 */
export function awsLogsStalledSince(
  input: { awsConnected: boolean; lastProgressAt: Date | null },
  now: Date,
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
): Date | null {
  if (!input.awsConnected || input.lastProgressAt === null) return null;
  const stalled =
    now.getTime() - input.lastProgressAt.getTime() > thresholds.awsStalledAfterHours * 60 * 60 * 1000;
  return stalled ? input.lastProgressAt : null;
}

export function trafficLight(
  input: {
    openIncidents: Readonly<Record<FindingSeverity, number>>;
    postureScore: number | null;
    /** As fontes com a coleta parada (`stalledSources`); sem informar, nenhuma. */
    stalledSources?: readonly CollectionSource[];
  },
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
): { light: TrafficLight; reasons: TrafficLightReason[] } {
  const reasons: TrafficLightReason[] = [];
  if (input.openIncidents.critical > 0) reasons.push('critical_incident');
  if (input.openIncidents.high > 0) reasons.push('high_incident');
  if (input.postureScore !== null && input.postureScore < thresholds.postureWarning) {
    reasons.push('low_posture');
  }
  if ((input.stalledSources ?? []).length > 0) reasons.push('collection_stalled');
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
  /**
   * Horário do último evento gravado na conta, ou `null` se nunca chegou nada. Na AWS, só o alerta (nível 5 ou mais)
   * que o sync do indexer lê; na GCP e no Cloudflare, toda entrada lida.
   */
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

function latest(times: readonly (string | null | undefined)[]): string | null {
  return times.reduce<string | null>(
    (newest, time) =>
      time != null && (newest === null || Date.parse(time) > Date.parse(newest)) ? time : newest,
    null,
  );
}

function earliest(times: readonly (string | null)[]): string | null {
  return times.reduce<string | null>(
    (oldest, time) =>
      time !== null && (oldest === null || Date.parse(time) < Date.parse(oldest)) ? time : oldest,
    null,
  );
}

/**
 * O sinal de vida mais recente da conta, que depende de como o provedor entrega os logs (ver `coverage`). A AWS e a GCP
 * entregam por evento: uma leitura vazia não prova que os logs chegam (sink apagado, trilha parada).
 */
function lastSignOfLife(account: AccountActivity, awsLastProgressAt: string | null): string | null {
  switch (account.provider) {
    case 'aws':
      return latest([account.lastEventAt, account.connection === 'connected' ? awsLastProgressAt : null]);
    case 'gcp':
      return account.lastEventAt;
    default:
      return latest([account.lastCollectedAt, account.lastEventAt]);
  }
}

/**
 * Cobertura (fase 2, com o OP-01): "conectadas" são as contas no estado `connected`, gravado pelo coletor de cada uma.
 * Conta silenciosa é a que não dá sinal de vida há mais que o limite, e o sinal depende do provedor:
 * - **AWS** (lida pelo Wazuh): o último alerta ou, com a conta conectada, o andamento dos eventos da AWS no Wazuh do nó
 *   (`awsLastProgressAt`, de `IngestHealth`). Os eventos comuns de uma conta calma (CloudTrail, bloqueio do WAF,
 *   GuardDuty de baixa gravidade) têm nível 3 no Wazuh e nunca viram alerta: antes do OP-01, só o alerta contava, e a
 *   conta calma aparecia "sem eventos há mais de 24 horas" justamente com a coleta saudável. O contador é do nó, então
 *   vale para cada conta AWS conectada do cliente; a conta com erro de conexão depende do próprio alerta;
 * - **GCP** (entregue pelo Pub/Sub): só o último evento (toda entrada lida, com ou sem regra). Uma conta lida sem erro,
 *   mas sem evento, fica silenciosa;
 * - **Cloudflare e os demais coletados por API**: o mais recente entre a última coleta e o último evento. A leitura
 *   bem-sucedida prova que a conta está acessível, mesmo sem evento.
 */
export function coverage(
  accounts: readonly AccountActivity[],
  now: Date,
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
  awsLastProgressAt: string | null = null,
): Coverage {
  const limit = now.getTime() - thresholds.silentAfterHours * 60 * 60 * 1000;
  return {
    connectedAccounts: accounts.filter((account) => account.connection === 'connected').length,
    lastCollectedAt: latest(accounts.map((account) => account.lastCollectedAt)),
    lastEventAt: latest(accounts.map((account) => account.lastEventAt)),
    silentAccounts: accounts
      .filter((account) => {
        const alive = lastSignOfLife(account, awsLastProgressAt);
        return alive === null || Date.parse(alive) < limit;
      })
      .map((account) => account.accountId)
      .sort(),
  };
}

/** O que a Torre sabe de cada fonte para dizer se a coleta anda (OP-02). */
export interface CollectionSignals {
  /** As contas ativas do cliente. */
  accounts: readonly AccountActivity[];
  /** AWS: `IngestHealth.lastProgressAt` (PR-V6), a última vez que os eventos da AWS andaram no Wazuh do nó; ou null. */
  awsLastProgressAt: string | null;
  /** Agentes do Wazuh registrados do cliente e o keepalive mais recente entre eles. */
  agents: { registered: number; lastKeepAliveAt: string | null };
  /** Postura e inventário da AWS: a varredura e o retrato mais recentes das contas AWS ativas. */
  lastPostureScanAt: string | null;
  lastInventoryAt: string | null;
}

export interface SourceHealth {
  source: CollectionSource;
  state: CollectionState;
  lastDataAt: string | null;
  /** Só na AWS: o último alerta, à parte do último dado. */
  lastAlertAt?: string | null;
  delayedAfterMinutes: number;
  stalledAfterMinutes: number;
}

function stateOf(
  configured: boolean,
  lastDataAt: string | null,
  window: Readonly<CollectionWindow>,
  now: Date,
): CollectionState {
  if (!configured) return 'not_configured';
  if (lastDataAt === null) return 'waiting';
  const minutes = (now.getTime() - Date.parse(lastDataAt)) / 60_000;
  if (minutes > window.stalledAfterMinutes) return 'stalled';
  if (minutes > window.delayedAfterMinutes) return 'delayed';
  return 'collecting';
}

/**
 * "Saúde da coleta" da Torre (OP-02): uma linha por fonte, com o último dado que prova a coleta e o estado pelo prazo
 * da fonte (`thresholds.collection`). A fonte é configurada quando o cliente tem uma conta ativa do provedor (na
 * postura, uma conta AWS ativa; nos agentes, um agente registrado); sem dado nenhum ainda, ela aguarda. O estado é da
 * fonte, não de cada conta: basta uma conta entregando para a fonte coletar, e a conta com problema aparece na
 * conexão dela e entre as contas silenciosas. O último dado de cada fonte:
 * - **AWS:** o mais recente entre o andamento dos eventos da AWS no Wazuh do nó (`IngestHealth.lastProgressAt`; no
 *   começo da observação é a hora em que ela começou) e o último alerta de uma conta AWS (o alerta também prova que os
 *   logs chegaram). O último alerta vai à parte (`lastAlertAt`). O prazo de parada é o de "Sem logs novos da AWS";
 * - **GCP:** o último evento de um projeto (toda entrada do Pub/Sub, com ou sem regra);
 * - **Cloudflare:** a última leitura bem-sucedida ou o último evento de uma conta;
 * - **agentes:** o keepalive mais recente de um agente registrado;
 * - **postura e inventário:** o mais antigo entre a última varredura de postura e o último retrato do inventário (as
 *   duas leituras têm de andar), ou o que existir.
 */
export function collectionHealth(
  signals: CollectionSignals,
  now: Date,
  thresholds: TowerThresholds = DEFAULT_TOWER_THRESHOLDS,
): SourceHealth[] {
  const of = (provider: CloudProvider) => signals.accounts.filter((account) => account.provider === provider);
  const aws = of('aws');
  const gcp = of('gcp');
  const cloudflare = of('cloudflare');
  const awsLastAlertAt = latest(aws.map((account) => account.lastEventAt));
  const posture =
    signals.lastPostureScanAt !== null && signals.lastInventoryAt !== null
      ? earliest([signals.lastPostureScanAt, signals.lastInventoryAt])
      : latest([signals.lastPostureScanAt, signals.lastInventoryAt]);

  const facts: Record<CollectionSource, { configured: boolean; lastDataAt: string | null }> = {
    aws: { configured: aws.length > 0, lastDataAt: latest([signals.awsLastProgressAt, awsLastAlertAt]) },
    gcp: { configured: gcp.length > 0, lastDataAt: latest(gcp.map((account) => account.lastEventAt)) },
    cloudflare: {
      configured: cloudflare.length > 0,
      lastDataAt: latest(cloudflare.flatMap((account) => [account.lastCollectedAt, account.lastEventAt])),
    },
    agents: { configured: signals.agents.registered > 0, lastDataAt: signals.agents.lastKeepAliveAt },
    posture: { configured: aws.length > 0, lastDataAt: posture },
  };

  return COLLECTION_SOURCES.map((source) => {
    const window = thresholds.collection[source];
    const { configured, lastDataAt } = facts[source];
    // Uma fonte que o cliente não tem não mostra dado nenhum (o retrato de uma conta já desativada, por exemplo).
    const shown = configured ? lastDataAt : null;
    return {
      source,
      state: stateOf(configured, shown, window, now),
      lastDataAt: shown,
      ...(source === 'aws' && { lastAlertAt: configured ? awsLastAlertAt : null }),
      delayedAfterMinutes: window.delayedAfterMinutes,
      stalledAfterMinutes: window.stalledAfterMinutes,
    };
  });
}

/** As fontes paradas, na ordem da tela: o motivo `collection_stalled` do semáforo. */
export function stalledSources(sources: readonly SourceHealth[]): CollectionSource[] {
  return sources.filter((health) => health.state === 'stalled').map((health) => health.source);
}

/** O último dado entre todas as fontes (OP-01): a prova de que a coleta anda, à parte do último alerta. */
export function lastDataAt(sources: readonly SourceHealth[]): string | null {
  return latest(sources.map((health) => health.lastDataAt));
}

const HOUR_MS = 60 * 60 * 1000;

/** Começo da faixa "Pulso da operação": a hora cheia atual menos 23 horas (24 horas cheias, a última em curso). */
export function pulseSince(now: Date): Date {
  return new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - (PULSE_HOURS - 1) * HOUR_MS);
}

/** Achados por hora cheia desde `since`, da mais antiga à atual. O que ficar fora das 24 horas não conta. */
export function hourlyCounts(occurredAt: readonly Date[], since: Date): number[] {
  const hours = Array.from({ length: PULSE_HOURS }, () => 0);
  for (const at of occurredAt) {
    const index = Math.floor((at.getTime() - since.getTime()) / HOUR_MS);
    if (index >= 0 && index < PULSE_HOURS) hours[index] = (hours[index] ?? 0) + 1;
  }
  return hours;
}

/**
 * Mediana do tempo até detectar, em segundos inteiros: da hora do evento (`occurredAt`) à criação do achado
 * (`createdAt`). Um relógio de origem adiantado (achado criado antes do evento) conta como zero. Null sem achado.
 */
export function medianTimeToDetect(
  findings: readonly { occurredAt: Date; createdAt: Date }[],
): number | null {
  const seconds = findings
    .map((finding) => Math.max(0, (finding.createdAt.getTime() - finding.occurredAt.getTime()) / 1000))
    .sort((a, b) => a - b);
  if (seconds.length === 0) return null;
  const middle = Math.floor(seconds.length / 2);
  const median =
    seconds.length % 2 === 1
      ? (seconds[middle] ?? 0)
      : ((seconds[middle - 1] ?? 0) + (seconds[middle] ?? 0)) / 2;
  return Math.round(median);
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
