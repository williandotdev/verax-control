import { z } from 'zod';
import { withPagination } from './pagination.js';

/**
 * Trilha de auditoria na tela Auditoria. Só leitura: nenhuma rota altera ou apaga registro, e o banco bloqueia as duas
 * operações (T1.3). O admin do cliente vê a trilha do próprio cliente. O admin_verax vê a do cliente escolhido ou,
 * sem cliente, a da própria Verax: logins da equipe, o que ela faz sem tocar dados de cliente e tentativas de login de quem
 * não chegou a se identificar.
 */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const AUDIT_ACTOR_TYPES = ['user', 'system', 'anonymous'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AUDIT_PERIODS = ['24h', '7d', '30d', '90d'] as const;
export type AuditPeriod = (typeof AUDIT_PERIODS)[number];

/** Áreas da trilha (o tipo do recurso), para o filtro da tela. */
export const AUDIT_RESOURCE_TYPES = [
  'login',
  'tenant',
  'user',
  'cloud_account',
  'protected_resource',
  'alert_exception',
  'finding',
  'incident',
  'wazuh_agents',
] as const;
export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

export const auditListQuerySchema = withPagination({
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  period: z.enum(AUDIT_PERIODS).optional(),
  resourceType: z.enum(AUDIT_RESOURCE_TYPES).optional(),
  /** Só as ações de uma pessoa (o id do usuário, como aparece em `actor.id`). */
  actorId: z.string().min(1).max(64).optional(),
});
export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

export const auditActorSchema = z.strictObject({
  type: z.enum(AUDIT_ACTOR_TYPES),
  /** Usuário que agiu (nulo para sistema e anônimo). */
  id: z.string().max(64).nullable(),
  name: z.string().max(120).nullable(),
  /**
   * Alguém da equipe da Verax (admin_verax). O cliente vê na própria trilha quando a Verax entrou e o que fez, com o
   * nome (o mesmo que já aparece como responsável de incidente), mas não o IP nem o navegador de quem é da Verax.
   */
  verax: z.boolean(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditEntrySchema = z.strictObject({
  id: z.uuid(),
  occurredAt: z.iso.datetime(),
  actor: auditActorSchema,
  /** Nome da ação (ex.: `cloud_account.create`), ou método e rota quando o service não nomeou. */
  action: z.string().max(200),
  resourceType: z.string().max(100).nullable(),
  resourceId: z.string().max(200).nullable(),
  outcome: z.enum(AUDIT_OUTCOMES),
  statusCode: z.number().int().nullable(),
  /** De onde veio. Nulo para a equipe da Verax vista por um cliente. */
  ip: z.string().max(64).nullable(),
  requestId: z.string().max(64).nullable(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** O registro inteiro, com o estado anterior e o novo (já sem senha, token ou segredo, limpos na gravação). */
export const auditEntryDetailSchema = auditEntrySchema.extend({
  /** Navegador. Nulo para a equipe da Verax vista por um cliente. */
  userAgent: z.string().max(256).nullable(),
  before: z.json().nullable(),
  after: z.json().nullable(),
});
export type AuditEntryDetail = z.infer<typeof auditEntryDetailSchema>;
