import {
  ALERT_EXCEPTION_FIELDS,
  type AlertExceptionField,
  alertExceptionBatchSchema,
  type CaseExceptionDraft,
  isScopedExceptionBlocked,
  MAX_ALERT_EXCEPTIONS_PER_REQUEST,
  SCOPED_EXCEPTION_MAX_DAYS,
  SCOPED_EXCEPTION_SEVERITIES,
  scopedExceptionCreateSchema,
  scopedExceptionNeedsEvent,
  type ScopedExceptionSeverity,
} from '@verax/shared';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { FormError, SelectInput, TextAreaField } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { EXCEPTION_FIELD_LABELS } from '@/features/admin/labels';
import { useScopedOpenPreview } from '@/features/exception-open-alerts/open-alerts-api';
import { OpenAlertsPreview, OpenAlertsResult } from '@/features/exception-open-alerts/open-alerts-view';
import { plural } from '@/lib/format';
import {
  useCaseExceptionDraft,
  useCreateExceptionBatch,
  useCreateScoped,
  useScopedPreview,
} from './case-exceptions-api';
import { dateInDays, endOfDay, previewText, targetText } from './case-exception-text';
import { Modal } from './modal';

type Kind = AlertExceptionField | 'wide';
type Target = CaseExceptionDraft['targets'][number];

/**
 * Criar exceção a partir de um caso. O que é constante nos alertas preenche as exceções de usuário, IP ou recurso (até 20
 * de uma vez); o que é largo demais vai para a exceção ampla (só administradores), com a prévia antes de salvar, o motivo e
 * a validade de até 90 dias. Quem decide é a API.
 */
export function CaseExceptionDialog({
  caseId,
  canWide,
  onClose,
}: {
  caseId: string;
  canWide: boolean;
  onClose: () => void;
}) {
  const draft = useCaseExceptionDraft(caseId);
  const [done, setDone] = useState<ReactNode>(null);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Criar exceção a partir do caso"
      description="Os próximos alertas iguais entram como legítimos, sem pedir decisão. Os que estão em aberto agora são resolvidos junto; os que estão em incidente ficam."
      footer={
        <Button size="sm" variant={done ? 'primary' : 'ghost'} className="max-md:h-11" onClick={onClose}>
          {done ? 'Fechar' : 'Cancelar'}
        </Button>
      }
    >
      {done !== null ? (
        done
      ) : draft.isPending ? (
        <p className="text-sm text-muted-foreground">Lendo os alertas do caso…</p>
      ) : draft.error || !draft.data ? (
        <FormError error={draft.error ?? new Error('Não foi possível ler o caso.')} />
      ) : draft.data.targets.length === 0 ? (
        <p className="text-sm">O caso não tem alertas guardados para basear uma exceção.</p>
      ) : (
        <ExceptionForm draft={draft.data} canWide={canWide} onDone={setDone} />
      )}
    </Modal>
  );
}

