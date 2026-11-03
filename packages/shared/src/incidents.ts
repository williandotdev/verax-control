import { z } from 'zod';
import { awsAccountIdSchema } from './cloud-accounts.js';
import { FINDING_SEVERITIES, findingSchema } from './findings.js';
import { withPagination } from './pagination.js';
import { authorSchema } from './protected-resources.js';

/**
 * Incidentes (T5.6 e T5.7): achados do mesmo usuário, chave de acesso, IP ou recurso, numa janela de tempo. A regra
 * de agrupamento e a nota de risco estão em `apps/api/src/incidents/correlation.ts`; aqui fica só o formato. O
 * título e o resumo em português são montados no painel a partir destes dados (pendência 8: modelo, sem LLM).
 */

export const INCIDENT_STATUSES = ['open', 'investigating', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const CORRELATION_KINDS = ['user', 'key', 'ip', 'resource'] as const;
export type CorrelationKind = (typeof CORRELATION_KINDS)[number];

/** Chave de agrupamento no formato `tipo:valor`, como a API grava (ex.: `ip:192.0.2.1`). */
export const correlationKeySchema = z
  .string()
  .max(2100)
  .regex(/^(user|key|ip|resource):.+$/, { error: 'chave de agrupamento fora do formato' });

export const incidentListQuerySchema = withPagination({
  status: z.enum(INCIDENT_STATUSES).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  /** `true`: só os sem responsável (o atalho da Torre). */
  unassigned: z.enum(['true']).optional(),
});
export type IncidentListQuery = z.infer<typeof incidentListQuerySchema>;

export const incidentSchema = z.strictObject({
  id: z.uuid(),
  severity: z.enum(FINDING_SEVERITIES),
  status: z.enum(INCIDENT_STATUSES),
  /** Nota de risco de 0 a 100; a lista vem ordenada por ela, da maior para a menor. */
  riskScore: z.number().int().min(0).max(100),
  findingCount: z.number().int().min(1),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  keys: z.array(correlationKeySchema).min(1).max(200),
  accounts: z.array(awsAccountIdSchema).min(1).max(50),
  resources: z.array(z.string().max(2048)).max(200),
  mitreTactics: z.array(z.string().max(100)).max(20),
  assignee: authorSchema.nullable(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const incidentDetailSchema = incidentSchema.extend({
  mitreTechniques: z.array(z.string().max(20)).max(50),
  /** Achados do incidente, do mais antigo ao mais recente (a linha do tempo). */
  findings: z.array(findingSchema).min(1).max(500),
});
export type IncidentDetail = z.infer<typeof incidentDetailSchema>;

/** Mudar status e responsável (T5.7). `assigneeId: null` tira o responsável. */
export const incidentUpdateSchema = z
  .strictObject({
    status: z.enum(INCIDENT_STATUSES).optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
  })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type IncidentUpdate = z.infer<typeof incidentUpdateSchema>;

/** Quem pode ser responsável por um incidente do cliente da sessão. */
export const incidentAssigneesSchema = z.strictObject({ items: z.array(authorSchema).max(500) });
