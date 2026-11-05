import {
  AWS_READER_STACK_NAME,
  type CloudAccount,
  cloudAccountUpdateSchema,
  LOG_SOURCES,
  type LogBuckets,
  type LogSource,
  sameLogBucketNames,
  WAF_LOG_BUCKET_PREFIX,
} from '@verax/shared';
import { Plus, Trash2 } from 'lucide-react';
import { type FormEvent, Fragment, type Ref, useId, useImperativeHandle, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { useUpdateCloudAccount } from '@/features/admin/admin-api';
import { FormError, SelectInput } from '@/features/admin/admin-ui';
import {
  type BucketRow,
  bucketRowErrors,
  bucketRowsOf,
  bucketsFromRows,
  freeSources,
  LOG_SOURCE_LABELS,
  newBucketRow,
} from '@/features/admin/aws-log-buckets';
import { fieldErrors } from '@/features/admin/forms';
import { cn } from '@/lib/cn';

/** Cada fonte no seletor da linha. */
const SOURCE_OPTIONS: Readonly<Record<LogSource, string>> = {
  cloudtrail: 'CloudTrail (trilha)',
  guardduty: 'GuardDuty (export dos findings)',
  waf: 'WAF (log da Web ACL)',
};

/** Onde o cliente acha o bucket de cada fonte no console da AWS. */
const SOURCE_HINTS: Readonly<Record<LogSource, string>> = {
  cloudtrail: 'O bucket onde a trilha grava, no console do CloudTrail (Trails).',
  guardduty: 'O destino do export dos findings (GuardDuty → Settings → Findings export options).',
  waf: `Começa com ${WAF_LOG_BUCKET_PREFIX}: é o destino do log da Web ACL.`,
};

/** O que o formulário pode pedir à lista: o foco no nome de uma linha (a primeira com erro, no envio). */
export interface LogBucketsEditorHandle {
  focusRow: (key: number) => void;
}

/**
 * A lista editável de buckets (`features/admin/aws-log-buckets.ts`): até três linhas, cada uma com a fonte e o nome.
 * O seletor de cada linha mostra as três fontes, com as das outras linhas desligadas. "Adicionar bucket" cria a linha
 * com a primeira fonte livre e põe o foco no nome dela; "Remover" devolve o foco para "Adicionar bucket". Os erros
 * ficam ao lado do nome (`aria-invalid` e `aria-describedby`, pelo `Field`).
 */
export function LogBucketsEditor({
  ref,
  rows,
  onChange,
  errors,
  legend,
  legendHidden = false,
  note,
}: {
  ref?: Ref<LogBucketsEditorHandle>;
  rows: readonly BucketRow[];
  onChange: (rows: BucketRow[]) => void;
  errors: Readonly<Record<number, string>>;
  legend: string;
  /** O título já está na tela (o da seção): a legenda fica só para o leitor de tela. */
  legendHidden?: boolean;
  /** Uma frase a mais na dica do grupo. */
  note?: string;
}) {
  const hintId = useId();
  const names = useRef(new Map<number, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => ({ focusRow: (key) => names.current.get(key)?.focus() }), []);

  const free = freeSources(rows);
  const used = new Set(rows.map((row) => row.source));

  // A linha nova (ou a lista sem a removida) precisa estar na tela antes do foco: `flushSync` desenha na hora.
  const add = () => {
    const [source] = free;
    if (source === undefined) return;
    const row = newBucketRow(source);
    flushSync(() => onChange([...rows, row]));
    names.current.get(row.key)?.focus();
  };
  const remove = (key: number) => {
    flushSync(() => onChange(rows.filter((row) => row.key !== key)));
    addButton.current?.focus();
  };
  const change = (key: number, patch: Partial<Omit<BucketRow, 'key'>>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  return (
    <fieldset aria-describedby={hintId} className="min-w-0 space-y-3">
      <legend className={cn('text-sm font-medium', legendHidden && 'sr-only')}>{legend}</legend>
      <p id={hintId} className="text-xs text-muted-foreground">
        Até três, um por fonte. Cole o nome ou o ARN (arn:aws:s3:::nome). Os buckets que a própria pilha cria
        (as saídas TrailBucketArn e GuardDutyBucketArn) também entram aqui.{note && ` ${note}`}
      </p>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum bucket na lista.</p>
      ) : (
        <ul className="space-y-3">
          {rows.map((row, index) => (
            <li key={row.key}>
              <fieldset className="grid min-w-0 items-start gap-2 rounded-md border p-2 sm:grid-cols-[13rem_minmax(0,1fr)_auto]">
                <legend className="sr-only">Bucket {index + 1}</legend>
                <SelectInput
                  label="Fonte"
                  value={row.source}
                  onChange={(event) => change(row.key, { source: event.target.value as LogSource })}
                  options={LOG_SOURCES.map((source) => ({
                    value: source,
                    label: SOURCE_OPTIONS[source],
                    disabled: source !== row.source && used.has(source),
                  }))}
                />
                <Field
                  ref={(node: HTMLInputElement | null) => {
                    if (node) names.current.set(row.key, node);
                    else names.current.delete(row.key);
                  }}
                  label="Nome do bucket"
                  hint={SOURCE_HINTS[row.source]}
                  value={row.name}
                  onChange={(event) => change(row.key, { name: event.target.value })}
                  error={errors[row.key]}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="justify-self-start sm:mt-6"
                  onClick={() => remove(row.key)}
                  aria-label={`Remover o bucket ${index + 1} (${LOG_SOURCE_LABELS[row.source]})`}
                >
                  <Trash2 aria-hidden />
                  Remover
                </Button>
              </fieldset>
            </li>
          ))}
        </ul>
      )}
      {free.length > 0 ? (
        <Button ref={addButton} type="button" variant="secondary" size="sm" onClick={add}>
          <Plus aria-hidden />
          Adicionar bucket
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">As três fontes já têm bucket.</p>
      )}
    </fieldset>
  );
}

