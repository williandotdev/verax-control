import { z } from 'zod';
import { cloudAccountRefSchema } from './cloud-accounts.js';
import { MITRE_TACTICS, mitreTacticSchema } from './reports.js';

/**
 * Resumo da Torre (T5.10): a resposta de `GET /v1/tower`, do cliente da sessão. A regra do semáforo está em
 * `apps/api/src/tower/tower-rules.ts`; aqui fica só o formato, validado pela API ao responder e pelo painel ao ler.
 */

export const TRAFFIC_LIGHTS = ['red', 'yellow', 'green'] as const;
export type TrafficLight = (typeof TRAFFIC_LIGHTS)[number];

/** Por que o semáforo não está verde: incidente crítico aberto, incidente alto aberto ou postura abaixo do limite. */
export const TRAFFIC_LIGHT_REASONS = ['critical_incident', 'high_incident', 'low_posture'] as const;
export type TrafficLightReason = (typeof TRAFFIC_LIGHT_REASONS)[number];

/** Incidente aberto sem responsável, achado alto ou crítico sem triagem e (só admin_verax) alerta sem dono. */
export const PENDING_DECISION_KINDS = ['unassigned_incident', 'untriaged_finding', 'unowned_alert'] as const;
export type PendingDecisionKind = (typeof PENDING_DECISION_KINDS)[number];

const count = z.number().int().min(0);

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
    lastEventAt: z.iso.datetime().nullable(),
    /**
     * Contas ativas sem sinal de vida há mais de `silentAfterHours` horas (ou que nunca deram sinal). Na AWS e na
     * GCP, o sinal é o evento; no Cloudflare, a coleta ou o evento.
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
  }),
  /** Táticas do MITRE ATT&CK nos achados e incidentes dos últimos `periodDays` dias, na ordem da cadeia de ataque. */
  mitre: z.strictObject({
    periodDays: z.number().int().positive(),
    tactics: z.array(mitreTacticSchema).length(MITRE_TACTICS.length),
  }),
  generatedAt: z.iso.datetime(),
});
export type TowerSummary = z.infer<typeof towerSummarySchema>;
