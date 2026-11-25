import {
  isTrustedExpiryValid,
  normalizeTrustedCidr,
  WEB_TRUSTED_KINDS,
  type WebLogSource,
  type WebTrustedKind,
  type WebTrustedSource,
  webTrustedSourceCreateSchema,
  webTrustedSourceUpdateSchema,
} from '@verax/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { SelectInput, TextAreaField } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { Notice, Tag } from '@/features/admin/aws-ui';
import { formatDate, formatList, plural } from '@/lib/format';
import { dateInput, endOfDay } from './web-forms';
import {
  useCreateTrusted,
  useRemoveTrusted,
  useTrustedSources,
  useUpdateTrusted,
  useWebLogSource,
} from './web-logs-api';
import {
  NEVER_SILENCED_RULES,
  SILENCED_RULES,
  WEB_TRUSTED_KIND_TEXTS,
  webLogsErrorText,
  webRuleTitle,
} from './web-logs-labels';

const KIND_OPTIONS = WEB_TRUSTED_KINDS.map((kind) => ({
  value: kind,
  label: WEB_TRUSTED_KIND_TEXTS[kind].label,
}));
const ALL_BALANCERS = '';
/** Um título no meio de uma frase: só a primeira letra em minúscula. */
const inSentence = (title: string): string => `${title.charAt(0).toLowerCase()}${title.slice(1)}`;
const DAY_MS = 24 * 60 * 60 * 1000;

/** O formulário da fonte nova aberto, no lugar do ID da que está sendo alterada. */
const NEW = 'nova';

interface FormValues {
  sourceId: string;
  cidr: string;
  kind: WebTrustedKind;
  reason: string;
  expires: string;
}

