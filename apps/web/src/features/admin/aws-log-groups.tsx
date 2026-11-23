import { type AwsOnboarding, type AwsSource, type CloudAccount } from '@verax/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import type { SourceRetry } from '@/features/admin/aws-hooks';
import {
  AWS_LOG_GROUP_CATEGORY_LABELS,
  AWS_SOURCE_COLLECTION_NOTES,
} from '@/features/admin/aws-onboarding-labels';
import { PermissionFix, RetryButton, SourceNotes, SourceRegion } from '@/features/admin/aws-source-parts';
import { awsSourceGroup, isAuthorizableSource, matchesLogGroupSearch } from '@/features/admin/aws-sources';
import { Notice, ToneBadge } from '@/features/admin/aws-ui';
import { formatGb } from '@/features/plan/plan-format';
import { formatDate, plural } from '@/lib/format';

/** Quantos grupos a lista mostra de cada vez: uma conta pode ter centenas. */
const PAGE = 25;

function tagState(source: AwsSource): { tone: 'ok' | 'idle' | 'medium'; text: string } {
  if (source.details.tagged === true) return { tone: 'ok', text: 'com a etiqueta de leitura' };
  if (source.details.tagged === false) return { tone: 'idle', text: 'sem a etiqueta de leitura' };
  return { tone: 'medium', text: 'etiqueta não lida' };
}

/** O que a descoberta sabe do grupo, numa linha: a região, o tamanho guardado, a retenção e a categoria. */
function LogGroupFacts({ source }: { source: AwsSource }) {
  const { storedBytes, retentionDays, category } = source.details;
  return (
    <p className="text-xs text-muted-foreground">
      <SourceRegion region={source.region} />
      {' · '}
      {storedBytes === undefined ? 'tamanho não lido' : `${formatGb(storedBytes)} guardados`}
      {retentionDays !== undefined && (
        <>
          {' · '}
          {retentionDays === null
            ? 'sem prazo de retenção'
            : `retenção de ${plural(retentionDays, 'dia', 'dias')}`}
        </>
      )}
      {category !== undefined && <> · {AWS_LOG_GROUP_CATEGORY_LABELS[category]}</>}
    </p>
  );
}

/**
 * Os grupos do CloudWatch Logs ainda sem autorização. Podem ser centenas: a lista tem busca (pelo nome ou pela região)
 * e mostra uma página por vez. Cada grupo é marcado um a um (não existe "marcar todos"), porque log de aplicação pode
 * trazer dado pessoal, e só pode ser marcado o grupo que já tem a etiqueta `verax-control = leitura` e que o Verax
 * conferiu que lê. O que não pode ainda diz o que falta: a etiqueta (com o comando pronto) ou a autorização na pilha.
 */
