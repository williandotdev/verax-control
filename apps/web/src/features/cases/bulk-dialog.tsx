import { FINDING_SEVERITIES, TRIAGE_REASON_MAX, type TriageOperationDetail } from '@verax/shared';
import { ShieldAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { useOpenIncidents } from '@/features/incidents/incidents-api';
import { incidentTitle } from '@/features/incidents/narrative';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatCount, plural } from '@/lib/format';
import {
  BULK_ACTION_LABELS,
  BULK_ACTIONS,
  type BulkAction,
  type BulkProblem,
  bulkProblem,
  type BulkScope,
  cleanReason,
  expectedCount,
  INCIDENT_ACTIONS,
  limitProblem,
  needsTypedConfirmation,
  reasonRequired,
  requestBody,
  scopeOfFilter,
  sumPending,
  typedMatches,
} from './bulk';
import type { BulkRequest } from './cases-context';
import { useCasesContext } from './cases-context';
import { alertCount, caseCount } from './labels';
import { Modal } from './modal';
import { OperationOutcome } from './operation-outcome';
import { useRequestId, useRequestTriage, useTriagePreview } from './triage-api';
import { CHECKBOX } from './select-cells';

/** O diálogo da triagem em massa: o alvo, o que fazer, o que fica de fora e a confirmação. */
export function BulkDialog({ request, onClose }: { request: BulkRequest; onClose: () => void }) {
  const preview = useTriagePreview(request.kind === 'filter' ? request.filter : null);
  const scope: BulkScope | null =
    request.kind === 'scope'
      ? request.scope
      : preview.data
        ? scopeOfFilter(request.filter, request.label, preview.data)
        : null;
  const label = request.kind === 'scope' ? request.scope.label : request.label;

  if (scope === null) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`Tratar: ${label}`}
        description="Contando o que o filtro alcança agora."
        footer={
          <Button variant="ghost" size="sm" className="max-md:h-11" onClick={onClose}>
            Cancelar
          </Button>
        }
      >
        {preview.isError ? (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        ) : (
          <LoadingState rows={3} label="Contando os alertas" />
        )}
      </Modal>
    );
  }
  return (
    <BulkForm
      scope={scope}
      label={label}
      initialAction={request.action ?? null}
      onAccepted={request.onAccepted}
      onScopeChanged={() => {
        if (request.kind === 'filter') void preview.refetch();
      }}
      onClose={onClose}
    />
  );
}

function confirmLabel(action: BulkAction | null, count: number, exact: boolean): string {
  const alerts = `${exact ? '' : 'até '}${alertCount(count)}`;
  switch (action) {
    case 'investigating':
      return `Colocar ${alerts} em análise`;
    case 'legitimate':
      return `Marcar ${alerts} como ${count === 1 ? 'legítimo' : 'legítimos'}`;
    case 'resolved':
      return `Marcar ${alerts} como ${count === 1 ? 'resolvido' : 'resolvidos'}`;
    case 'promote':
      return `Promover ${alerts} a incidente`;
    case 'attach':
      return `Anexar ${alerts}`;
    case null:
      return 'Escolha o que fazer';
  }
}

