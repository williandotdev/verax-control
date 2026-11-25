import {
  WEB_ROUTE_KINDS,
  WEB_ROUTE_METHODS,
  type WebRoute,
  webRouteCreateSchema,
  type WebRouteKind,
  type WebRouteMethod,
  webRouteUpdateSchema,
} from '@verax/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { SelectInput } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { Tag } from '@/features/admin/aws-ui';
import { plural } from '@/lib/format';
import { formatMultiplier, MULTIPLIER_ERROR, parseCodes, parseMultiplier, routeName } from './web-forms';
import { useReturnFocus } from './use-return-focus';
import { useCreateRoute, useRemoveRoute, useUpdateRoute, useWebRoutes } from './web-logs-api';
import { WEB_ROUTE_KIND_TEXTS, WEB_ROUTE_METHOD_LABELS, webLogsErrorText } from './web-logs-labels';

const KIND_OPTIONS = WEB_ROUTE_KINDS.map((kind) => ({
  value: kind,
  label: WEB_ROUTE_KIND_TEXTS[kind].label,
}));
const METHOD_OPTIONS = WEB_ROUTE_METHODS.map((method) => ({
  value: method,
  label: WEB_ROUTE_METHOD_LABELS[method],
}));
/** O formulário da rota nova aberto, no lugar do ID da que está sendo alterada. */
const NEW = 'nova';

interface FormValues {
  kind: WebRouteKind;
  method: WebRouteMethod;
  host: string;
  path: string;
  failureCodes: string;
  successCodes: string;
  multiplier: string;
}

const EMPTY: FormValues = {
  kind: 'login',
  method: 'POST',
  host: '',
  path: '',
  failureCodes: '401, 403, 422',
  successCodes: '200, 302',
  multiplier: '1',
};

const valuesOf = (route: WebRoute): FormValues => ({
  kind: route.kind,
  method: route.method,
  host: route.host ?? '',
  path: route.path,
  failureCodes: route.failureCodes.join(', '),
  successCodes: route.successCodes.join(', '),
  multiplier: formatMultiplier(route.multiplier),
});

