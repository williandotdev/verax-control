import { z } from 'zod';
import { cloudAccountRefSchema } from './cloud-accounts.js';

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
    connectedAccounts: count,
    lastEventAt: z.iso.datetime().nullable(),
    /** Contas sem evento há mais de `silentAfterHours` horas (ou que nunca mandaram nada). */
    silentAccounts: z.array(cloudAccountRefSchema).max(500),
    silentAfterHours: z.number().int().positive(),
  }),
  generatedAt: z.iso.datetime(),
});
export type TowerSummary = z.infer<typeof towerSummarySchema>;
