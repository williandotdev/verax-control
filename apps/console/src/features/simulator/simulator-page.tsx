import { Calculator } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useVersion, useVersions } from '@/features/versions/queries';
import { DraftForm } from '@/form/draft-form';
import { ErrorSummary } from '@/form/error-summary';
import { Grid, NumberField, type Option, Section, SelectField } from '@/form/fields';
import { ApiError, api } from '@/lib/api';
import type {
  ConfigurationInput,
  PlanId,
  PriceTable,
  SimulationRequest,
  SimulationResult,
  ValidationIssue,
  VersionSummary,
} from '@/lib/api-types';
import { CONTACT_REASON_LABELS, MODE_LABELS, PLAN_LABELS, PLANS, STATUS_LABELS } from '@/lib/format';
import { formatInteger, formatRatio } from '@/lib/numbers';
import { DreStatement } from './dre-statement';

const MODE_OPTIONS: readonly Option[] = (['managed', 'self_hosted'] as const).map((mode) => ({
  value: mode,
  label: MODE_LABELS[mode],
}));
const PLAN_OPTIONS: readonly Option[] = PLANS.map((plan) => ({ value: plan, label: PLAN_LABELS[plan] }));
const PAYMENT_OPTIONS: readonly Option[] = [
  { value: 'card', label: 'Cartão' },
  { value: 'boleto', label: 'Boleto' },
];

function versionOptions(list: readonly VersionSummary[] | undefined): Option[] {
  return (list ?? [])
    .filter((entry) => entry.legacy !== true)
    .map((entry) => ({
      value: entry.version,
      label: `${entry.version} (${STATUS_LABELS[entry.status].toLowerCase()}${entry.current ? ', vigente' : ''})`,
    }));
}

/** A configuração mínima da tabela (a do "a partir de"): a Plataforma no volume incluído, na Verax. */
function minimalConfiguration(table: PriceTable): ConfigurationInput {
  return { plan: 'plataforma', gbDay: table.plans.plataforma.includedGbDay, mode: 'managed' };
}

/** O que o plano cota, para a dica do volume. */
function gbDayHint(table: PriceTable, plan: PlanId | undefined): string {
  const { plataforma, dedicado } = table.plans;
  if (plan === 'plataforma') {
    return `${formatInteger(plataforma.includedGbDay)} GB/dia incluídos, até ${formatInteger(plataforma.maxOnlineGbDay)} no site.`;
  }
  return `De ${formatInteger(dedicado.minGbDay)} a ${formatInteger(dedicado.maxGbDay)} GB/dia (abaixo do mínimo, sobe até ele).`;
}

/**
 * O simulador de DRE: o plano, o volume em GB/dia e onde roda, o meio de pagamento, a alíquota, o desconto e o rateio,
 * com a tabela de preços e o modelo de custos vigentes ou qualquer versão (rascunho também). A API cota e monta a DRE;
 * os números ficam só na tela.
 */
