import { z } from 'zod';
import {
  type CaseFilterFields,
  caseFilterShape,
  checkCaseFilter,
  exactText,
  triageCanSchema,
  triageOperationSchema,
} from './cases.js';
import { FINDING_STATUSES } from './findings.js';
import { paginatedSchema, withPagination } from './pagination.js';
import type { Role } from './permissions.js';
import { authorSchema } from './protected-resources.js';

/**
 * Triagem em massa: uma pessoa trata muitos alertas de uma vez (muda o status, promove a incidente ou anexa a um), com
 * desfazer. Aqui fica o contrato de `POST /v1/triage-operations` e das rotas dela; o histórico (a operação como aparece
 * no caso e no alerta) está em `cases.ts`.
 *
 * O conjunto é congelado na chegada do pedido: os alertas do alvo que chegaram até ali e estão pendentes (fora de
 * incidente, novos ou em análise). O que muda depois, por outra pessoa, não é tocado.
 */

/** Os tetos de um pedido. */
export const MAX_TRIAGE_CASES = 50;
export const MAX_TRIAGE_FINDINGS = 500;
export const MAX_TRIAGE_ALERTS = 50_000;
/** Até aqui, a operação inteira roda na própria requisição; além disso, no worker, em lotes. */
export const TRIAGE_SYNC_ALERTS = 200;
/** Por quanto tempo se pode desfazer, do fim da operação. */
export const TRIAGE_UNDO_HOURS = 24;
/** Operações na fila ou em curso, por cliente (uma roda por vez). */
export const MAX_ACTIVE_TRIAGE_OPERATIONS = 10;
/** O que o `undo_all_of` alcança de uma vez: as operações mais recentes da pessoa. */
export const MAX_UNDO_ALL_OPERATIONS = 100;
/** O motivo, o tamanho da coluna. */
export const TRIAGE_REASON_MAX = 500;
/** Dividir um caso: quantos alertas saem de uma vez, pela lista de ids ou pelo subgrupo. */
export const MAX_SPLIT_FINDINGS = 500;
export const MAX_SPLIT_ALERTS = 2_000;

/**
 * Os limites de quem não administra (o analista): alertas por operação e, na soma das operações dele, em 24 horas.
 *
 * Por papel, e não por uma permissão nova: `GET /v1/me` devolve as permissões como um enum fechado, e um painel aberto
 * de antes recusaria a resposta inteira com um valor que não conhece.
 */
export const TRIAGE_ALERTS_PER_OPERATION = 2_000;
export const TRIAGE_ALERTS_PER_DAY = 5_000;
export const MASS_TRIAGE_ROLES: readonly Role[] = ['admin_verax', 'admin_cliente'];
/** Quem administra: sem os limites acima, desfaz e cancela a operação de qualquer pessoa, e desfaz todas de uma. */
export function isMassTriageRole(role: Role): boolean {
  return MASS_TRIAGE_ROLES.includes(role);
}

/** A folga entre o que a pessoa confirmou e o que o servidor achou: 10% e mais 20 alertas. */
export function triageScopeChanged(expected: number, actual: number): boolean {
  return actual - expected > expected / 10 + 20;
}

/** Códigos das recusas, para o painel explicar. */
export const TRIAGE_SCOPE_CHANGED_CODE = 'TRIAGE_SCOPE_CHANGED';
export const TRIAGE_EMPTY_CODE = 'TRIAGE_NOTHING_TO_DO';
export const TRIAGE_REASON_REQUIRED_CODE = 'TRIAGE_REASON_REQUIRED';
export const TRIAGE_TOO_LARGE_CODE = 'TRIAGE_TOO_LARGE';
export const TRIAGE_QUOTA_CODE = 'TRIAGE_QUOTA_EXCEEDED';
export const TRIAGE_QUEUE_FULL_CODE = 'TRIAGE_QUEUE_FULL';
export const TRIAGE_REQUEST_REUSED_CODE = 'TRIAGE_REQUEST_REUSED';
export const TRIAGE_NOT_ACTIVE_CODE = 'TRIAGE_NOT_ACTIVE';
export const TRIAGE_STILL_ACTIVE_CODE = 'TRIAGE_STILL_ACTIVE';
export const TRIAGE_NOT_RESUMABLE_CODE = 'TRIAGE_NOT_RESUMABLE';
export const TRIAGE_NOT_UNDOABLE_CODE = 'TRIAGE_NOT_UNDOABLE';
export const TRIAGE_UNDO_EXPIRED_CODE = 'TRIAGE_UNDO_EXPIRED';
export const TRIAGE_INCIDENT_RESOLVED_CODE = 'INCIDENT_RESOLVED';
export const CASE_SPLIT_WHOLE_CODE = 'CASE_SPLIT_WHOLE';
export const CASE_SPLIT_TOO_LARGE_CODE = 'CASE_SPLIT_TOO_LARGE';

const count = z.number().int().min(0);

