import { Calculator, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useCurrentVersion } from '@/features/versions/queries';
import { DraftForm } from '@/form/draft-form';
import { ErrorSummary } from '@/form/error-summary';
import {
  Grid,
  NumberField,
  type Option,
  RadioField,
  type RadioOption,
  Section,
  SelectField,
  TextField,
} from '@/form/fields';
import { ApiError, tenantsApi } from '@/lib/api';
import type {
  DirectConfiguration,
  DirectTenantPreview,
  DirectTenantRequest,
  Hosting,
  PriceTable,
  ValidationIssue,
} from '@/lib/api-types';
import { CONTACT_REASON_LABELS, configurationSummary, SUPPORT_LABELS } from '@/lib/format';
import { formatCents, formatInteger } from '@/lib/numbers';
import { newUlid } from '@/lib/ulid';
import { ConfirmBySlug } from './confirm-by-slug';
import { HOSTING_LABELS, PROBLEM_LABELS } from './labels';
import { useInvalidateTenants } from './queries';
import { QuoteSummary } from './quote-summary';

const SUPPORT_OPTIONS: readonly Option[] = (['standard', 'priority'] as const).map((level) => ({
  value: level,
  label: SUPPORT_LABELS[level],
}));

/** Onde o ambiente roda: escolha obrigatória, sem nenhuma marcada de início (cada uma tem consequências diferentes). */
const HOSTING_OPTIONS: readonly RadioOption[] = [
  {
    value: 'verax',
    label: HOSTING_LABELS.verax,
    description:
      'O ambiente sobe pelos mesmos passos de uma compra no site, com o nó e o painel na infraestrutura da Verax (tem custo de nuvem). A cotação usa a tabela do ambiente gerenciado.',
  },
  {
    value: 'customer',
    label: HOSTING_LABELS.customer,
    description:
      'Nada é criado na infraestrutura da Verax: o cliente instala a versão publicada com o guia, e apaga o próprio ambiente no fim do contrato. A cotação usa a tabela da licença.',
  },
];

const HOSTING_REQUIRED: ValidationIssue = {
  path: 'hosting',
  message: 'Escolha onde o ambiente roda: na infraestrutura da Verax ou na do cliente.',
};

/** O formulário como documento (os campos do cadastro, onde roda e as outras cinco respostas), antes de ir à API. */
type Draft = Partial<Omit<DirectTenantRequest, 'configuration'>> & {
  configuration?: Partial<DirectConfiguration>;
};

/** A configuração mínima da tabela vigente: o ponto de partida das respostas (o "a partir de"). */
function minimalConfiguration(table: PriceTable): DirectConfiguration {
  return {
    cloudAccounts: table.cloudAccounts.included,
    monthlyGib: table.volume.includedMonthlyGib,
    agents: 0,
    historyDays: table.history.includedDays,
    support: 'standard',
  };
}

function list(values: readonly number[]): string {
  return values.map((value) => formatInteger(value)).join(', ');
}

function isHosting(value: unknown): value is Hosting {
  return value === 'verax' || value === 'customer';
}

/** O que ficou de um envio com problemas por campo: os problemas; senão, o erro para mostrar. */
function splitError(caught: unknown): { issues: readonly ValidationIssue[]; error?: unknown } {
  if (caught instanceof ApiError && caught.issues.length > 0) return { issues: caught.issues };
  return { issues: [], error: caught };
}

/**
 * O cadastro de um cliente de contrato direto (negociado com a Verax, sem o checkout do site e sem a Stripe): a
 * empresa, o administrador, o subdomínio, onde o ambiente roda (escolha obrigatória) e as outras cinco respostas da
 * calculadora; a cotação de referência pela tabela vigente, no modo do lugar escolhido; e a confirmação com o
 * subdomínio digitado. A API confere tudo de novo e cria o cliente. Na infraestrutura da Verax, pede ao cp-worker o
 * início do provisionamento, que segue os mesmos passos de uma compra paga; na do cliente, nada é provisionado, e o
 * detalhe mostra o que mandar a ele para instalar.
 *
 * A chave de idempotência nasce com o formulário: o mesmo envio repetido (clique duplo, resposta que se perdeu) cria um
 * cliente só.
 */
