import { z } from 'zod';
import { FINDING_SOURCES } from './findings.js';
import { MITRE_TACTIC_NAMES, MITRE_TECHNIQUE_PATTERN } from './mitre.js';

/**
 * Cobertura de detecção (UC-1): o catálogo de cenários de detecção. Um cenário descreve um objetivo de detecção (ex.:
 * "força bruta contra login") e junta as regras, de qualquer fonte, que servem a esse objetivo. O catálogo fica no
 * repositório, em `detections/catalog/<id>.json` (um arquivo por cenário), e descreve só regras que existem no código.
 *
 * "Cenário" não é o "caso" dos alertas (`apps/api/src/cases/`) nem o relatório `coverage` (a cobertura das contas por
 * fonte, a aba "Cobertura das fontes"). Na interface, a tela se chama "Cobertura de detecção".
 *
 * O estado declarado no arquivo não basta: o estado efetivo sai de `effectiveScenarioState`, que confere a evidência
 * contra a impressão digital (fingerprint) atual de cada regra.
 */

/** Nome da tela na interface. A aba "Cobertura das fontes" (relatório `coverage`) mantém o nome dela. */
export const DETECTION_COVERAGE_LABEL = 'Cobertura de detecção';

/**
 * Os cinco estados nascem completos (o painel novo precisa entender todos desde o começo). `sugerido` e
 * `em_desenvolvimento` são da equipe da Verax e não vivem no repositório; o arquivo do catálogo aceita só os outros três.
 */
export const DETECTION_SCENARIO_STATES = [
  'sugerido',
  'em_desenvolvimento',
  'em_teste',
  'homologado',
  'aposentado',
] as const;
export type DetectionScenarioState = (typeof DETECTION_SCENARIO_STATES)[number];

/** Os estados que um arquivo de `detections/catalog/` pode declarar. */
export const CATALOG_SCENARIO_STATES = [
  'em_teste',
  'homologado',
  'aposentado',
] as const satisfies readonly DetectionScenarioState[];
export type CatalogScenarioState = (typeof CATALOG_SCENARIO_STATES)[number];

/** O que o cliente vê, só leitura e com o rótulo do estado (decisão do responsável de 25/11/2026). */
export const CUSTOMER_VISIBLE_SCENARIO_STATES = [
  'homologado',
  'em_teste',
] as const satisfies readonly DetectionScenarioState[];

export const DETECTION_SCENARIO_STATE_LABELS: Readonly<Record<DetectionScenarioState, string>> = {
  sugerido: 'Sugerido',
  em_desenvolvimento: 'Em desenvolvimento',
  em_teste: 'Em teste',
  homologado: 'Homologado',
  aposentado: 'Aposentado',
};

/** Severidade do cenário: a da regra mais grave, ou `from_source` quando quem dá a severidade é o provedor. */
export const DETECTION_SCENARIO_SEVERITIES = ['critical', 'high', 'medium', 'low', 'from_source'] as const;
export type DetectionScenarioSeverity = (typeof DETECTION_SCENARIO_SEVERITIES)[number];

/** ID do cenário: `SC-0001`, sequencial e sem significado. É também o nome do arquivo. */
export const DETECTION_SCENARIO_ID_PATTERN = /^SC-\d{4}$/;
/** ID de regra: o mesmo que vai para o `ruleId` do achado (Wazuh ou worker). */
export const DETECTION_RULE_ID_PATTERN = /^\d{1,7}$/;
/** Impressão digital de uma regra: SHA-256 em hexadecimal, com o prefixo do algoritmo. */
export const RULE_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** Texto de uma linha para o analista: sem caractere de controle e sem espaço nas pontas. */
const line = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u, { error: 'caractere de controle' })
    .refine((value) => value.trim() === value, { error: 'espaço nas pontas' });

/** Apelido da equipe ou da pessoa da Verax (nunca e-mail): letras, números, espaço, ponto, hífen e sublinhado. */
const nickname = z
  .string()
  .min(2)
  .max(60)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, { error: 'apelido inválido (sem e-mail)' });

const isoDate = z.iso.date();
const commitSha = z.string().regex(/^[0-9a-f]{40}$/, { error: 'commit inválido' });
const ruleId = z.string().regex(DETECTION_RULE_ID_PATTERN, { error: 'regra inválida' });
const fingerprint = z.string().regex(RULE_FINGERPRINT_PATTERN, { error: 'fingerprint inválida' });

/**
 * Evidência do CI: um evento de teste fictício que o CI passa pela regra a cada PR (UC-2). `fires: true` é a positiva;
 * `fires: false`, a negativa (o evento parecido que não deve disparar). Homologar exige as duas, com resultado `pass`.
 */
export const ciEvidenceSchema = z.strictObject({
  kind: z.literal('ci'),
  ruleId,
  fingerprint,
  /** Caminho do evento no repositório: `detections/evidence/<id do cenário>/<nome>.json`. */
  event: z.string().regex(/^detections\/evidence\/SC-\d{4}\/[a-z0-9][a-z0-9-]{0,80}\.json$/, {
    error: 'caminho do evento inválido',
  }),
  expected: z.strictObject({
    fires: z.boolean(),
    level: z.number().int().min(0).max(16).optional(),
  }),
  result: z.enum(['pass', 'fail']),
  date: isoDate,
  approver: nickname,
  commit: commitSha,
});

/**
 * Evidência de laboratório (opcional): o evento real numa conta de teste fica fora do repositório; o arquivo cita só o
 * hash do evento sanitizado. Não conta para homologar.
 */
