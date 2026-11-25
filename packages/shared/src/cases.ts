import { z } from 'zod';
import {
  FINDING_PERIODS,
  FINDING_SEVERITIES,
  findingFilterShape,
  FINDING_SOURCES,
  FINDING_STATUSES,
  findingOriginSchema,
  findingSchema,
} from './findings.js';
import { checkCustomRange, customRangeShape } from './history.js';
import { INCIDENT_STATUSES } from './incidents.js';
import { MAX_PAGE_SIZE, paginatedSchema, withPagination } from './pagination.js';
import { authorSchema } from './protected-resources.js';

/**
 * Casos: os alertas de um cliente agrupados pela mesma chave (`apps/api/src/cases/case-key.ts`). Aqui fica o contrato da
 * leitura (`GET /v1/cases` e as rotas dele). Nenhuma rota daqui grava nada.
 *
 * O título do caso é sempre de um dicionário da API, em português. Todo o resto que é texto (as partes da chave, as
 * amostras, os subgrupos) pode ter vindo do evento: é dado a mostrar, nunca HTML, link nem consulta.
 */

/** Filas: detecção (o padrão do que não se conhece), vulnerabilidade e postura. */
export const CASE_QUEUES = ['detection', 'vulnerability', 'posture'] as const;
export type CaseQueueName = (typeof CASE_QUEUES)[number];

/**
 * O que a lista mostra. `pending` (o padrão): há alerta fora de incidente, novo ou em análise. `investigating`: há
 * alerta em análise. `treated`: nada pendente (legítimo, resolvido ou num incidente). `all`: os dois. Um caso sem nenhum
 * alerta guardado não entra em lista nenhuma (só abre pelo id).
 */
export const CASE_STATES = ['pending', 'investigating', 'treated', 'all'] as const;
export type CaseState = (typeof CASE_STATES)[number];

/**
 * A ordem da lista, sempre total (dois pedidos iguais dão a mesma ordem):
 * - `priority` (o padrão): a pior severidade pendente; nela, quem toca um item da lista de proteção; e, dentro disso, a
 *   chegada do último alerta, a mais recente primeiro;
 * - `recent`: a chegada do último alerta, a mais recente primeiro;
 * - `volume`: mais alertas pendentes; no empate, mais alertas guardados; e a chegada do último.
 * O desempate final é o id. A chegada é a do servidor (`lastAlertAt`), nunca o horário do log, que quem ataca escreve.
 */
export const CASE_SORTS = ['priority', 'recent', 'volume'] as const;
export type CaseSort = (typeof CASE_SORTS)[number];

/** Por onde a fila de vulnerabilidades é agrupada: o pacote, o recurso ou a conta. */
export const CASE_GROUPINGS = ['package', 'resource', 'account'] as const;
export type CaseGrouping = (typeof CASE_GROUPINGS)[number];

/** Por que um caso foi selado: a janela passou, foi tratado inteiro, ficou sem alerta ou foi dividido. */
export const CASE_SEAL_REASONS = ['window', 'treated', 'idle', 'split'] as const;
export type CaseSealReasonName = (typeof CASE_SEAL_REASONS)[number];

/** Até que página a lista e os grupos vão (a ordem é feita em memória; quem passa disto refina os filtros). */
export const MAX_CASE_PAGE = 10_000;
/** Quantos valores de cada amostra a lista traz (o detalhe traz todos os guardados). */
export const CASE_PREVIEW_SAMPLES = 3;
/** O tamanho de um valor de amostra ou de parte da chave: 256 caracteres, que podem ocupar duas unidades cada um. */
const CASE_TEXT_MAX = 512;
/** Os tetos do detalhe. */
export const MAX_RARE_VALUES = 10;
export const MAX_CASE_GROUPS = 50;
export const MAX_PREVIOUS_CASES = 10;
export const MAX_CASE_OPERATIONS = 20;
export const MAX_CASE_INCIDENTS = 10;
/** Linha do tempo: de hora em hora até 7 dias; além disso, por dia do calendário de Brasília, no máximo um ano. */
export const CASE_TIMELINE_HOURLY_DAYS = 7;
export const CASE_TIMELINE_MAX_DAYS = 366;

