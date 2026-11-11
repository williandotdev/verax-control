import { useId } from 'react';
import { MarginBadge } from '@/components/badges';
import type { DreResult, SimulationResult } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { gbDayLabel, lineItemLabel, MODE_LABELS, PLAN_LABELS } from '@/lib/format';
import { decimalText, formatCents, formatInteger, formatRatio } from '@/lib/numbers';

type DreSimulation = Extract<SimulationResult, { contactUs: false }>;

interface StatementRow {
  sign: '+' | '−' | '=';
  label: string;
  value: number;
  /** Linha de resultado (receita líquida, margem, resultado): em negrito e com o traço em cima. */
  total?: boolean;
  note?: string;
}

function share(value: number, whole: number): string {
  return whole === 0 ? '—' : formatRatio(value / whole);
}

function Statement({ caption, rows, base }: { caption: string; rows: StatementRow[]; base: number }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="px-3 pt-2 text-left font-medium">{caption}</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Linha
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Valor
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              % da receita bruta
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row) => (
            <tr
              key={row.label}
              className={cn('border-t', row.total && 'border-t-2 border-border-strong font-semibold')}
            >
              <th
                scope="row"
                className={cn('px-3 py-2 text-left', row.total ? 'font-semibold' : 'font-normal')}
              >
                <span aria-hidden className="mr-1 inline-block w-7 text-muted-foreground">
                  {row.sign === '−' ? '(−)' : `(${row.sign})`}
                </span>
                <span className="sr-only">
                  {row.sign === '+' ? 'mais' : row.sign === '−' ? 'menos' : 'igual a'}
                </span>{' '}
                {row.label}
                {row.note !== undefined && (
                  <>
                    {' '}
                    <span className="block pl-8 text-xs font-normal text-muted-foreground">{row.note}</span>
                  </>
                )}
              </th>
              <td className="px-3 py-2 text-right whitespace-nowrap">{formatCents(row.value)}</td>
              <td className="px-3 py-2 text-right whitespace-nowrap">{share(row.value, base)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** De onde a receita bruta sai: o desconto sobre os itens e, com o imposto por cima, o valor da tabela ÷ (1 − alíquota). */
function grossNote(dre: DreResult): string | undefined {
  const lines = dre.monthly;
  const discounted = lines.tableRevenue !== dre.quote.monthlyTotal;
  const notes = [
    ...(discounted ? [`Itens de ${formatCents(dre.quote.monthlyTotal)} menos o desconto.`] : []),
    ...(dre.taxMode === 'exclusive'
      ? [
          `Imposto por cima: o valor da tabela (${formatCents(lines.tableRevenue)}) mais o imposto, que o cliente paga na fatura.`,
        ]
      : []),
  ];
  return notes.length === 0 ? undefined : notes.join(' ');
}

function monthlyRows(dre: DreResult, taxLabel: string, taxRate: number): StatementRow[] {
  const lines = dre.monthly;
  const managed = dre.quote.configuration.mode === 'managed';
  const note = grossNote(dre);
  return [
    {
      sign: '+',
      label: 'Receita bruta',
      value: lines.grossRevenue,
      ...(note === undefined ? {} : { note }),
    },
    {
      sign: '−',
      label: `Imposto (${taxLabel}, ${formatRatio(taxRate)}${dre.taxMode === 'exclusive' ? ', por cima' : ''})`,
      value: lines.taxes,
    },
    { sign: '−', label: 'Reserva para reembolso e contestação', value: lines.refundReserve },
    { sign: '=', label: 'Receita líquida', value: lines.netRevenue, total: true },
    {
      sign: '−',
      label: 'Infraestrutura',
      value: lines.infrastructure,
      note: managed
        ? dre.quote.configuration.plan === 'plataforma'
          ? 'O rateio da célula compartilhada pelo GB/dia contratado, mais a ingestão.'
          : 'O nó dedicado do porte, mais a ingestão.'
        : 'Na infraestrutura do cliente: a nuvem é paga por ele, fora da DRE.',
    },
    {
      sign: '−',
      label: `Meio de pagamento (${dre.paymentMethod === 'card' ? 'cartão' : 'boleto'})`,
      value: lines.paymentFees,
    },
    { sign: '−', label: `Suporte (${decimalText(dre.supportHours, 2)} h)`, value: lines.support },
    {
      sign: '=',
      label: 'Margem de contribuição',
      value: lines.contributionMargin,
      total: true,
      note: `Sobre a receita líquida: ${formatRatio(lines.contributionMarginNetRatio)}`,
    },
    { sign: '−', label: 'Custos fixos rateados', value: lines.fixedCosts },
    { sign: '=', label: 'Resultado do cliente', value: lines.result, total: true },
  ];
}

/**
 * A DRE de uma configuração, como demonstrativo: os itens cotados, o mês da receita bruta ao resultado com as margens
 * (com o imposto por cima quando a tabela é "+ impostos"), a implantação à parte, os doze meses e, na infraestrutura
 * do cliente, a estimativa da nuvem dele (só informação). A margem de contribuição leva o selo das metas do modelo de custos usado.
 */
export function DreStatement({ simulation }: { simulation: DreSimulation }) {
  const titleId = useId();
  const { dre, margins, taxRate } = simulation;
  const { quote, monthly, setup, twelveMonths } = dre;
  const mode = quote.configuration.mode;
  return (
    <section aria-labelledby={titleId} className="space-y-4 rounded-xl border bg-surface p-4">
      <header className="space-y-2">
        <h2 id={titleId} className="text-base font-semibold">
          DRE por cliente e por mês
        </h2>
        <p className="text-sm text-muted-foreground">
          Tabela {simulation.priceTableVersion}, modelo de custos {simulation.costModelVersion}.{' '}
          {PLAN_LABELS[quote.configuration.plan]}, {gbDayLabel(quote.configuration.gbDay)}.{' '}
          {MODE_LABELS[mode]}, porte {quote.configuration.size} ({quote.sizeDescription}).
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            Margem de contribuição: {formatRatio(monthly.contributionMarginRatio)}
          </span>
          <MarginBadge ratio={monthly.contributionMarginRatio} margins={margins} />
          <span className="text-muted-foreground">
            Metas do modelo: mínima {formatRatio(margins.minimum)}, alerta {formatRatio(margins.alert)}.
          </span>
        </div>
      </header>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="px-3 pt-2 text-left font-medium">Itens cotados</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Item
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Quantidade
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Unitário
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Total
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {quote.lineItems.map((item) => (
              <tr key={`${item.component}-${item.variant}`} className="border-t">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {lineItemLabel(item.component)}
                  <span className="ml-2 font-mono text-xs text-subtle-foreground">{item.lookupKey}</span>
                </th>
                <td className="px-3 py-2 text-right">{formatInteger(item.quantity)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{formatCents(item.unitAmount)}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{formatCents(item.amount)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="tabular-nums">
            <tr className="border-t-2 border-border-strong font-semibold">
              <th scope="row" colSpan={3} className="px-3 py-2 text-left">
                Mensal
              </th>
              <td className="px-3 py-2 text-right">{formatCents(quote.monthlyTotal)}</td>
            </tr>
            {quote.setupTotal > 0 && (
              <tr className="border-t">
                <th scope="row" colSpan={3} className="px-3 py-2 text-left font-normal">
                  Primeira fatura (com a implantação)
                </th>
                <td className="px-3 py-2 text-right">{formatCents(quote.firstInvoiceTotal)}</td>
              </tr>
            )}
          </tfoot>
        </table>
      </div>

      <Statement
        caption="Demonstrativo do mês"
        rows={monthlyRows(dre, taxRate.label, taxRate.rate)}
        base={monthly.grossRevenue}
      />

      {setup.revenue > 0 && (
        <Statement
          caption="Implantação (uma vez, na primeira fatura)"
          base={setup.revenue}
          rows={[
            { sign: '+', label: 'Receita da implantação', value: setup.revenue },
            { sign: '−', label: 'Imposto', value: setup.taxes },
            { sign: '−', label: 'Reserva para reembolso e contestação', value: setup.refundReserve },
            {
              sign: '−',
              label: 'Meio de pagamento (sem o valor fixo: mesma cobrança)',
              value: setup.paymentFees,
            },
            { sign: '−', label: `Suporte (${decimalText(setup.supportHours, 2)} h)`, value: setup.support },
            {
              sign: '=',
              label: 'Margem de contribuição da implantação',
              value: setup.contributionMargin,
              total: true,
            },
          ]}
        />
      )}

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <caption className="px-3 pt-2 text-left font-medium">
            Doze meses (a implantação entra no primeiro)
          </caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Linha
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                12 meses
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                % da receita bruta
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {(
              [
                ['Receita bruta', twelveMonths.grossRevenue],
                ['Margem de contribuição', twelveMonths.contributionMargin],
                ['Resultado do cliente', twelveMonths.result],
              ] as const
            ).map(([label, value]) => (
              <tr key={label} className="border-t">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {label}
                </th>
                <td className="px-3 py-2 text-right whitespace-nowrap">{formatCents(value)}</td>
                <td className="px-3 py-2 text-right">{share(value, twelveMonths.grossRevenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dre.customerCloudEstimate !== null && (
        <div className="rounded-lg border border-dashed p-3 text-sm">
          <p className="font-medium">
            Custo estimado da infraestrutura do cliente (paga direto por ele, fora da DRE)
          </p>
          <p className="tabular-nums">
            {formatCents(dre.customerCloudEstimate.monthly)} por mês, entre{' '}
            {formatCents(dre.customerCloudEstimate.low)} e {formatCents(dre.customerCloudEstimate.high)}.
          </p>
        </div>
      )}
    </section>
  );
}
