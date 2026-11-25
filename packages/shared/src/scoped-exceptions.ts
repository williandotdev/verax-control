import { z } from 'zod';
import { ALERT_EXCEPTION_FIELDS, ALERT_EXCEPTION_MAX_DAYS } from './alert-exceptions.js';
import { FINDING_SOURCES, type FindingSeverity } from './findings.js';
import { withPagination } from './pagination.js';
import type { Role } from './permissions.js';
import { authorSchema, plainText } from './protected-resources.js';

/**
 * Exceções amplas (casos, PR-9): marcam como esperado o alerta novo de uma regra numa fonte de log e numa conta, com o
 * evento e o começo do recurso, se informados, até uma severidade. Ficam numa tabela própria (`ScopedException`), nunca
 * como um valor novo de `AlertExceptionField`: a imagem anterior do nó ignora a tabela, e os alertas voltam para a fila.
 *
 * Decisão D8 do dono (24/11/2026): validade obrigatória de até 90 dias, nunca crítico, só administradores. A permissão
 * fica no papel (`canWriteScopedExceptions`), como `isMassTriageRole`, e não numa permissão nova: a lista de permissões do
 * `/v1/me` é um enum fechado no painel, e um valor novo quebraria o painel de antes.
 */

/** Validade máxima, em dias. Sem validade não existe. */
export const SCOPED_EXCEPTION_MAX_DAYS = 90;
/** Exceções amplas em vigor por cliente: o worker compara cada alerta com todas, em memória. */
export const MAX_ACTIVE_SCOPED_EXCEPTIONS = 50;
/** Janela da prévia ("teria coberto N alertas nos últimos 30 dias"). */
export const SCOPED_EXCEPTION_PREVIEW_DAYS = 30;
/** Exceções de usuário, IP ou recurso criadas de uma vez a partir de um caso. Acima disso, a ampla. */
export const MAX_ALERT_EXCEPTIONS_PER_REQUEST = 20;
/** O maior valor de uma exceção de usuário, IP ou recurso. */
export const ALERT_EXCEPTION_VALUE_MAX = 256;
/** O começo do recurso precisa dizer algo: um prefixo de poucas letras cobriria quase tudo. */
export const SCOPED_RESOURCE_PREFIX_MIN = 8;

/** Até onde a exceção vale. Crítico nunca: o alerta crítico sempre pede decisão. */
export const SCOPED_EXCEPTION_SEVERITIES = [
  'low',
  'medium',
  'high',
] as const satisfies readonly FindingSeverity[];
export type ScopedExceptionSeverity = (typeof SCOPED_EXCEPTION_SEVERITIES)[number];
export const SCOPED_EXCEPTION_DEFAULT_SEVERITY: ScopedExceptionSeverity = 'medium';

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/** O alerta dessa severidade cabe na exceção? Crítico, nunca. */
export function severityWithin(severity: FindingSeverity, max: ScopedExceptionSeverity): boolean {
  return severity !== 'critical' && SEVERITY_RANK[severity] <= SEVERITY_RANK[max];
}

/** Quem cria, revoga e pede a prévia das amplas: só os administradores (D8). Quem decide é a API. */
export function canWriteScopedExceptions(role: Role): boolean {
  return role === 'admin_verax' || role === 'admin_cliente';
}

const ruleNumber = (ruleId: string): number => Number(ruleId);

/**
 * Regras em que a exceção ampla não existe: as de identidade e acesso da AWS (100300-100324), que são justamente o que um
 * atacante usaria, e os ataques web pelos logs do balanceador (990403, 990406, 990407).
 */
export function isScopedExceptionBlocked(ruleId: string): boolean {
  const rule = ruleNumber(ruleId);
  return (rule >= 100300 && rule <= 100324) || rule === 990403 || rule === 990406 || rule === 990407;
}

/**
 * Regras que são uma classe, e não uma detecção (todo CVE de pacote, todo controle, todo achado alto do GuardDuty): sem o
 * evento (o CVE, o controle, o tipo), a exceção cobriria a classe inteira.
 */
export function scopedExceptionNeedsEvent(ruleId: string): boolean {
  const rule = ruleNumber(ruleId);
  return rule === 990501 || rule === 990502 || rule === 990511 || (rule >= 80300 && rule <= 80309);
}

const ruleIdSchema = z.string().regex(/^\d{1,6}$/, { error: 'ID de regra tem até 6 dígitos' });
const accountIdSchema = z
  .string()
  .trim()
  .min(1, { error: 'informe a conta' })
  .max(32)
  .regex(/^[A-Za-z0-9._:-]+$/, { error: 'conta inválida' });

const expiresAtSchema = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const at = Date.parse(value);
    return at > Date.now() && at <= Date.now() + SCOPED_EXCEPTION_MAX_DAYS * 24 * 60 * 60 * 1000;
  },
  { error: `a validade precisa estar no futuro e em até ${SCOPED_EXCEPTION_MAX_DAYS} dias` },
);

/** O alvo da exceção ampla: a prévia e a criação usam o mesmo. */
const targetShape = {
  ruleId: ruleIdSchema,
  logSource: z.enum(FINDING_SOURCES),
  accountId: accountIdSchema,
  eventName: plainText(256).optional(),
  resourcePrefix: plainText(2048)
    .refine((value) => value.length >= SCOPED_RESOURCE_PREFIX_MIN, {
      error: `o começo do recurso precisa ter ao menos ${SCOPED_RESOURCE_PREFIX_MIN} caracteres`,
    })
    .optional(),
  maxSeverity: z.enum(SCOPED_EXCEPTION_SEVERITIES).default(SCOPED_EXCEPTION_DEFAULT_SEVERITY),
};