const count = z.number().int().min(0);
const text = z.string().max(CASE_TEXT_MAX);

/** Um texto comparado por inteiro com o gravado: sem cortar espaços, e sem o que o banco não guarda. */
export const exactText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // O NUL e o surrogate solto.
    .refine((value) => !value.includes('\0') && !/\p{Cs}/u.test(value), {
      error: 'caractere inválido',
    });

const casePage = {
  page: z.coerce.number().int().min(1).max(MAX_CASE_PAGE).default(1),
};

const pendingSchema = z.strictObject({ critical: count, high: count, medium: count, low: count });

// ---------------------------------------------------------------------------------------------------
// Situação
// ---------------------------------------------------------------------------------------------------

/**
 * `GET /v1/cases/status`: como o painel sabe se os casos valem para quem está vendo. É a única rota dos casos que
 * responde com eles desligados. `off`: as outras rotas respondem 404, como uma que não existe. `shadow` (a medição antes
 * de ligar) só aparece para a equipe da Verax; para os outros papéis é `off`.
 */
export const CASE_MODES = ['off', 'shadow', 'on'] as const;
export const caseStatusSchema = z.strictObject({
  mode: z.enum(CASE_MODES),
  /** A última passagem da tarefa que dá caso aos alertas; null se ela nunca rodou ou com os casos desligados. */
  asOf: z.iso.datetime().nullable(),
  /** Há quantos minutos espera o alerta pendente mais antigo ainda sem caso; null se não há nenhum. */
  oldestUnassignedMinutes: count.nullable(),
});
export type CaseStatus = z.infer<typeof caseStatusSchema>;

// ---------------------------------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------------------------------

/**
 * Filtros da lista. `period` ou `from`/`to`: os casos ativos em algum momento da janela, pelo horário do evento ou pelo
 * da chegada. `severity`: há alerta pendente dela, por isso só vale em `pending` e `investigating`. `tactic`, `technique`
 * e `accountId`: pelas amostras do caso. `q`: no título, nas partes da chave e nas amostras (nunca nos alertas).
 * `groupBy` com `group`: um grupo de `GET /v1/cases/groups`; `groupBy` sozinho: os casos sem esse valor.
 */
export const caseFilterShape = {
  queue: z.enum(CASE_QUEUES).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  source: z.enum(FINDING_SOURCES).optional(),
  accountId: findingOriginSchema.optional(),
  tactic: findingFilterShape.tactic,
  technique: findingFilterShape.technique,
  period: z.enum(FINDING_PERIODS).optional(),
  ...customRangeShape,
  q: findingFilterShape.q,
  groupBy: z.enum(CASE_GROUPINGS).optional(),
  group: exactText(CASE_TEXT_MAX).optional(),
};

export const caseFilterSchema = z.strictObject(caseFilterShape);
export type CaseFilterFields = z.infer<typeof caseFilterSchema>;