/** As mensagens dos schemas, com a caixa alta de uma frase na tela. */
const sentence = (text: string): string =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}${text.endsWith('.') ? '' : '.'}`;

/** O formulário de uma rota: na nova, tudo; na alteração, o que a API deixa mudar (o host, o método e o caminho são outra rota). */
function RouteForm({
  sourceId,
  route,
  onDone,
}: {
  sourceId: string;
  route: WebRoute | null;
  /** Fechar: salva (com a rota), ou cancelada. */
  onDone: (saved: boolean) => void;
}) {
  const [values, setValues] = useState<FormValues>(() => (route === null ? EMPTY : valuesOf(route)));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateRoute(sourceId);
  const update = useUpdateRoute(sourceId);
  const form = useRef<HTMLFormElement>(null);
  const busy = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  useEffect(() => {
    form.current?.querySelector<HTMLElement>('select, input')?.focus();
  }, []);

  const set =
    (key: keyof FormValues) =>
    (event: { target: { value: string } }): void => {
      setValues((current) => ({ ...current, [key]: event.target.value }));
      setErrors({});
    };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const failureCodes = parseCodes(values.failureCodes);
    const successCodes = parseCodes(values.successCodes);
    const multiplier = parseMultiplier(values.multiplier);
    const found: Record<string, string> = {
      ...(failureCodes === null && { failureCodes: 'Códigos de 100 a 599, separados por vírgula.' }),
      ...(successCodes === null && { successCodes: 'Códigos de 100 a 599, separados por vírgula.' }),
      ...(multiplier === null && { multiplier: MULTIPLIER_ERROR }),
    };
    const shared = {
      kind: values.kind,
      failureCodes: failureCodes ?? [],
      successCodes: successCodes ?? [],
      multiplier: multiplier ?? 1,
    };
    const full = {
      ...shared,
      host: values.host.trim() === '' ? null : values.host,
      method: values.method,
      path: values.path,
    };
    // A rota inteira também na alteração: o mesmo código não pode ser falha e sucesso.
    const parsed = webRouteCreateSchema.safeParse(full);
    if (!parsed.success) {
      for (const [key, message] of Object.entries(fieldErrors(parsed.error))) {
        const [field = key] = key.split('.');
        found[field] ??= sentence(message);
      }
    }
    setErrors(found);
    if (!parsed.success || Object.keys(found).length > 0) return;
    if (route === null) {
      create.mutate(parsed.data, { onSuccess: () => onDone(true) });
      return;
    }
    const input = webRouteUpdateSchema.parse(shared);
    update.mutate({ id: route.id, input }, { onSuccess: () => onDone(true) });
  };

  return (
    <form
      ref={form}
      onSubmit={submit}
      noValidate
      aria-label={route === null ? 'Declarar uma rota' : `Alterar a rota ${routeName(route)}`}
      className="space-y-3 rounded-md border border-border-strong p-3"
    >
      {route !== null && (
        <p className="text-sm wrap-anywhere">
          <span className="font-mono text-xs">{routeName(route)}</span>
          <span className="block text-xs text-muted-foreground">
            O host, o método e o caminho não mudam: para outros, declare outra rota.
          </span>
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <SelectInput
            label="O que é esta rota"
            value={values.kind}
            onChange={set('kind')}
            options={KIND_OPTIONS}
            error={errors['kind']}
          />
          <p className="text-xs text-muted-foreground">{WEB_ROUTE_KIND_TEXTS[values.kind].hint}</p>
        </div>
        {route === null && (
          <>
            <SelectInput
              label="Método"
              value={values.method}
              onChange={set('method')}
              options={METHOD_OPTIONS}
              error={errors['method']}
            />
            <Field
              label="Host (opcional)"
              hint="Como loja.exemplo.com.br. Vazio vale para todos os hosts do balanceador."
              value={values.host}
              onChange={set('host')}
              error={errors['host']}
              autoComplete="off"
              spellCheck={false}
            />
            <Field
              label="Caminho"
              hint="Como /api/entrar. Use * no lugar de uma parte inteira: /lojas/*/entrar. Sem a parte depois de ?."
              value={values.path}
              onChange={set('path')}
              error={errors['path']}
              autoComplete="off"
              spellCheck={false}
            />
          </>
        )}
        <Field
          label="Códigos de falha"
          hint="As respostas que querem dizer que não entrou. Vazio: o Verax usa os de sempre."
          value={values.failureCodes}
          onChange={set('failureCodes')}
          error={errors['failureCodes']}
          inputMode="numeric"
          autoComplete="off"
        />
        <Field
          label="Códigos de sucesso"
          hint="As respostas que querem dizer que entrou. O mesmo código não pode estar nos dois."
          value={values.successCodes}
          onChange={set('successCodes')}
          error={errors['successCodes']}
          inputMode="numeric"
          autoComplete="off"
        />
        <Field
          label="Multiplicador dos limites desta rota"
          hint="1 é o padrão. Multiplica também o do balanceador."
          value={values.multiplier}
          onChange={set('multiplier')}
          error={errors['multiplier']}
          inputMode="decimal"
          autoComplete="off"
        />
      </div>
      {error ? (
        <p role="alert" className="text-sm text-critical-text">
          {webLogsErrorText(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Salvando…' : route === null ? 'Declarar rota' : 'Salvar alteração'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onDone(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/**
 * As rotas que o cliente declara num balanceador: onde se entra, e como a aplicação responde quando dá certo e quando não dá.
 * Sem nenhuma, o Verax reconhece sozinho as de nome comum; a declarada é mais precisa.
 */
export function RoutesPanel({
  sourceId,
  name,
  canWrite,
}: {
  sourceId: string;
  name: string;
  canWrite: boolean;
}) {
  const query = useWebRoutes(sourceId);
  const remove = useRemoveRoute(sourceId);
  // O que está aberto: a rota nova, a alteração de uma, ou nada.
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<WebRoute | null>(null);
  const list = useReturnFocus(editing);
  const close = () => setEditing(null);

  if (query.error && query.data === undefined) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  if (query.data === undefined) return <LoadingState rows={2} label="Carregando as rotas declaradas" />;
  if (query.data === null) return null;
  const { items, limit } = query.data;
  const full = items.length >= limit;

  return (
    <div ref={list} tabIndex={-1} className="space-y-3 text-sm focus:outline-none">
      <p className="text-muted-foreground">
        Diga onde se entra na sua aplicação e como ela responde: a força bruta e o acesso depois de muitas
        falhas ficam mais precisos. Sem nenhuma rota declarada, o Verax reconhece sozinho as de nome comum
        (login, entrar, signin).
      </p>
      <p role="status" className="text-xs text-muted-foreground">
        {plural(items.length, 'rota declarada', 'rotas declaradas')} de {limit}.
      </p>
      {items.length > 0 && (
        <ul aria-label={`Rotas declaradas do ${name}`} className="divide-y rounded-md border">
          {items.map((route) => (
            <li key={route.id} className="space-y-1.5 px-3 py-2">
              {editing === route.id ? (
                <RouteForm sourceId={sourceId} route={route} onDone={close} />
              ) : (
                <>
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 font-mono text-xs wrap-anywhere">{routeName(route)}</span>
                    <Tag>{WEB_ROUTE_KIND_TEXTS[route.kind].label}</Tag>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {route.host === null ? 'Todos os hosts' : 'Só este host'}
                    {route.method === 'ANY' && ', qualquer método'}. Falha:{' '}
                    {route.failureCodes.length > 0 ? route.failureCodes.join(', ') : 'os códigos de sempre'}.
                    Sucesso:{' '}
                    {route.successCodes.length > 0 ? route.successCodes.join(', ') : 'os códigos de sempre'}.
                    {route.multiplier !== 1 && ` Multiplicador ${formatMultiplier(route.multiplier)}.`}
                  </p>
                  {canWrite && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={editing !== null}
                        aria-label={`Alterar a rota ${routeName(route)}`}
                        data-abre={route.id}
                        onClick={() => setEditing(route.id)}
                      >
                        Alterar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={editing !== null}
                        aria-label={`Remover a rota ${routeName(route)}`}
                        onClick={() => {
                          remove.reset();
                          setRemoving(route);
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
      {canWrite && editing === NEW && <RouteForm sourceId={sourceId} route={null} onDone={close} />}
      {canWrite && editing !== NEW && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={full || editing !== null}
          aria-label={`Declarar uma rota: ${name}`}
          data-abre={NEW}
          onClick={() => setEditing(NEW)}
        >
          Declarar uma rota
        </Button>
      )}
      {canWrite && full && (
        <p className="text-xs text-muted-foreground">
          Este balanceador chegou ao limite de {limit} rotas. Remova uma para declarar outra.
        </p>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
        title="Remover a rota declarada"
        description={
          removing === null
            ? ''
            : `${routeName(removing)} deixa de valer na próxima leitura. A remoção fica na auditoria.`
        }
        confirmLabel="Remover rota"
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
