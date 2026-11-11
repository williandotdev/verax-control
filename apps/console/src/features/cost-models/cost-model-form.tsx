import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDraftValue, useField, useSetter } from '@/form/form-context';
import { Grid, ListEditor, NumberField, Section, SelectField, TextField } from '@/form/fields';
import { recordsAt } from '@/features/versions/shape';
import type { SizeId } from '@/lib/api-types';
import { formatCents } from '@/lib/numbers';
import { getAt } from '@/lib/paths';
import { nodeCostBySize, sharedCellCost } from './node-cost';

const SIZES: readonly SizeId[] = ['P', 'M', 'G'];

function SizeCosts({ size }: { size: SizeId }) {
  const path = ['infrastructure', 'sizes', size] as const;
  const binding = useField(path);
  const setter = useSetter();
  if (binding.value === undefined) {
    if (binding.readOnly) return null;
    return (
      <Button variant="secondary" size="sm" onClick={() => setter(path, {})}>
        <Plus aria-hidden />
        Acrescentar o porte {size}
      </Button>
    );
  }
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Porte {size}</p>
        {!binding.readOnly && (
          <Button variant="ghost" size="sm" onClick={() => setter(path, undefined)}>
            <Trash2 aria-hidden />
            Tirar o porte {size}
          </Button>
        )}
      </div>
      <Grid>
        <NumberField
          path={[...path, 'vmUsdPerMonth']}
          label={`VM do porte ${size} (US$/mês)`}
          kind="decimal"
        />
        <NumberField path={[...path, 'diskGb']} label={`Disco do porte ${size} (GB)`} kind="decimal" />
        <NumberField
          path={[...path, 'snapshotGib']}
          label={`Snapshots do porte ${size} (GiB)`}
          kind="decimal"
          hint="Estimativa da retenção dos snapshots."
        />
      </Grid>
    </div>
  );
}

function usdText(usd: number | undefined): string {
  return usd === undefined ? '—' : usd.toLocaleString('pt-BR', { maximumFractionDigits: 2 });
}

/** O custo da célula compartilhada e o rateio por GB/dia, recalculados a cada tecla. */
function CellCostPreview() {
  const cell = sharedCellCost(useDraftValue());
  if (cell === undefined) return null;
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-3">
      <div className="rounded-lg border p-3">
        <dt className="text-xs text-muted-foreground">Célula (US$/mês)</dt>
        <dd className="mt-1 font-semibold tabular-nums">{usdText(cell.usd)}</dd>
      </div>
      <div className="rounded-lg border p-3">
        <dt className="text-xs text-muted-foreground">Célula com a folga (R$/mês)</dt>
        <dd className="mt-1 font-semibold tabular-nums">
          {cell.brlCents === undefined ? '—' : formatCents(cell.brlCents)}
        </dd>
      </div>
      <div className="rounded-lg border p-3">
        <dt className="text-xs text-muted-foreground">Rateio por GB/dia contratado (R$/mês)</dt>
        <dd className="mt-1 font-semibold tabular-nums">
          {cell.brlCentsPerGbDay === undefined ? '—' : formatCents(cell.brlCentsPerGbDay)}
        </dd>
        <dd className="mt-1 text-xs text-muted-foreground">
          Sem a ingestão nem o custo fixo de cada cliente.
        </dd>
      </div>
    </dl>
  );
}