interface Target {
  ruleId: string;
  eventName?: string | undefined;
}

function checkTarget(target: Target, context: z.RefinementCtx): void {
  if (isScopedExceptionBlocked(target.ruleId)) {
    context.addIssue({
      code: 'custom',
      path: ['ruleId'],
      message: 'esta regra não aceita exceção ampla; use a de usuário, IP ou recurso',
    });
  }
  if (scopedExceptionNeedsEvent(target.ruleId) && target.eventName === undefined) {
    context.addIssue({
      code: 'custom',
      path: ['eventName'],
      message: 'esta regra cobre uma classe inteira: informe o evento (o CVE, o controle ou o tipo)',
    });
  }
}

export const scopedExceptionPreviewQuerySchema = z.strictObject(targetShape).superRefine(checkTarget);
export type ScopedExceptionPreviewQuery = z.infer<typeof scopedExceptionPreviewQuerySchema>;

export const scopedExceptionCreateSchema = z
  .strictObject({ ...targetShape, reason: plainText(500), expiresAt: expiresAtSchema })
  .superRefine(checkTarget);
export type ScopedExceptionCreate = z.input<typeof scopedExceptionCreateSchema>;
export type ScopedExceptionCreateParsed = z.infer<typeof scopedExceptionCreateSchema>;

const count = z.number().int().min(0);

/** "Teria coberto N alertas nos últimos 30 dias, M altos": só os alertas que a exceção marcaria. */
export const scopedExceptionPreviewSchema = z.strictObject({
  days: count,
  matched: count,
  high: count,
});
export type ScopedExceptionPreview = z.infer<typeof scopedExceptionPreviewSchema>;

export const scopedExceptionListQuerySchema = withPagination({
  active: z.enum(['true', 'false']).optional(),
});
export type ScopedExceptionListQuery = z.infer<typeof scopedExceptionListQuerySchema>;

export const scopedExceptionSchema = z.strictObject({
  id: z.uuid(),
  ruleId: z.string(),
  logSource: z.string(),
  accountId: z.string(),
  eventName: z.string().nullable(),
  resourcePrefix: z.string().nullable(),
  maxSeverity: z.enum(SCOPED_EXCEPTION_SEVERITIES),
  reason: z.string(),
  expiresAt: z.iso.datetime(),
  /** Em vigor: nem revogada, nem vencida. */
  active: z.boolean(),
  matchedCount: count,
  lastMatchedAt: z.iso.datetime().nullable(),
  createdBy: authorSchema,
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  revokedBy: authorSchema.nullable(),
});
export type ScopedException = z.infer<typeof scopedExceptionSchema>;

/** Valores que um caso tem num campo, até o teto; `complete` diz se couberam todos. */
const caseValuesSchema = z.strictObject({
  values: z.array(z.string().max(2048)).max(MAX_ALERT_EXCEPTIONS_PER_REQUEST),
  complete: z.boolean(),
});

/**
 * O que é constante num caso, para a exceção a partir dele: as combinações de regra, fonte, conta e evento (com quantos
 * alertas e a pior severidade de cada uma) e os valores de usuário, IP e recurso. Lido na hora, dos alertas do caso.
 */
export const caseExceptionDraftSchema = z.strictObject({
  caseId: z.uuid(),
  targets: z
    .array(
      z.strictObject({
        ruleId: z.string().max(6),
        logSource: z.string().max(32),
        accountId: z.string().max(32),
        eventName: z.string().max(256).nullable(),
        alerts: count,
        severity: z.enum(['critical', 'high', 'medium', 'low']),
      }),
    )
    .max(MAX_ALERT_EXCEPTIONS_PER_REQUEST),
  targetsComplete: z.boolean(),
  values: z.strictObject({ user: caseValuesSchema, ip: caseValuesSchema, resource: caseValuesSchema }),
});
export type CaseExceptionDraft = z.infer<typeof caseExceptionDraftSchema>;

/** Várias exceções de usuário, IP ou recurso de uma vez (a partir de um caso), da mesma regra, com o mesmo motivo. */
export const alertExceptionBatchSchema = z
  .strictObject({
    ruleId: ruleIdSchema,
    field: z.enum(ALERT_EXCEPTION_FIELDS),
    values: z.array(plainText(ALERT_EXCEPTION_VALUE_MAX)).min(1).max(MAX_ALERT_EXCEPTIONS_PER_REQUEST),
    reason: plainText(500),
    expiresAt: z.iso
      .datetime({ offset: true })
      .refine(
        (value) =>
          Date.parse(value) > Date.now() &&
          Date.parse(value) <= Date.now() + ALERT_EXCEPTION_MAX_DAYS * 24 * 60 * 60 * 1000,
        { error: `a validade precisa estar no futuro e em até ${ALERT_EXCEPTION_MAX_DAYS} dias` },
      )
      .nullable()
      .optional(),
  })
  .refine((input) => new Set(input.values).size === input.values.length, {
    error: 'valores repetidos',
    path: ['values'],
  })
  .refine((input) => input.field !== 'ip' || input.values.every(isIpOrCidr), {
    error: 'IP ou faixa CIDR inválida',
    path: ['values'],
  });
export type AlertExceptionBatch = z.infer<typeof alertExceptionBatchSchema>;

export const alertExceptionBatchResultSchema = z.strictObject({
  /** Criadas agora. */
  created: count,
  /** Já existiam (mesma regra, campo e valor): ficaram como estavam. */
  existing: count,
});
export type AlertExceptionBatchResult = z.infer<typeof alertExceptionBatchResultSchema>;

function isIpOrCidr(value: string): boolean {
  return [z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()].some((schema) => schema.safeParse(value).success);
}
