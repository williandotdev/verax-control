import { z } from 'zod';
import { type CaseQueueName, casesRequestShape } from './cases.js';
import { cloudAccountRefSchema } from './cloud-accounts.js';
import { FINDING_SEVERITIES, FINDING_SOURCES, FINDING_STATUSES, type FindingSource } from './findings.js';
import { usageMonthSchema } from './plan-usage.js';
import { MITRE_TACTICS } from './mitre.js';
import { mitreTacticSchema } from './reports.js';

/**
 * Resumo da Torre (T5.10): a resposta de `GET /v1/tower`, do cliente da sessão. A regra do semáforo está em
 * `apps/api/src/tower/tower-rules.ts`; aqui fica só o formato, validado pela API ao responder e pelo painel ao ler.
 *
 * **Versões diferentes.** O formato é estrito, e um painel de antes recusa a resposta inteira por um campo ou um valor que
 * não conhece. Por isso tudo o que é dos casos só vem para quem o pede (`towerQuerySchema`), e só de um nó que os mostra
 * a quem pede: o painel de antes não pede e recebe a resposta de sempre. O painel novo só pede a um nó que diz ter casos
 * (`GET /v1/cases/status`); o que ainda não conhece o pedido responde 400, e o painel pede de novo sem ele.
 */

/**
 * `cases=true`: com os casos valendo para quem pede (a mesma regra de `GET /v1/cases/status`), a resposta traz os campos
 * deles. Com os casos desligados, ou sem o pedido, é a de sempre.
 */
export const towerQuerySchema = z.strictObject(casesRequestShape);
export type TowerQuery = z.infer<typeof towerQuerySchema>;

export const TRAFFIC_LIGHTS = ['red', 'yellow', 'green'] as const;
export type TrafficLight = (typeof TRAFFIC_LIGHTS)[number];

/**
 * Por que o semáforo não está verde: incidente crítico aberto, incidente alto aberto, postura abaixo do limite ou
 * coleta parada numa fonte configurada (OP-02, decisão de 05/11/2026). A lista é fechada, e um painel de antes recusa
 * o valor que não conhece: alertas altos ou críticos para validar também tiram o verde, mas a tela os lê de
 * `pendingDecisions`, sem um motivo novo.
 */
export const TRAFFIC_LIGHT_REASONS = [
  'critical_incident',
  'high_incident',
  'low_posture',
  'collection_stalled',
] as const;
export type TrafficLightReason = (typeof TRAFFIC_LIGHT_REASONS)[number];

/**
 * Incidente aberto sem responsável, achado alto ou crítico sem triagem e (só admin_verax) alerta sem dono. Com os casos
 * ligados e pedidos, o achado sem triagem é contado pelo caso dele: `untriaged_case` (detecção e postura) e
 * `untriaged_vulnerability_case` são os casos com algum alerta alto ou crítico ainda em "novo", e `untriaged_finding` fica
 * só com os que nenhum caso cobre (à espera da atribuição, ou dentro de um incidente).
 */
export const PENDING_DECISION_KINDS = [
  'unassigned_incident',
  'untriaged_case',
  'untriaged_vulnerability_case',
  'untriaged_finding',
  'unowned_alert',
] as const;
export type PendingDecisionKind = (typeof PENDING_DECISION_KINDS)[number];

/**
 * Fontes da "Saúde da coleta" da Torre (OP-02), na ordem da tela: os logs da AWS (CloudTrail, GuardDuty e WAF, lidos
 * pelo Wazuh do nó), da GCP (Cloud Logging, pelo Pub/Sub) e do Cloudflare (auditoria e eventos de segurança), os
 * agentes do Wazuh nas instâncias do cliente e a leitura diária da postura e do inventário da AWS.
 */
export const COLLECTION_SOURCES = ['aws', 'gcp', 'cloudflare', 'agents', 'posture'] as const;
export type CollectionSource = (typeof COLLECTION_SOURCES)[number];