/** O motivo: quebra de linha e tabulação, nenhum outro caractere de controle nem surrogate solto. */
const reasonText = z
  .string()
  .trim()
  .min(1)
  .max(TRIAGE_REASON_MAX)
  .refine(
    (value) =>
      !/\p{Cs}/u.test(value) &&
      ![...value].some((char) => {
        const code = char.charCodeAt(0);
        return (code < 32 && char !== '\n' && char !== '\t') || code === 127;
      }),
    { error: 'caractere de controle não é permitido' },
  );

/** Ids sem repetição, com maiúsculas e minúsculas valendo o mesmo. */
const uniqueIds = (max: number) =>
  z
    .array(z.uuid())
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      error: 'id repetido na lista',
    });

// ---------------------------------------------------------------------------------------------------
// Pedido
// ---------------------------------------------------------------------------------------------------

/** Os campos do filtro que estreitam de verdade. A fila, o estado e o período, sozinhos, são quase a tela inteira. */
const NARROWING_FIELDS = [
  'severity',
  'source',
  'accountId',
  'tactic',
  'technique',
  'q',
  'groupBy',
] as const satisfies readonly (keyof CaseFilterFields)[];

/**
 * O filtro da lista de casos (`GET /v1/cases`), com os mesmos campos e o mesmo sentido: escolhe **casos**, e a operação
 * alcança os alertas pendentes deles (a severidade do filtro não estreita os alertas do caso). Só os estados com
 * pendência, e com pelo menos um campo que estreite além da fila, do estado e do período.
 */
export const triageFilterSchema = z
  .strictObject({ ...caseFilterShape, state: z.enum(['pending', 'investigating']).default('pending') })
  .superRefine(checkCaseFilter)
  .superRefine((value, ctx) => {
    if (NARROWING_FIELDS.every((field) => value[field] === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'o filtro precisa de mais que a fila, o estado e o período',
        path: [],
      });
    }
  });
export type TriageFilter = z.infer<typeof triageFilterSchema>;

/**
 * O alvo: os alertas de até 50 casos (ou só um subgrupo deles, o valor inteiro que o detalhe do caso mostra), até 500
 * alertas, ou os casos de um filtro da lista.
 */
export const triageTargetSchema = z.union([
  z.strictObject({ caseIds: uniqueIds(MAX_TRIAGE_CASES), group: exactText(256).optional() }),
  z.strictObject({ findingIds: uniqueIds(MAX_TRIAGE_FINDINGS) }),
  z.strictObject({ filter: triageFilterSchema }),
]);
export type TriageTarget = z.infer<typeof triageTargetSchema>;

const request = {
  /** Escolhido pelo painel, um por pedido: o mesmo id, de novo, devolve a operação que ele já criou. */
  requestId: z.uuid(),
  target: triageTargetSchema,
  /** Quantos alertas a pessoa confirmou. Se forem bem mais, 409 com a contagem nova (`details.count`). */
  expectedCount: z.number().int().min(0).max(10_000_000),
  /** Sem isto, os alertas críticos ficam de fora, e a resposta diz quantos (`excludedCritical`). */
  includeCritical: z.boolean().default(false),
  /** Obrigatório para marcar mais de um alerta como legítimo ou resolvido. */
  reason: reasonText.optional(),
};

export const triageOperationCreateSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('status'), status: z.enum(FINDING_STATUSES), ...request }),
  /** Abre um incidente com os alertas. */
  z.strictObject({ action: z.literal('promote'), ...request }),
  /** Anexa os alertas a um incidente que não está resolvido. */
  z.strictObject({ action: z.literal('attach'), incidentId: z.uuid(), ...request }),
  /** Desfaz tudo o que uma pessoa fez em massa e ainda pode ser desfeito. Só de quem administra. */
  z.strictObject({
    action: z.literal('undo_all_of'),
    requestId: z.uuid(),
    target: z.strictObject({ userId: z.string().min(1).max(64) }),
    reason: reasonText,
  }),
]);
export type TriageOperationCreate = z.infer<typeof triageOperationCreateSchema>;

/** `POST /v1/triage-operations/:id/undo`. */
export const triageUndoSchema = z.strictObject({ requestId: z.uuid(), reason: reasonText.optional() });
export type TriageUndo = z.infer<typeof triageUndoSchema>;

const severityCounts = z.strictObject({ critical: count, high: count, medium: count, low: count });

/**
 * `GET /v1/triage-operations/preview`, com o filtro da lista: quantos casos e alertas pendentes ele alcança agora, para
 * a pessoa confirmar. `alerts` inclui os críticos, que só entram com `includeCritical`.
 */
export const triagePreviewSchema = z.strictObject({
  cases: count,
  alerts: count,
  new: count,
  investigating: count,
  pending: severityCounts,
  /** Dos casos, os que tocam a lista de proteção (a marca da lista). Opcional: um nó de antes não manda. */
  protectedCases: count.optional(),
  /**
   * Os pendentes por status e severidade: cada um soma `new` e `investigating`, e os dois, `pending`. Opcional: um nó de
   * antes não manda, e a conta que passa do prazo do banco também fica de fora.
   */
  byStatus: z.strictObject({ new: severityCounts, investigating: severityCounts }).optional(),
});
export type TriagePreview = z.infer<typeof triagePreviewSchema>;

// ---------------------------------------------------------------------------------------------------
// Operação
// ---------------------------------------------------------------------------------------------------

