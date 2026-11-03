import {
  type AlertExceptionField,
  type FindingDetail,
  type FindingStatus,
  FINDING_STATUSES,
  type Permission,
} from '@verax/shared';
import { type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { useMe } from '@/features/session/session';
import { errorMessage } from '@/lib/errors';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { FindingStatusBadge } from './finding-status-badge';
import {
  useAddFindingComment,
  useCreateAlertException,
  useFinding,
  useUpdateFindingStatus,
} from './findings-api';
import { FINDING_SOURCE_LABELS } from './labels';

/** Detalhe do achado num painel lateral (T7.7): evento bruto, status, comentários e exceção. */
export function FindingPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const finding = useFinding(id);
  return (
    <Sheet
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={finding.data?.title ?? 'Achado'}
      description={
        finding.data
          ? `${FINDING_SOURCE_LABELS[finding.data.source]} · conta ${finding.data.accountId}`
          : undefined
      }
    >
      {finding.isError ? (
        <ErrorState error={finding.error} onRetry={() => void finding.refetch()} />
      ) : !finding.data ? (
        <LoadingState rows={6} label="Carregando o achado" />
      ) : (
        <FindingDetailView key={finding.data.id} finding={finding.data} />
      )}
    </Sheet>
  );
}

function FindingDetailView({ finding }: { finding: FindingDetail }) {
  const { data: me } = useMe();
  const can = (permission: Permission) => me?.permissions.includes(permission) === true;
  const fields: [string, string | null][] = [
    ['Quando', `${formatTimestamp(finding.occurredAt)} (${formatRelative(finding.occurredAt)})`],
    ['Evento', finding.eventName],
    ['Região', finding.region],
    ['Recurso', finding.resource],
    [
      'Usuário',
      finding.actor.user && `${finding.actor.user}${finding.actor.type ? ` (${finding.actor.type})` : ''}`,
    ],
    ['Chave de acesso', finding.actor.accessKeyId],
    ['IP de origem', finding.actor.ip],
    [
      // Os alertas da AWS vêm das regras do Wazuh; os da GCP, das regras do próprio nó.
      finding.source === 'gcp_audit' ? 'Regra (auditoria da GCP)' : 'Regra do Wazuh',
      `${finding.ruleId} (nível ${finding.ruleLevel})`,
    ],
  ];
  const mitre = [...finding.mitreTactics, ...finding.mitreTechniques];

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <FindingStatusBadge status={finding.status} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {fields
          .filter((entry): entry is [string, string] => Boolean(entry[1]))
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-medium">{value}</dd>
            </div>
          ))}
      </dl>

      {mitre.length > 0 && (
        <section aria-label="MITRE ATT&CK" className="space-y-1">
          <h3 className="text-sm font-semibold">MITRE ATT&CK</h3>
          <ul className="flex flex-wrap gap-1.5">
            {mitre.map((item) => (
              <li key={item} className="rounded border px-2 py-0.5 text-xs">
                {item}
              </li>
            ))}
          </ul>
        </section>
      )}

      {finding.incidentId && (
        <p className="rounded-md border bg-foreground/[0.03] p-3 text-sm">
          Este achado faz parte de um incidente.{' '}
          <Link to={`/incidentes/${finding.incidentId}`} className="font-medium underline">
            Ver incidente
          </Link>
        </p>
      )}

      {can('findings:triage') && (
        <StatusActions finding={finding} canCreateException={can('alert_exceptions:write')} />
      )}

      <Comments finding={finding} canComment={can('findings:triage')} />

      <details className="rounded-md border">
        <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Evento bruto</summary>
        {finding.rawEvent ? (
          <pre className="max-h-96 overflow-auto border-t bg-foreground/[0.03] p-3 text-xs">
            {JSON.stringify(finding.rawEvent, null, 2)}
          </pre>
        ) : (
          <p className="border-t p-3 text-sm text-muted-foreground">
            O evento bruto já saiu da retenção de 90 dias do indexer.
          </p>
        )}
      </details>
    </>
  );
}

const ACTION_LABELS: Record<FindingStatus, string> = {
  new: 'Reabrir',
  investigating: 'Colocar em análise',
  legitimate: 'Marcar como legítimo',
  resolved: 'Marcar como resolvido',
};

