import {
  type CaseQueueName,
  type CaseSealReasonName,
  type CaseSort,
  type CaseState,
  type CaseSummary,
  type FindingSource,
  FINDING_SOURCES,
} from '@verax/shared';
import type { VulnerabilityGrouping } from '@/features/detections/url-state';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { plural } from '@/lib/format';

/** Os textos dos casos. Tudo o que vem do evento (partes da chave, amostras, subgrupos) é só mostrado, como texto. */

export const QUEUE_LABELS: Readonly<Record<CaseQueueName, string>> = {
  detection: 'Detecção',
  posture: 'Postura',
  vulnerability: 'Vulnerabilidades',
};

export const CASE_STATE_LABELS: Readonly<Record<CaseState, string>> = {
  pending: 'Pendentes',
  investigating: 'Em análise',
  treated: 'Tratados',
  all: 'Todos',
};

export const CASE_SORT_LABELS: Readonly<Record<CaseSort, string>> = {
  priority: 'Prioridade',
  recent: 'Mais recentes primeiro',
  volume: 'Mais alertas primeiro',
};

export const GROUPING_LABELS: Readonly<Record<VulnerabilityGrouping, string>> = {
  package: 'Pacote',
  resource: 'Recurso',
  account: 'Conta',
  none: 'Sem agrupar',
};

/** O grupo dos casos sem o valor (a vulnerabilidade no código não tem pacote). */
export const NULL_GROUP_LABELS: Readonly<Record<Exclude<VulnerabilityGrouping, 'none'>, string>> = {
  package: 'Sem pacote (vulnerabilidade no código)',
  resource: 'Sem recurso',
  account: 'Sem conta',
};

/** O nome de cada parte da chave, para a pessoa. */
const KEY_PART_LABELS: Readonly<Record<string, string>> = {
  rule: 'Regra',
  actor: 'Quem agiu',
  role: 'Papel da AWS',
  principal: 'Papel da AWS (ID)',
  federated: 'Conta dos usuários federados',
  resource: 'Recurso',
  network: 'Rede de origem',
  type: 'Tipo do achado',
  package: 'Pacote',
  control: 'Controle',
  service: 'Serviço dos controles',
  product: 'Produto',
  source: 'Fonte',
};

const NETWORK_PREFIXES = ['ipv4:', 'ipv6:'] as const;

type CaseKeyPart = CaseSummary['keyParts'][number];

function isSource(value: string): value is FindingSource {
  return (FINDING_SOURCES as readonly string[]).includes(value);
}

/** O valor de uma parte da chave como a pessoa o conhece: a rede sem o prefixo da chave, a fonte pelo nome. */
function keyPartValue({ name, value }: CaseKeyPart): string {
  if (name === 'network') {
    const prefix = NETWORK_PREFIXES.find((candidate) => value.startsWith(candidate));
    return prefix ? value.slice(prefix.length) : value;
  }
  if (name === 'source' && isSource(value)) return FINDING_SOURCE_LABELS[value];
  return value;
}

/** O que os alertas do caso têm em comum, parte por parte. A reunião (`fold`) não é um valor: vira explicação. */
export function keyPartRows(parts: readonly CaseKeyPart[]): { label: string; value: string }[] {
  return parts
    .filter((part) => part.name !== 'fold')
    .map((part) => ({ label: KEY_PART_LABELS[part.name] ?? part.name, value: keyPartValue(part) }));
}

const FOLD_TEXTS: Readonly<Record<string, string>> = {
  distributed:
    'Os mesmos alertas vieram de redes de origem demais, e foram reunidos num caso só: abrir um por rede esconderia o resto da fila.',
  overflow:
    'Passou do limite diário de casos críticos desta origem: os críticos seguintes foram reunidos aqui, para nenhum ficar sem caso.',
  rollup:
    'Passou do limite diário de casos: os alertas médios e baixos desta fonte foram reunidos aqui. Os altos e críticos nunca entram nesta reunião.',
};

const SEAL_TEXTS: Readonly<Record<CaseSealReasonName, string>> = {
  window: 'Passou da janela de tempo: os alertas seguintes foram para outro caso.',
  treated: 'Foi tratado por inteiro: os alertas seguintes foram para outro caso.',
  idle: 'Ficou sem nenhum alerta guardado: os seguintes foram para outro caso.',
  split: 'Nasceu de um caso dividido: os alertas seguintes continuam no caso original.',
};

