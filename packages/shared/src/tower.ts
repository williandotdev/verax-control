import { z } from 'zod';
import { cloudAccountRefSchema } from './cloud-accounts.js';
import { usageMonthSchema } from './plan-usage.js';
import { MITRE_TACTICS, mitreTacticSchema } from './reports.js';

/**
 * Resumo da Torre (T5.10): a resposta de `GET /v1/tower`, do cliente da sessão. A regra do semáforo está em
 * `apps/api/src/tower/tower-rules.ts`; aqui fica só o formato, validado pela API ao responder e pelo painel ao ler.
 */

export const TRAFFIC_LIGHTS = ['red', 'yellow', 'green'] as const;
export type TrafficLight = (typeof TRAFFIC_LIGHTS)[number];

/**
 * Por que o semáforo não está verde: incidente crítico aberto, incidente alto aberto, postura abaixo do limite ou
 * coleta parada numa fonte configurada (OP-02, decisão de 05/11/2026).
 */
export const TRAFFIC_LIGHT_REASONS = [
  'critical_incident',
  'high_incident',
  'low_posture',
  'collection_stalled',
] as const;
export type TrafficLightReason = (typeof TRAFFIC_LIGHT_REASONS)[number];

/** Incidente aberto sem responsável, achado alto ou crítico sem triagem e (só admin_verax) alerta sem dono. */
export const PENDING_DECISION_KINDS = ['unassigned_incident', 'untriaged_finding', 'unowned_alert'] as const;
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
     * Só na AWS: o último alerta (nível 5 ou mais) recebido de uma conta. O alerta não é o sinal de vida: uma conta
     * calma passa dias sem alerta, com os eventos andando no Wazuh do nó.
     */
    lastAlertAt: z.iso.datetime().nullable().optional(),
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

export const towerSummarySchema = z.strictObject({
  light: z.enum(TRAFFIC_LIGHTS),
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
     * evento ou, com a conta conectada, o andamento dos eventos da AWS no Wazuh do nó (OP-01); na GCP, o evento; no
     * Cloudflare, a coleta ou o evento.
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
  /** Táticas do MITRE ATT&CK nos achados e incidentes dos últimos `periodDays` dias, na ordem da cadeia de ataque. */
  mitre: z.strictObject({
    periodDays: z.number().int().positive(),
    tactics: z.array(mitreTacticSchema).length(MITRE_TACTICS.length),
  }),
  generatedAt: z.iso.datetime(),
});
export type TowerSummary = z.infer<typeof towerSummarySchema>;