export const labEvidenceSchema = z.strictObject({
  kind: z.literal('lab'),
  ruleId,
  fingerprint,
  eventSha256: z.string().regex(/^[0-9a-f]{64}$/, { error: 'hash inválido' }),
  result: z.enum(['pass', 'fail']),
  date: isoDate,
  approver: nickname,
});

export type CiEvidence = z.infer<typeof ciEvidenceSchema>;

export const scenarioEvidenceSchema = z.discriminatedUnion('kind', [ciEvidenceSchema, labEvidenceSchema]);
export type ScenarioEvidence = z.infer<typeof scenarioEvidenceSchema>;

const uniqueList = <T extends z.ZodType>(item: T, label: string) =>
  z.array(item).refine((list) => new Set(list).size === list.length, { error: `${label} repetido` });

/** Um arquivo de `detections/catalog/`. */
export const detectionScenarioSchema = z
  .strictObject({
    id: z.string().regex(DETECTION_SCENARIO_ID_PATTERN, { error: 'ID inválido' }),
    title: line(120),
    /** O objetivo da detecção, para o analista: o que ela procura e por que importa. */
    goal: line(700),
    logSources: uniqueList(z.enum(FINDING_SOURCES), 'fonte').min(1),
    rules: uniqueList(ruleId, 'regra'),
    /**
     * A lógica da detecção é do provedor (GuardDuty, Security Hub, Inspector, Access Analyzer): a Verax só responde
     * pelo repasse do achado até o painel, não pelo que o provedor detecta ou deixa de detectar.
     */
    providerDetection: z.boolean(),
    /** Só o MITRE que o código já mapeia para as regras do cenário (conferido por teste), nunca inventado. */
    mitre: z.strictObject({
      tactics: uniqueList(z.enum(MITRE_TACTIC_NAMES), 'tática'),
      techniques: uniqueList(
        z.string().regex(MITRE_TECHNIQUE_PATTERN, { error: 'técnica inválida' }),
        'técnica',
      ),
    }),
    severity: z.enum(DETECTION_SCENARIO_SEVERITIES),
    /** O que o analista faz quando o cenário dispara. */
    expectedResponse: line(900),
    /** Papel ou apelido da equipe dona do cenário (nunca e-mail). */
    owner: nickname,
    state: z.enum(CATALOG_SCENARIO_STATES),
    /** Evento raro por natureza (conta root, zona apagada): silêncio é o esperado. */
    quietExpected: z.boolean(),
    evidence: z.array(scenarioEvidenceSchema),
  })
  .refine((scenario) => scenario.state === 'aposentado' || scenario.rules.length > 0, {
    error: 'cenário sem regra só aposentado',
    path: ['rules'],
  })
  .refine((scenario) => scenario.evidence.every((item) => scenario.rules.includes(item.ruleId)), {
    error: 'evidência de regra fora do cenário',
    path: ['evidence'],
  })
  .refine(
    (scenario) =>
      scenario.evidence.every(
        (item) => item.kind !== 'ci' || item.event.startsWith(`detections/evidence/${scenario.id}/`),
      ),
    { error: 'evento de outro cenário', path: ['evidence'] },
  )
  .refine((scenario) => scenario.providerDetection === (scenario.severity === 'from_source'), {
    error: 'severidade "from_source" só (e sempre) em detecção do provedor',
    path: ['severity'],
  });
export type DetectionScenario = z.infer<typeof detectionScenarioSchema>;

/** Por que o estado efetivo não é o declarado. */
export type EffectiveStateReason =
  | `rule_missing:${string}`
  | `rule_changed:${string}`
  | `missing_evidence:${string}`
  | `evidence_failed:${string}`;

export interface EffectiveScenarioState {
  state: DetectionScenarioState;
  /** Vazio quando o efetivo é o declarado. */
  reasons: EffectiveStateReason[];
}

/**
 * O estado efetivo de um cenário. `homologado` declarado só vale se toda regra existe nesta versão e tem evidência do
 * CI positiva e negativa, com resultado `pass`, presa à fingerprint atual da regra, e nenhuma evidência do CI com essa
 * fingerprint falhou. Qualquer falta derruba o cenário para `em_teste`, com o motivo por regra. A evidência de
 * laboratório não entra na conta (é opcional). Os demais estados valem como declarados.
 *
 * @param fingerprints a fingerprint atual de cada regra da versão (`ruleId` → `sha256:...`).
 */
export function effectiveScenarioState(
  scenario: Pick<DetectionScenario, 'state' | 'rules' | 'evidence'>,
  fingerprints: ReadonlyMap<string, string>,
): EffectiveScenarioState {
  if (scenario.state !== 'homologado') return { state: scenario.state, reasons: [] };
  const reasons: EffectiveStateReason[] = [];
  // Sem regra não há o que homologar (o schema já recusa; a função não confia nisso).
  if (scenario.rules.length === 0) reasons.push('missing_evidence:*');
  for (const rule of scenario.rules) {
    const current = fingerprints.get(rule);
    if (current === undefined) {
      reasons.push(`rule_missing:${rule}`);
      continue;
    }
    const ci = scenario.evidence.filter(
      (item): item is CiEvidence => item.kind === 'ci' && item.ruleId === rule,
    );
    const valid = ci.filter((item) => item.fingerprint === current);
    if (valid.some((item) => item.result === 'fail')) {
      reasons.push(`evidence_failed:${rule}`);
      continue;
    }
    const passed = valid.filter((item) => item.result === 'pass');
    const positive = passed.some((item) => item.expected.fires);
    const negative = passed.some((item) => !item.expected.fires);
    if (positive && negative) continue;
    reasons.push(ci.length > valid.length ? `rule_changed:${rule}` : `missing_evidence:${rule}`);
  }
  return reasons.length === 0 ? { state: 'homologado', reasons } : { state: 'em_teste', reasons };
}