export function sealText(reason: CaseSealReasonName | null): string {
  return reason === null ? 'Não recebe mais alertas.' : SEAL_TEXTS[reason];
}

const SEAL_LABELS: Readonly<Record<CaseSealReasonName, string>> = {
  window: 'passou da janela de tempo',
  treated: 'tratado',
  idle: 'sem alertas guardados',
  split: 'dividido',
};
export const sealLabel = (reason: CaseSealReasonName | null): string =>
  reason === null ? 'fechado' : SEAL_LABELS[reason];

/** Como os alertas foram agrupados, em frases. */
export function groupingText(
  row: Pick<CaseSummary, 'queue' | 'keyParts' | 'sealedAt' | 'sealReason'>,
): string[] {
  const folded = FOLD_TEXTS[row.keyParts.find((part) => part.name === 'fold')?.value ?? ''];
  return [
    ...(folded ? [folded] : []),
    ...(row.queue === 'vulnerability'
      ? [
          'Cada caso é um pacote num recurso: entram nele todas as vulnerabilidades desse pacote ali, de qualquer severidade. O caso fica aberto até ser tratado.',
        ]
      : [
          ...(folded ? [] : ['Alertas altos e críticos nunca dividem um caso com os médios e baixos.']),
          row.queue === 'detection'
            ? 'Um caso de detecção recebe alertas novos enquanto o intervalo entre eles for de até 24 horas, e por até 7 dias.'
            : 'Um caso de postura fica aberto até ser tratado.',
        ]),
    ...(row.sealedAt === null ? [] : [sealText(row.sealReason)]),
  ];
}

/**
 * "Voltou depois de tratado (2×)": a API diz quantas das voltas foram depois de tratado (`recurrenceTreated`). De um nó de
 * antes, o caso só diz quantas vezes a chave já voltou; na fila de detecção ela também volta quando a janela de tempo passa,
 * então o "depois de tratado" vale sem mais conferência só nas outras filas, que não têm janela. No detalhe, os casos
 * anteriores dizem quantas vezes foi depois de tratado.
 */
export function recurrenceLabel(
  row: Pick<CaseSummary, 'queue' | 'recurrence' | 'recurrenceTreated'>,
  treatedBefore?: number,
): string | null {
  if (row.recurrence === 0) return null;
  const treated = row.recurrenceTreated ?? treatedBefore;
  if (treated === undefined) {
    return row.queue === 'detection'
      ? `Voltou (${row.recurrence}×)`
      : `Voltou depois de tratado (${row.recurrence}×)`;
  }
  return treated > 0 ? `Voltou depois de tratado (${treated}×)` : `Voltou (${row.recurrence}×)`;
}

/** O que identifica o caso numa linha: no de vulnerabilidade, o pacote e o recurso; nos outros, quem, onde e de onde. */
export function mainSubjects(
  row: Pick<CaseSummary, 'queue' | 'keyParts' | 'preview'>,
): { label: string; value: string; more: boolean }[] {
  if (row.queue === 'vulnerability') {
    return keyPartRows(
      row.keyParts.filter((part) => part.name === 'package' || part.name === 'resource'),
    ).map((part) => ({ ...part, more: false }));
  }
  const samples: [string, readonly string[]][] = [
    ['Usuário', row.preview.actors],
    ['Recurso', row.preview.resources],
    ['IP', row.preview.ips],
  ];
  return samples
    .flatMap(([label, values]) =>
      values[0] === undefined ? [] : [{ label, value: values[0], more: values.length > 1 }],
    )
    .slice(0, 2);
}

/** O que o leitor de tela ouve no botão: o título se repete entre os casos, então vai junto o que identifica este. */
export function caseName(row: Pick<CaseSummary, 'title' | 'queue' | 'keyParts' | 'preview'>): string {
  return [row.title, ...mainSubjects(row).map((subject) => subject.value)].join(', ');
}

/** A severidade é a do que está pendente: nos tratados (e em todos), a API não a aceita. */
export const severityApplies = (state: CaseState): state is 'pending' | 'investigating' =>
  state === 'pending' || state === 'investigating';

export const alertCount = (count: number): string => plural(count, 'alerta', 'alertas');
export const caseCount = (count: number): string => plural(count, 'caso', 'casos');
