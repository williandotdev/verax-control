import { useState } from 'react';
import { fieldId, useField, useSetter } from '@/form/form-context';
import { Grid, ListEditor, NumberField, type Option, Section, SelectField, TextField } from '@/form/fields';
import type { DeploymentMode, SizeId } from '@/lib/api-types';
import { MODE_LABELS, SUPPORT_LABELS } from '@/lib/format';
import type { Path } from '@/lib/paths';

const SIZES: readonly SizeId[] = ['P', 'M', 'G'];
const MODES: readonly DeploymentMode[] = ['managed', 'self_hosted'];
const SIZE_OPTIONS: readonly Option[] = SIZES.map((size) => ({ value: size, label: `Porte ${size}` }));
const MODE_OPTIONS: readonly Option[] = MODES.map((mode) => ({ value: mode, label: MODE_LABELS[mode] }));
const SUPPORT_OPTIONS: readonly Option[] = (['standard', 'priority'] as const).map((level) => ({
  value: level,
  label: SUPPORT_LABELS[level],
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

/** A implantação de um modo é opcional: sem ela, o modo não cobra nada uma vez. */
function SetupFields({ mode }: { mode: DeploymentMode }) {
  const path = ['modes', mode, 'setup'] as const;
  const binding = useField(path);
  const setter = useSetter();
  const [open, setOpen] = useState(binding.value !== undefined);
  const charged = binding.value !== undefined || open;
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={charged}
          disabled={binding.readOnly}
          onChange={(event) => {
            setOpen(event.target.checked);
            if (!event.target.checked) setter(path, undefined);
          }}
        />
        Cobra implantação neste modo (uma vez, na primeira fatura)
      </label>
      {charged && <PricedFields path={path} label="Implantação" />}
    </div>
  );
}

/**
 * A tabela de preços inteira (estudo comercial, §4.1): a regra de porte, o ambiente de cada modo e porte, os
 * componentes com a quantidade incluída, o máximo e o preço, e os pacotes de partida do site. Cada preço leva o
 * `lookup_key` da Stripe, que o checkout confere.
 */
export function PricingTableForm() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Valores mensais em reais, com o imposto embutido. Moeda e intervalo são fixos (BRL, mensal).
      </p>

      <Section
        title="Regra de porte"
        description="Do menor para o maior: o porte é o menor que comporta as contas, o volume e os agentes ao mesmo tempo. Acima do maior, sob consulta."
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
                path={['sizing', 'sizes', index, 'maxCloudAccounts']}
                label="Até quantas contas"
                kind="integer"
              />
              <NumberField
                path={['sizing', 'sizes', index, 'maxMonthlyGib']}
                label="Até quantos GiB/mês"
                kind="integer"
              />
              <NumberField
                path={['sizing', 'sizes', index, 'maxAgents']}
                label="Até quantos agentes"
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

      {MODES.map((mode) => (
        <Section
          key={mode}
          title={mode === 'managed' ? 'Ambiente gerenciado' : 'Licença na nuvem do cliente'}
          description={`${MODE_LABELS[mode]}: um preço por porte da regra.`}
          path={['modes', mode]}
        >
          {SIZES.map((size) => (
            <PricedFields
              key={size}
              path={['modes', mode, 'environment', size]}
              label={`${mode === 'managed' ? 'Ambiente' : 'Licença'} porte ${size}`}
            />
          ))}
          <SetupFields mode={mode} />
        </Section>
      ))}

      <Section title="Contas de nuvem" path={['cloudAccounts']}>
        <Grid>
          <NumberField path={['cloudAccounts', 'included']} label="Contas incluídas" kind="integer" />
          <NumberField path={['cloudAccounts', 'max']} label="Máximo vendido" kind="integer" />
        </Grid>
        <PricedFields path={['cloudAccounts', 'additional']} label="Conta adicional" />
      </Section>

      <Section title="Volume de logs" path={['volume']}>
        <Grid>
          <NumberField
            path={['volume', 'includedMonthlyGib']}
            label="Franquia incluída (GiB/mês)"
            kind="integer"
          />
        </Grid>
        <ListEditor
          path={['volume', 'bands']}
          itemLabel="Faixa"
          addLabel="Acrescentar faixa"
          newItem={() => ({})}
        >
          {(index) => (
            <Grid>
              <NumberField
                path={['volume', 'bands', index, 'monthlyGib']}
                label="Até (GiB/mês)"
                kind="integer"
              />
              <NumberField
                path={['volume', 'bands', index, 'amount']}
                label="Preço da faixa (R$)"
                kind="money"
              />
              <TextField path={['volume', 'bands', index, 'lookupKey']} label="lookup_key da faixa" mono />
            </Grid>
          )}
        </ListEditor>
      </Section>

      <Section title="Agentes nas instâncias" path={['agents']}>
        <Grid>
          <NumberField path={['agents', 'packSize']} label="Agentes por pacote" kind="integer" />
          <NumberField path={['agents', 'maxPacks']} label="Máximo de pacotes" kind="integer" />
        </Grid>
        <PricedFields path={['agents', 'pack']} label="Pacote de agentes" />
      </Section>

      <Section title="Histórico" path={['history']}>
        <Grid>
          <NumberField path={['history', 'includedDays']} label="Dias incluídos" kind="integer" />
        </Grid>
        <ListEditor
          path={['history', 'extended']}
          itemLabel="Opção de histórico"
          addLabel="Acrescentar opção"
          newItem={() => ({})}
        >
          {(index) => (
            <Grid>
              <NumberField path={['history', 'extended', index, 'days']} label="Dias" kind="integer" />
              <NumberField path={['history', 'extended', index, 'amount']} label="Preço (R$)" kind="money" />
              <TextField
                path={['history', 'extended', index, 'lookupKey']}
                label="lookup_key da opção"
                mono
              />
            </Grid>
          )}
        </ListEditor>
      </Section>

      <Section title="Suporte e usuários">
        <PricedFields path={['prioritySupport']} label="Suporte prioritário" />
        <Grid>
          <NumberField
            path={['users', 'max']}
            label="Usuários (máximo, em qualquer configuração)"
            kind="integer"
          />
        </Grid>
      </Section>

      <Section
        title="Pacotes de partida"
        description="Os atalhos da calculadora do site: cada um preenche as seis respostas. Precisa cotar (não pode cair em sob consulta)."
        path={['presets']}
      >
        <ListEditor path={['presets']} itemLabel="Pacote" addLabel="Acrescentar pacote" newItem={() => ({})}>
          {(index) => (
            <Grid>
              <TextField
                path={['presets', index, 'id']}
                label="Identificador"
                mono
                hint="Minúsculas, números e traço."
              />
              <TextField path={['presets', index, 'label']} label="Nome no site" />
              <SelectField
                path={['presets', index, 'configuration', 'mode']}
                label="Onde roda"
                options={MODE_OPTIONS}
              />
              <NumberField
                path={['presets', index, 'configuration', 'cloudAccounts']}
                label="Contas de nuvem"
                kind="integer"
              />
              <NumberField
                path={['presets', index, 'configuration', 'monthlyGib']}
                label="Volume (GiB/mês)"
                kind="integer"
              />
              <NumberField
                path={['presets', index, 'configuration', 'agents']}
                label="Agentes"
                kind="integer"
              />
              <NumberField
                path={['presets', index, 'configuration', 'historyDays']}
                label="Histórico (dias)"
                kind="integer"
              />
              <SelectField
                path={['presets', index, 'configuration', 'support']}
                label="Suporte"
                options={SUPPORT_OPTIONS}
              />
            </Grid>
          )}
        </ListEditor>
      </Section>
    </div>
  );
}
