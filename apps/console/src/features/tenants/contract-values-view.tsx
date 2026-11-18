import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Grid, NumberField } from '@/form/fields';
import type { ContractValues } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatCents } from '@/lib/numbers';
import {
  CONTRACT_FIELD_LABELS,
  CONTRACT_FIELDS,
  CONTRACT_UNITS,
  type ContractField,
  negotiationText,
} from './contract-values';

/** O marcador ao lado de um valor: "Tabela" discreto; "Negociado" em destaque, com a diferença. */
export function NegotiationMarker({ contracted, reference }: { contracted: number; reference: number }) {
  const negotiated = contracted !== reference;
  const text = negotiationText(contracted, reference);
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        negotiated ? 'border-high/60 bg-high/10' : 'text-muted-foreground',
      )}
    >
      {text.charAt(0).toUpperCase() + text.slice(1)}
    </span>
  );
}

/**
 * Os valores do contrato no formulário de cadastro, depois da cotação: o mensal e o GB/dia adicional, preenchidos com a
 * referência da tabela e editáveis para uma negociação por fora. Cada campo mostra o valor da tabela e o marcador; o
 * negociado tem "Voltar ao valor da tabela". Fica dentro de um `DraftForm` (os campos são `contracted.*` do rascunho).
 */
export function ContractValuesSection({
  reference,
  value,
  readOnly,
  onReset,
}: {
  reference: ContractValues;
  value: unknown;
  readOnly: boolean;
  onReset: (field: ContractField) => void;
}) {
  const values = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  return (
    <section aria-labelledby="valores-contrato" className="space-y-3 rounded-xl border bg-surface p-4">
      <div className="space-y-1">
        <h2 id="valores-contrato" className="text-base font-semibold">
          Valores do contrato
        </h2>
        <p className="text-sm text-muted-foreground">
          Vêm preenchidos com a tabela (calculados como na infraestrutura da Verax, onde quer que o ambiente
          rode). Mude se houve negociação por fora: o cliente grava o valor contratado ao lado do da tabela.
          Ao calcular a cotação de novo, um valor que você mudou é mantido; use “Voltar ao valor da tabela”
          para ficar com o da cotação nova.
        </p>
      </div>
      <Grid>
        {CONTRACT_FIELDS.map((field) => {
          const current = values[field];
          const negotiated = typeof current === 'number' && current !== reference[field];
          return (
            <div key={field} className="space-y-2">
              <NumberField
                path={['contracted', field]}
                label={CONTRACT_FIELD_LABELS[field]}
                kind="money"
                hint={`Tabela: ${formatCents(reference[field])} ${CONTRACT_UNITS[field]}.`}
              />
              <div className="flex flex-wrap items-center gap-2" data-field={field}>
                {typeof current === 'number' && (
                  <NegotiationMarker contracted={current} reference={reference[field]} />
                )}
                {negotiated && !readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onReset(field)}
                    aria-label={`Voltar ao valor da tabela: ${CONTRACT_FIELD_LABELS[field]}`}
                  >
                    <RotateCcw aria-hidden />
                    Voltar ao valor da tabela
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Grid>
    </section>
  );
}

/**
 * Um valor do contrato para leitura (a confirmação do cadastro e o detalhe do cliente): o contratado, o marcador e, se
 * negociado, o valor da tabela ao lado.
 */
export function ContractValueLine({
  field,
  contracted,
  reference,
}: {
  field: ContractField;
  contracted: number;
  reference: number;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{CONTRACT_FIELD_LABELS[field]}</dt>
      <dd className="flex flex-wrap items-center gap-2 text-sm tabular-nums">
        <span>
          {formatCents(contracted)} {CONTRACT_UNITS[field]}
        </span>
        <NegotiationMarker contracted={contracted} reference={reference} />
        {contracted !== reference && (
          <span className="text-xs text-muted-foreground">tabela: {formatCents(reference)}</span>
        )}
      </dd>
    </div>
  );
}