export function NewTenantPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidateTenants();
  const table = useCurrentVersion('pricing-tables');
  const tableContent = table.record.data?.content;
  const [idempotencyKey] = useState(newUlid);
  const [draft, setDraft] = useState<unknown>({ configuration: { support: 'standard' } });
  const value = draft as Draft;
  const hosting = isHosting(value.hosting) ? value.hosting : undefined;

  // A tabela vigente carregada preenche as respostas que faltam com a configuração mínima dela.
  const [filled, setFilled] = useState(false);
  if (tableContent !== undefined && !filled) {
    setFilled(true);
    setDraft({ ...value, configuration: { ...minimalConfiguration(tableContent), ...value.configuration } });
  }

  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [preview, setPreview] = useState<{ result: DirectTenantPreview; for: string } | undefined>(undefined);
  const [previewError, setPreviewError] = useState<unknown>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(undefined);

  // A cotação vale para o lugar e as respostas com que foi calculada: mudar qualquer um pede outra.
  const previewKey = JSON.stringify({
    hosting: value.hosting ?? null,
    configuration: value.configuration ?? {},
  });
  const currentPreview = preview?.for === previewKey ? preview.result : undefined;
  const provisionable = currentPreview?.contactUs === false && currentPreview.problems.length === 0;

  async function calculate(): Promise<void> {
    if (hosting === undefined) {
      setIssues([HOSTING_REQUIRED]);
      return;
    }
    setPreviewing(true);
    setPreviewError(undefined);
    try {
      const result = await tenantsApi.preview(hosting, value.configuration as DirectConfiguration);
      setPreview({ result, for: previewKey });
      setIssues((current) =>
        current.filter((issue) => !issue.path.startsWith('configuration') && issue.path !== 'hosting'),
      );
    } catch (caught) {
      setPreview(undefined);
      const split = splitError(caught);
      setIssues(split.issues);
      setPreviewError(split.error);
    } finally {
      setPreviewing(false);
    }
  }

  async function create(confirmSlug: string): Promise<void> {
    if (creating) return;
    setCreating(true);
    setCreateError(undefined);
    try {
      const created = await tenantsApi.create({
        ...(value as DirectTenantRequest),
        idempotencyKey,
        confirmSlug,
      });
      await invalidate(created.id);
      void navigate(`/clientes/${created.id}`, { state: { created } });
    } catch (caught) {
      const split = splitError(caught);
      setIssues(split.issues);
      setCreateError(split.error);
      setConfirming(false);
    } finally {
      setCreating(false);
    }
  }

  const slug = typeof value.slug === 'string' ? value.slug : '';
  const customer = hosting === 'customer';
  return (
    <div className="space-y-6">
      <header className="max-w-3xl space-y-1">
        <p className="text-sm">
          <Link to="/clientes" className="text-primary underline-offset-2 hover:underline">
            Clientes
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Novo cliente (contrato direto)</h1>
        <p className="text-sm text-muted-foreground">
          Para um contrato negociado direto com a Verax, sem checkout e sem cobrança pela Stripe (a cobrança é
          a do contrato). Você escolhe onde o ambiente roda: na infraestrutura da Verax, ele sobe pelos mesmos
          passos de uma compra no site; na do cliente, nada é criado aqui, e o detalhe mostra a versão e o
          guia para enviar a ele. A cotação abaixo é a referência da tabela vigente.
        </p>
      </header>

      {table.list.isError && <ErrorState error={table.list.error} />}
      {table.list.data !== undefined && table.version === undefined && (
        <p role="status" className="text-sm font-medium">
          Nenhuma tabela de preços vigente: publique uma antes de cadastrar um cliente.
        </p>
      )}

      <ErrorSummary issues={issues} title="A API recusou o cadastro." />

      <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={confirming || creating}>
        <Section title="Empresa e administrador">
          <Grid>
            <TextField path={['companyName']} label="Razão social" />
            <TextField
              path={['cnpj']}
              label="CNPJ"
              hint="Com ou sem a máscara; o formato alfanumérico também vale."
            />
            <TextField
              path={['adminEmail']}
              label="E-mail do administrador do cliente"
              hint="O primeiro acesso ao painel. Na infraestrutura da Verax, recebe o e-mail “ambiente pronto” com o link para ver a senha; na do cliente, é o administrador que a instalação cria."
            />
            <TextField
              path={['slug']}
              label="Subdomínio"
              mono
              hint="3 a 16 caracteres: minúsculas, números e hífen, começando por letra. Na infraestrutura da Verax, é o endereço do painel; na do cliente, identifica o cliente aqui."
            />
          </Grid>
        </Section>

        <RadioField
          path={['hosting']}
          label="Onde o ambiente roda"
          hint="Escolha obrigatória. Pelo site, todo cliente roda na infraestrutura da Verax; a do cliente é só por contrato direto."
          options={HOSTING_OPTIONS}
        />

        <Section
          title="Configuração (as outras cinco respostas)"
          description="As mesmas perguntas da calculadora do site. Cada resposta sobe até a opção que a tabela vende."
          path={['configuration']}
        >
          <Grid>
            <NumberField
              path={['configuration', 'cloudAccounts']}
              label="Contas de nuvem"
              kind="integer"
              {...(tableContent === undefined
                ? {}
                : {
                    hint: `${formatInteger(tableContent.cloudAccounts.included)} incluídas, até ${formatInteger(tableContent.cloudAccounts.max)}.`,
                  })}
            />
            <NumberField
              path={['configuration', 'monthlyGib']}
              label="Volume de logs (GiB/mês)"
              kind="integer"
              {...(tableContent === undefined
                ? {}
                : {
                    hint: `Opções: ${list([tableContent.volume.includedMonthlyGib, ...tableContent.volume.bands.map((band) => band.monthlyGib)])}.`,
                  })}
            />
            <NumberField
              path={['configuration', 'agents']}
              label="Agentes nas instâncias"
              kind="integer"
              hint="Na infraestrutura da Verax, ainda não provisionados: deixe 0."
            />
            <NumberField
              path={['configuration', 'historyDays']}
              label="Histórico (dias)"
              kind="integer"
              {...(tableContent === undefined
                ? {}
                : {
                    hint: `Opções: ${list([tableContent.history.includedDays, ...tableContent.history.extended.map((option) => option.days)])}.`,
                  })}
            />
            <SelectField path={['configuration', 'support']} label="Suporte" options={SUPPORT_OPTIONS} />
          </Grid>
        </Section>
      </DraftForm>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => void calculate()} disabled={previewing || confirming}>
          <Calculator aria-hidden />
          {previewing ? 'Calculando…' : 'Calcular a cotação'}
        </Button>
        <Button onClick={() => setConfirming(true)} disabled={!provisionable || confirming || creating}>
          <ShieldCheck aria-hidden />
          Revisar e confirmar…
        </Button>
        {!provisionable && (
          <span className="text-sm text-muted-foreground">
            {preview !== undefined && currentPreview === undefined
              ? 'A configuração mudou: calcule a cotação de novo.'
              : 'Calcule a cotação para revisar e confirmar.'}
          </span>
        )}
      </div>

      {previewError !== undefined && <ErrorState error={previewError} />}
      <div aria-live="polite" className="space-y-3">
        {currentPreview?.contactUs === true && (
          <section className="rounded-xl border bg-surface p-4">
            <h2 className="text-base font-semibold">Acima do que a tabela vende</h2>
            <p className="text-sm">
              {CONTACT_REASON_LABELS[currentPreview.reason]} (tabela {currentPreview.priceTableVersion}). O
              cadastro só aceita o que a tabela vende.
            </p>
          </section>
        )}
        {currentPreview?.contactUs === false && (
          <QuoteSummary quote={currentPreview.quote} priceTableVersion={currentPreview.priceTableVersion}>
            {currentPreview.problems.length > 0 && (
              <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
                <p className="font-medium">
                  {customer
                    ? 'O nó do cliente não aceita esta configuração:'
                    : 'O provisionamento ainda não cria esta configuração:'}
                </p>
                <ul className="list-disc pl-5">
                  {currentPreview.problems.map((problem) => (
                    <li key={problem}>{PROBLEM_LABELS[problem]}.</li>
                  ))}
                </ul>
              </div>
            )}
          </QuoteSummary>
        )}
      </div>

      {confirming && currentPreview?.contactUs === false && hosting !== undefined && (
        <section aria-labelledby="confirmar-cadastro" className="space-y-3 rounded-xl border bg-surface p-4">
          <h2 id="confirmar-cadastro" className="text-base font-semibold">
            Confirmar o cadastro
          </h2>
          <ConfirmBySlug
            slug={slug}
            actionLabel={customer ? 'Criar o cliente' : 'Criar e provisionar'}
            busyLabel="Criando…"
            busy={creating}
            onConfirm={(typed) => void create(typed)}
            onCancel={() => setConfirming(false)}
          >
            <dl className="grid gap-2 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Cliente</dt>
                <dd>
                  {value.companyName} · CNPJ {value.cnpj}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Administrador</dt>
                <dd>{value.adminEmail}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Onde o ambiente roda</dt>
                <dd>{HOSTING_LABELS[hosting]}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Contratado</dt>
                <dd>{configurationSummary(currentPreview.quote.configuration)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Preço de referência</dt>
                <dd className="tabular-nums">
                  {formatCents(currentPreview.quote.monthlyTotal)} por mês
                  {currentPreview.quote.setupTotal > 0 &&
                    `, implantação ${formatCents(currentPreview.quote.setupTotal)}`}
                </dd>
              </div>
            </dl>
            {customer ? (
              <p>
                Nada é criado na infraestrutura da Verax: nenhum nó, túnel nem painel. O cliente nasce
                “Aguardando instalação pelo cliente”, e o detalhe mostra a versão, as imagens e o guia para
                você enviar a ele. Nenhuma cobrança é feita pela Stripe.
              </p>
            ) : (
              <p>
                Cria o nó <span className="font-mono">vx-{slug}</span> na infraestrutura da Verax (tem custo)
                e o painel em <span className="font-mono">{slug}</span>. Nenhuma cobrança é feita pela Stripe.
                O e-mail com o acesso vai para o administrador quando o ambiente ficar pronto.
              </p>
            )}
          </ConfirmBySlug>
        </section>
      )}
      {createError !== undefined && <ErrorState error={createError} />}
    </div>
  );
}
