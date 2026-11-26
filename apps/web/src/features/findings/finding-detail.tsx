import {
  type AlertExceptionField,
  type FindingDetail,
  type FindingStatus,
  type Permission,
  RAW_EVENT_RETENTION_DAYS,
} from '@verax/shared';
import { ChevronRight } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { FindingTriageTrail } from '@/features/cases/finding-triage-trail';
import { useAlertExceptionOpenPreview } from '@/features/exception-open-alerts/open-alerts-api';
import { OpenAlertsPreview, OpenAlertsResult } from '@/features/exception-open-alerts/open-alerts-view';
import { selectionSearch } from '@/features/detections/url-state';
import { AttachForm, PromoteDialog } from '@/features/incidents/incident-actions';
import { usePlanHistory } from '@/features/plan/plan-history';
import { useMe } from '@/features/session/session';
import { errorMessage } from '@/lib/errors';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { FindingEvidenceSection } from './finding-evidence';
import { FindingStatusBadge } from './finding-status-badge';
import { useAddFindingComment, useCreateAlertException, useUpdateFindingStatus } from './findings-api';

/**
 * De onde vem a regra do alerta, quando não é a do Wazuh para os logs da AWS. Os achados lidos pela API do Security
 * Hub, do Inspector e do IAM Access Analyzer têm regras do próprio nó, uma por classe de achado; os ataques web vistos nos
 * logs dos balanceadores, as do motor do nó.
 */
const RULE_LABELS: Partial<Record<FindingDetail['source'], string>> = {
  security_hub: 'Regra (achados do Security Hub)',
  inspector: 'Regra (achados do Inspector)',
  access_analyzer: 'Regra (achados do IAM Access Analyzer)',
  alb: 'Regra (logs de acesso do ALB)',
  gcp_audit: 'Regra (auditoria da GCP)',
  cloudflare_audit: 'Regra (auditoria do Cloudflare)',
  cloudflare_waf: 'Regra (eventos de segurança do Cloudflare)',
  wazuh_agent: 'Regra (agente do Wazuh)',
};

/**
 * Detalhe do alerta (tela Detecções, no painel ao lado da lista): os campos, o MITRE, o incidente ou a validação
 * (promover a incidente, anexar a um incidente aberto), a triagem com a exceção, os comentários e o evento bruto. O alerta
 * dos logs do ALB não tem evento bruto (nenhuma linha do log fica guardada): no lugar dele, a evidência.
 */
export function FindingDetailView({ finding }: { finding: FindingDetail }) {
  const { data: me } = useMe();
  const [params] = useSearchParams();
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
    // No Cloudflare, o campo guarda o ID do token de API usado na ação (não é segredo).
    [
      finding.source === 'cloudflare_audit' ? 'ID do token de API' : 'Chave de acesso',
      finding.actor.accessKeyId,
    ],
    ['IP de origem', finding.actor.ip],
    [
      // Os alertas dos logs da AWS e dos agentes vêm das regras do Wazuh; os dos achados lidos pela API da AWS, da GCP
      // e do Cloudflare, das regras do próprio nó.
      RULE_LABELS[finding.source] ?? 'Regra (logs da AWS)',
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

      {/* E-03: a decisão num quadro só, logo abaixo dos selos (no alerta do balanceador, antes da evidência). */}
      {finding.incidentId && (
        <p className="rounded-md border bg-foreground/[0.03] p-3 text-sm">
          Este alerta foi confirmado como parte de um incidente.{' '}
          <Link
            to={{ search: selectionSearch(params, { kind: 'incident', id: finding.incidentId }) }}
            className="font-medium underline"
          >
            Ver incidente
          </Link>
        </p>
      )}
      {(can('findings:triage') || (can('incidents:write') && !finding.incidentId)) && (
        <AlertDecision
          finding={finding}
          canIncidents={can('incidents:write')}
          canTriage={can('findings:triage')}
          canCreateException={can('alert_exceptions:write')}
        />
      )}

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

      {finding.source === 'alb' && <FindingEvidenceSection finding={finding} />}

      <FindingTriageTrail findingId={finding.id} />

      <Comments finding={finding} canComment={can('findings:triage')} />

      {(finding.source !== 'alb' || finding.rawEvent) && (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">Evento bruto</summary>
          <RawEventRetention />
          {finding.rawEvent ? (
            // Rola por dentro: o foco pelo teclado deixa ler o evento inteiro sem mouse.
            <pre
              role="region"
              aria-label="Evento bruto do log"
              tabIndex={0}
              className="max-h-96 overflow-auto border-t bg-foreground/[0.03] p-3 text-xs"
            >
              {JSON.stringify(finding.rawEvent, null, 2)}
            </pre>
          ) : (
            <p className="border-t p-3 text-sm text-muted-foreground">
              O evento bruto deste alerta não está disponível.
            </p>
          )}
        </details>
      )}
    </>
  );
}

