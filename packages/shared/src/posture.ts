import { z } from 'zod';
import { cloudAccountRefSchema, isAwsRegion } from './cloud-accounts.js';
import { HISTORY_PERIOD_DAYS } from './history.js';
import { isInventoryErrorCode } from './inventory.js';
import { withPagination } from './pagination.js';

/**
 * Postura cloud (T5.8 e fase 2, PR-15'): a varredura de cada conta AWS com o catálogo nativo de checagens
 * (`posture-catalog.ts`), feita na mesma coleta do inventário. A nota (de 0 a 100) é a taxa de aprovação ponderada pela
 * severidade, calculada em `apps/api/src/posture/prowler-report.ts` (`summarizePosture`); aqui fica só o formato.
 */

export const POSTURE_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const;
export type PostureSeverity = (typeof POSTURE_SEVERITIES)[number];

/** O formato do ID de uma checagem (o mesmo do Prowler, que o catálogo nativo segue). */
export const POSTURE_CHECK_ID = /^[a-z0-9_]{1,160}$/;

const count = z.number().int().min(0);
const score = z.number().int().min(0).max(100);

/**
 * As leituras de que as checagens nativas dependem (fase 2, PR-15'): as partes do inventário (a conta root, o IAM, o
 * S3 e, por região, o EC2 e os security groups) e as leituras próprias da postura (a política de senha, o bloqueio de
 * acesso público da conta, a criptografia padrão do EBS por região, as trilhas do CloudTrail e o GuardDuty por região).
 */
export const POSTURE_SECTIONS = [
  'root',
  'iam',
  'password_policy',
  's3',
  's3_account',
  'ec2',
  'sg',
  'ebs',
  'cloudtrail',
  'guardduty',
] as const;
export type PostureSection = (typeof POSTURE_SECTIONS)[number];

/** As partes por região (as outras são da conta inteira). */
export const REGIONAL_POSTURE_SECTIONS: ReadonlySet<PostureSection> = new Set<PostureSection>([
  'ec2',
  'sg',
  'ebs',
  'guardduty',
]);

/** Até onde vai a lista de leituras recusadas de uma varredura: 6 da conta e 4 por região (até 40), com folga. */
export const MAX_POSTURE_ERRORS = 200;

/**
 * Uma leitura que a AWS recusou numa varredura (permissão, SCP, região desligada) ou com itens fora do formato
 * (`invalid_items`): as checagens que dependem dela ficam "não lidas" naquele escopo, fora da nota.
 */
export const postureSectionErrorSchema = z.strictObject({
  section: z.enum(POSTURE_SECTIONS),
  /** A região das partes regionais; null nas da conta inteira. */
  region: z.string().max(32).refine(isAwsRegion, { error: 'região AWS inválida' }).nullable(),
  code: z.string().refine(isInventoryErrorCode, { error: 'código fora do formato' }),
});
export type PostureSectionError = z.infer<typeof postureSectionErrorSchema>;

/** O que vai para `PostureScan.errors`: `parte:código` ou, com região, `parte:região:código`. */
export function postureErrorValue(error: PostureSectionError): string {
  return error.region === null
    ? `${error.section}:${error.code}`
    : `${error.section}:${error.region}:${error.code}`;
}

/** A parte, a região e o código de um valor de `PostureScan.errors`; null para um valor fora do formato. */
export function parsePostureError(value: string): PostureSectionError | null {
  if (value.length > 128) return null;
  const parts = value.split(':');
  const candidate =
    parts.length === 2
      ? { section: parts[0], region: null, code: parts[1] }
      : parts.length === 3
        ? { section: parts[0], region: parts[1], code: parts[2] }
        : null;
  const parsed = postureSectionErrorSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * A situação de uma checagem numa varredura: `fail` com algum recurso reprovado; `unknown` com alguma leitura recusada
 * (nunca conta como aprovada); `pass` com todos os recursos aprovados; `not_applicable` sem recurso a conferir (a
 * conta sem usuário com console, sem instância, sem bucket).
 */
export const POSTURE_CHECK_STATUSES = ['fail', 'unknown', 'pass', 'not_applicable'] as const;
export type PostureCheckStatus = (typeof POSTURE_CHECK_STATUSES)[number];

/** Até quantas checagens uma varredura guarda (o catálogo tem 18). */
export const MAX_POSTURE_CHECKS = 50;

/**
 * O resultado de uma checagem do catálogo numa varredura (`PostureScan.checks`): quantos recursos (ou regiões, ou a
 * conta) foram aprovados, reprovados e não lidos. Conferido pelo contrato ao gravar e ao ler.
 */
export const postureCheckResultSchema = z.strictObject({
  checkId: z.string().regex(POSTURE_CHECK_ID),
  /** O que a checagem confere ("MFA no usuário root"). */
  title: z.string().min(1).max(200),
  severity: z.enum(POSTURE_SEVERITIES),
  passed: count,
  failed: count,
  unknown: count,
});
export type PostureCheckResult = z.infer<typeof postureCheckResultSchema>;

export function postureCheckStatus(
  result: Pick<PostureCheckResult, 'passed' | 'failed' | 'unknown'>,
): PostureCheckStatus {
  if (result.failed > 0) return 'fail';
  if (result.unknown > 0) return 'unknown';
  return result.passed > 0 ? 'pass' : 'not_applicable';
}

/** Uma checagem do catálogo na última varredura de uma conta, com a situação. */
export const postureCheckSummarySchema = z.strictObject({
  ...postureCheckResultSchema.shape,
  status: z.enum(POSTURE_CHECK_STATUSES),
});
export type PostureCheckSummary = z.infer<typeof postureCheckSummarySchema>;

/** Teto da evolução da nota: o maior período das telas (12 meses). */
export const POSTURE_HISTORY_MAX_DAYS = HISTORY_PERIOD_DAYS['12m'];

/** Dias da evolução da nota: o histórico do plano (`null` é sem limite), até o teto de 365. */
export function postureHistoryDays(historyDays: number | null): number {
  return Math.min(historyDays ?? POSTURE_HISTORY_MAX_DAYS, POSTURE_HISTORY_MAX_DAYS);
}

export const postureAccountSchema = z.strictObject({
  accountId: cloudAccountRefSchema,
  /** Nota da última varredura; null antes da primeira. */
  score: score.nullable(),
  scannedAt: z.iso.datetime().nullable(),
  passed: count,
  failed: count,
  /** Resultados não lidos (a AWS recusou a leitura): fora da nota, nunca aprovados. */
  unknown: count,
  failedBySeverity: z.strictObject({
    critical: count,
    high: count,
    medium: count,
    low: count,
    informational: count,
  }),
  /**
   * Uma nota por dia de varredura, do mais antigo ao mais recente, pelo histórico do plano do nó (PR-20): 90 dias no
   * Essencial, 365 no Profissional. Sem limite (Interno) ou acima de 365 dias, os últimos 365.
   */
  history: z.array(z.strictObject({ date: z.iso.date(), score })).max(POSTURE_HISTORY_MAX_DAYS),
  /** As checagens do catálogo na última varredura, com a situação de cada uma (vazio antes da primeira). */
  checks: z.array(postureCheckSummarySchema).max(MAX_POSTURE_CHECKS),
  /** As leituras recusadas na última varredura: a varredura é parcial quando há alguma. */
  errors: z.array(postureSectionErrorSchema).max(MAX_POSTURE_ERRORS),
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
  checkId: z.string().regex(POSTURE_CHECK_ID),
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
