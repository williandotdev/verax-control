import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDraftValue, useField, useSetter } from '@/form/form-context';
import { Grid, ListEditor, NumberField, Section, SelectField, TextField } from '@/form/fields';
import { recordsAt } from '@/features/versions/shape';
import type { SizeId } from '@/lib/api-types';
import { formatCents } from '@/lib/numbers';
import { getAt } from '@/lib/paths';
import { nodeCostBySize } from './node-cost';

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

/** O custo do nó de cada porte, recalculado a cada tecla (a tabela da seção de custos do estudo). */
function NodeCostPreview() {
  const rows = nodeCostBySize(useDraftValue());
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="px-3 pt-2 text-left text-sm font-medium">
          Custo do nó por porte, sem volume nem agentes (calculado na hora)
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
              <td className="px-3 py-2 text-right">
                {row.usd === undefined ? '—' : row.usd.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}
              </td>
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
 * O modelo de custos inteiro, seção por seção (estudo comercial, §4.1): câmbio, nuvem por porte, tarifas, impostos,
 * suporte, custos fixos, metas de margem e as fontes. Dólar onde a nuvem cobra em dólar; reais e percentuais no resto.
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
        title="Infraestrutura do nó (gerenciado)"
        description="Custos da nuvem em dólares por mês, a preço de lista. Cada porte usado na tabela de preços precisa estar aqui."
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
            path={['infrastructure', 'ingestionUsdPerGib']}
            label="Ingestão (US$ por GiB de franquia)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'agents', 'entryUsdPerMonth']}
            label="Entrada dos agentes (US$/mês)"
            kind="decimal"
            hint="O IP fixo e a regra de encaminhamento, quando há agentes."
          />
          <NumberField
            path={['infrastructure', 'agents', 'diskBaseGb']}
            label="Disco a mais com agentes (GB)"
            kind="decimal"
          />
          <NumberField
            path={['infrastructure', 'agents', 'diskPerAgentGb']}
            label="Disco por agente (GB)"
            kind="decimal"
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
            path={['support', 'hours', 'baseManaged']}
            label="Base no gerenciado (h/mês)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'baseSelfHosted']}
            label="Base na nuvem do cliente (h/mês)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'perAdditionalAccount']}
            label="Por conta adicional (h/mês)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'perAgentPack']}
            label="Por pacote de agentes (h/mês)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'prioritySupport']}
            label="Suporte prioritário (h/mês)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupManaged']}
            label="Implantação no gerenciado (h, uma vez)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupPriorityExtra']}
            label="Implantação, a mais com prioritário (h)"
            kind="decimal"
          />
          <NumberField
            path={['support', 'hours', 'setupSelfHosted']}
            label="Implantação na nuvem do cliente (h)"
            kind="decimal"
          />
        </Grid>
        <ListEditor
          path={['support', 'hours', 'perVolumeBand']}
          itemLabel="Faixa de volume"
          addLabel="Acrescentar faixa de volume"
          newItem={() => ({})}
        >
          {(index) => (
            <Grid>
              <NumberField
                path={['support', 'hours', 'perVolumeBand', index, 'monthlyGib']}
                label="Faixa (GiB/mês)"
                kind="integer"
                hint="Uma por faixa vendida na tabela de preços."
              />
              <NumberField
                path={['support', 'hours', 'perVolumeBand', index, 'hours']}
                label="Horas a mais por mês"
                kind="decimal"
              />
            </Grid>
          )}
        </ListEditor>
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
            hint="Só informativa, no simulador do modo na nuvem do cliente."
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