/**
 * Quanto tempo o evento bruto fica (a retenção do índice do Wazuh) e, com o plano conhecido, quanto tempo ficam os
 * dados do alerta, que seguem o histórico do plano.
 */
function RawEventRetention() {
  const history = usePlanHistory();
  const days = history.data?.historyDays;
  return (
    <p className="border-t px-3 py-2 text-xs text-muted-foreground">
      Evento bruto do log disponível por {RAW_EVENT_RETENTION_DAYS} dias.
      {typeof days === 'number' &&
        ` Os dados do alerta acima ficam pelo histórico do plano, de ${days} dias.`}
    </p>
  );
}

/** Uma resposta da decisão: o que ela é e, numa linha, o que ela faz (como no diálogo da triagem em massa). */
interface DecisionOption {
  key: string;
  title: string;
  detail: string;
  run: () => void;
}

/**
 * "O que você decide?" (E-03): um quadro só no lugar de "Validar o alerta" e "Mudar status". Três respostas explicadas,
 * nenhuma em destaque (não há uma resposta certa): ameaça real (promover, com o diálogo de sempre), esperado (legítimo,
 * com a oferta da exceção) e ainda não sei (em análise). "Mais opções" guarda anexar a um incidente aberto, marcar como
 * resolvido e reabrir. Uma caixa de texto só: o porquê vai junto com a decisão e fica nos comentários.
 */