export function SimulatorPage() {
  const tables = useVersions('pricing-tables');
  const models = useVersions('cost-models');
  const [request, setRequest] = useState<unknown>({
    configuration: { plan: 'plataforma', mode: 'managed' },
    paymentMethod: 'card',
  });
  const chosen = request as Partial<SimulationRequest>;
  const tableVersion = chosen.priceTableVersion ?? tables.data?.find((entry) => entry.current)?.version;
  const modelVersion = chosen.costModelVersion ?? models.data?.find((entry) => entry.current)?.version;
  const table = useVersion('pricing-tables', tableVersion);
  const model = useVersion('cost-models', modelVersion);
  const tableContent = table.data?.content;
  const modelContent = model.data?.content;

  // A primeira tabela carregada preenche as respostas que faltam com a configuração mínima dela.
  const [filledFrom, setFilledFrom] = useState<string | undefined>(undefined);
  if (tableContent !== undefined && table.data !== undefined && filledFrom === undefined) {
    setFilledFrom(table.data.version);
    setRequest({
      ...chosen,
      configuration: { ...minimalConfiguration(tableContent), ...chosen.configuration },
    });
  }

  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [result, setResult] = useState<SimulationResult | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);

  async function simulate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.simulate(request as SimulationRequest));
      setIssues([]);
    } catch (caught) {
      setResult(undefined);
      if (caught instanceof ApiError && caught.issues.length > 0) setIssues(caught.issues);
      else {
        setIssues([]);
        setError(caught);
      }
    } finally {
      setBusy(false);
    }
  }

  const taxOptions = (modelContent?.taxes.rates ?? []).map((rate) => ({
    value: rate.id,
    label: `${rate.label} (${formatRatio(rate.rate)})`,
  }));
  const defaultTax = modelContent?.taxes.rates.find((rate) => rate.id === modelContent.taxes.defaultRateId);

  return (
    <div className="space-y-6">
      <header className="max-w-3xl space-y-1">
        <h1 className="text-2xl font-semibold">Simulador de DRE</h1>
        <p className="text-sm text-muted-foreground">
          A DRE por cliente e por mês de uma configuração: receita bruta, deduções, custos variáveis, margem
          de contribuição, custos fixos rateados e resultado. Os números vêm da tabela de preços e do modelo
          de custos escolhidos, e não são gravados.
        </p>
      </header>

      {(tables.isError || models.isError) && <ErrorState error={tables.error ?? models.error} />}

      <ErrorSummary issues={issues} title="A API recusou a simulação." />

      <DraftForm value={request} onChange={setRequest} issues={issues} readOnly={false}>
        <Section title="Tabela e modelo">
          <Grid>
            <SelectField
              path={['priceTableVersion']}
              label="Tabela de preços"
              options={versionOptions(tables.data)}
              placeholder={
                tables.data?.some((entry) => entry.current) ? 'A vigente' : 'Nenhuma vigente: escolha'
              }
            />
            <SelectField
              path={['costModelVersion']}
              label="Modelo de custos"
              options={versionOptions(models.data)}
              placeholder={
                models.data?.some((entry) => entry.current) ? 'O vigente' : 'Nenhum vigente: escolha'
              }
            />
          </Grid>
        </Section>

        <Section
          title="Configuração"
          description="O plano e o volume em GB/dia: abaixo do mínimo do plano, o volume sobe até ele; acima do máximo, sob consulta. Na infraestrutura do cliente, só o Dedicado e o vCISO (o mesmo preço, sem a nuvem da Verax)."
          path={['configuration']}
        >
          <Grid>
            <SelectField path={['configuration', 'plan']} label="Plano" options={PLAN_OPTIONS} />
            <NumberField
              path={['configuration', 'gbDay']}
              label="Volume de logs (GB/dia)"
              kind="integer"
              {...(tableContent === undefined
                ? {}
                : { hint: gbDayHint(tableContent, chosen.configuration?.plan) })}
            />
            <SelectField path={['configuration', 'mode']} label="Onde roda" options={MODE_OPTIONS} />
          </Grid>
        </Section>

        <Section title="Cobrança e rateio">
          <Grid>
            <SelectField path={['paymentMethod']} label="Meio de pagamento" options={PAYMENT_OPTIONS} />
            <SelectField
              path={['taxRateId']}
              label="Alíquota"
              options={taxOptions}
              placeholder={defaultTax === undefined ? 'A padrão do modelo' : `A padrão: ${defaultTax.label}`}
            />
            <NumberField
              path={['discountRate']}
              label="Desconto nos itens mensais (%)"
              kind="percent"
              hint="Um cupom; a implantação não tem desconto. Vazio: sem desconto."
            />
            <NumberField
              path={['allocationCustomers']}
              label="Clientes para o rateio dos fixos"
              kind="integer"
              hint={
                modelContent === undefined
                  ? 'Vazio: o do modelo.'
                  : `Vazio: o do modelo (${formatInteger(modelContent.fixedCosts.allocationCustomers)}).`
              }
            />
          </Grid>
        </Section>
      </DraftForm>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void simulate()} disabled={busy}>
          <Calculator aria-hidden />
          {busy ? 'Simulando…' : 'Simular'}
        </Button>
      </div>

      {error !== undefined && <ErrorState error={error} />}
      <div aria-live="polite">
        {result?.contactUs === true && (
          <section className="rounded-xl border bg-surface p-4">
            <h2 className="text-base font-semibold">Sob consulta</h2>
            <p className="text-sm">
              Esta configuração não tem preço na hora: {CONTACT_REASON_LABELS[result.reason]}. No site, ela
              leva ao contato (tabela {result.priceTableVersion}).
            </p>
          </section>
        )}
        {result?.contactUs === false && <DreStatement simulation={result} />}
      </div>
    </div>
  );
}
