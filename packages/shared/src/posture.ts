import { z } from 'zod';
import { cloudAccountRefSchema } from './cloud-accounts.js';
import { withPagination } from './pagination.js';

/**
 * Postura cloud (T5.8): resultado do Prowler por conta. A nota (de 0 a 100) é a taxa de aprovação ponderada pela
 * severidade, calculada em `apps/api/src/posture/prowler-report.ts`; aqui fica só o formato.
 */

export const POSTURE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type PostureSeverity = (typeof POSTURE_SEVERITIES)[number];

const count = z.number().int().min(0);
const score = z.number().int().min(0).max(100);

export const postureAccountSchema = z.strictObject({
  accountId: cloudAccountRefSchema,
  /** Nota da última varredura; null antes da primeira. */
  score: score.nullable(),
  scannedAt: z.iso.datetime().nullable(),
  passed: count,
  failed: count,
  failedBySeverity: z.strictObject({
    critical: count,
    high: count,
    medium: count,
    low: count,
    informational: count,
  }),
  /** Uma nota por dia de varredura, do mais antigo ao mais recente (até 90 dias). */
  history: z.array(z.strictObject({ date: z.iso.date(), score })).max(90),
});
export type PostureAccount = z.infer<typeof postureAccountSchema>;

export const postureOverviewSchema = z.strictObject({
  /** Nota do cliente: a mesma taxa ponderada, com as checagens de todas as contas. */
  score: score.nullable(),
  /** Abaixo desta nota, a postura está em atenção (a mesma regra da Torre). */
  warningBelow: score,
  accounts: z.array(postureAccountSchema).max(200),
});
export type PostureOverview = z.infer<typeof postureOverviewSchema>;

export const postureCheckListQuerySchema = withPagination({
  accountId: cloudAccountRefSchema.optional(),
  severity: z.enum(POSTURE_SEVERITIES).optional(),
});
export type PostureCheckListQuery = z.infer<typeof postureCheckListQuerySchema>;

const nullableText = z.string().max(4000).nullable();

/** Checagem reprovada na última varredura. A lista vem da mais grave para a menos grave. */
export const postureCheckSchema = z.strictObject({
  id: z.string().min(1).max(512),
  checkId: z.string().regex(/^[a-z0-9_]{1,160}$/),
  title: z.string().max(500),
  severity: z.enum(POSTURE_SEVERITIES),
  accountId: cloudAccountRefSchema,
  region: z.string().max(40),
  resource: nullableText,
  resourceType: nullableText,
  /** Por que importa. */
  risk: nullableText,
  /** Como corrigir. */
  remediation: nullableText,
  references: z.array(z.url({ protocol: /^https$/ })).max(20),
});
export type PostureCheck = z.infer<typeof postureCheckSchema>;