/** O que vale entre os campos do filtro, na lista e na triagem em massa por filtro. */
export function checkCaseFilter(
  value: {
    severity?: unknown;
    state: CaseState;
    groupBy?: unknown;
    group?: unknown;
    period?: unknown;
    from?: string | undefined;
    to?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  checkCustomRange(value, ctx);
  if (value.severity !== undefined && (value.state === 'treated' || value.state === 'all')) {
    ctx.addIssue({
      code: 'custom',
      message: 'a severidade é a do que está pendente: use com os casos pendentes ou em análise',
      path: ['severity'],
    });
  }
  if (value.group !== undefined && value.groupBy === undefined) {
    ctx.addIssue({ code: 'custom', message: 'informe por onde os casos são agrupados', path: ['groupBy'] });
  }
}

export const caseListQuerySchema = withPagination({
  ...casePage,
  ...caseFilterShape,
  state: z.enum(CASE_STATES).default('pending'),
  sort: z.enum(CASE_SORTS).default('priority'),
}).superRefine(checkCaseFilter);
export type CaseListQuery = z.infer<typeof caseListQuerySchema>;

/** Uma parte da chave: o que os alertas do caso têm em comum. O valor pode ter vindo do evento. */
export const caseKeyPartSchema = z.strictObject({ name: z.string().max(32), value: text });

const preview = z.array(text).max(CASE_PREVIEW_SAMPLES);

export const caseSummarySchema = z.strictObject({
  id: z.uuid(),
  queue: z.enum(CASE_QUEUES),
  /** A família da chave (`console-login`, `package`...): um identificador, não um texto a mostrar. */
  family: z.string().max(64),
  /** Do dicionário da API: nunca leva texto do evento. */
  title: z.string().max(200),
  keyParts: z.array(caseKeyPartSchema).max(10),
  /** As fontes de log dos alertas do caso; vazio se a fonte não é reconhecida. */
  sources: z.array(z.enum(FINDING_SOURCES)).max(FINDING_SOURCES.length),
  /** A pior severidade entre os alertas pendentes; null sem nada pendente. */
  severity: z.enum(FINDING_SEVERITIES).nullable(),
  /** Um valor da amostra (usuário, IP ou recurso) está na lista de proteção do cliente. */
  protected: z.boolean(),
  /** Os alertas pendentes por severidade: fora de incidente, novos ou em análise. */
  pending: pendingSchema,
  /** Os alertas guardados: cada um conta uma vez, em incidente ou no status dele. */
  counts: z.strictObject({
    total: count,
    new: count,
    investigating: count,
    legitimate: count,
    resolved: count,
    incident: count,
  }),
  /** Selado não recebe alerta novo: o seguinte da mesma chave abre outro caso. */
  sealedAt: z.iso.datetime().nullable(),
  sealReason: z.enum(CASE_SEAL_REASONS).nullable(),
  /** Quantas vezes a chave já voltou (o caso anterior está no detalhe). */
  recurrence: count,
  openedAt: z.iso.datetime(),
  /** O primeiro e o último alerta, pelo horário do evento, e a chegada do último, pelo relógio do servidor. */
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  lastAlertAt: z.iso.datetime(),
  /** O começo de cada amostra. */
  preview: z.strictObject({ accounts: preview, actors: preview, ips: preview, resources: preview }),
  mitreTactics: z.array(z.string().max(CASE_TEXT_MAX)).max(20),
});
export type CaseSummary = z.infer<typeof caseSummarySchema>;

export const casePageSchema = paginatedSchema(caseSummarySchema);
export type CasePage = z.infer<typeof casePageSchema>;

// ---------------------------------------------------------------------------------------------------
// Grupos da fila de vulnerabilidades
// ---------------------------------------------------------------------------------------------------

/** Os grupos só existem na fila de vulnerabilidades, em que cada caso é um pacote num recurso (decisão D1). */
export const caseGroupsQuerySchema = withPagination({
  ...casePage,
  queue: z.literal('vulnerability').default('vulnerability'),
  by: z.enum(CASE_GROUPINGS),
  state: z.enum(['pending', 'investigating']).default('pending'),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  accountId: findingOriginSchema.optional(),
  /** No valor do grupo. */
  q: findingFilterShape.q,
});
export type CaseGroupsQuery = z.infer<typeof caseGroupsQuerySchema>;

export const caseGroupSchema = z.strictObject({
  /** O valor do grupo, o mesmo do `group` da lista; null reúne os casos sem ele (a vulnerabilidade no código). */
  value: text.nullable(),
  cases: count,
  pending: pendingSchema,
});
export type CaseGroup = z.infer<typeof caseGroupSchema>;

export const caseGroupPageSchema = paginatedSchema(caseGroupSchema);
export type CaseGroupPage = z.infer<typeof caseGroupPageSchema>;

// ---------------------------------------------------------------------------------------------------
// Operações de triagem, no histórico (as rotas delas estão em `triage-operations.ts`)
// ---------------------------------------------------------------------------------------------------

export const TRIAGE_ACTIONS = ['status', 'promote', 'attach', 'undo', 'undo_all_of'] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const TRIAGE_STATES = [
  'queued',
  'running',
  'done',
  'partial',
  'failed',
  'canceled',
  'undoing',
  'undone',
] as const;
export type TriageState = (typeof TRIAGE_STATES)[number];

/** Uma operação de triagem em massa, para o histórico: o que foi pedido, por quem, por quê e quando. */
export const triageOperationSchema = z.strictObject({
  id: z.uuid(),
  action: z.enum(TRIAGE_ACTIONS),
  /** O status pedido, só em `status`. */
  status: z.enum(FINDING_STATUSES).nullable(),
  state: z.enum(TRIAGE_STATES),
  reason: z.string().max(500).nullable(),
  /** Quem pediu; null se a pessoa foi excluída. */
  author: authorSchema.nullable(),
  createdAt: z.iso.datetime(),
  matched: count,
  changed: count,
  skipped: count,
  undoUntil: z.iso.datetime().nullable(),
  undoOfId: z.uuid().nullable(),
});
export type TriageOperationView = z.infer<typeof triageOperationSchema>;

/** `GET /v1/findings/:id/triage`: as operações que mexeram num alerta. */
export const MAX_FINDING_OPERATIONS = 20;
export const findingTriageEntrySchema = z.strictObject({
  operation: triageOperationSchema,
  /** Quando a operação mexeu neste alerta e o que ele era antes. */
  at: z.iso.datetime(),
  previousStatus: z.enum(FINDING_STATUSES),
});
export const findingTriageSchema = z.strictObject({
  /** A operação que vale: a última que mexeu no alerta, se ninguém o mudou à mão depois. */
  operation: findingTriageEntrySchema.nullable(),
  /** As operações que mexeram nele, da mais recente para a mais antiga. */
  operations: z.array(findingTriageEntrySchema).max(MAX_FINDING_OPERATIONS),
});
export type FindingTriage = z.infer<typeof findingTriageSchema>;

// ---------------------------------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------------------------------

/** Os valores menos frequentes do caso, o menos frequente primeiro e, no empate, o visto por último. */
export const rareValuesSchema = z.strictObject({
  /** Quantos valores diferentes há nos alertas lidos. */
  distinct: count,
  // O usuário tem até 512 caracteres, que podem ocupar duas unidades cada um.
  values: z
    .array(z.strictObject({ value: z.string().max(1024), count, lastSeenAt: z.iso.datetime() }))
    .max(MAX_RARE_VALUES),
});

/**
 * O que sai dos próprios alertas do caso, lidos na hora: os mais recentes, até um teto (`complete` diz se couberam
 * todos) e dentro de um prazo.
 */
export const caseAnalysisSchema = z.strictObject({
  alerts: count,
  complete: z.boolean(),
  rare: z.strictObject({ ips: rareValuesSchema, users: rareValuesSchema }),
  /** Os subgrupos (o pacote, ou o recurso do controle reprovado), o mais grave pendente primeiro. */
  groups: z.strictObject({
    distinct: count,
    values: z
      .array(z.strictObject({ value: z.string().max(256), total: count, pending: pendingSchema }))
      .max(MAX_CASE_GROUPS),
  }),
  /** Marcados como resolvidos (fora de incidente) que a origem voltou a ver depois da triagem. */
  stillActive: count,
});
export type CaseAnalysis = z.infer<typeof caseAnalysisSchema>;

/** Um caso anterior da mesma chave. */
export const previousCaseSchema = z.strictObject({
  id: z.uuid(),
  openedAt: z.iso.datetime(),
  sealedAt: z.iso.datetime().nullable(),
  sealReason: z.enum(CASE_SEAL_REASONS).nullable(),
  lastAlertAt: z.iso.datetime(),
  pending: count,
  counts: caseSummarySchema.shape.counts,
});

export const caseDetailSchema = caseSummarySchema.extend({
  samples: z.strictObject({
    ruleIds: z.array(text).max(20),
    accounts: z.array(text).max(50),
    actors: z.array(text).max(20),
    ips: z.array(text).max(20),
    resources: z.array(text).max(20),
    mitreTechniques: z.array(text).max(50),
  }),
  /** Null se a leitura passou do prazo: o resto do detalhe continua valendo. */
  analysis: caseAnalysisSchema.nullable(),
  /** Os casos anteriores da chave, do mais recente para o mais antigo; para no primeiro que já saiu pela retenção. */
  previous: z.array(previousCaseSchema).max(MAX_PREVIOUS_CASES),
  /** Os incidentes do caso: o dele (`promoted`) e os dos alertas lidos, com quantos alertas estão em cada um. */
  incidents: z
    .array(
      z.strictObject({
        id: z.uuid(),
        status: z.enum(INCIDENT_STATUSES),
        severity: z.enum(FINDING_SEVERITIES),
        alerts: count,
        promoted: z.boolean(),
      }),
    )
    .max(MAX_CASE_INCIDENTS + 1),
  /** As operações em vigor nos alertas lidos (a última de cada um) e as que elas desfizeram, da mais recente para trás. */
  operations: z.array(triageOperationSchema).max(MAX_CASE_OPERATIONS),
  /** O que quem está vendo pode fazer com o caso. Quem decide é a API, em cada operação. */
  can: z.strictObject({ triage: z.boolean(), promote: z.boolean() }),
});
export type CaseDetail = z.infer<typeof caseDetailSchema>;

// ---------------------------------------------------------------------------------------------------
// Alertas do caso
// ---------------------------------------------------------------------------------------------------

/**
 * `GET /v1/cases/:id/findings`: os alertas do caso, do mais recente para trás, por cursor (sem limite de profundidade).
 * O cursor é opaco e só vale para o mesmo caso com os mesmos filtros.
 */
export const caseFindingsQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,256}$/, { error: 'cursor inválido' })
    .optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  status: z.enum(FINDING_STATUSES).optional(),
  severity: z.enum(FINDING_SEVERITIES).optional(),
  /** O subgrupo, o valor inteiro. */
  group: exactText(256).optional(),
});
export type CaseFindingsQuery = z.infer<typeof caseFindingsQuerySchema>;