function BulkForm({
  scope,
  label,
  initialAction,
  onAccepted,
  onScopeChanged,
  onClose,
}: {
  scope: BulkScope;
  label: string;
  initialAction: BulkAction | null;
  onAccepted: (() => void) | undefined;
  onScopeChanged: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const { canPromote, role } = useCasesContext();
  const [action, setAction] = useState<BulkAction | null>(initialAction);
  const [includeCritical, setIncludeCritical] = useState(false);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [incidentId, setIncidentId] = useState('');
  /** A contagem nova que a API mandou (409), que a pessoa confirma de novo. */
  const [changed, setChanged] = useState<number | null>(null);
  const [problem, setProblem] = useState<BulkProblem | null>(null);
  const [accepted, setAccepted] = useState<TriageOperationDetail | null>(null);
  const requestIdOf = useRequestId();
  const triage = useRequestTriage();
  const incidents = useOpenIncidents(action === 'attach');
  const incidentOptions = incidents.data ?? [];
  const chosenIncident = incidentId || incidentOptions[0]?.id || '';

  const estimate = expectedCount(scope, includeCritical, action ?? 'legitimate');
  const count = changed ?? estimate.count;
  const exact = changed !== null || estimate.exact;
  const critical = Math.max(scope.pending.critical, problem?.kind === 'only_critical' ? problem.excluded : 0);
  const limit = role === null ? null : limitProblem(count, role);
  const mustExplain = action !== null && reasonRequired(action, count);
  const reasonMissing = mustExplain && cleanReason(reason) === '';
  const mustType = needsTypedConfirmation(count);
  const typedWrong = mustType && !typedMatches(typed, count);
  const incidentMissing = action === 'attach' && chosenIncident === '';
  // O problema que veio da API fica até a pessoa mudar alguma coisa do pedido (ou tentar de novo).
  const ready =
    action !== null &&
    limit === null &&
    !reasonMissing &&
    !typedWrong &&
    !incidentMissing &&
    !triage.isPending;

  /** Mudou o que se vai pedir: a contagem confirmada e a recusa de antes não valem mais. */
  const restart = () => {
    setChanged(null);
    setProblem(null);
    setTyped('');
  };

  const submit = () => {
    if (!ready || action === null) return;
    const body = requestBody({
      scope,
      action,
      incidentId: chosenIncident || null,
      includeCritical,
      expected: count,
      reason,
    });
    setProblem(null);
    triage.mutate(
      { ...body, requestId: requestIdOf(body) },
      {
        onSuccess: (operation) => {
          setAccepted(operation);
          onAccepted?.();
        },
        onError: (error) => {
          const found = bulkProblem(error);
          setProblem(found);
          if (found.kind === 'scope_changed') {
            setChanged(found.count);
            setTyped('');
            onScopeChanged();
          }
        },
      },
    );
  };

  if (accepted !== null) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`${action === null ? 'Tratar' : BULK_ACTION_LABELS[action].label}: ${label}`}
        description={
          accepted.incidentId !== null && accepted.action === 'promote'
            ? 'O incidente foi aberto, e quem recebe os avisos é avisado uma vez.'
            : 'O pedido foi aceito e fica na auditoria.'
        }
        footer={
          <Button size="sm" className="max-md:h-11" onClick={onClose}>
            Fechar
          </Button>
        }
      >
        <OperationOutcome operation={accepted} onUndo={onClose} onFollowLink={onClose} />
      </Modal>
    );
  }

  const actions = BULK_ACTIONS.filter((option) => canPromote || !INCIDENT_ACTIONS.includes(option));
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Tratar: ${label}`}
      description="Nada muda antes de você confirmar, e dá para desfazer por 24 horas."
      footer={
        <>
          <Button variant="ghost" size="sm" className="max-md:h-11" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            className="h-auto min-h-8 py-1 max-md:min-h-11"
            disabled={!ready}
            onClick={submit}
          >
            {triage.isPending ? 'Enviando…' : confirmLabel(action, count, exact)}
          </Button>
        </>
      }
    >
      <ScopeSummary scope={scope} changed={changed} />

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">O que fazer</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {actions.map((option) => (
            <label
              key={option}
              className={cn(
                'flex min-h-11 cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-foreground/5 has-focus-visible:outline-2 has-focus-visible:outline-ring',
                action === option && 'border-primary bg-primary/5',
              )}
            >
              <input
                type="radio"
                name={`${id}-acao`}
                value={option}
                className="mt-0.5 accent-primary focus:outline-none"
                checked={action === option}
                onChange={() => {
                  setAction(option);
                  restart();
                }}
              />
              <span>
                <span className="block font-medium">{BULK_ACTION_LABELS[option].label}</span>
                <span className="block text-xs text-muted-foreground">{BULK_ACTION_LABELS[option].hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {action === 'attach' &&
        (incidents.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            Carregando os incidentes em aberto…
          </p>
        ) : incidents.isError ? (
          <p role="alert" className="text-sm text-critical-text">
            {errorMessage(incidents.error)}
          </p>
        ) : incidentOptions.length === 0 ? (
          <p role="status" className="text-sm text-muted-foreground">
            Nenhum incidente aberto ou em análise. Use &quot;Promover a incidente&quot; para abrir um.
          </p>
        ) : (
          <SelectField
            label="Incidente"
            className="[&_select]:w-full"
            value={chosenIncident}
            onChange={(value) => {
              setIncidentId(value);
              restart();
            }}
            options={incidentOptions.map((incident) => ({
              value: incident.id,
              label: `${incidentTitle(incident)} (nota ${incident.riskScore}, ${alertCount(incident.findingCount)})`,
            }))}
          />
        ))}

      {critical > 0 && (
        <label className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-critical/50 bg-critical/5 p-3 text-sm">
          <input
            type="checkbox"
            className={cn(CHECKBOX, 'mt-0.5')}
            checked={includeCritical}
            onChange={(event) => {
              setIncludeCritical(event.target.checked);
              restart();
            }}
          />
          <span>
            <span className="block font-medium">
              Incluir também{' '}
              {critical === 1 ? 'o alerta crítico' : `os ${formatCount(critical)} alertas críticos`}
            </span>
            <span className="block text-xs text-muted-foreground">
              Sem marcar, {critical === 1 ? 'ele fica pendente' : 'eles ficam pendentes'}, como{' '}
              {critical === 1 ? 'está' : 'estão'}.
            </span>
          </span>
        </label>
      )}

      {scope.protectedTitles !== null && scope.protectedTitles.length > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-medium/70 bg-medium/15 p-3 text-sm">
          <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">
              {plural(
                scope.protectedTitles.length,
                'caso toca a lista de proteção',
                'casos tocam a lista de proteção',
              )}
            </p>
            <ul className="text-xs text-muted-foreground">
              {scope.protectedTitles.slice(0, 5).map((title, index) => (
                <li key={`${index}:${title}`} className="wrap-anywhere">
                  {title}
                </li>
              ))}
              {scope.protectedTitles.length > 5 && <li>e mais {scope.protectedTitles.length - 5}</li>}
            </ul>
          </div>
        </div>
      )}
      {scope.protectedTitles === null && scope.cases !== null && (
        <p className="text-xs text-muted-foreground">
          O filtro pode incluir casos que tocam a lista de proteção: eles aparecem na lista com a marca
          &quot;Item protegido&quot;.
        </p>
      )}

      {action === 'promote' && (
        <p className="text-xs text-muted-foreground">
          O incidente nasce com o alerta que abriu o caso (ou o pior) e os mais graves; os outros entram em
          seguida. O aviso por e-mail sai uma vez, na abertura, e não volta se você desfizer.
        </p>
      )}

      <div className="space-y-1">
        <label htmlFor={`${id}-motivo`} className="text-sm font-medium">
          Motivo {mustExplain ? '(obrigatório)' : '(opcional)'}
        </label>
        <Textarea
          id={`${id}-motivo`}
          value={reason}
          maxLength={TRIAGE_REASON_MAX}
          required={mustExplain}
          aria-invalid={problem?.kind === 'reason' || undefined}
          aria-describedby={`${id}-motivo-dica`}
          onChange={(event) => setReason(event.target.value)}
        />
        <p id={`${id}-motivo-dica`} className="text-xs text-muted-foreground">
          {mustExplain
            ? 'Fica na auditoria e no histórico de cada alerta. Sem ele, não dá para tirar da fila mais de um alerta.'
            : 'Fica na auditoria e no histórico de cada alerta.'}
        </p>
      </div>

      {mustType && limit === null && (
        <div className="space-y-1">
          <label htmlFor={`${id}-total`} className="text-sm font-medium">
            São {alertCount(count)}. Digite {formatCount(count)} para confirmar
          </label>
          <Input
            id={`${id}-total`}
            inputMode="numeric"
            autoComplete="off"
            className="max-w-48"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      )}

      {limit !== null && (
        <p role="alert" className="text-sm text-critical-text">
          {limit}
        </p>
      )}
      {problem !== null && (
        <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 p-3 text-sm">
          {problem.message}
        </p>
      )}
    </Modal>
  );
}

/** O que vai ser tratado: casos, alertas e a conta por severidade. */
function ScopeSummary({ scope, changed }: { scope: BulkScope; changed: number | null }) {
  const total = sumPending(scope.pending);
  return (
    <section
      aria-label="O que vai ser tratado"
      className="space-y-2 rounded-md border bg-foreground/[0.03] p-3 text-sm"
    >
      <p>
        {scope.cases !== null && (
          <>
            <strong>{caseCount(scope.cases)}</strong>,{' '}
          </>
        )}
        <strong>{alertCount(total)}</strong> {total === 1 ? 'pendente' : 'pendentes'}
        {changed !== null && (
          <>
            {' '}
            na lista; <strong>agora são {formatCount(changed)}</strong>
          </>
        )}
        .
      </p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1">
        {FINDING_SEVERITIES.map((severity) => {
          const { icon: Icon, tone, label } = SEVERITY_STYLES[severity];
          return (
            <div key={severity} className="flex items-center gap-1.5">
              <Icon aria-hidden className={cn('size-4', tone)} />
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{formatCount(scope.pending[severity])}</dd>
            </div>
          );
        })}
      </dl>
      <p className="text-xs text-muted-foreground">
        Entram os alertas novos e em análise, fora de incidente, que chegaram até você confirmar.
        {scope.severityFiltered &&
          ' O filtro de severidade escolhe os casos: entram todos os pendentes deles.'}
        {scope.cases === null && ' Os já tratados ou em incidente ficam como estão.'}
      </p>
    </section>
  );
}
