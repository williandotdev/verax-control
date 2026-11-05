import { z } from 'zod';
import { cloudAccountRefSchema } from './cloud-accounts.js';
import { withPagination } from './pagination.js';
import { authorSchema } from './protected-resources.js';

/**
 * Achados (T5.3 a T5.5): alertas do Wazuh já vinculados a um cliente e gravados no PostgreSQL, onde ficam os estados
 * humanos (status e comentários). A severidade vem das regras da T5.3; os status, da T5.5. O evento bruto continua
 * no indexer e só vem no detalhe.
 */

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Novo, em análise, legítimo (comportamento esperado; pode virar exceção) e resolvido. */
export const FINDING_STATUSES = ['new', 'investigating', 'legitimate', 'resolved'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Origem do alerta na AWS, lida pelo Wazuh. */
/**
 * Fontes de log: as da AWS (lidas pelo Wazuh), a auditoria da GCP (lida do Pub/Sub pelo próprio nó) e, do Cloudflare
 * (lidos pela API dele, com o token do cofre do nó), a auditoria da conta e os eventos de segurança das zonas (WAF,
 * limite de taxa, DDoS).
 */
export const FINDING_SOURCES = [
  'cloudtrail',
  'guardduty',
  'waf',
  'gcp_audit',
  'cloudflare_audit',
  'cloudflare_waf',
] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

/** Períodos do filtro, em horas. */
export const FINDING_PERIODS = ['24h', '7d', '30d', '90d'] as const;
export type FindingPeriod = (typeof FINDING_PERIODS)[number];

export const findingListQuerySchema = withPagination({
  severity: z.enum(FINDING_SEVERITIES).optional(),
  status: z.enum(FINDING_STATUSES).optional(),
  accountId: cloudAccountRefSchema.optional(),
  period: z.enum(FINDING_PERIODS).optional(),
});
export type FindingListQuery = z.infer<typeof findingListQuerySchema>;

const nullableText = z.string().max(2048).nullable();

export const findingSchema = z.strictObject({
  id: z.uuid(),
  accountId: cloudAccountRefSchema,
  occurredAt: z.iso.datetime(),
  severity: z.enum(FINDING_SEVERITIES),
  status: z.enum(FINDING_STATUSES),
  /** Descrição da regra do Wazuh. */
  title: z.string().max(500),
  source: z.enum(FINDING_SOURCES),
  eventName: nullableText,
  region: nullableText,
  resource: nullableText,
  actor: z.strictObject({
    user: nullableText,
    type: nullableText,
    accessKeyId: nullableText,
    ip: nullableText,
  }),
  mitreTactics: z.array(z.string().max(100)).max(20),
  /** Incidente em que o achado entrou (T5.6), se entrou. */
  incidentId: z.uuid().nullable(),
  commentCount: z.number().int().min(0),
});
export type Finding = z.infer<typeof findingSchema>;

export const findingCommentSchema = z.strictObject({
  id: z.uuid(),
  author: authorSchema,
  body: z.string(),
  createdAt: z.iso.datetime(),
});
export type FindingComment = z.infer<typeof findingCommentSchema>;

export const findingDetailSchema = findingSchema.extend({
  ruleId: z.string().regex(/^\d{1,6}$/),
  ruleLevel: z.number().int().min(0).max(16),
  mitreTechniques: z.array(z.string().max(20)).max(50),
  comments: z.array(findingCommentSchema).max(500),
  /** Evento bruto do indexer; null quando já saiu da retenção (90 dias). */
  rawEvent: z.record(z.string(), z.unknown()).nullable(),
});
export type FindingDetail = z.infer<typeof findingDetailSchema>;

/** Texto de comentário: aceita quebra de linha e tabulação, nenhum outro caractere de controle. */
const commentText = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (value) =>
      ![...value].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && char !== '\n' && char !== '\t') || code === 127;
      }),
    { error: 'caractere de controle não é permitido' },
  );

/** Mudar o status (T5.5). Um comentário opcional explica a decisão e entra junto, na mesma auditoria. */
export const findingStatusUpdateSchema = z.strictObject({
  status: z.enum(FINDING_STATUSES),
  comment: commentText.optional(),
});
export type FindingStatusUpdate = z.infer<typeof findingStatusUpdateSchema>;

export const findingCommentCreateSchema = z.strictObject({ body: commentText });
export type FindingCommentCreate = z.infer<typeof findingCommentCreateSchema>;