/**
 * Estado da coleta de uma fonte: `collecting` (dado novo dentro do prazo), `delayed` (passou do primeiro prazo),
 * `stalled` (passou do segundo; deixa a Torre amarela), `waiting` (configurada, mas sem nenhum dado ainda) e
 * `not_configured` (o cliente não tem a fonte). As duas últimas nunca pesam no semáforo.
 */
export const COLLECTION_STATES = ['collecting', 'delayed', 'stalled', 'waiting', 'not_configured'] as const;
export type CollectionState = (typeof COLLECTION_STATES)[number];

/** Horas da faixa "Pulso da operação": os achados por hora cheia, da hora atual até 23 horas antes. */
export const PULSE_HOURS = 24;

/** As fontes do medidor com eventos de log de verdade (o Cloudflare mede entradas e linhas agregadas, não eventos). */
export const PULSE_EVENT_SOURCES = ['aws', 'gcp'] as const;
export type PulseEventSource = (typeof PULSE_EVENT_SOURCES)[number];

const count = z.number().int().min(0);

export const collectionSourceHealthSchema = z
  .strictObject({
    source: z.enum(COLLECTION_SOURCES),
    state: z.enum(COLLECTION_STATES),
    /** O último dado que prova a coleta da fonte (a regra de cada uma está em `tower-rules.ts`); null sem nenhum. */
    lastDataAt: z.iso.datetime().nullable(),
    /**
     * Nas fontes de contas cloud (AWS, GCP e Cloudflare): o último evento recebido de uma conta, à parte do último dado.
     * Na AWS é o último alerta (nível 5 ou mais); na GCP, a última entrada do Pub/Sub; no Cloudflare, a última entrada
     * da auditoria. O evento não é o sinal de vida: uma conta ou um projeto calmo passa dias sem evento com a coleta
     * saudável. Ausente nas outras fontes.
     */
    lastEventAt: z.iso.datetime().nullable().optional(),
    /** Sem dado novo há mais que isto, a fonte fica atrasada; há mais que `stalledAfterMinutes`, parada. */
    delayedAfterMinutes: z.number().int().positive(),
    stalledAfterMinutes: z.number().int().positive(),
  })
  .refine((health) => health.delayedAfterMinutes < health.stalledAfterMinutes, {
    error: 'o prazo de atraso vem antes do de parada',
  });
export type CollectionSourceHealth = z.infer<typeof collectionSourceHealthSchema>;

export const towerPulseSchema = z
  .strictObject({
    /** Começo da primeira hora da faixa (hora cheia): os achados contados vão daqui até `generatedAt`. */
    since: z.iso.datetime(),
    findings: z.strictObject({
      /** Achados que aconteceram desde `since`. */
      total: count,
      /** Quantos deles chegaram marcados como esperados por uma exceção. */
      expected: count,
      /**
       * Achados por hora, da mais antiga à atual. Somam `total`, salvo num dia com mais de 5.000 achados: aí as horas
       * contam os 5.000 mais recentes, e o total segue exato.
       */
      hourly: z.array(count).length(PULSE_HOURS),
    }),
    /**
     * Mediana do tempo até detectar dos achados do período (da hora do evento à criação do achado), em segundos.
     * Inclui o atraso de entrega da fonte. Null sem achado.
     */
    timeToDetectSeconds: count.nullable(),
    /** Agentes do Wazuh nas instâncias do cliente: online (ativos) de registrados. Null sem nenhum registrado. */
    agents: z
      .strictObject({ online: count, total: z.number().int().positive() })
      .refine((agents) => agents.online <= agents.total, { error: 'mais agentes online que registrados' })
      .nullable(),
    /** Eventos lidos no mês pelo medidor de uso (`IngestUsage`), só das fontes com volume no mês. */
    monthEvents: z.strictObject({
      month: usageMonthSchema,
      sources: z
        .array(z.strictObject({ source: z.enum(PULSE_EVENT_SOURCES), events: count }))
        .max(PULSE_EVENT_SOURCES.length),
    }),
  })
  .refine((pulse) => pulse.findings.expected <= pulse.findings.total, {
    error: 'mais achados esperados que achados',
  });