/** O custo do nó dedicado de cada porte, recalculado a cada tecla. */
function NodeCostPreview() {
  const rows = nodeCostBySize(useDraftValue());
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="px-3 pt-2 text-left text-sm font-medium">
          Custo do nó dedicado por porte, sem a ingestão (calculado na hora)
        </caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Porte
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              US$/mês
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              R$/mês com a folga (custo da DRE)
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row) => (
            <tr key={row.size} className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                {row.size}
              </th>
              <td className="px-3 py-2 text-right">{usdText(row.usd)}</td>
              <td className="px-3 py-2 text-right">
                {row.brlCents === undefined ? '—' : formatCents(row.brlCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * O total dos custos fixos e o rateio, na hora. O rascunho pode vir de um arquivo importado com a forma errada (um
 * item nulo, a lista como objeto): a prévia só soma os itens que são objetos com valor numérico, e o problema aparece
 * no campo (`shape.ts`), em vez de derrubar a tela.
 */
function FixedCostPreview() {
  const draft = useDraftValue();
  const items = recordsAt(draft, ['fixedCosts', 'items']);
  const customers = getAt(draft, ['fixedCosts', 'allocationCustomers']);
  const total = items.reduce(
    (sum, item) => sum + (typeof item['monthly'] === 'number' ? item['monthly'] : 0),
    0,
  );
  return (
    <p className="text-sm text-muted-foreground tabular-nums">
      Total: {formatCents(total)} por mês
      {typeof customers === 'number' &&
        customers > 0 &&
        ` · ${formatCents(Math.round(total / customers))} por cliente`}
    </p>
  );
}

/** As alíquotas do rascunho que têm identificador viram as opções da padrão (item sem forma de objeto fica de fora). */
function TaxDefault() {
  const draft = useDraftValue();
  const options = recordsAt(draft, ['taxes', 'rates']).flatMap((rate) => {
    const id = rate['id'];
    const label = rate['label'];
    return typeof id === 'string'
      ? [{ value: id, label: typeof label === 'string' ? `${label} (${id})` : id }]
      : [];
  });
  return (
    <SelectField
      path={['taxes', 'defaultRateId']}
      label="Alíquota padrão"
      options={options}
      hint="A da checagem de publicação e a do simulador quando ele não pede outra."
    />
  );
}

/**
 * O modelo de custos inteiro, seção por seção (modelo por GB/dia): câmbio, a célula compartilhada da Plataforma (com a
 * capacidade em GB/dia), o nó dedicado por porte, a ingestão por GB/dia, tarifas, impostos, as horas de suporte por
 * plano, custos fixos, metas de margem e as fontes. Dólar onde a nuvem cobra em dólar; reais e percentuais no resto.
 */
export function CostModelForm() {
  return (
    <div className="space-y-6">
      <Section title="Câmbio e folga" path={['exchange']}>
        <Grid>
          <NumberField path={['exchange', 'brlPerUsd']} label="Câmbio (R$ por US$)" kind="decimal" />
          <TextField path={['exchange', 'quotedOn']} label="Data da cotação" type="date" />
          <NumberField
            path={['exchange', 'cloudBuffer']}
            label="Folga sobre a nuvem (%)"
            kind="percent"
            hint="Impostos, IOF e variação do câmbio sobre a fatura da nuvem."
          />
        </Grid>
      </Section>

      <Section
        title="Célula compartilhada (Plataforma)"
        description="A máquina com vários clientes da Plataforma, em dólares por mês a preço de lista, e quantos GB/dia ela comporta. O custo entra na DRE rateado pelo GB/dia contratado (custo ÷ capacidade), mais o custo fixo de cada cliente nela."
        path={['infrastructure', 'sharedCell']}
      >
        <Grid>
          <NumberField
            path={['infrastructure', 'sharedCell', 'vmUsdPerMonth']}
            label="VM da célula (US$/mês)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'sharedCell', 'diskGb']}
            label="Disco da célula (GB)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'sharedCell', 'snapshotGib']}
            label="Snapshots da célula (GiB)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'sharedCell', 'capacityGbDay']}
            label="Capacidade da célula (GB/dia)"
            kind="integer"
            hint="Quanto volume a máquina comporta: confirme com um teste de carga."
          />
          <NumberField
            path={['infrastructure', 'sharedCell', 'perCustomerUsdPerMonth']}
            label="Custo fixo de cada cliente na célula (US$/mês)"
            kind="decimal"
            hint="O que um cliente custa na célula independentemente do volume."
          />
        </Grid>
        <CellCostPreview />
      </Section>

      <Section
        title="Infraestrutura (nó dedicado e itens comuns)"
        description="Custos da nuvem em dólares por mês, a preço de lista. O nó de cada porte é o do Dedicado e do vCISO; cada porte usado na tabela de preços precisa estar aqui. Disco, snapshot, NAT e outros valem também para a célula."
        path={['infrastructure']}
      >
        <div className="space-y-3">
          {SIZES.map((size) => (
            <SizeCosts key={size} size={size} />
          ))}
        </div>
        <Grid>
          <NumberField
            path={['infrastructure', 'diskUsdPerGibMonth']}
            label="Disco (US$ por GiB/mês)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'snapshotUsdPerGibMonth']}
            label="Snapshot (US$ por GiB/mês)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'natUsdPerVmMonth']}
            label="NAT por VM (US$/mês)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'natIpUsdPerMonth']}
            label="IP do NAT (US$/mês)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'otherUsdPerNodeMonth']}
            label="Outros por nó (US$/mês)"
            kind="decimal"
            hint="Segredos, backup, saída, logs de fluxo e registro."
          />
          <NumberField
            path={['infrastructure', 'ingestionUsdPerGbDay']}
            label="Ingestão (US$ por GB/dia, por mês)"
            kind="decimal"
            hint="Publicação, entrega e retenção no tópico de um GB por dia durante o mês."
          />
        </Grid>
        <NodeCostPreview />
      </Section>

      <Section title="Meio de pagamento" path={['paymentFees']}>
        <Grid>
          <NumberField path={['paymentFees', 'card', 'rate']} label="Cartão (%)" kind="percent" />
          <NumberField path={['paymentFees', 'card', 'fixed']} label="Cartão, valor fixo (R$)" kind="money" />
          <NumberField path={['paymentFees', 'boleto', 'fixed']} label="Boleto pago (R$)" kind="money" />
          <NumberField
            path={['paymentFees', 'billingRate']}
            label="Cobrança recorrente (%)"
            kind="percent"
            hint="Sobre o valor faturado em assinatura."
          />
        </Grid>
      </Section>

      <Section title="Impostos e reserva" path={['taxes']}>
        <ListEditor
          path={['taxes', 'rates']}
          itemLabel="Alíquota"
          addLabel="Acrescentar alíquota"
          newItem={() => ({})}
        >
          {(index) => (
            <Grid>
              <TextField
                path={['taxes', 'rates', index, 'id']}
                label="Identificador"
                mono
                hint="Minúsculas, números e _ (ex.: anexo_iii)."
              />
              <TextField path={['taxes', 'rates', index, 'label']} label="Nome" />
              <NumberField path={['taxes', 'rates', index, 'rate']} label="Alíquota (%)" kind="percent" />
            </Grid>
          )}
        </ListEditor>
        <Grid>
          <TaxDefault />
          <NumberField
            path={['refundReserveRate']}
            label="Reserva para reembolso e contestação (%)"
            kind="percent"
            hint="Sobre a receita bruta."
          />
        </Grid>
      </Section>

      <Section title="Suporte" path={['support']}>
        <Grid>
          <NumberField path={['support', 'hourlyCost']} label="Custo da hora (R$)" kind="money" />
          <NumberField
            path={['support', 'hours', 'plataforma']}
            label="Plataforma (h/mês por cliente)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'dedicado']}
            label="Dedicado (h/mês por cliente)"
            kind="decimal"
            hint="Também a base do vCISO."
          />
          <NumberField
            path={['support', 'hours', 'vcisoService']}
            label="Serviço do vCISO (h/mês equivalentes)"
            kind="decimal"
            hint="A mais que o Dedicado, no vCISO."
          />
          <NumberField
            path={['support', 'hours', 'selfHosted']}
            label="A mais na infraestrutura do cliente (h/mês)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupPlataforma']}
            label="Implantação da Plataforma (h, uma vez)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupDedicado']}
            label="Implantação do Dedicado (h, uma vez)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupVciso']}
            label="Implantação do vCISO, a mais (h, uma vez)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupSelfHosted']}
            label="Implantação na infraestrutura do cliente, a mais (h)"
            kind="decimal"
          />
        </Grid>
      </Section>

      <Section title="Custos fixos" path={['fixedCosts']}>
        <ListEditor
          path={['fixedCosts', 'items']}
          itemLabel="Custo fixo"
          addLabel="Acrescentar custo fixo"
          newItem={() => ({})}
        >
          {(index) => (
            <Grid>
              <TextField path={['fixedCosts', 'items', index, 'name']} label="Nome" />
              <NumberField
                path={['fixedCosts', 'items', index, 'monthly']}
                label="Valor mensal (R$)"
                kind="money"
              />
            </Grid>
          )}
        </ListEditor>
        <Grid>
          <NumberField
            path={['fixedCosts', 'allocationCustomers']}
            label="Clientes para o rateio"
            kind="integer"
            hint="O simulador pode pedir outro número."
          />
        </Grid>
        <FixedCostPreview />
      </Section>

      <Section title="Metas de margem" path={['margins']}>
        <Grid>
          <NumberField
            path={['margins', 'minimum']}
            label="Margem mínima (%)"
            kind="percent"
            hint="Margem de contribuição sobre a receita bruta: abaixo dela, a tabela de preços não publica."
          />
          <NumberField
            path={['margins', 'alert']}
            label="Margem de alerta (%)"
            kind="percent"
            hint="Abaixo dela, a checagem avisa (não bloqueia)."
          />
          <NumberField
            path={['customerCloudEstimateSpread']}
            label="Faixa da estimativa da nuvem do cliente (± %)"
            kind="percent"
            hint="Só informativa, no simulador com o ambiente na infraestrutura do cliente."
          />
        </Grid>
      </Section>

      <Section
        title="Fontes"
        description="De onde veio cada número, com o link e a data da conferência."
        path={['sources']}
      >
        <ListEditor path={['sources']} itemLabel="Fonte" addLabel="Acrescentar fonte" newItem={() => ({})}>
          {(index) => (
            <Grid>
              <TextField path={['sources', index, 'item']} label="Item" />
              <TextField path={['sources', index, 'url']} label="Link (https)" type="url" />
              <TextField path={['sources', index, 'checkedOn']} label="Conferido em" type="date" />
            </Grid>
          )}
        </ListEditor>
      </Section>
    </div>
  );
}
