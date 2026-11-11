import type { ReactNode } from 'react';
import type { Quote } from '@/lib/api-types';
import { gbDayLabel, lineItemLabel, PLAN_LABELS } from '@/lib/format';
import { formatCents, formatInteger } from '@/lib/numbers';

/**
 * A cotação de referência de um cadastro: o plano, o volume contratado em GB/dia, o porte, os itens e os totais pela
 * tabela vigente. Só referência: um contrato direto não passa pela Stripe, e o preço negociado é o do contrato.
 */
export function QuoteSummary({
  quote,
  priceTableVersion,
  children,
}: {
  quote: Quote;
  priceTableVersion: string;
  children?: ReactNode;
}) {
  return (
    <section aria-labelledby="cotacao-referencia" className="space-y-3 rounded-xl border bg-surface p-4">
      <div className="space-y-1">
        <h2 id="cotacao-referencia" className="text-base font-semibold">
          Cotação de referência
        </h2>
        <p className="text-sm text-muted-foreground">
          Tabela {priceTableVersion} · {PLAN_LABELS[quote.configuration.plan]},{' '}
          {gbDayLabel(quote.configuration.gbDay)} · porte {quote.configuration.size}: {quote.sizeDescription}
        </p>
      </div>
      {children}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Itens da cotação de referência</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Item
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Quantidade
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Valor
              </th>
            </tr>
          </thead>
          <tbody>
            {quote.lineItems.map((item) => (
              <tr key={`${item.component}-${item.variant}`} className="border-t">
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {lineItemLabel(item.component)}
                </th>
                <td className="py-1 pr-3 text-right tabular-nums">{formatInteger(item.quantity)}</td>
                <td className="py-1 text-right tabular-nums">{formatCents(item.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm font-medium tabular-nums">
        {formatCents(quote.monthlyTotal)} por mês
        {quote.setupTotal > 0 && ` · implantação ${formatCents(quote.setupTotal)} (uma vez)`}
      </p>
    </section>
  );
}
