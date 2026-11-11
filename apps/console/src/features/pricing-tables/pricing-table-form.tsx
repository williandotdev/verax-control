import { fieldId, useField } from '@/form/form-context';
import { Grid, ListEditor, NumberField, type Option, Section, SelectField, TextField } from '@/form/fields';
import type { SizeId, TaxMode } from '@/lib/api-types';
import { TAX_MODE_LABELS } from '@/lib/format';
import type { Path } from '@/lib/paths';

const SIZES: readonly SizeId[] = ['P', 'M', 'G'];
const SIZE_OPTIONS: readonly Option[] = SIZES.map((size) => ({ value: size, label: `Porte ${size}` }));
const TAX_MODES: readonly TaxMode[] = ['exclusive', 'inclusive'];
const TAX_MODE_OPTIONS: readonly Option[] = TAX_MODES.map((mode) => ({
  value: mode,
  label: TAX_MODE_LABELS[mode],
}));

/** Um preço da tabela: o valor (em reais na tela, centavos na API) e o `lookup_key` do preço na Stripe. */
function PricedFields({ path, label }: { path: Path; label: string }) {
  const binding = useField(path);
  return (
    <div className="space-y-2">
      <Grid>
        <NumberField path={[...path, 'amount']} label={`${label} (R$)`} kind="money" />
        <TextField
          path={[...path, 'lookupKey']}
          label={`lookup_key (${label})`}
          mono
          hint="O do preço na Stripe (minúsculas, números e _)."
        />
      </Grid>
      {binding.issues.length > 0 && (
        <p id={fieldId(path)} tabIndex={-1} className="text-sm text-critical-text">
          {label}: {binding.issues.join(' · ')}
        </p>
      )}
    </div>
  );
}

/**
 * A tabela de preços inteira (modelo por GB/dia, 10/11/2026): como o imposto entra, a regra de porte pelo volume e os
 * três planos (a Plataforma, vendida no site, com a base, a franquia incluída, o GB/dia adicional e o excedente; o
 * Dedicado, por GB/dia com mínimo e máximo; o vCISO, o Dedicado com o serviço e a implantação). Cada preço leva o
 * `lookup_key` da Stripe, que o checkout confere.
 */
export function PricingTableForm() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Valores mensais em reais. Moeda e intervalo são fixos (BRL, mensal). O preço depende só do volume de
        logs em GB por dia: contas de nuvem não mudam o preço, e agentes não são vendidos.
      </p>

      <Section title="Imposto" path={['taxMode']}>
        <Grid>
          <SelectField
            path={['taxMode']}
            label="Como o imposto entra no preço"
            options={TAX_MODE_OPTIONS}
            hint='Por cima: o site mostra "+ impostos", e a DRE soma o imposto ao valor da tabela.'
          />
        </Grid>
      </Section>

      <Section
        title="Regra de porte"
        description="Do menor para o maior: o porte do nó é o menor que comporta o volume em GB/dia. Acima do maior, sob consulta."
        path={['sizing']}
      >
        <ListEditor
          path={['sizing', 'sizes']}
          itemLabel="Porte"
          addLabel="Acrescentar porte"
          newItem={() => ({})}
        >
          {(index) => (
            <Grid>
              <SelectField path={['sizing', 'sizes', index, 'size']} label="Porte" options={SIZE_OPTIONS} />
              <NumberField
                path={['sizing', 'sizes', index, 'maxGbDay']}
                label="Até quantos GB/dia"
                kind="integer"
              />
              <TextField
                path={['sizing', 'sizes', index, 'description']}
                label="Texto para o cliente"
                hint='Ex.: "2 vCPU e 8 GB em São Paulo".'
                className="sm:col-span-2"
              />
            </Grid>
          )}
        </ListEditor>
      </Section>

      <Section
        title="Plataforma"
        description="A célula compartilhada, vendida no checkout do site. O cliente escolhe a franquia do incluído até o máximo do site; acima, fale conosco. O uso acima da franquia é cobrado depois, como excedente."
        path={['plans', 'plataforma']}
      >
        <PricedFields path={['plans', 'plataforma', 'base']} label="Base mensal" />
        <Grid>
          <NumberField
            path={['plans', 'plataforma', 'includedGbDay']}
            label="GB/dia incluídos na base"
            kind="integer"
          />
          <NumberField
            path={['plans', 'plataforma', 'maxOnlineGbDay']}
            label="Máximo no site (GB/dia)"
            kind="integer"
          />
        </Grid>
        <PricedFields path={['plans', 'plataforma', 'additionalGbDay']} label="GB/dia adicional" />
        <PricedFields path={['plans', 'plataforma', 'overageGbDay']} label="GB/dia excedente" />
        <Grid>
          <NumberField
            path={['plans', 'plataforma', 'maxCloudAccounts']}
            label="Contas de nuvem no nó da Plataforma (teto)"
            kind="integer"
            hint="Só o limite gravado no nó: não muda o preço."
          />
        </Grid>
      </Section>

      <Section
        title="Dedicado"
        description="Servidor próprio, só por contrato direto: um preço por GB/dia, do mínimo ao máximo cotável. O mesmo preço vale na infraestrutura do cliente."
        path={['plans', 'dedicado']}
      >
        <PricedFields path={['plans', 'dedicado', 'gbDay']} label="GB/dia" />
        <Grid>
          <NumberField path={['plans', 'dedicado', 'minGbDay']} label="Mínimo (GB/dia)" kind="integer" />
          <NumberField
            path={['plans', 'dedicado', 'maxGbDay']}
            label="Máximo cotável (GB/dia)"
            kind="integer"
          />
          <NumberField
            path={['plans', 'dedicado', 'contractMonths']}
            label="Duração do contrato (meses)"
            kind="integer"
          />
          <NumberField
            path={['plans', 'dedicado', 'maxCloudAccounts']}
            label="Contas de nuvem no nó do Dedicado (teto)"
            kind="integer"
            hint="Só o limite gravado no nó: não muda o preço."
          />
        </Grid>
      </Section>

      <Section
        title="vCISO"
        description="O Dedicado (o mesmo preço por GB/dia, mínimo e máximo) mais o serviço mensal e a implantação, cobrada uma vez. Só por contrato direto."
        path={['plans', 'vciso']}
      >
        <PricedFields path={['plans', 'vciso', 'service']} label="Serviço mensal" />
        <PricedFields path={['plans', 'vciso', 'setup']} label="Implantação (uma vez)" />
      </Section>

      <Section title="Histórico e usuários">
        <Grid>
          <NumberField path={['history', 'includedDays']} label="Dias de histórico" kind="integer" />
          <NumberField path={['users', 'max']} label="Usuários (máximo, em qualquer plano)" kind="integer" />
        </Grid>
      </Section>
    </div>
  );
}