/**
 * Por que a operação parou antes do fim: o incidente dela foi resolvido ou não existe mais, alertas que o banco não
 * deixou gravar (os outros entraram), falhas demais, ou o banco indisponível por tempo demais.
 */
export const TRIAGE_STOPS = [
  'incident_resolved',
  'incident_gone',
  'failed_alerts',
  'too_many_failures',
  'unavailable',
] as const;
export type TriageStop = (typeof TRIAGE_STOPS)[number];

/**
 * O que a pessoa precisa saber: críticos ficaram de fora; o aviso por e-mail do incidente já saiu e não volta; o alerta
 * que abriu o incidente fica nele.
 */
export const TRIAGE_WARNINGS = ['critical_excluded', 'notice_not_recalled', 'anchor_kept'] as const;
export type TriageWarning = (typeof TRIAGE_WARNINGS)[number];

export const triageTargetViewSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cases'),
    caseIds: z.array(z.uuid()).max(MAX_TRIAGE_CASES),
    group: z.string().max(256).nullable(),
  }),
  z.strictObject({ kind: z.literal('findings'), count }),
  z.strictObject({ kind: z.literal('filter'), filter: z.record(z.string().max(32), z.string().max(512)) }),
  z.strictObject({ kind: z.literal('operation'), operationId: z.uuid() }),
  z.strictObject({ kind: z.literal('user'), userId: z.string().max(64) }),
]);
export type TriageTargetView = z.infer<typeof triageTargetViewSchema>;

/** Uma operação inteira: o histórico (`triageOperationSchema`), o andamento e o que quem vê pode fazer com ela. */
export const triageOperationDetailSchema = triageOperationSchema.extend({
  requestId: z.uuid(),
  target: triageTargetViewSchema,
  /** O incidente aberto (`promote`) ou que recebeu os alertas (`attach`). */
  incidentId: z.uuid().nullable(),
  includeCritical: z.boolean(),
  /** Críticos do alvo que ficaram de fora, por falta do `includeCritical`. */
  excludedCritical: count,
  /** O confirmado pela pessoa; no desfazer, quantos alertas a operação tinha mudado. */
  expectedCount: count,
  /** Até quando o alerta tinha de ter chegado para entrar. */
  cutoffAt: z.iso.datetime(),
  /** Alertas do conjunto que ainda não foram vistos. */
  remaining: count,
  /** Alertas que o banco não deixou gravar (contados em `skipped`). */
  failed: count,
  stop: z.enum(TRIAGE_STOPS).nullable(),
  updatedAt: z.iso.datetime(),
  /** A operação que desfaz (ou desfez) esta, a mais recente. */
  undoId: z.uuid().nullable(),
  warnings: z.array(z.enum(TRIAGE_WARNINGS)).max(TRIAGE_WARNINGS.length),
  can: triageCanSchema,
});
export type TriageOperationDetail = z.infer<typeof triageOperationDetailSchema>;

export const triageOperationPageSchema = paginatedSchema(triageOperationDetailSchema);
export type TriageOperationPage = z.infer<typeof triageOperationPageSchema>;

/** `active`: na fila ou em curso. */
export const triageOperationListQuerySchema = withPagination({
  state: z.enum(['active', 'finished']).optional(),
  authorId: z.string().min(1).max(64).optional(),
});
export type TriageOperationListQuery = z.infer<typeof triageOperationListQuerySchema>;

/** Os autores das operações: de quantos dias para cá e quantos, no máximo. */
export const TRIAGE_AUTHORS_DAYS = 30;
export const MAX_TRIAGE_AUTHORS = 100;

/**
 * `GET /v1/triage-operations/authors`: quem pediu operações neste cliente nos últimos 30 dias, do pedido mais recente para
 * trás, para o filtro do histórico. Um nó de antes recusa (o caminho é lido como um id).
 */
export const triageAuthorsSchema = z.strictObject({
  items: z.array(authorSchema).max(MAX_TRIAGE_AUTHORS),
  /** Há mais pessoas que o teto. */
  truncated: z.boolean(),
});
export type TriageAuthors = z.infer<typeof triageAuthorsSchema>;

// ---------------------------------------------------------------------------------------------------
// Dividir um caso
// ---------------------------------------------------------------------------------------------------

/**
 * `POST /v1/cases/:id/split`: tira alertas de um caso que juntou coisas demais, para um caso novo. Pela lista de ids
 * (todos do caso) ou por um subgrupo inteiro. O caso novo nasce selado: os alertas seguintes da chave continuam no
 * original.
 */
export const caseSplitSchema = z.union([
  z.strictObject({ findingIds: uniqueIds(MAX_SPLIT_FINDINGS), reason: reasonText.optional() }),
  z.strictObject({ group: exactText(256), reason: reasonText.optional() }),
]);
export type CaseSplit = z.infer<typeof caseSplitSchema>;

export const caseSplitResultSchema = z.strictObject({
  /** O caso novo. */
  caseId: z.uuid(),
  moved: count,
  remaining: count,
});
export type CaseSplitResult = z.infer<typeof caseSplitResultSchema>;