export function AwsLogGroupList({
  account,
  onboarding,
  logGroups,
  picked,
  onToggle,
  canAuthorize,
  retry,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  logGroups: readonly AwsSource[];
  picked: ReadonlySet<string>;
  onToggle: (sourceId: string) => void;
  canAuthorize: boolean;
  retry: SourceRetry;
}) {
  const [search, setSearch] = useState('');
  const [onlyTagged, setOnlyTagged] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const matches = logGroups.filter(
    (source) => matchesLogGroupSearch(source, search) && (!onlyTagged || source.details.tagged === true),
  );
  // Os que já podem ser marcados vêm primeiro; dentro de cada parte, a ordem da lista (região e nome).
  const ordered = [
    ...matches.filter(isAuthorizableSource),
    ...matches.filter((source) => !isAuthorizableSource(source)),
  ];
  const visible = ordered.slice(0, limit);
  const pickedCount = logGroups.filter((source) => picked.has(source.id)).length;
  // A autorização dos grupos desligada na pilha trava todos de uma vez: o aviso vem antes da lista.
  const capabilityOff = logGroups.some((source) => source.permissionDetail === 'capability_off');

  return (
    <div className="space-y-3">
      <Notice tone="medium" title="Logs de aplicação podem conter dados pessoais.">
        <p>
          Por isso cada grupo é escolhido um a um, e o Verax só lê o grupo em que você puser a etiqueta{' '}
          <code className="font-mono text-xs">verax-control = leitura</code>, na AWS. Dos outros, ele vê só o
          nome e o tamanho.
        </p>
        <p>{AWS_SOURCE_COLLECTION_NOTES.cloudwatch_log_group}</p>
      </Notice>
      {capabilityOff && (
        <Notice tone="medium" title="A leitura de grupos de logs está desligada na pilha.">
          <p>
            Enquanto a autorização &ldquo;Grupos do CloudWatch Logs marcados&rdquo; estiver desligada, nenhum
            grupo pode ser autorizado. Para ligar, vá em{' '}
            <a href="#aws-pilha" className="underline">
              {onboarding.credentialMode === 'access_key'
                ? 'Atualize as políticas do usuário de leitura'
                : 'Atualize a pilha'}
            </a>
            .
          </p>
        </Notice>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="Buscar grupo de logs"
          hint="Pelo nome ou pela região."
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(PAGE);
          }}
          className="min-w-56 flex-1"
          autoComplete="off"
          spellCheck={false}
        />
        <label className="flex items-center gap-2 pb-6 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={onlyTagged}
            onChange={(event) => {
              setOnlyTagged(event.target.checked);
              setLimit(PAGE);
            }}
          />
          Só os que têm a etiqueta
        </label>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {matches.length === 0
          ? 'Nenhum grupo com esse filtro.'
          : `Mostrando ${Math.min(limit, matches.length)} de ${plural(matches.length, 'grupo', 'grupos')}.`}
        {pickedCount > 0 && ` ${plural(pickedCount, 'marcado', 'marcados')} para autorizar.`}
      </p>
      {visible.length > 0 && (
        <ul aria-label="Grupos do CloudWatch Logs" className="divide-y rounded-md border text-sm">
          {visible.map((source) => {
            const selectable = isAuthorizableSource(source);
            const fieldId = `aws-grupo-${source.id}`;
            const tag = tagState(source);
            const needsPermission = awsSourceGroup(source) === 'needs_permission';
            return (
              <li key={source.id} className="flex items-start gap-2 px-3 py-2">
                {canAuthorize && selectable ? (
                  <input
                    id={fieldId}
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0"
                    checked={picked.has(source.id)}
                    onChange={() => onToggle(source.id)}
                  />
                ) : (
                  <span aria-hidden className="size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {canAuthorize && selectable ? (
                      <label htmlFor={fieldId} className="break-all font-mono text-xs">
                        {source.name}
                      </label>
                    ) : (
                      <span className="break-all font-mono text-xs">{source.name}</span>
                    )}
                    <ToneBadge tone={tag.tone}>
                      <span className="text-xs">{tag.text}</span>
                    </ToneBadge>
                  </p>
                  <LogGroupFacts source={source} />
                  <SourceNotes source={source} omit={['tag_required', 'stack_update_required']} />
                  {source.authorization.revokedAt !== null && (
                    <p className="text-xs text-muted-foreground">
                      Autorização retirada em {formatDate(source.authorization.revokedAt)}.
                    </p>
                  )}
                  {source.missingSince !== null && (
                    <p className="text-xs text-muted-foreground">
                      A última descoberta não achou mais este grupo na conta.
                    </p>
                  )}
                  {needsPermission && (
                    <details className="space-y-1.5">
                      <summary className="cursor-pointer text-xs">Como liberar a leitura deste grupo</summary>
                      <PermissionFix
                        source={source}
                        account={account}
                        onboarding={onboarding}
                        retry={canAuthorize ? <RetryButton source={source} retry={retry} /> : undefined}
                      />
                    </details>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {matches.length > limit && (
        <Button type="button" variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE)}>
          Mostrar mais {Math.min(PAGE, matches.length - limit)}
        </Button>
      )}
    </div>
  );
}