function ExceptionForm({
  draft,
  canWide,
  onDone,
}: {
  draft: CaseExceptionDraft;
  canWide: boolean;
  onDone: (message: ReactNode) => void;
}) {
  const id = useId();
  const [index, setIndex] = useState(0);
  const target = draft.targets[index] ?? draft.targets[0];
  const fields = ALERT_EXCEPTION_FIELDS.filter((field) => draft.values[field].values.length > 0);
  const wideAllowed = canWide && target !== undefined && !isScopedExceptionBlocked(target.ruleId);
  const firstKind: Kind | null =
    fields.find((field) => draft.values[field].complete) ?? (wideAllowed ? 'wide' : null);
  const [kind, setKind] = useState<Kind | null>(firstKind);
  if (target === undefined) return null;

  return (
    <div className="space-y-4">
      {draft.targets.length > 1 && (
        <SelectInput
          label="Regra do caso"
          value={String(index)}
          onChange={(event) => setIndex(Number(event.target.value))}
          options={draft.targets.map((item, position) => ({
            value: String(position),
            label: `${targetText(item)} (${plural(item.alerts, 'alerta', 'alertas')})`,
          }))}
        />
      )}
      {draft.targets.length === 1 && <p className="text-sm wrap-anywhere">{targetText(target)}</p>}
      {!draft.targetsComplete && (
        <p className="text-xs text-muted-foreground">
          O caso tem mais combinações; aparecem as {draft.targets.length} primeiras.
        </p>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Tipo de exceção</legend>
        {fields.map((field) => {
          const values = draft.values[field];
          return (
            <label key={field} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-tipo`}
                className="mt-1 size-4"
                disabled={!values.complete}
                checked={kind === field}
                onChange={() => setKind(field)}
              />
              <span>
                Por {EXCEPTION_FIELD_LABELS[field].toLowerCase()} (
                {plural(values.values.length, 'valor', 'valores')}
                {values.complete ? '' : ' ou mais'})
                {!values.complete && (
                  <span className="block text-xs text-muted-foreground">
                    Mais de {MAX_ALERT_EXCEPTIONS_PER_REQUEST} valores: use a exceção ampla.
                  </span>
                )}
              </span>
            </label>
          );
        })}
        {canWide && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-tipo`}
              className="mt-1 size-4"
              disabled={!wideAllowed}
              checked={kind === 'wide'}
              onChange={() => setKind('wide')}
            />
            <span>
              Exceção ampla (regra, fonte e conta)
              {!wideAllowed && (
                <span className="block text-xs text-muted-foreground">
                  Esta regra não aceita exceção ampla.
                </span>
              )}
            </span>
          </label>
        )}
      </fieldset>
      {kind === null ? (
        <p className="text-sm text-muted-foreground">Nada constante neste caso para basear uma exceção.</p>
      ) : kind === 'wide' ? (
        <WideForm key={index} target={target} onDone={onDone} />
      ) : (
        <BatchForm
          key={`${index}-${kind}`}
          caseId={draft.caseId}
          target={target}
          field={kind}
          values={draft.values[kind].values}
          onDone={onDone}
        />
      )}
    </div>
  );
}

function BatchForm({
  caseId,
  target,
  field,
  values,
  onDone,
}: {
  caseId: string;
  target: Target;
  field: AlertExceptionField;
  values: readonly string[];
  onDone: (message: ReactNode) => void;
}) {
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const batch = useCreateExceptionBatch(caseId);

  const submit = () => {
    const input = alertExceptionBatchSchema.safeParse({
      ruleId: target.ruleId,
      field,
      values,
      reason,
      expiresAt: endOfDay(expires),
    });
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    batch.mutate(input.data, {
      onSuccess: (result) =>
        onDone(
          <Done
            message={`${plural(result.created, 'exceção criada', 'exceções criadas')}${
              result.existing > 0 ? `; ${plural(result.existing, 'já existia', 'já existiam')}` : ''
            }.`}
          >
            <OpenAlertsResult resolution={result.openAlerts} kind="alert" />
          </Done>,
        ),
    });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{EXCEPTION_FIELD_LABELS[field]} (uma exceção por valor)</p>
        <ul className="max-h-40 space-y-1 overflow-auto rounded-md border p-2 font-mono text-xs">
          {values.map((value) => (
            <li key={value} className="wrap-anywhere">
              {value}
            </li>
          ))}
        </ul>
        {errors['values'] && <p className="text-sm text-critical-text">{errors['values']}</p>}
      </div>
      <TextAreaField
        label="Motivo (obrigatório)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={errors['reason']}
        maxLength={500}
      />
      <Field
        label="Validade (opcional)"
        hint="Até um ano. Sem validade, a exceção vale até ser removida."
        type="date"
        value={expires}
        onChange={(event) => setExpires(event.target.value)}
        error={errors['expiresAt']}
      />
      <FormError error={batch.error} />
      <Button size="sm" className="max-md:h-11" disabled={batch.isPending} onClick={submit}>
        {batch.isPending ? 'Criando…' : `Criar ${plural(values.length, 'exceção', 'exceções')}`}
      </Button>
    </div>
  );
}

const SEVERITY_WORDS: Readonly<Record<ScopedExceptionSeverity, string>> = {
  low: 'baixa',
  medium: 'média',
  high: 'alta',
};
const SEVERITY_OPTIONS = SCOPED_EXCEPTION_SEVERITIES.map((severity) => ({
  value: severity,
  label: `Até ${SEVERITY_WORDS[severity]}`,
}));

/** O fim do diálogo: a mensagem e o que a criação fez com os alertas em aberto. */
function Done({ message, children }: { message: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm font-medium">
        {message}
      </p>
      {children}
    </div>
  );
}

function WideForm({ target, onDone }: { target: Target; onDone: (message: ReactNode) => void }) {
  const [eventName, setEventName] = useState(target.eventName ?? '');
  const [resourcePrefix, setResourcePrefix] = useState('');
  const [maxSeverity, setMaxSeverity] = useState<ScopedExceptionSeverity>('medium');
  const [reason, setReason] = useState('');
  const [expires, setExpires] = useState(dateInDays(30));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [previewed, setPreviewed] = useState<string | null>(null);
  const preview = useScopedPreview();
  const openPreview = useScopedOpenPreview();
  const create = useCreateScoped();

  const targetInput = {
    ruleId: target.ruleId,
    logSource: target.logSource,
    accountId: target.accountId,
    ...(eventName.trim() !== '' && { eventName: eventName.trim() }),
    ...(resourcePrefix.trim() !== '' && { resourcePrefix: resourcePrefix.trim() }),
    maxSeverity,
  };
  const key = JSON.stringify(targetInput);
  const current = previewed === key && preview.data !== undefined;

  const check = (): boolean => {
    const parsed = scopedExceptionCreateSchema.safeParse({
      ...targetInput,
      reason: reason || '-',
      expiresAt: endOfDay(expires),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return false;
    }
    setErrors({});
    return true;
  };
  const runPreview = () => {
    if (!check()) return;
    preview.mutate(targetInput, { onSuccess: () => setPreviewed(key) });
    // Os alertas em aberto que ela resolve agora. Um nó de antes não tem a rota: a linha só não aparece.
    openPreview.mutate(targetInput);
  };
  const save = () => {
    const parsed = scopedExceptionCreateSchema.safeParse({
      ...targetInput,
      reason,
      expiresAt: endOfDay(expires),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    create.mutate(parsed.data, {
      onSuccess: (created) =>
        onDone(
          <Done message="Exceção ampla criada. Ela aparece na tela Exceções, onde pode ser revogada.">
            <OpenAlertsResult resolution={created.openAlerts} kind="scoped" exceptionId={created.id} />
          </Done>,
        ),
    });
  };

  return (
    <div className="space-y-4">
      <Field
        label={
          scopedExceptionNeedsEvent(target.ruleId) ? 'Evento (obrigatório nesta regra)' : 'Evento (opcional)'
        }
        hint="O CVE, o controle ou o tipo do achado. Em branco, vale para todos os eventos da regra nesta conta."
        value={eventName}
        onChange={(event) => setEventName(event.target.value)}
        error={errors['eventName']}
      />
      <Field
        label="Começo do recurso (opcional)"
        hint="Por exemplo, o ARN de um repositório do ECR terminado em /. Comparado como texto, letra por letra."
        value={resourcePrefix}
        onChange={(event) => setResourcePrefix(event.target.value)}
        error={errors['resourcePrefix']}
      />
      <SelectInput
        label="Severidade"
        value={maxSeverity}
        onChange={(event) => setMaxSeverity(event.target.value as ScopedExceptionSeverity)}
        options={SEVERITY_OPTIONS}
      />
      <p className="text-xs text-muted-foreground">
        Crítico nunca entra. Se a severidade de um alerta subir acima da escolhida, ele volta para a fila.
      </p>
      <TextAreaField
        label="Motivo (obrigatório)"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={errors['reason']}
        maxLength={500}
      />
      <Field
        label="Validade (obrigatória)"
        hint={`Até ${SCOPED_EXCEPTION_MAX_DAYS} dias.`}
        type="date"
        min={dateInDays(1)}
        max={dateInDays(SCOPED_EXCEPTION_MAX_DAYS - 1)}
        value={expires}
        onChange={(event) => setExpires(event.target.value)}
        error={errors['expiresAt']}
      />
      {errors['ruleId'] && <p className="text-sm text-critical-text">{errors['ruleId']}</p>}
      <div aria-live="polite" className="text-sm">
        {current && preview.data && (
          <div className="space-y-2">
            <p className="rounded-md border p-2 font-medium">{previewText(preview.data)}</p>
            <OpenAlertsPreview
              preview={JSON.stringify(openPreview.variables) === key ? openPreview.data : undefined}
            />
          </div>
        )}
      </div>
      <FormError error={preview.error ?? create.error} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          className="max-md:h-11"
          disabled={preview.isPending}
          onClick={runPreview}
        >
          {preview.isPending ? 'Contando…' : 'Ver prévia'}
        </Button>
        <Button size="sm" className="max-md:h-11" disabled={!current || create.isPending} onClick={save}>
          {create.isPending ? 'Salvando…' : 'Salvar exceção ampla'}
        </Button>
      </div>
      {!current && <p className="text-xs text-muted-foreground">Veja a prévia antes de salvar.</p>}
    </div>
  );
}
