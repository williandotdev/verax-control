import { CircleCheck, OctagonX } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { MarginBadge } from '@/components/badges';
import type { DeploymentMode, GuardConfiguration, GuardReport } from '@/lib/api-types';
import { configurationSummary, MODE_LABELS, PLAN_LABELS, PLANS } from '@/lib/format';
import { formatCents, formatInteger, formatRatio } from '@/lib/numbers';

const MODES: readonly DeploymentMode[] = ['managed', 'self_hosted'];

/** Um número do resumo (rótulo em cima, valor embaixo; texto na tinta, nunca na cor). */
function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-surface-raised p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums">{value}</dd>
      {note !== undefined && <dd className="mt-1 text-xs">{note}</dd>}
    </div>
  );
}

function ConfigurationTable({
  caption,
  rows,
  report,
  rowLabel,
  collapsed = false,
}: {
  caption: string;
  rows: readonly GuardConfiguration[];
  report: GuardReport;
  /** Um rótulo antes de cada linha (o plano, o lugar, o cenário). */
  rowLabel?: (index: number) => string;
  /** Lista longa que não bloqueia: fechada num `<details>`, aberta pelo título. */
  collapsed?: boolean;
}) {
  if (rows.length === 0) return null;
  const margins = { minimum: report.minimumMargin, alert: report.alertMargin };
  if (collapsed) {
    return (
      <details className="rounded-lg border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{caption}</summary>
        <ConfigurationTable
          caption={caption}
          rows={rows}
          report={report}
          {...(rowLabel === undefined ? {} : { rowLabel })}
        />
      </details>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="px-3 pt-2 text-left font-medium">{caption}</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            {rowLabel !== undefined && (
              <th scope="col" className="px-3 py-2 font-medium">
                Recorte
              </th>
            )}
            <th scope="col" className="px-3 py-2 font-medium">
              Configuração
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Mensal
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Margem de contribuição
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Situação
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row, index) => (
            <tr key={`${configurationSummary(row.configuration)}-${index}`} className="border-t align-top">
              {rowLabel !== undefined && (
                <th scope="row" className="px-3 py-2 text-left font-medium whitespace-nowrap">
                  {rowLabel(index)}
                </th>
              )}
              <td className="px-3 py-2">{configurationSummary(row.configuration)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">{formatCents(row.monthlyTotal)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                {formatCents(row.contributionMargin)} ({formatRatio(row.contributionMarginRatio)})
              </td>
              <td className="px-3 py-2">
                <MarginBadge ratio={row.contributionMarginRatio} margins={margins} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * O relatório da checagem de publicação (`POST .../check` ou o 422 da publicação recusada): a grade inteira no cartão
 * e na alíquota padrão do modelo de custos. Aprovação, contagens, o "a partir de" de cada plano contra o menor preço
 * dele, os problemas, as piores configurações, as abaixo da mínima e do alerta, o pior de cada plano e lugar, os outros
 * cenários (só informação) e a monotonia (um GB/dia a mais nunca baixa o preço).
 */
export function GuardReportView({
  report,
  costModelVersion,
  title,
}: {
  report: GuardReport;
  costModelVersion?: string;
  title: string;
}) {
  const titleId = useId();
  const worstMargin = report.worst[0]?.contributionMarginRatio;
  const byPlan = PLANS.flatMap((plan) => {
    const entry = report.worstByPlan[plan];
    return entry === undefined ? [] : [{ label: PLAN_LABELS[plan], entry }];
  });
  const byMode = MODES.flatMap((mode) => {
    const entry = report.worstByMode[mode];
    return entry === undefined ? [] : [{ label: MODE_LABELS[mode], entry }];
  });
  const scenarios = report.otherScenarios.flatMap((scenario) =>
    scenario.worst === null
      ? []
      : [
          {
            label: `${scenario.paymentMethod === 'card' ? 'Cartão' : 'Boleto'}, alíquota ${scenario.taxRateId}`,
            entry: scenario.worst,
          },
        ],
  );
  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-xl border bg-surface p-4">
      <header className="space-y-1">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <p className="flex items-center gap-2 font-medium" role="status">
          {report.ok ? (
            <>
              <CircleCheck aria-hidden className="size-5 text-ok" />
              Aprovada: nenhuma configuração abaixo da margem mínima.
            </>
          ) : (
            <>
              <OctagonX aria-hidden className="size-5 text-critical" />
              Reprovada: a tabela não pode ser publicada assim.
            </>
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          Cartão, alíquota {report.taxRateId}
          {costModelVersion !== undefined && `, modelo de custos ${costModelVersion}`}. Margem mínima{' '}
          {formatRatio(report.minimumMargin)}, alerta {formatRatio(report.alertMargin)}.
        </p>
      </header>

      {report.problems.length > 0 && (
        <div className="rounded-lg border border-critical/40 bg-critical/5 p-3">
          <p className="text-sm font-medium">Problemas que impedem a publicação</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {report.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}

      <dl className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Configurações conferidas" value={formatInteger(report.checkedConfigurations)} />
        <Stat label="Sob consulta" value={formatInteger(report.contactUsConfigurations)} />
        <Stat label="Abaixo da mínima" value={formatInteger(report.belowMinimum.count)} />
        <Stat label="Abaixo do alerta" value={formatInteger(report.belowAlert.count)} />
        <Stat label="Pior margem" value={worstMargin === undefined ? '—' : formatRatio(worstMargin)} />
        <Stat label="Quebras de monotonia" value={formatInteger(report.monotonicity.violations)} />
      </dl>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="px-3 pt-2 text-left font-medium">
            O &quot;a partir de&quot; (o menor volume de cada plano, na infraestrutura da Verax) contra o
            menor preço dele na grade
          </caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Plano
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                A partir de
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Menor preço da grade
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {PLANS.map((plan) => {
              const start = report.startingAt[plan];
              const minimum = report.gridMinimum[plan];
              return (
                <tr key={plan} className="border-t">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {PLAN_LABELS[plan]}
                  </th>
                  <td className="px-3 py-2 text-right">{start === undefined ? '—' : formatCents(start)}</td>
                  <td className="px-3 py-2 text-right">
                    {minimum === undefined ? '—' : formatCents(minimum)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ConfigurationTable caption="As piores configurações" rows={report.worst} report={report} />
      <ConfigurationTable
        caption={`Abaixo da margem mínima (${formatInteger(report.belowMinimum.count)}; as primeiras)`}
        rows={report.belowMinimum.configurations}
        report={report}
      />
      <ConfigurationTable
        caption={`Abaixo da margem de alerta (${formatInteger(report.belowAlert.count)}; não bloqueiam)`}
        rows={report.belowAlert.configurations}
        report={report}
        collapsed
      />
      <ConfigurationTable
        caption="A pior de cada plano"
        rows={byPlan.map((row) => row.entry)}
        rowLabel={(index) => byPlan[index]?.label ?? ''}
        report={report}
      />
      <ConfigurationTable
        caption="A pior de cada lugar"
        rows={byMode.map((row) => row.entry)}
        rowLabel={(index) => byMode[index]?.label ?? ''}
        report={report}
      />
      <ConfigurationTable
        caption="Outros cenários (só informação: não bloqueiam)"
        rows={scenarios.map((row) => row.entry)}
        rowLabel={(index) => scenarios[index]?.label ?? ''}
        report={report}
      />
      {report.monotonicity.examples.length > 0 && (
        <div className="rounded-lg border p-3 text-sm">
          <p className="font-medium">Um GB/dia a mais baixou o preço (exemplos)</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {report.monotonicity.examples.map((example, index) => (
              <li key={index}>
                {configurationSummary(example.from)} ({formatCents(example.fromTotal)}) →{' '}
                {configurationSummary(example.to)} ({formatCents(example.toTotal)})
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