export type TowerPulse = z.infer<typeof towerPulseSchema>;

/** Janela do radar de detecções da Torre: o centro é agora, o anel de fora é o começo da janela. */
export const RADAR_WINDOW_HOURS = 24;

/** Teto de detecções que o radar desenha: as mais recentes da janela. O total da janela vem à parte, sempre exato. */
export const RADAR_DETECTIONS_LIMIT = 100;

/**
 * Setores do radar, no sentido horário a partir do topo: um quarto da volta para cada origem dos achados (as mesmas
 * fontes da "Saúde da coleta", menos a postura, que não gera achado).
 */
export const RADAR_SECTORS = [
  'aws',
  'gcp',
  'cloudflare',
  'agents',
] as const satisfies readonly CollectionSource[];
export type RadarSector = (typeof RADAR_SECTORS)[number];

const RADAR_SECTOR_OF: Readonly<Record<FindingSource, RadarSector>> = {
  cloudtrail: 'aws',
  guardduty: 'aws',
  waf: 'aws',
  security_hub: 'aws',
  inspector: 'aws',
  access_analyzer: 'aws',
  vpc_flow: 'aws',
  alb: 'aws',
  cloudwatch_logs: 'aws',
  gcp_audit: 'gcp',
  cloudflare_audit: 'cloudflare',
  cloudflare_waf: 'cloudflare',
  wazuh_agent: 'agents',
};

/** O setor do radar de uma fonte de log. */
export function radarSectorOf(source: FindingSource): RadarSector {
  return RADAR_SECTOR_OF[source];
}

export const radarDetectionSchema = z.strictObject({
  /** O achado; o painel abre o detalhe dele na tela Detecções (`/?alerta=<id>`). */
  id: z.uuid(),
  severity: z.enum(FINDING_SEVERITIES),
  status: z.enum(FINDING_STATUSES),
  source: z.enum(FINDING_SOURCES),
  occurredAt: z.iso.datetime(),
  title: z.string().max(500),
  /** O incidente em que o achado entrou, e se ele segue aberto (não resolvido); null fora de incidente. */
  incident: z.strictObject({ id: z.uuid(), open: z.boolean() }).nullable(),
});
export type RadarDetection = z.infer<typeof radarDetectionSchema>;

const severityCounts = z.strictObject({ critical: count, high: count, medium: count, low: count });
const sectorCounts = z.strictObject({ aws: count, gcp: count, cloudflare: count, agents: count });
const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

/** Teto de casos que o radar desenha: os mais graves. O total vem à parte. */
export const RADAR_CASES_LIMIT = 100;

/** Um caso de detecção no radar. */
export const radarCaseSchema = z.strictObject({
  /** O caso; o painel abre o detalhe dele na tela Detecções (`/?caso=<id>`). */
  id: z.uuid(),
  /** Do dicionário da API: nunca leva texto do evento. */
  title: z.string().max(200),
  /** A pior severidade entre os alertas pendentes; null sem nada pendente. */
  severity: z.enum(FINDING_SEVERITIES).nullable(),
  /** As fontes de log do caso; vazio se a fonte não é reconhecida. O setor vem pronto. */
  sources: z.array(z.enum(FINDING_SOURCES)).max(FINDING_SOURCES.length),
  sector: z.enum(RADAR_SECTORS),
  /** Os alertas guardados (o tamanho do ponto), os pendentes e os que aconteceram na janela do radar. */
  total: count,
  pending: count,
  recent: count,
  /**
   * A atividade mais recente, que é a distância do centro: o horário do evento do último alerta ou, se ele é de antes da
   * janela, o da chegada. Nunca depois de `generatedAt`.
   */
  lastActivityAt: z.iso.datetime(),
  /**
   * O incidente aberto em que há alerta do caso (o mais grave) ou, sem nenhum, o incidente para onde o caso foi promovido. O
   * caso sem nada pendente e num incidente aberto continua no radar com a gravidade dele.
   */
  incident: z
    .strictObject({ id: z.uuid(), open: z.boolean(), severity: z.enum(FINDING_SEVERITIES) })
    .nullable(),
});
export type RadarCase = z.infer<typeof radarCaseSchema>;

