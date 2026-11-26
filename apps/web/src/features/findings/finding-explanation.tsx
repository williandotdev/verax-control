import {
  explainFinding,
  type ExplanationChange,
  extractFindingChange,
  type FindingChange,
  type FindingDetail,
  type FindingExplanation,
} from '@verax/shared';
import { useId } from 'react';
import { formatMinute } from '@/lib/format';
import { useFindingChange } from './findings-api';

/**
 * "O que aconteceu": o alerta explicado em português, no topo do detalhe. Quem fez (uma pessoa, uma automação como a função
 * Lambda X, um serviço da AWS, a conta root), em que objeto, o que mudou (com o antes e o depois quando o estado anterior é
 * conhecido), por que importa e o que conferir. Os textos saem de modelos fixos (`explainFinding`, sem LLM).
 *
 * A alteração vem da API (`GET /v1/findings/:id/change`); num nó de antes (404) ou num alerta gravado antes dela, sai do
 * evento bruto do próprio detalhe, pela mesma função da API. Tudo o que veio do log é mostrado como texto, nunca como HTML.
 */

/** Quantos itens de cada lista aparecem; o resto fica contado. */
const EXPLANATION_LIST_LIMIT = 20;

/** O `data.aws` do alerta do Wazuh guardado no indexer (o evento bruto do detalhe). */
function rawAws(finding: FindingDetail): unknown {
  const data = finding.rawEvent?.['data'];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
  return Object.getOwnPropertyDescriptor(data, 'aws')?.value;
}

/** A explicação do alerta, com a alteração da API ou, sem ela, a do evento bruto. `null` enquanto carrega. */
function useFindingExplanation(finding: FindingDetail): FindingExplanation | null | undefined {
  const query = useFindingChange(finding.id);
  if (query.isPending) return undefined;
  // Falha da rota não esconde a seção: ela explica com o que o detalhe já tem.
  const context = query.isError ? null : query.data;
  const stored = context?.change ?? null;
  const fromRaw: FindingChange | null = stored === null ? extractFindingChange(rawAws(finding)) : null;
  const change = stored ?? fromRaw;
  return explainFinding({
    finding,
    change,
    previous: stored === null ? null : (context?.previous ?? null),
    repeats: context?.repeats ?? null,
    basis: stored !== null ? 'stored' : fromRaw !== null ? 'raw_event' : 'fields',
  });
}

function Items({ label, items }: { label: string; items: readonly string[] }) {
  const shown = items.slice(0, EXPLANATION_LIST_LIMIT);
  const hidden = items.length - shown.length;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul aria-label={label} className="flex flex-wrap gap-1.5">
        {shown.map((item) => (
          <li key={item} className="rounded border px-1.5 py-0.5 font-mono text-xs wrap-anywhere">
            {item}
          </li>
        ))}
        {hidden > 0 && <li className="px-1.5 py-0.5 text-xs text-muted-foreground">e mais {hidden}</li>}
      </ul>
    </div>
  );
}

const CHANGE_TITLES: Readonly<Record<ExplanationChange['kind'], string>> = {
  diff: 'Antes e depois',
  delta: 'O que mudou',
  snapshot: 'Como ficou',
  unchanged: 'Antes e depois',
};

function ChangeView({ change }: { change: ExplanationChange }) {
  const titleId = useId();
  const total = change.currentTotal ?? change.current.length;
  const hiddenByCap = change.currentTotal !== null ? change.currentTotal - change.current.length : 0;
  return (
    <section aria-labelledby={titleId} className="space-y-2 rounded-md border p-3">
      <h4 id={titleId} className="text-sm font-medium">
        {CHANGE_TITLES[change.kind]}
      </h4>
      <p className="text-xs text-muted-foreground">
        {change.note}
        {change.previousAt !== null && ` Estado anterior registrado em ${formatMinute(change.previousAt)}.`}
      </p>
      {change.added.length > 0 && <Items label={`Incluídos (${change.added.length})`} items={change.added} />}
      {change.removed.length > 0 && (
        <Items label={`Retirados (${change.removed.length})`} items={change.removed} />
      )}
      {change.changed.length > 0 && (
        <Items label={`Com a ação trocada (${change.changed.length})`} items={change.changed} />
      )}
      {(change.kind === 'snapshot' || change.kind === 'unchanged') && change.current.length > 0 && (
        <Items
          label={`${change.noun.charAt(0).toUpperCase()}${change.noun.slice(1)} agora (${total})`}
          items={change.current}
        />
      )}
      {hiddenByCap > 0 && (
        <p className="text-xs text-muted-foreground">
          O evento trazia {total} {change.noun}; só os {change.current.length} primeiros foram guardados.
        </p>
      )}
    </section>
  );
}

export function FindingExplanationSection({ finding }: { finding: FindingDetail }) {
  const titleId = useId();
  const explanation = useFindingExplanation(finding);
  if (!explanation) return null;
  return (
    <section
      aria-labelledby={titleId}
      data-testid="o-que-aconteceu"
      className="space-y-3 rounded-md border bg-foreground/[0.03] p-3"
    >
      <h3 id={titleId} className="text-sm font-semibold">
        O que aconteceu
      </h3>
      <p className="text-sm wrap-anywhere">{explanation.summary}</p>
      {explanation.failed && (
        <p className="text-sm font-medium">
          A AWS recusou esta chamada: nada mudou de fato, mas houve a tentativa.
        </p>
      )}
      {explanation.facts.length > 0 && (
        <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1 text-sm">
          {explanation.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className="min-w-0 font-medium wrap-anywhere">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {explanation.change && <ChangeView change={explanation.change} />}
      <div className="space-y-1 text-sm">
        <p>
          <span className="font-medium">Por que importa: </span>
          {explanation.why}
        </p>
        <p>
          <span className="font-medium">O que conferir: </span>
          {explanation.check}
        </p>
      </div>
      {explanation.suggestion && (
        <p role="note" className="rounded-md border border-ok/50 bg-ok/10 p-2 text-sm">
          {explanation.suggestion}
        </p>
      )}
      {explanation.basis === 'fields' && (
        <p className="text-xs text-muted-foreground">
          Os detalhes da alteração não estão disponíveis para este alerta; a explicação usa só os campos
          abaixo.
        </p>
      )}
    </section>
  );
}