/** Código da recusa (400) do cursor que não é deste caso com estes filtros. */
export const INVALID_CASE_CURSOR_CODE = 'CASE_CURSOR_INVALID';

export const caseFindingSchema = z.strictObject({
  finding: findingSchema,
  /** O subgrupo dele no caso. */
  group: z.string().max(256).nullable(),
  /** A última vez que a origem o atualizou, nas fontes que atualizam. */
  lastSeenAt: z.iso.datetime().nullable(),
  /** Marcado como resolvido (fora de incidente), mas a origem voltou a vê-lo depois da triagem. */
  stillActive: z.boolean(),
});
export type CaseFinding = z.infer<typeof caseFindingSchema>;

export const caseFindingPageSchema = z.strictObject({
  items: z.array(caseFindingSchema).max(MAX_PAGE_SIZE),
  /** O cursor da página seguinte; null no fim. */
  nextCursor: z.string().max(256).nullable(),
});
export type CaseFindingPage = z.infer<typeof caseFindingPageSchema>;

// ---------------------------------------------------------------------------------------------------
// Linha do tempo
// ---------------------------------------------------------------------------------------------------

/**
 * `GET /v1/cases/:id/timeline`: os alertas do caso por hora cheia ou por dia de Brasília, pelo horário do evento, sem
 * buracos. Vazia se não há alerta na janela.
 */
export const caseTimelineSchema = z.strictObject({
  granularity: z.enum(['hour', 'day']),
  /** O começo da primeira faixa e o fim da última; null sem faixa nenhuma. */
  from: z.iso.datetime().nullable(),
  to: z.iso.datetime().nullable(),
  /** Há alertas fora da janela: mais antigos que um ano antes do último, ou com horário no futuro. */
  truncated: z.boolean(),
  buckets: z.array(pendingSchema.extend({ at: z.iso.datetime() })).max(CASE_TIMELINE_MAX_DAYS),
});
export type CaseTimeline = z.infer<typeof caseTimelineSchema>;