function AlertDecision({
  finding,
  canIncidents,
  canTriage,
  canCreateException,
}: {
  finding: FindingDetail;
  canIncidents: boolean;
  canTriage: boolean;
  canCreateException: boolean;
}) {
  const baseId = useId();
  const [comment, setComment] = useState('');
  const [offerException, setOfferException] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const update = useUpdateFindingStatus(finding.id);
  const addComment = useAddFindingComment(finding.id);
  const open = finding.incidentId === null;
  const text = comment.trim();

  const change = (status: FindingStatus) => {
    update.mutate(text ? { status, comment: text } : { status }, {
      onSuccess: () => {
        setComment('');
        setOfferException(status === 'legitimate' && canCreateException);
      },
    });
  };
  // Promover não leva comentário na API: o porquê entra nos comentários do alerta logo depois.
  const promoted = () => {
    if (text) addComment.mutate(text, { onSuccess: () => setComment('') });
  };

  const options: DecisionOption[] = [
    ...(canIncidents && open
      ? [
          {
            key: 'promote',
            title: 'É uma ameaça real',
            detail:
              'Abre um incidente com este alerta e os relacionados. Pede confirmação e avisa por e-mail.',
            run: () => setPromoting(true),
          },
        ]
      : []),
    ...(canTriage && finding.status !== 'legitimate'
      ? [
          {
            key: 'legitimate',
            title: 'É esperado (falso positivo)',
            detail: 'Marca como legítimo. Depois, o painel oferece criar a exceção.',
            run: () => change('legitimate'),
          },
        ]
      : []),
    ...(canTriage && finding.status !== 'investigating'
      ? [
          {
            key: 'investigating',
            title: 'Ainda não sei',
            detail: 'Fica em análise e continua pendente.',
            run: () => change('investigating'),
          },
        ]
      : []),
  ];
  const more: { key: string; label: string; run: () => void; expanded?: boolean }[] = [
    ...(canIncidents && open
      ? [
          {
            key: 'attach',
            label: 'Anexar a um incidente aberto',
            run: () => setAttaching(!attaching),
            expanded: attaching,
          },
        ]
      : []),
    ...(canTriage && finding.status !== 'resolved'
      ? [{ key: 'resolved', label: 'Marcar como resolvido', run: () => change('resolved') }]
      : []),
    ...(canTriage && finding.status !== 'new'
      ? [{ key: 'new', label: 'Reabrir', run: () => change('new') }]
      : []),
  ];
  const busy = update.isPending || addComment.isPending;

  return (
    <section
      data-tour="achado-triagem"
      aria-labelledby={`${baseId}-titulo`}
      className="space-y-3 rounded-md border bg-foreground/[0.03] p-3"
    >
      <h3 id={`${baseId}-titulo`} className="text-sm font-semibold">
        O que você decide?
      </h3>
      <ul data-tour="alerta-validacao" className="space-y-2">
        {options.map((option) => (
          <li key={option.key}>
            <button
              type="button"
              disabled={busy}
              aria-labelledby={`${baseId}-${option.key}-nome`}
              aria-describedby={`${baseId}-${option.key}`}
              onClick={option.run}
              className="flex min-h-11 w-full flex-col items-start rounded-md border bg-surface px-3 py-2 text-left text-sm hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
            >
              <span id={`${baseId}-${option.key}-nome`} className="font-medium">
                {option.title}
              </span>
              <span id={`${baseId}-${option.key}`} className="text-xs text-muted-foreground">
                {option.detail}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {more.length > 0 && (
        <details className="group">
          <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              aria-hidden
              className="size-4 group-open:rotate-90 motion-safe:transition-transform"
            />
            Mais opções
          </summary>
          <div className="mt-2 flex flex-wrap gap-2">
            {more.map((item) => (
              <Button
                key={item.key}
                variant="secondary"
                size="sm"
                className="max-sm:min-h-11"
                disabled={busy}
                aria-expanded={item.expanded}
                onClick={item.run}
              >
                {item.label}
              </Button>
            ))}
          </div>
          {attaching && <AttachForm finding={finding} onCancel={() => setAttaching(false)} />}
        </details>
      )}
      <div className="space-y-1">
        <label htmlFor={`${baseId}-porque`} className="text-sm font-medium">
          Por quê? <span className="font-normal text-muted-foreground">(opcional)</span>
        </label>
        <Textarea
          id={`${baseId}-porque`}
          aria-describedby={`${baseId}-porque-nota`}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          maxLength={2000}
        />
        <p id={`${baseId}-porque-nota`} className="text-xs text-muted-foreground">
          Vai junto com a decisão e fica nos comentários.
        </p>
      </div>
      {(update.error ?? addComment.error) && (
        <p role="alert" className="text-sm text-critical-text">
          {errorMessage(update.error ?? addComment.error)}
        </p>
      )}
      {offerException && <ExceptionOffer finding={finding} onDone={() => setOfferException(false)} />}
      {canIncidents && open && (
        <PromoteDialog finding={finding} open={promoting} onOpenChange={setPromoting} onCreated={promoted} />
      )}
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
  const preview = useAlertExceptionOpenPreview(
    chosen && !create.isSuccess ? { ruleId: finding.ruleId, field: chosen.field, value: chosen.value } : null,
  );

  if (create.isSuccess) {
    return (
      <div className="space-y-2 rounded-md border border-ok/50 bg-ok/10 p-3">
        <p role="status" className="text-sm">
          Exceção criada: alertas da regra {finding.ruleId} com {chosen?.label.toLowerCase()} {chosen?.value}{' '}
          passam a ser marcados como esperados.
        </p>
        <OpenAlertsResult
          resolution={create.data.openAlerts}
          kind="alert"
          exceptionId={create.data.id}
          nested
        />
      </div>
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
        Os que estão em aberto agora são resolvidos junto; os que estão em incidente ficam.
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
      <div aria-live="polite">
        <OpenAlertsPreview preview={preview.data} />
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
