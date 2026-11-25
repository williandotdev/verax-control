import {
  type AwsWebLogsAcknowledgement,
  WEB_ESTIMATE_MAX_AGE_MS,
  type WebEstimate,
  type WebEstimateBasis,
  type WebEstimateProjection,
  type WebLogSource,
} from '@verax/shared';

/**
 * A estimativa de volume de um balanceador, como a tela a mostra. Só regras de leitura do que a API mandou: quem confere a
 * estimativa na autorização é a API, com o que está gravado.
 */

/**
 * - `never`: nunca pedida;
 * - `pending`: pedida, e o worker ainda não respondeu (`slow`: há mais tempo do que o normal);
 * - `ready` e `no_sample`: vale para autorizar, com a projeção;
 * - `hidden`: calculada, e quem lê não vê o plano (nem a projeção, que diria o tamanho dele);
 * - `expired`: mais velha que 7 dias, não vale para autorizar;
 * - `failed`: a leitura falhou, com o motivo.
 */
export type EstimateView =
  | { kind: 'never' }
  | { kind: 'pending'; since: string; slow: boolean }
  | { kind: 'ready'; estimate: WebEstimate; projection: WebEstimateProjection }
  | { kind: 'no_sample'; estimate: WebEstimate; projection: WebEstimateProjection }
  | { kind: 'hidden'; estimate: WebEstimate; computedAt: string }
  | { kind: 'expired'; computedAt: string }
  | { kind: 'failed'; code: string | null; computedAt: string | null };

/** O resultado guardado, sem olhar o pedido em andamento; null se nunca houve um. */
function resultView(estimate: WebEstimate, now: number): EstimateView | null {
  const { status, computedAt, projection } = estimate;
  if (status === null) return null;
  if (status === 'failed') return { kind: 'failed', code: estimate.errorCode, computedAt };
  if (computedAt === null) return null;
  const age = now - Date.parse(computedAt);
  // O relógio do navegador pode estar um pouco atrás do servidor: só a idade de mais de 7 dias diz que venceu.
  if (age > WEB_ESTIMATE_MAX_AGE_MS) return { kind: 'expired', computedAt };
  if (projection === null) return { kind: 'hidden', estimate, computedAt };
  return { kind: status, estimate, projection };
}

/** O que a tela mostra da estimativa agora. */
export function estimateView(
  estimate: WebEstimate | null,
  now: number,
  slowAfterMs: number,
): { current: EstimateView; previous: EstimateView | null } {
  if (estimate === null) return { current: { kind: 'never' }, previous: null };
  const result = resultView(estimate, now);
  if (estimate.requestedAt === null) return { current: result ?? { kind: 'never' }, previous: null };
  return {
    current: {
      kind: 'pending',
      since: estimate.requestedAt,
      slow: now - Date.parse(estimate.requestedAt) > slowAfterMs,
    },
    previous: result,
  };
}

/** A estimativa que vale para autorizar agora: calculada, de até 7 dias e com a projeção. Null fora disso. */
export function usableEstimate(
  source: Pick<WebLogSource, 'estimate'> | undefined,
  now: number,
): { computedAt: string; truncated: boolean; projection: WebEstimateProjection } | null {
  const estimate = source?.estimate ?? null;
  if (estimate === null) return null;
  const view = resultView(estimate, now);
  if (view === null || (view.kind !== 'ready' && view.kind !== 'no_sample')) return null;
  if (estimate.computedAt === null) return null;
  return { computedAt: estimate.computedAt, truncated: estimate.truncated, projection: view.projection };
}
export type UsableEstimate = NonNullable<ReturnType<typeof usableEstimate>>;

/**
 * A identidade do que o cliente viu: se a estimativa for refeita, ou o plano mudar, a ciência dada antes deixa de valer e a
 * caixa volta desmarcada.
 */
export function estimateKey(sourceId: string, estimate: UsableEstimate): string {
  const { gbPerDay, percent } = estimate.projection;
  return [sourceId, estimate.computedAt, gbPerDay ?? '-', percent ?? '-'].join('|');
}

/** A ciência da estimativa, como o pedido de autorização a leva. */
export function acknowledgementOf(
  sourceId: string,
  estimate: UsableEstimate,
  acknowledged: boolean,
): AwsWebLogsAcknowledgement {
  return {
    sourceId,
    estimatedAt: estimate.computedAt,
    estimatedGbPerDay: estimate.projection.gbPerDay,
    projectedPercent: estimate.projection.percent,
    acknowledged,
  };
}

const gb = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
const mb = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const percentFormat = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** O volume por dia em GB (10^9 bytes); pouco, em MB, para não virar "0 GB". */
export function formatGbPerDay(gbPerDay: number): string {
  if (gbPerDay === 0) return 'menos de 1 MB';
  return gbPerDay >= 0.1 ? `${gb.format(gbPerDay)} GB` : `${mb.format(Math.max(1, gbPerDay * 1000))} MB`;
}

export const formatPercentOf = (percent: number): string => `${percentFormat.format(percent)}%`;

const BASIS_TEXTS: Readonly<Record<WebEstimateBasis, string>> = {
  monthly: 'do volume do mês do plano',
  franchise: 'da franquia por dia do plano',
  none: '',
};

/** "cerca de 1 GB por dia (46,6% do volume do mês do plano)"; null sem amostra. */
export function projectionText(projection: WebEstimateProjection, truncated: boolean): string | null {
  if (projection.gbPerDay === null) return null;
  const volume = `${truncated ? 'pelo menos' : 'cerca de'} ${formatGbPerDay(projection.gbPerDay)} por dia`;
  return projection.percent === null
    ? `${volume} (o plano não tem limite de volume)`
    : `${volume} (${formatPercentOf(projection.percent)} ${BASIS_TEXTS[projection.basis]})`;
}

/** O texto da confirmação de um balanceador, na primeira pessoa de quem autoriza. */
export function acknowledgementText(name: string, estimate: UsableEstimate): string {
  const { projection, truncated } = estimate;
  const text = projectionText(projection, truncated);
  return text === null
    ? `Entendi: não deu para medir o volume do ${name}, e ele pode consumir boa parte do plano.`
    : `Entendi: o ${name} deve consumir ${text}.`;
}