/** O formulário de uma fonte confiável: na nova, tudo; na alteração, o tipo, o motivo e a validade. */
function TrustedForm({
  trusted,
  balancers,
  onDone,
}: {
  trusted: WebTrustedSource | null;
  balancers: readonly WebLogSource[];
  onDone: (saved: boolean) => void;
}) {
  const [now] = useState(() => new Date());
  const [values, setValues] = useState<FormValues>(() =>
    trusted === null
      ? {
          sourceId: ALL_BALANCERS,
          cidr: '',
          kind: 'office',
          reason: '',
          expires: dateInput(new Date(now.getTime() + 90 * DAY_MS)),
        }
      : {
          sourceId: trusted.sourceId ?? ALL_BALANCERS,
          cidr: trusted.cidr,
          kind: trusted.kind,
          reason: trusted.reason,
          expires: dateInput(new Date(trusted.expiresAt)),
        },
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateTrusted();
  const update = useUpdateTrusted();
  const form = useRef<HTMLFormElement>(null);
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('input, select, textarea')?.focus();
  }, []);

  const set =
    (key: keyof FormValues) =>
    (event: { target: { value: string } }): void => {
      setValues((current) => ({ ...current, [key]: event.target.value }));
      setErrors({});
    };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    const expires = endOfDay(values.expires);
    if (expires === null || !isTrustedExpiryValid(expires, new Date())) {
      found['expires'] = 'Uma data a partir de hoje, em até 365 dias.';
    }
    if (trusted === null && normalizeTrustedCidr(values.cidr.trim()) === null) {
      found['cidr'] =
        'Uma faixa como 192.0.2.10/32 ou 198.51.100.0/24: IPv4 de /16 a /32, IPv6 de /32 a /64, com o endereço da rede.';
    }
    const shared = {
      kind: values.kind,
      reason: values.reason,
      expiresAt: (expires ?? now).toISOString(),
    };
    const parsed = webTrustedSourceUpdateSchema.safeParse(shared);
    if (!parsed.success) {
      for (const [key, message] of Object.entries(fieldErrors(parsed.error))) found[key] ??= message;
    }
    setErrors(found);
    if (Object.keys(found).length > 0 || !parsed.success) return;
    if (trusted !== null) {
      update.mutate({ id: trusted.id, input: parsed.data }, { onSuccess: () => onDone(true) });
      return;
    }
    const input = webTrustedSourceCreateSchema.parse({
      ...shared,
      sourceId: values.sourceId === ALL_BALANCERS ? null : values.sourceId,
      cidr: values.cidr,
    });
    create.mutate(input, { onSuccess: () => onDone(true) });
  };

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-label={trusted === null ? 'Incluir fonte confiável' : `Alterar a fonte confiável ${trusted.cidr}`}
      className="space-y-3 rounded-md border border-border-strong p-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {trusted === null ? (
          <>
            <Field
              label="Faixa de endereços"
              hint="Como 192.0.2.10/32 (um endereço) ou 198.51.100.0/24. Quanto menor, melhor."
              value={values.cidr}
              onChange={set('cidr')}
              error={errors['cidr']}
              autoComplete="off"
              spellCheck={false}
            />
            <SelectInput
              label="Onde vale"
              value={values.sourceId}
              onChange={set('sourceId')}
              options={[
                { value: ALL_BALANCERS, label: 'Todos os balanceadores do cliente' },
                ...balancers.map((item) => ({ value: item.id, label: `Só ${item.name} (${item.region})` })),
              ]}
            />
          </>
        ) : (
          <p className="text-sm wrap-anywhere sm:col-span-2">
            <span className="font-mono text-xs">{trusted.cidr}</span>
            <span className="block text-xs text-muted-foreground">
              A faixa e onde ela vale não mudam: para outra, inclua outra fonte confiável.
            </span>
          </p>
        )}
        <div className="space-y-1">
          <SelectInput label="O que é" value={values.kind} onChange={set('kind')} options={KIND_OPTIONS} />
          <p className="text-xs text-muted-foreground">{WEB_TRUSTED_KIND_TEXTS[values.kind].hint}</p>
        </div>
        <Field
          type="date"
          label="Vale até"
          hint="Obrigatório, em até 365 dias. Vencida, deixa de valer sozinha."
          value={values.expires}
          min={dateInput(now)}
          max={dateInput(new Date(now.getTime() + 364 * DAY_MS))}
          onChange={set('expires')}
          error={errors['expires']}
        />
      </div>
      <TextAreaField
        label="Motivo"
        hint="Fica na auditoria: de quem é o endereço e por que confiar nele."
        value={values.reason}
        onChange={set('reason')}
        error={errors['reason']}
        maxLength={200}
        rows={2}
      />
      {values.kind !== 'proxy' && (
        <Notice tone="medium" title="O que esta fonte deixa de abrir, e o que nunca deixa.">
          <p>
            Cala só: {formatList(SILENCED_RULES.map((rule) => inSentence(webRuleTitle(rule))))}. Continua
            contando, e a contagem do que foi calado aparece na leitura do balanceador.
          </p>
          <p>
            <strong>Nunca cala:</strong>{' '}
            {formatList(NEVER_SILENCED_RULES.map((rule) => inSentence(webRuleTitle(rule))))}. Um endereço de
            confiança também pode ser invadido.
          </p>
        </Notice>
      )}
      {error ? (
        <p role="alert" className="text-sm text-critical-text">
          {webLogsErrorText(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Salvando…' : trusted === null ? 'Incluir fonte confiável' : 'Salvar alteração'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onDone(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** Onde a fonte vale: todos, o balanceador desta conta pelo nome, ou o de outra conta (lido à parte). */
function Scope({ trusted, balancers }: { trusted: WebTrustedSource; balancers: readonly WebLogSource[] }) {
  const { sourceId } = trusted;
  const own = balancers.find((item) => item.id === sourceId);
  const other = useWebLogSource(sourceId ?? '', sourceId !== null && own === undefined);
  if (sourceId === null) return <>Todos os balanceadores do cliente</>;
  if (own !== undefined) return <>Só {own.name}</>;
  return other.data == null ? (
    <>Só um balanceador de outra conta</>
  ) : (
    <>
      Só {other.data.name} (conta {other.data.accountId})
    </>
  );
}

/**
 * As fontes confiáveis do cliente: endereços conhecidos, de quem não se quer alerta de varredura nem de força bruta. São do
 * cliente inteiro (de todos os balanceadores ou de um), com validade obrigatória, e nunca calam o que é sinal de invasão.
 */
export function TrustedPanel({
  balancers,
  canWrite,
}: {
  /** Os balanceadores da conta em que uma fonte nova pode valer. */
  balancers: readonly WebLogSource[];
  canWrite: boolean;
}) {
  const query = useTrustedSources();
  const remove = useRemoveTrusted();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WebTrustedSource | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const close = () => {
    const opener = editing;
    setEditing(null);
    // O botão que abriu o formulário volta a existir no próximo quadro: o foco volta para ele ou, se ele saiu, para a lista.
    requestAnimationFrame(() => {
      const button = [...(list.current?.querySelectorAll('button') ?? [])].find(
        (candidate) => candidate.dataset['abre'] === opener,
      );
      if (button !== undefined && !button.disabled) button.focus();
      else list.current?.focus();
    });
  };

  if (query.error && query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) return <LoadingState rows={2} label="Carregando as fontes confiáveis" />;
  if (query.data === null) return null;
  const { items, limit } = query.data;
  const full = items.length >= limit;
  const expired = items.filter((item) => !item.active).length;

  return (
    <div ref={list} tabIndex={-1} className="space-y-3 text-sm focus:outline-none">
      <p className="text-muted-foreground">
        Endereços que você conhece (o monitor do site, a saída do escritório, um teste de invasão contratado):
        deixam de abrir alerta de varredura e de força bruta por um endereço. Só a faixa de endereços vale;
        dizer ser um robô conhecido nunca isenta ninguém.
      </p>
      <p role="status" className="text-xs text-muted-foreground">
        {plural(items.length, 'fonte confiável', 'fontes confiáveis')} de {limit}, somadas as de todas as
        contas do cliente
        {expired > 0 && ` (${plural(expired, 'vencida', 'vencidas')})`}.
      </p>
      {items.length > 0 && (
        <ul aria-label="Fontes confiáveis" className="divide-y rounded-md border">
          {items.map((trusted) => (
            <li key={trusted.id} className="space-y-1.5 px-3 py-2">
              {editing === trusted.id ? (
                <TrustedForm trusted={trusted} balancers={balancers} onDone={close} />
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 font-mono text-xs wrap-anywhere">{trusted.cidr}</span>
                    <Tag>{WEB_TRUSTED_KIND_TEXTS[trusted.kind].label}</Tag>
                    {!trusted.active && <Tag>Vencida: não vale mais</Tag>}
                  </p>
                  <p className="wrap-anywhere">{trusted.reason}</p>
                  <p className="text-xs text-muted-foreground wrap-anywhere">
                    <Scope trusted={trusted} balancers={balancers} />.{' '}
                    {trusted.active ? 'Vale até' : 'Venceu em'} {formatDate(trusted.expiresAt)}.
                  </p>
                  {canWrite && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={editing !== null}
                        aria-label={`${trusted.active ? 'Alterar' : 'Renovar'} a fonte confiável ${trusted.cidr}`}
                        data-abre={trusted.id}
                        onClick={() => setEditing(trusted.id)}
                      >
                        {trusted.active ? 'Alterar' : 'Renovar'}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={editing !== null}
                        aria-label={`Remover a fonte confiável ${trusted.cidr}`}
                        onClick={() => {
                          remove.reset();
                          setRemoving(trusted);
                        }}
                      >
                        Remover
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && editing === NEW && <TrustedForm trusted={null} balancers={balancers} onDone={close} />}
      {canWrite && editing !== NEW && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={full || editing !== null}
          data-abre={NEW}
          onClick={() => setEditing(NEW)}
        >
          Incluir fonte confiável
        </Button>
      )}
      {canWrite && full && (
        <p className="text-xs text-muted-foreground">
          O cliente chegou ao limite de {limit} fontes confiáveis. Remova uma para incluir outra.
        </p>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title="Remover a fonte confiável"
        description={
          removing === null
            ? ''
            : `${removing.cidr} volta a abrir alerta como qualquer outro endereço, na próxima leitura. A remoção fica na auditoria.`
        }
        confirmLabel="Remover fonte confiável"
        busyLabel="Removendo…"
        danger
        busy={remove.isPending}
        error={remove.error ? webLogsErrorText(remove.error) : null}
        onConfirm={() => {
          if (removing !== null) remove.mutate(removing.id, { onSuccess: () => setRemoving(null) });
        }}
        fallbackFocus={list}
      />
    </div>
  );
}