function StatusActions({
  finding,
  canCreateException,
}: {
  finding: FindingDetail;
  canCreateException: boolean;
}) {
  const commentId = useId();
  const [comment, setComment] = useState('');
  const [offerException, setOfferException] = useState(false);
  const update = useUpdateFindingStatus(finding.id);

  const change = (status: FindingStatus) => {
    const text = comment.trim();
    update.mutate(text ? { status, comment: text } : { status }, {
      onSuccess: () => {
        setComment('');
        setOfferException(status === 'legitimate' && canCreateException);
      },
    });
  };

  return (
    <section data-tour="achado-triagem" aria-labelledby={`${commentId}-titulo`} className="space-y-2">
      <h3 id={`${commentId}-titulo`} className="text-sm font-semibold">
        Mudar status
      </h3>
      <label htmlFor={commentId} className="text-xs text-muted-foreground">
        Comentário (opcional): por que a decisão
      </label>
      <Textarea
        id={commentId}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        maxLength={2000}
      />
      <div className="flex flex-wrap gap-2">
        {FINDING_STATUSES.filter((status) => status !== finding.status).map((status) => (
          <Button
            key={status}
            variant={status === 'resolved' ? 'primary' : 'secondary'}
            size="sm"
            disabled={update.isPending}
            onClick={() => change(status)}
          >
            {ACTION_LABELS[status]}
          </Button>
        ))}
      </div>
      {update.error && (
        <p role="alert" className="text-sm text-critical-text">
          {errorMessage(update.error)}
        </p>
      )}
      {offerException && <ExceptionOffer finding={finding} onDone={() => setOfferException(false)} />}
    </section>
  );
}

const EXCEPTION_FIELDS: {
  field: AlertExceptionField;
  label: string;
  value: (f: FindingDetail) => string | null;
}[] = [
  { field: 'user', label: 'Usuário', value: (f) => f.actor.user },
  { field: 'ip', label: 'IP de origem', value: (f) => f.actor.ip },
  { field: 'resource', label: 'Recurso', value: (f) => f.resource },
];

/** Depois de "legítimo": oferecer a exceção, para alertas iguais não voltarem como novos (T5.5 e T3.5). */
function ExceptionOffer({ finding, onDone }: { finding: FindingDetail; onDone: () => void }) {
  const reasonId = useId();
  const options = EXCEPTION_FIELDS.flatMap((option) => {
    const value = option.value(finding);
    return value ? [{ ...option, value }] : [];
  });
  const [field, setField] = useState<AlertExceptionField | undefined>(options[0]?.field);
  const [reason, setReason] = useState('');
  const create = useCreateAlertException();
  const chosen = options.find((option) => option.field === field);

  if (create.isSuccess) {
    return (
      <p role="status" className="rounded-md border border-ok/50 bg-ok/10 p-3 text-sm">
        Exceção criada: alertas da regra {finding.ruleId} com {chosen?.label.toLowerCase()} {chosen?.value}{' '}
        passam a ser marcados como esperados.
      </p>
    );
  }
  if (options.length === 0) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen || !reason.trim()) return;
    create.mutate({
      ruleId: finding.ruleId,
      field: chosen.field,
      value: chosen.value,
      reason: reason.trim(),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border bg-foreground/[0.03] p-3">
      <p className="text-sm font-medium">Criar exceção para alertas iguais?</p>
      <p className="text-xs text-muted-foreground">
        Alertas futuros da regra {finding.ruleId} com o mesmo valor entram como esperados, sem pedir decisão.
      </p>
      <fieldset className="space-y-1">
        <legend className="text-xs text-muted-foreground">Comparar por</legend>
        {options.map((option) => (
          <label key={option.field} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${reasonId}-campo`}
              checked={field === option.field}
              onChange={() => setField(option.field)}
            />
            {option.label}: <span className="break-all font-mono text-xs">{option.value}</span>
          </label>
        ))}
      </fieldset>
      <div className="space-y-1">
        <label htmlFor={reasonId} className="text-xs text-muted-foreground">
          Motivo (obrigatório)
        </label>
        <Textarea
          id={reasonId}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxLength={500}
        />
      </div>
      {create.error && (
        <p role="alert" className="text-sm text-critical-text">
          {errorMessage(create.error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={create.isPending || !reason.trim()}>
          Criar exceção
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Agora não
        </Button>
      </div>
    </form>
  );
}

function Comments({ finding, canComment }: { finding: FindingDetail; canComment: boolean }) {
  const bodyId = useId();
  const [body, setBody] = useState('');
  const add = useAddFindingComment(finding.id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    add.mutate(text, { onSuccess: () => setBody('') });
  };

  return (
    <section aria-labelledby={`${bodyId}-titulo`} className="space-y-3">
      <h3 id={`${bodyId}-titulo`} className="text-sm font-semibold">
        Comentários ({finding.comments.length})
      </h3>
      {finding.comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum comentário ainda.</p>
      ) : (
        <ol className="space-y-2">
          {finding.comments.map((comment) => (
            <li key={comment.id} className="rounded-md border p-3 text-sm">
              <p className="text-xs text-muted-foreground">
                {comment.author.name} · {formatRelative(comment.createdAt)}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{comment.body}</p>
            </li>
          ))}
        </ol>
      )}
      {canComment && (
        <form onSubmit={submit} className="space-y-2">
          <label htmlFor={bodyId} className="sr-only">
            Novo comentário
          </label>
          <Textarea
            id={bodyId}
            placeholder="Escreva um comentário"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            maxLength={2000}
          />
          {add.error && (
            <p role="alert" className="text-sm text-critical-text">
              {errorMessage(add.error)}
            </p>
          )}
          <Button type="submit" size="sm" variant="secondary" disabled={add.isPending || !body.trim()}>
            Comentar
          </Button>
        </form>
      )}
    </section>
  );
}
