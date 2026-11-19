import { Calculator, FilePenLine, ShieldCheck } from 'lucide-react';
import { type ReactNode, useState } from 'react';
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
  AmendablePlan,
  AmendmentRequest,
  ContractAmendmentResult,
  ContractAmendmentView,
  ContractTermsView,
  ContractValues,
  DirectTenantPreview,
  Hosting,
  TenantDetail,
  TenantState,
  ValidationIssue,
} from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { CONTACT_REASON_LABELS, formatDateTime, gbDayLabel, PLAN_LABELS } from '@/lib/format';
import { formatCents } from '@/lib/numbers';
import { ConfirmBySlug } from './confirm-by-slug';
import { completeContractValues, type ContractField, gbDayHint, prefillContracted } from './contract-values';
import { ContractValuesSection } from './contract-values-view';
import { addMonths, contractMonthsOf, termText } from './contract-term';
import { CUSTOMER_PROBLEM_LABELS, HOSTING_LABELS, PROBLEM_LABELS, STATE_LABELS } from './labels';
import { useInvalidateTenants } from './queries';
import { QuoteSummary } from './quote-summary';

/** Os planos de um aditivo: os três do cadastro. O SIEM Cloud roda só na infraestrutura da Verax. */
const AMENDABLE_PLANS: readonly AmendablePlan[] = ['plataforma', 'dedicado', 'vciso'];

/** No cliente, o SIEM Cloud aparece desligado (ele é a célula da Verax), como a API recusa. */
function planOptions(hosting: Hosting | undefined): Option[] {
  return AMENDABLE_PLANS.map((plan) =>
    plan === 'plataforma' && hosting === 'customer'
      ? { value: plan, label: `${PLAN_LABELS[plan]} (só na infraestrutura da Verax)`, disabled: true }
      : { value: plan, label: PLAN_LABELS[plan] },
  );
}

const HOSTING_OPTIONS: readonly RadioOption[] = [
  {
    value: 'verax',
    label: HOSTING_LABELS.verax,
    description:
      'O cliente fica “Aguardando início”, como um cadastro novo; depois, “Iniciar provisionamento” cria o nó pelos passos de sempre (tem custo de nuvem; só o porte P hoje).',
  },
  {
    value: 'customer',
    label: HOSTING_LABELS.customer,
    description:
      'O cliente fica “Aguardando instalação pelo cliente”; depois, você gera o comando de instalação e envia a ele. Nada é criado na infraestrutura da Verax.',
  },
];

/** O formulário do aditivo como documento, antes de ir à API. */
interface Draft {
  hosting?: unknown;
  configuration?: { plan?: unknown; gbDay?: unknown };
  contracted?: Partial<Record<ContractField, unknown>>;
  contractedSetup?: unknown;
  note?: unknown;
}

function isHosting(value: unknown): value is Hosting {
  return value === 'verax' || value === 'customer';
}

function isAmendablePlan(value: unknown): value is AmendablePlan {
  return value === 'plataforma' || value === 'dedicado' || value === 'vciso';
}

/** Com o SIEM Cloud escolhido, a infraestrutura do cliente aparece desligada, com o motivo. */
function hostingOptions(plan: AmendablePlan | undefined): RadioOption[] {
  if (plan !== 'plataforma') return [...HOSTING_OPTIONS];
  return HOSTING_OPTIONS.map((option) =>
    option.value === 'customer'
      ? {
          ...option,
          disabled: true,
          description:
            'Indisponível com o SIEM Cloud: ele roda só na infraestrutura da Verax. Escolha outro plano para instalar no cliente.',
        }
      : option,
  );
}

function splitError(caught: unknown): { issues: readonly ValidationIssue[]; error?: unknown } {
  if (caught instanceof ApiError && caught.issues.length > 0) return { issues: caught.issues };
  return { issues: [], error: caught };
}