/**
 * Os casos de detecção ativos na janela do radar, com a mesma regra da lista de casos no período (o horário do evento ou o
 * da chegada): `total` bate com o da lista. `alerts` é quantos dos alertas da janela (o `total` do radar) estão neles.
 */
export const towerRadarCasesSchema = z
  .strictObject({
    total: count,
    alerts: count,
    limit: z.literal(RADAR_CASES_LIMIT),
    items: z.array(radarCaseSchema).max(RADAR_CASES_LIMIT),
  })
  .refine((cases) => cases.items.length <= cases.total, { error: 'mais casos que o total' });
export type TowerRadarCases = z.infer<typeof towerRadarCasesSchema>;

/**
 * Radar de detecções da Torre: os achados que aconteceram nas últimas `RADAR_WINDOW_HOURS` horas, os mais recentes
 * primeiro, até `limit`. `total` e as contagens por severidade e por setor contam todos os da janela: com o total maior
 * que a lista, a tela avisa que desenha só uma parte, e as contagens continuam valendo para a janela inteira.
 */
export const towerRadarSchema = z
  .strictObject({
    /** Começo da janela (o anel de fora); o fim é `generatedAt` do resumo (o centro). */
    since: z.iso.datetime(),
    windowHours: z.literal(RADAR_WINDOW_HOURS),
    limit: z.literal(RADAR_DETECTIONS_LIMIT),
    total: count,
    /** As detecções da janela inteira por severidade e por setor (não só as da lista): cada divisão soma `total`. */
    bySeverity: severityCounts,
    bySector: sectorCounts,
    detections: z.array(radarDetectionSchema).max(RADAR_DETECTIONS_LIMIT),
    /** Só com os casos (`towerQuerySchema`): o radar desenha os casos, e o resto continua contando alertas. */
    cases: towerRadarCasesSchema.optional(),
  })
  .refine((radar) => radar.detections.length <= radar.total, { error: 'mais detecções que o total' })
  .refine((radar) => sum(radar.bySeverity) === radar.total && sum(radar.bySector) === radar.total, {
    error: 'as contagens por severidade e por setor somam o total',
  });
export type TowerRadar = z.infer<typeof towerRadarSchema>;

const oldest = z.iso.datetime().nullable();

/**
 * Os casos pendentes: quantos em cada fila, cada caso pela pior severidade pendente dele (o caso com um alerta crítico e mil
 * baixos é um caso crítico), e desde quando espera o mais antigo de cada uma (a abertura, pelo relógio do servidor).
 */
export const towerCasesSchema = z.strictObject({
  detection: severityCounts,
  vulnerability: severityCounts,
  posture: severityCounts,
  oldestPendingAt: z.strictObject({ detection: oldest, vulnerability: oldest, posture: oldest }),
} satisfies Record<CaseQueueName | 'oldestPendingAt', z.ZodType>);
export type TowerCases = z.infer<typeof towerCasesSchema>;