/** Os buckets gravados, fonte a fonte, para quem só lê. */
export function LogBucketsList({ buckets }: { buckets: LogBuckets }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {LOG_SOURCES.map((source) => {
        const name = buckets[source];
        return (
          <Fragment key={source}>
            <dt className="text-muted-foreground">{LOG_SOURCE_LABELS[source]}</dt>
            <dd className="break-all">
              {name === null ? (
                <span className="text-muted-foreground">sem bucket</span>
              ) : (
                <code className="font-mono text-xs">{name}</code>
              )}
            </dd>
          </Fragment>
        );
      })}
    </dl>
  );
}

/**
 * Os buckets de log no detalhe da conta AWS: quem administra altera a lista; quem só lê vê os buckets gravados. Salva
 * uma lista com outros nomes, a tela diz o que falta: atualizar o `LogBucketArns` da pilha (o passo 2 já mostra a lista
 * nova) e clicar em "Verificar conexão". A API volta a conexão para "aguardando" e não pede nada à AWS sozinha.
 */
export function AwsLogBuckets({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
      <h3 id={titleId} className="text-sm font-semibold">
        Buckets de log
      </h3>
      <p className="text-sm text-muted-foreground">
        Os buckets S3 de onde o Verax lê os logs desta conta, no máximo um por fonte. Eles vão no{' '}
        <code className="font-mono text-xs">LogBucketArns</code> da pilha, e o Verificar lê um objeto de cada.
      </p>
      {canWrite ? (
        <AwsLogBucketsForm account={account} />
      ) : (
        <>
          <LogBucketsList buckets={account.buckets} />
          <p className="text-xs text-muted-foreground">Quem administra as contas altera os buckets.</p>
        </>
      )}
    </section>
  );
}

function AwsLogBucketsForm({ account }: { account: CloudAccount }) {
  const [rows, setRows] = useState(() => bucketRowsOf(account.buckets));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [saved, setSaved] = useState<'changed' | 'same' | null>(null);
  const editor = useRef<LogBucketsEditorHandle>(null);
  const update = useUpdateCloudAccount(account.id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = cloudAccountUpdateSchema.safeParse({ buckets: bucketsFromRows(rows) });
    const rowErrors = bucketRowErrors(rows, parsed.success ? {} : fieldErrors(parsed.error));
    const first = rows.find((row) => rowErrors[row.key] !== undefined);
    if (!parsed.success || first) {
      // O erro na tela antes do foco: o leitor de tela lê o campo já com a mensagem.
      flushSync(() => {
        setErrors(rowErrors);
        setSaved(null);
      });
      if (first) editor.current?.focusRow(first.key);
      return;
    }
    setErrors({});
    setSaved(null);
    const before = account.buckets;
    update.mutate(parsed.data, {
      onSuccess: (result) => {
        setRows(bucketRowsOf(result.buckets));
        setSaved(sameLogBucketNames(before, result.buckets) ? 'same' : 'changed');
      },
    });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <LogBucketsEditor
        ref={editor}
        rows={rows}
        onChange={setRows}
        errors={errors}
        legend="Buckets de log"
        legendHidden
      />
      <FormError error={update.error} />
      {saved === 'changed' && (
        <p role="status" className="rounded-md border border-medium/70 bg-medium/15 p-2 text-sm">
          Buckets salvos, e a lista mudou. Se a pilha {AWS_READER_STACK_NAME} já existe na conta, atualize o{' '}
          <code className="font-mono text-xs">LogBucketArns</code> dela com a lista nova (no passo 2, abaixo,
          com o comando da CLI) e depois clique em Verificar conexão. Até lá, a conexão fica em Aguardando.
        </p>
      )}
      {saved === 'same' && (
        <p role="status" className="text-xs text-muted-foreground">
          Buckets salvos. Os nomes são os mesmos: a pilha não precisa mudar.
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={update.isPending}>
        Salvar buckets
      </Button>
    </form>
  );
}