/** O contratado de hoje: os valores do contrato, ou a referência num contrato de antes deles. */
function currentValues(tenant: TenantDetail): {
  monthly: number;
  additional?: number;
  setup: number;
} {
  return {
    monthly: tenant.contractPricing?.contracted.monthlyTotal ?? tenant.pricing.monthlyTotal,
    ...(tenant.contractPricing === undefined
      ? {}
      : { additional: tenant.contractPricing.contracted.additionalGbDayAmount }),
    setup: tenant.contractPricing?.setup?.contracted ?? tenant.pricing.setupTotal,
  };
}

interface DiffRow {
  label: string;
  before: string;
  after: string;
}

function DiffTable({ rows, caption }: { rows: readonly DiffRow[]; caption: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Item
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Hoje
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Depois do aditivo
            </th>
            <th scope="col" className="py-1 font-medium">
              <span className="sr-only">Muda?</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const changes = row.before !== row.after;
            return (
              <tr key={row.label} className={cn('border-t', changes && 'font-medium')}>
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {row.label}
                </th>
                <td className="py-1 pr-3 tabular-nums">{row.before}</td>
                <td className="py-1 pr-3 tabular-nums">{row.after}</td>
                <td className="py-1 text-xs">
                  {changes ? (
                    <span className="rounded-full border border-high/60 bg-high/10 px-2 py-0.5">muda</span>
                  ) : (
                    <span className="text-muted-foreground">igual</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** O que acontece depois do aditivo, em texto (a mensagem de sucesso). */
function doneText(result: ContractAmendmentResult): { text: string; next?: string; warning?: string } {
  const base = `Aditivo gravado. A vigência recomeça: ${termText(result.contractTerm)}.`;
  const next = !result.hostingChanged
    ? undefined
    : result.hosting === 'verax'
      ? 'O ambiente agora roda na infraestrutura da Verax, e o cliente está “Aguardando início”: use “Iniciar provisionamento”, no painel Provisionamento, para criar o nó.'
      : 'O ambiente agora roda na infraestrutura do cliente, e o cliente está “Aguardando instalação pelo cliente”: gere o comando de instalação, logo abaixo, e envie a ele.';
  const warning = result.nodeLimitsPending
    ? 'Os limites do nó (franquia, histórico, contas e usuários) mudaram com o ambiente já instalado: ficam gravados no contrato, mas o nó em execução continua com os anteriores até ser instalado de novo. Ainda não há como aplicar limites novos num nó rodando.'
    : undefined;
  return {
    text: base,
    ...(next === undefined ? {} : { next }),
    ...(warning === undefined ? {} : { warning }),
  };
}

/**
 * "Alterar contrato…": o aditivo de um contrato direto (decisão do responsável de 19/11/2026), no detalhe do cliente.
 * O plano (SIEM Dedicado ou SIEM + vCISO), o volume em GB/dia, onde o ambiente roda (só enquanto nada foi instalado nem
 * provisionado: depois, o campo fica travado, com o motivo) e os valores do contrato, preenchidos com a cotação de
 * referência da tabela vigente, como no cadastro, e editáveis numa negociação. Antes de gravar, o que muda (hoje e
 * depois) e a confirmação com o subdomínio digitado. A vigência recomeça na data do aditivo.
 */
export function AmendContract({ tenant }: { tenant: TenantDetail }) {
  const invalidate = useInvalidateTenants();
  const table = useCurrentVersion('pricing-tables');
  const tableContent = table.record.data?.content;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<unknown>({});
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [preview, setPreview] = useState<{ result: DirectTenantPreview; for: string } | undefined>(undefined);
  const [prefilledFrom, setPrefilledFrom] = useState<{ values: ContractValues; setup: number } | undefined>(
    undefined,
  );
  const [previewError, setPreviewError] = useState<unknown>(undefined);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [done, setDone] = useState<ContractAmendmentResult | undefined>(undefined);

  if (!tenant.actions.amend || !('plan' in tenant.configuration)) {
    return done === undefined ? null : <DoneNotice result={done} />;
  }
  const current = tenant.configuration;
  const value = draft as Draft;
  const hosting = tenant.actions.amendHosting
    ? isHosting(value.hosting)
      ? value.hosting
      : undefined
    : tenant.hosting;
  const plan = isAmendablePlan(value.configuration?.plan) ? value.configuration.plan : undefined;
  const previewKey = JSON.stringify({ hosting: hosting ?? null, configuration: value.configuration ?? {} });
  const currentPreview = preview?.for === previewKey ? preview.result : undefined;
  const quoted = currentPreview?.contactUs === false ? currentPreview : undefined;
  const contracted = completeContractValues(value.contracted);
  const withSetup = quoted !== undefined && quoted.quote.setupTotal > 0;
  const setup = typeof value.contractedSetup === 'number' ? value.contractedSetup : undefined;
  const ready =
    quoted !== undefined &&
    quoted.problems.length === 0 &&
    contracted !== undefined &&
    (!withSetup || (setup !== undefined && Number.isInteger(setup) && setup >= 0));

  function start(): void {
    setOpen(true);
    setDone(undefined);
    setIssues([]);
    setPreview(undefined);
    setPrefilledFrom(undefined);
    setPreviewError(undefined);
    setSaveError(undefined);
    setConfirming(false);
    setDraft({
      hosting: tenant.hosting,
      configuration: {
        plan: current.plan,
        gbDay: current.gbDay,
      },
    });
  }

  async function calculate(): Promise<void> {
    if (hosting === undefined || plan === undefined) return;
    setPreviewing(true);
    setPreviewError(undefined);
    try {
      const result = await tenantsApi.preview(hosting, { plan, gbDay: value.configuration?.gbDay as number });
      setPreview({ result, for: previewKey });
      if (!result.contactUs) {
        const reference = result.reference;
        const setupReference = result.quote.setupTotal;
        setDraft((currentDraft: unknown) => {
          const draftNow = currentDraft as Draft;
          const { contractedSetup, ...rest } = draftNow;
          const untouched =
            contractedSetup === undefined ||
            (prefilledFrom !== undefined && contractedSetup === prefilledFrom.setup);
          return {
            ...rest,
            contracted: prefillContracted(draftNow.contracted, reference, prefilledFrom?.values),
            // A implantação só existe no vCISO: vem com a da tabela e fica com o que foi negociado.
            ...(setupReference > 0 ? { contractedSetup: untouched ? setupReference : contractedSetup } : {}),
          };
        });
        setPrefilledFrom({ values: reference, setup: setupReference });
      }
      setIssues((list) => list.filter((issue) => !issue.path.startsWith('configuration')));
    } catch (caught) {
      setPreview(undefined);
      const split = splitError(caught);
      setIssues(split.issues);
      setPreviewError(split.error);
    } finally {
      setPreviewing(false);
    }
  }

  async function save(confirmSlug: string): Promise<void> {
    if (saving || hosting === undefined || plan === undefined || contracted === undefined) return;
    setSaving(true);
    setSaveError(undefined);
    const note = typeof value.note === 'string' ? value.note.trim() : '';
    const body: AmendmentRequest = {
      hosting,
      configuration: { plan, gbDay: value.configuration?.gbDay as number },
      contracted,
      ...(withSetup && setup !== undefined ? { contractedSetup: setup } : {}),
      ...(note === '' ? {} : { note }),
      confirmSlug,
    };
    try {
      const result = await tenantsApi.amend(tenant.id, body);
      setDone(result);
      setOpen(false);
      await invalidate(tenant.id);
    } catch (caught) {
      const split = splitError(caught);
      setIssues(split.issues);
      setSaveError(split.error);
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  function resetToTable(field: ContractField): void {
    if (quoted === undefined) return;
    const reference = quoted.reference;
    setDraft((currentDraft: unknown) => {
      const draftNow = currentDraft as Draft;
      return { ...draftNow, contracted: { ...draftNow.contracted, [field]: reference[field] } };
    });
  }

  if (!open) {
    return (
      <div className="space-y-3">
        {done !== undefined && <DoneNotice result={done} />}
        <Button variant="secondary" onClick={start}>
          <FilePenLine aria-hidden />
          Alterar contrato…
        </Button>
      </div>
    );
  }

  const readOnly = confirming || saving;
  const today = new Date();
  const months = plan === undefined ? undefined : contractMonthsOf(plan, tableContent);
  const before = currentValues(tenant);
  const moving = hosting !== undefined && hosting !== tenant.hosting;
  const stateAfter: TenantState | undefined = moving
    ? hosting === 'verax'
      ? 'pending'
      : 'waiting_customer_install'
    : undefined;
  const rows: DiffRow[] =
    quoted === undefined || contracted === undefined || hosting === undefined
      ? []
      : [
          {
            label: 'Onde o ambiente roda',
            before: HOSTING_LABELS[tenant.hosting],
            after: HOSTING_LABELS[hosting],
          },
          {
            label: 'Plano',
            before: PLAN_LABELS[current.plan],
            after: PLAN_LABELS[quoted.quote.configuration.plan],
          },
          {
            label: 'Volume contratado',
            before: gbDayLabel(current.gbDay),
            after: gbDayLabel(quoted.quote.configuration.gbDay),
          },
          { label: 'Porte', before: current.size, after: quoted.quote.configuration.size },
          {
            label: 'Valor mensal do contrato',
            before: formatCents(before.monthly),
            after: formatCents(contracted.monthlyTotal),
          },
          {
            label: 'Valor por GB/dia adicional',
            before: before.additional === undefined ? '—' : formatCents(before.additional),
            after: formatCents(contracted.additionalGbDayAmount),
          },
          ...(withSetup || before.setup > 0
            ? [
                {
                  label: 'Implantação (uma vez)',
                  before: formatCents(before.setup),
                  after: formatCents(withSetup && setup !== undefined ? setup : 0),
                },
              ]
            : []),
          {
            label: 'Vigência',
            before: tenant.contractTerm === undefined ? 'Sem registro' : termText(tenant.contractTerm),
            after:
              months === undefined
                ? 'Recomeça hoje'
                : termText({
                    months,
                    startsAt: today.toISOString(),
                    endsAt: addMonths(today, months).toISOString(),
                  }),
          },
          ...(stateAfter === undefined
            ? []
            : [{ label: 'Estado', before: STATE_LABELS[tenant.state], after: STATE_LABELS[stateAfter] }]),
        ];

  return (
    <section
      aria-labelledby="alterar-contrato"
      className="space-y-4 rounded-xl border border-border-strong p-4"
    >
      <div className="space-y-1">
        <h3 id="alterar-contrato" className="text-base font-semibold">
          Alterar contrato (aditivo)
        </h3>
        <p className="text-sm text-muted-foreground">
          Muda o plano (SIEM Cloud, SIEM Dedicado ou SIEM + vCISO), o volume e os valores do contrato e,
          enquanto nada foi instalado, onde o ambiente roda. A cotação é a da tabela vigente, calculada como
          no cadastro; os valores vêm preenchidos com ela e podem ser negociados. A vigência recomeça na data
          do aditivo, com a duração do plano novo (12 meses no SIEM Cloud e no SIEM Dedicado, 60 no SIEM +
          vCISO).
        </p>
      </div>

      <ErrorSummary issues={issues} title="A API recusou o aditivo." />

      <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={readOnly}>
        {tenant.actions.amendHosting ? (
          <RadioField
            path={['hosting']}
            label="Onde o ambiente roda"
            hint="Nada foi instalado nem provisionado ainda: dá para mudar."
            options={hostingOptions(plan)}
          />
        ) : (
          <div className="space-y-1 rounded-xl border bg-surface p-4" role="note">
            <p className="text-sm font-medium">Onde o ambiente roda: {HOSTING_LABELS[tenant.hosting]}</p>
            <p className="text-sm text-muted-foreground">
              Não muda neste aditivo: o ambiente já começou a ser criado (
              {tenant.hosting === 'customer'
                ? 'o comando de instalação já foi gerado, e o túnel e o painel já existem na Verax'
                : 'o provisionamento já começou'}
              ). Daqui em diante, o aditivo muda só o plano, o volume e os valores. Para mudar de lugar,
              cancele este contrato e cadastre outro.
            </p>
          </div>
        )}
        <Section
          title="Plano e volume"
          description="Por contrato, o SIEM Cloud roda só na infraestrutura da Verax e, até a célula compartilhada abrir, ganha um servidor próprio (porte P)."
          path={['configuration']}
        >
          <Grid>
            <SelectField path={['configuration', 'plan']} label="Plano" options={planOptions(hosting)} />
            <NumberField
              path={['configuration', 'gbDay']}
              label="Volume de logs (GB/dia)"
              kind="integer"
              {...(tableContent === undefined
                ? {}
                : {
                    hint: `${gbDayHint(tableContent, plan)} Hoje: ${gbDayLabel(current.gbDay)}.`,
                  })}
            />
          </Grid>
        </Section>
      </DraftForm>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => void calculate()}
          disabled={previewing || readOnly || hosting === undefined || plan === undefined}
        >
          <Calculator aria-hidden />
          {previewing ? 'Calculando…' : 'Calcular a cotação'}
        </Button>
        <Button onClick={() => setConfirming(true)} disabled={!ready || readOnly}>
          <ShieldCheck aria-hidden />
          Revisar e confirmar…
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
          Desistir
        </Button>
        {!ready && (
          <span className="text-sm text-muted-foreground">
            {preview !== undefined && currentPreview === undefined
              ? 'A configuração mudou: calcule a cotação de novo.'
              : quoted !== undefined && quoted.problems.length === 0
                ? 'Preencha os valores do contrato.'
                : 'Calcule a cotação para revisar e confirmar.'}
          </span>
        )}
      </div>

      {previewError !== undefined && <ErrorState error={previewError} />}
      <div aria-live="polite" className="space-y-3">
        {currentPreview?.contactUs === true && (
          <section className="rounded-xl border bg-surface p-4">
            <h4 className="text-base font-semibold">Acima do que a tabela vende</h4>
            <p className="text-sm">
              {CONTACT_REASON_LABELS[currentPreview.reason]} (tabela {currentPreview.priceTableVersion}). O
              aditivo só aceita o que a tabela vende.
            </p>
          </section>
        )}
        {quoted !== undefined && (
          <QuoteSummary quote={quoted.quote} priceTableVersion={quoted.priceTableVersion}>
            {quoted.problems.length > 0 && (
              <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
                <p className="font-medium">
                  {hosting === 'customer'
                    ? 'Esta configuração ainda não pode ser instalada na infraestrutura do cliente:'
                    : 'O provisionamento ainda não cria esta configuração:'}
                </p>
                <ul className="list-disc pl-5">
                  {quoted.problems.map((problem) => (
                    <li key={problem}>
                      {(hosting === 'customer' ? CUSTOMER_PROBLEM_LABELS : PROBLEM_LABELS)[problem]}.
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </QuoteSummary>
        )}
        {quoted !== undefined && (
          <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={readOnly}>
            <ContractValuesSection
              reference={quoted.reference}
              value={value.contracted}
              readOnly={readOnly}
              onReset={resetToTable}
            />
            {withSetup && (
              <NumberField
                path={['contractedSetup']}
                label="Implantação do SIEM + vCISO (uma vez)"
                kind="money"
                hint={`Tabela: ${formatCents(quoted.quote.setupTotal)}. Use 0 se a implantação já foi paga.`}
              />
            )}
            <TextField
              path={['note']}
              label="Observação (opcional)"
              hint="Fica no histórico de aditivos e na auditoria (até 500 caracteres). Ex.: o motivo ou o número do aditivo assinado."
            />
          </DraftForm>
        )}
      </div>

      {confirming && quoted !== undefined && contracted !== undefined && (
        <section aria-labelledby="confirmar-aditivo" className="space-y-3 rounded-xl border bg-surface p-4">
          <h4 id="confirmar-aditivo" className="text-base font-semibold">
            Confirmar o aditivo
          </h4>
          <ConfirmBySlug
            slug={tenant.slug}
            actionLabel="Gravar o aditivo"
            busyLabel="Gravando…"
            busy={saving}
            onConfirm={(typed) => void save(typed)}
            onCancel={() => setConfirming(false)}
          >
            <DiffTable rows={rows} caption="O que muda no contrato" />
            {moving && hosting === 'verax' && (
              <p>
                O cliente volta a “Aguardando início”, como um cadastro novo na infraestrutura da Verax, e
                nada é criado agora. Depois, use “Iniciar provisionamento” para criar o nó{' '}
                <span className="font-mono">vx-{tenant.slug}</span> (tem custo).
              </p>
            )}
            {moving && hosting === 'customer' && (
              <p>
                O cliente passa a “Aguardando instalação pelo cliente”. Nada é criado na infraestrutura da
                Verax; depois, gere o comando de instalação e envie a ele.
              </p>
            )}
            {!moving && !tenant.actions.amendHosting && (
              <p>
                O ambiente já foi criado ou está sendo criado: o contrato muda agora, mas os limites do nó
                (franquia, histórico, contas e usuários) só chegam a um nó já instalado quando ele for
                instalado de novo. Nada é parado nem reiniciado.
              </p>
            )}
            <p className="text-muted-foreground">
              Nenhuma cobrança é feita pela Stripe: a cobrança é a do contrato.
            </p>
          </ConfirmBySlug>
        </section>
      )}
      {saveError !== undefined && <ErrorState error={saveError} />}
    </section>
  );
}

function DoneNotice({ result }: { result: ContractAmendmentResult }) {
  const notice = doneText(result);
  return (
    <div role="status" className="space-y-2 text-sm">
      <p className="font-medium">{notice.text}</p>
      {notice.next !== undefined && <p>{notice.next}</p>}
      {notice.warning !== undefined && (
        <p className="rounded-lg border border-high/60 bg-high/10 p-3">{notice.warning}</p>
      )}
    </div>
  );
}

/** Uma linha do contrato num aditivo: "SIEM Dedicado · 3 GB/dia · infraestrutura do cliente · R$ 1.350,00 por mês". */
function termsLine(terms: ContractTermsView): string {
  const monthly = terms.contractPricing?.contracted.monthlyTotal ?? terms.pricing.monthlyTotal;
  const setup = terms.contractPricing?.setup;
  return [
    PLAN_LABELS[terms.configuration.plan],
    gbDayLabel(terms.configuration.gbDay),
    `porte ${terms.configuration.size}`,
    terms.hosting === 'verax' ? 'na infraestrutura da Verax' : 'na infraestrutura do cliente',
    `${formatCents(monthly)} por mês`,
    ...(terms.contractPricing === undefined
      ? []
      : [`${formatCents(terms.contractPricing.contracted.additionalGbDayAmount)} por GB/dia adicional`]),
    ...(setup === undefined ? [] : [`implantação ${formatCents(setup.contracted)}`]),
  ].join(' · ');
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** O histórico de aditivos do contrato, do mais novo para o mais antigo: quem, quando, o antes e o depois. */
export function AmendmentHistory({ amendments }: { amendments: readonly ContractAmendmentView[] }) {
  if (amendments.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum aditivo: o contrato é o do cadastro.</p>;
  }
  return (
    <ol aria-label="Aditivos do contrato, do mais novo para o mais antigo" className="space-y-3">
      {[...amendments].reverse().map((amendment) => (
        <li key={amendment.id} className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">
            {formatDateTime(amendment.at)} · {amendment.by}
          </p>
          <dl className="grid gap-2">
            <Item label="Antes">{termsLine(amendment.before)}</Item>
            <Item label="Depois">{termsLine(amendment.after)}</Item>
            {amendment.after.contractTerm !== undefined && (
              <Item label="Vigência">{termText(amendment.after.contractTerm)}</Item>
            )}
            {amendment.stateBefore !== amendment.stateAfter && (
              <Item label="Estado">
                {STATE_LABELS[amendment.stateBefore]} → {STATE_LABELS[amendment.stateAfter]}
              </Item>
            )}
            {amendment.note !== undefined && <Item label="Observação">{amendment.note}</Item>}
          </dl>
          {amendment.nodeLimitsPending && (
            <p className="rounded-lg border border-high/60 bg-high/10 p-2 text-xs">
              Os limites do nó mudaram com o ambiente já instalado: o nó em execução continua com os
              anteriores até ser instalado de novo.
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