export const towerSummarySchema = z.strictObject({
  light: z.enum(TRAFFIC_LIGHTS),
  /** Pode vir vazio no amarelo: só há alertas altos ou críticos para validar (`pendingDecisions`, em casos ou não). */
  reasons: z.array(z.enum(TRAFFIC_LIGHT_REASONS)).max(TRAFFIC_LIGHT_REASONS.length),
  /** Só as decisões que existem (contagem maior que zero), em ordem de prioridade. */
  pendingDecisions: z
    .array(z.strictObject({ kind: z.enum(PENDING_DECISION_KINDS), count: z.number().int().positive() }))
    .max(PENDING_DECISION_KINDS.length),
  openIncidents: z.strictObject({ critical: count, high: count, medium: count, low: count }),
  posture: z.strictObject({
    /** Nota de 0 a 100 da última varredura; null antes da primeira. */
    score: z.number().int().min(0).max(100).nullable(),
    scannedAt: z.iso.datetime().nullable(),
    /** Abaixo desta nota, a Torre fica amarela. */
    warningBelow: z.number().int().min(0).max(100),
  }),
  coverage: z.strictObject({
    /** Contas ativas no estado "Conectada". */
    connectedAccounts: count,
    /** A coleta bem-sucedida mais recente entre as contas ativas. */
    lastCollectedAt: z.iso.datetime().nullable(),
    /**
     * O evento mais recente gravado nas contas ativas. Na AWS é o último alerta (nível 5 ou mais); na GCP e no
     * Cloudflare, qualquer entrada lida. Não é a prova de que a coleta anda: essa é `lastDataAt` (OP-01).
     */
    lastEventAt: z.iso.datetime().nullable(),
    /**
     * Contas ativas sem sinal de vida há mais de `silentAfterHours` horas (ou que nunca deram sinal). Na AWS, o
     * evento ou, com a conta conectada, o andamento dos eventos da AWS no Wazuh do nó (OP-01); na GCP e no
     * Cloudflare, a leitura bem-sucedida ou o evento (um projeto calmo passa dias sem entrada com a coleta saudável).
     */
    silentAccounts: z.array(cloudAccountRefSchema).max(500),
    silentAfterHours: z.number().int().positive(),
    /**
     * Saúde da ingestão da AWS (fase 2, PR-V6): com conta AWS conectada, desde quando os eventos da AWS no Wazuh do nó
     * estão parados, se for há mais de `awsStalledAfterHours` horas ("Sem logs novos da AWS"); null sem parada.
     * Opcionais: um nó de antes do PR-V6 não manda.
     */
    awsLogsStalledSince: z.iso.datetime().nullable().optional(),
    awsStalledAfterHours: z.number().int().positive().optional(),
    /**
     * Só para a equipe da Verax: o medidor da AWS do nó parado, porque há mais de um cliente no Wazuh dele (o nó atende
     * um cliente só). Fora disso, ausente.
     */
    awsMeterBlocked: z.boolean().optional(),
    /**
     * O último dado entre todas as fontes (OP-01): a prova de que a coleta anda, à parte do último alerta. Opcional,
     * como `sources`: um nó de antes do OP-01 não manda.
     */
    lastDataAt: z.iso.datetime().nullable().optional(),
    /** "Saúde da coleta" (OP-02): uma linha por fonte, na ordem de `COLLECTION_SOURCES`, inclusive as não configuradas. */
    sources: z
      .array(collectionSourceHealthSchema)
      .max(COLLECTION_SOURCES.length)
      .refine((sources) => new Set(sources.map((item) => item.source)).size === sources.length, {
        error: 'fonte repetida',
      })
      .optional(),
  }),
  /**
   * "Pulso da operação" (OP-02): o que a operação fez nas últimas 24 horas, com os dados que já existem. Opcional: um
   * nó de antes do OP-02 não manda.
   */
  pulse: towerPulseSchema.optional(),
  /** Radar de detecções: os achados recentes, para a Torre desenhar. Opcional: um nó de antes do radar não manda. */
  radar: towerRadarSchema.optional(),
  /** Os casos pendentes. Só com os casos (`towerQuerySchema`). */
  cases: towerCasesSchema.optional(),
  /** Táticas do MITRE ATT&CK nos achados e incidentes dos últimos `periodDays` dias, na ordem da cadeia de ataque. */
  mitre: z.strictObject({
    periodDays: z.number().int().positive(),
    tactics: z.array(mitreTacticSchema).length(MITRE_TACTICS.length),
  }),
  generatedAt: z.iso.datetime(),
});
export type TowerSummary = z.infer<typeof towerSummarySchema>;
