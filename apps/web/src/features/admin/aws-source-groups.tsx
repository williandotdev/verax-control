import {
  AWS_AUTHORIZE_MAX_SOURCES,
  type AwsOnboarding,
  type AwsSource,
  type CloudAccount,
} from '@verax/shared';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AwsLogGroupList } from '@/features/admin/aws-log-groups';
import { useAwsAuthorizeSources, useAwsRetrySource } from '@/features/admin/aws-onboarding-api';
import {
  AWS_SOURCE_AVAILABILITY_TEXTS,
  AWS_SOURCE_KIND_TEXTS,
  awsOnboardingErrorText,
  awsSourceName,
  isAwsCostNote,
} from '@/features/admin/aws-onboarding-labels';
import {
  PermissionFix,
  RetryButton,
  SensitiveTag,
  SourceLocation,
  SourceNotes,
  SourceRegion,
  SourceTitle,
} from '@/features/admin/aws-source-parts';
import {
  groupAwsSources,
  isAuthorizableSource,
  isCoveredByGuardDutyApi,
  isHighVolumeSource,
  isRecommendedSource,
} from '@/features/admin/aws-sources';
import { Notice, Section, Tag } from '@/features/admin/aws-ui';
import { formatDate, plural } from '@/lib/format';

/** Um grupo de fontes da tela: o título com a contagem, a explicação e a lista. Sem fonte, não aparece. */
function SourceGroup({
  title,
  count,
  description,
  children,
}: {
  title: string;
  count: number;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  if (count === 0) return null;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h4 id={id} className="text-sm font-medium">
        {title} ({count})
      </h4>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {children}
    </section>
  );
}

function SourceList({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="divide-y rounded-md border text-sm">
      {children}
    </ul>
  );
}

/** As marcas ao lado do nome: a forma recomendada, o export coberto pela API e a autorização retirada. */
function sourceTags(source: AwsSource, sources: readonly AwsSource[]): ReactNode {
  const tags: ReactNode[] = [];
  if (isRecommendedSource(source, sources)) tags.push(<Tag key="recomendada">Recomendada</Tag>);
  if (isCoveredByGuardDutyApi(source, sources)) tags.push(<Tag key="coberta">Coberto pela API</Tag>);
  if (source.sensitive) tags.push(<SensitiveTag key="sensivel" />);
  return tags.length > 0 ? tags : undefined;
}

/**
 * A confirmação antes de autorizar: o que entra, que a coleta começa hoje (sem histórico), o aviso de volume para as
 * fontes de volume alto e, para os grupos do CloudWatch Logs, o aviso de dado pessoal com a confirmação explícita. Só
 * com ela marcada o pedido leva os grupos em `sensitiveSourceIds`, como a API exige.
 */
function AuthorizeConfirmation({
  selected,
  sources,
  confirmed,
  onConfirmedChange,
  onConfirm,
  onCancel,
  busy,
  error,
}: {
  selected: readonly AwsSource[];
  sources: readonly AwsSource[];
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error: unknown;
}) {
  const titleId = useId();
  const sensitive = selected.filter((source) => source.sensitive);
  const highVolume = selected.filter(isHighVolumeSource);
  const duplicated =
    selected.some((source) => source.kind === 'guardduty') &&
    selected.some((source) => isCoveredByGuardDutyApi(source, sources));
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="space-y-3 rounded-md border border-border-strong p-3"
    >
      <h4 id={titleId} className="text-sm font-semibold">
        Confirmar a autorização de {plural(selected.length, 'fonte', 'fontes')}
      </h4>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {selected.map((source) => (
          <li key={source.id}>
            <SourceTitle source={source} />
          </li>
        ))}
      </ul>
      <p className="text-sm">
        A coleta começa hoje: o Verax não busca o histórico anterior. Você pode retirar a autorização de
        qualquer fonte a qualquer momento.
      </p>
      {highVolume.length > 0 && (
        <Notice tone="medium" title="Pode aumentar o volume mensal do seu plano.">
          <p>
            {plural(highVolume.length, 'fonte escolhida costuma', 'fontes escolhidas costumam')} gerar muito
            volume (VPC Flow Logs e grupos do CloudWatch Logs). O que for coletado conta no volume do plano.
          </p>
        </Notice>
      )}
      {duplicated && (
        <Notice tone="low" title="A API e o export do GuardDuty trazem os mesmos achados.">
          <p>O Verax não duplica os achados, mas basta autorizar a API, que é a forma recomendada.</p>
        </Notice>
      )}
      {sensitive.length > 0 && (
        <Notice tone="high" title="Logs de aplicação podem conter dados pessoais.">
          <p>
            Você está autorizando o Verax a ler o conteúdo de{' '}
            {plural(sensitive.length, 'grupo do CloudWatch Logs', 'grupos do CloudWatch Logs')}. Confira a
            lista acima, um a um.
          </p>
          <label className="flex items-start gap-2 font-medium">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={confirmed}
              onChange={(event) => onConfirmedChange(event.target.checked)}
            />
            Confirmo que o Verax pode ler o conteúdo{' '}
            {sensitive.length === 1 ? 'deste grupo de logs' : `destes ${sensitive.length} grupos de logs`}
          </label>
        </Notice>
      )}
      {error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={onConfirm} disabled={busy || (sensitive.length > 0 && !confirmed)}>
          {busy ? 'Autorizando…' : 'Confirmar autorização'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/**
 * "Fontes de log": o que a descoberta achou e ainda não está autorizado, em grupos: as disponíveis para coletar (com a
 * caixa de marcar e o "Autorizar selecionadas"), os grupos do CloudWatch Logs (a lista com busca), as que precisam de
 * permissão adicional (com a correção exata de cada uma e o "Verificar de novo"), as não habilitadas na AWS (com o
 * aviso de custo: ligar é decisão do cliente, e a Verax nunca liga nada), as que gravam onde o Verax não lê e as ainda
 * não coletadas. Nada é marcado de antemão, e a autorização só vale quando a API responde com o estado novo.
 */
export function AwsSourceGroups({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const authorize = useAwsAuthorizeSources(account.id);
  const retry = useAwsRetrySource(account.id);
  const { sources } = onboarding;
  const { groups, logGroups } = useMemo(() => groupAwsSources(sources), [sources]);
  const canAuthorize = canWrite && account.status === 'active';
  // Só o que ainda pode ser autorizado conta como escolhido: a fonte que mudou numa releitura sai da escolha.
  const selected = sources.filter((source) => picked.has(source.id) && isAuthorizableSource(source));
  const retryingId = retry.isPending ? (retry.variables ?? null) : null;

  const toggle = (sourceId: string) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
    // Outra lista de fontes pede outra confirmação.
    setConfirmed(false);
    authorize.reset();
  };
  const cancel = () => {
    setConfirming(false);
    setConfirmed(false);
    authorize.reset();
  };
  const confirm = () => {
    const sensitive = selected.filter((source) => source.sensitive).map((source) => source.id);
    authorize.mutate(
      {
        sourceIds: selected.map((source) => source.id),
        ...(sensitive.length > 0 && { sensitiveSourceIds: sensitive }),
      },
      {
        onSuccess: () => {
          setPicked(new Set());
          setConfirming(false);
          setConfirmed(false);
        },
      },
    );
  };
  const retryButton = (source: AwsSource) =>
    canAuthorize ? (
      <RetryButton source={source} onRetry={(id) => retry.mutate(id)} pending={retryingId === source.id} />
    ) : undefined;

  const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0) + logGroups.length;
  const tooMany = selected.length > AWS_AUTHORIZE_MAX_SOURCES;

  return (
    <Section id="aws-fontes" title="Fontes de log">
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">
          {onboarding.discovery.lastCompletedAt === null
            ? 'As fontes de log da conta aparecem aqui quando a descoberta terminar.'
            : 'Não há fonte de log para autorizar agora: tudo o que a descoberta encontrou já está em "Fontes autorizadas".'}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          O que a descoberta encontrou nesta conta e ainda não é coletado. Nada é lido até você autorizar, e a
          coleta de cada fonte começa no dia da autorização.
        </p>
      )}

      <SourceGroup
        title="Disponíveis para coletar"
        count={groups.available.length}
        description="Existem na conta, e o Verax conferiu que consegue ler. Marque as que quiser e autorize."
      >
        <SourceList label="Fontes disponíveis para coletar">
          {groups.available.map((source) => {
            const fieldId = `aws-fonte-${source.id}`;
            const covered = isCoveredByGuardDutyApi(source, sources);
            return (
              <li key={source.id} className="flex items-start gap-2 px-3 py-2">
                {canAuthorize && (
                  <input
                    id={fieldId}
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0"
                    checked={picked.has(source.id)}
                    onChange={() => toggle(source.id)}
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <label htmlFor={canAuthorize ? fieldId : undefined} className="block">
                    <SourceTitle source={source} tags={sourceTags(source, sources)} />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {AWS_SOURCE_KIND_TEXTS[source.kind].description}
                  </p>
                  <SourceLocation source={source} />
                  {covered && !source.notes.includes('covered_by_api') && (
                    <p className="text-xs text-muted-foreground">
                      Coberto pela API: os mesmos achados já chegam pela API do GuardDuty.
                    </p>
                  )}
                  <SourceNotes source={source} />
                  {source.authorization.revokedAt !== null && (
                    <p className="text-xs text-muted-foreground">
                      Autorização retirada em {formatDate(source.authorization.revokedAt)}. Pode ser
                      autorizada de novo.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </SourceList>
      </SourceGroup>

      <SourceGroup
        title="Grupos do CloudWatch Logs"
        count={logGroups.length}
        description="Todos os grupos de logs da conta, pelo nome. O Verax só lê os que você etiquetar e autorizar aqui."
      >
        <AwsLogGroupList
          account={account}
          onboarding={onboarding}
          logGroups={logGroups}
          picked={picked}
          onToggle={toggle}
          canAuthorize={canAuthorize}
          onRetry={(id) => retry.mutate(id)}
          retryingId={retryingId}
        />
      </SourceGroup>

      {canAuthorize && (groups.available.length > 0 || logGroups.length > 0) && (
        <div className="space-y-2">
          {confirming && selected.length > 0 ? (
            <AuthorizeConfirmation
              selected={selected}
              sources={sources}
              confirmed={confirmed}
              onConfirmedChange={setConfirmed}
              onConfirm={confirm}
              onCancel={cancel}
              busy={authorize.isPending}
              error={authorize.error}
            />
          ) : (
            <Button
              type="button"
              onClick={() => setConfirming(true)}
              disabled={selected.length === 0 || tooMany}
            >
              {selected.length === 0
                ? 'Autorizar selecionadas'
                : `Autorizar selecionadas (${selected.length})`}
            </Button>
          )}
          {tooMany && (
            <p role="alert" className="text-sm text-critical-text">
              No máximo {AWS_AUTHORIZE_MAX_SOURCES} fontes por vez: desmarque algumas e autorize em duas
              etapas.
            </p>
          )}
        </div>
      )}
      {!canWrite && total > 0 && (
        <p className="text-sm text-muted-foreground">Quem administra as contas autoriza as fontes.</p>
      )}
      {retry.error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(retry.error)}
        </p>
      ) : null}

      <SourceGroup
        title="Já lidas pelo cadastro manual"
        count={groups.covered.length}
        description='O bucket destas fontes já é lido como "cadastrado manualmente", em Fontes autorizadas: autorizar aqui duplicaria a coleta.'
      >
        <SourceList label="Fontes já lidas pelo cadastro manual">
          {groups.covered.map((source) => (
            <li key={source.id} className="space-y-1 px-3 py-2">
              <SourceTitle source={source} tags={sourceTags(source, sources)} />
              <SourceLocation source={source} />
            </li>
          ))}
        </SourceList>
      </SourceGroup>

      <SourceGroup
        title="Precisam de permissão adicional"
        count={groups.needs_permission.length}
        description="Existem na conta, mas o Verax ainda não consegue ler. Cada uma diz o que falta."
      >
        <SourceList label="Fontes que precisam de permissão adicional">
          {groups.needs_permission.map((source) => (
            <li key={source.id} className="space-y-1.5 px-3 py-2">
              <SourceTitle source={source} tags={sourceTags(source, sources)} />
              <SourceLocation source={source} />
              <SourceNotes source={source} omit={['stack_update_required', 'additional_bucket_required']} />
              <PermissionFix
                source={source}
                account={account}
                onboarding={onboarding}
                retry={retryButton(source)}
              />
            </li>
          ))}
        </SourceList>
      </SourceGroup>

      <SourceGroup
        title="Não habilitadas na AWS"
        count={groups.not_enabled.length}
        description="Ligar um destes serviços tem custo na AWS, e a decisão é sua: o Verax nunca liga nada na sua conta. Se você ligar, a fonte aparece aqui na próxima descoberta."
      >
        <SourceList label="Fontes não habilitadas na AWS">
          {groups.not_enabled.map((source) => (
            <li key={source.id} className="space-y-1 px-3 py-2">
              <SourceTitle source={source} />
              <p className="text-xs text-muted-foreground">
                {AWS_SOURCE_AVAILABILITY_TEXTS[source.availability]}.{' '}
                {AWS_SOURCE_KIND_TEXTS[source.kind].description}
              </p>
              <SourceNotes source={source} omit={source.notes.filter((note) => !isAwsCostNote(note))} />
            </li>
          ))}
        </SourceList>
      </SourceGroup>

      <SourceGroup
        title="Em destino ou formato que o Verax não lê"
        count={groups.unsupported.length}
        description="O log existe, mas é gravado de um jeito que o Verax não lê nesta versão."
      >
        <SourceList label="Fontes em destino ou formato que o Verax não lê">
          {groups.unsupported.map((source) => (
            <li key={source.id} className="space-y-1 px-3 py-2">
              <SourceTitle source={source} />
              <p className="text-xs text-muted-foreground">
                {AWS_SOURCE_AVAILABILITY_TEXTS[source.availability]}.
              </p>
              {source.details.destination !== undefined && (
                <p className="break-all text-xs text-muted-foreground">
                  Destino: <code className="font-mono">{source.details.destination}</code>
                </p>
              )}
              <SourceLocation source={source} />
            </li>
          ))}
        </SourceList>
      </SourceGroup>

      <SourceGroup
        title="Ainda não coletadas"
        count={groups.not_collected.length}
        description="O Verax já encontra estas fontes, mas ainda não as coleta nesta versão. Nada a fazer por enquanto."
      >
        <SourceList label="Fontes ainda não coletadas">
          {groups.not_collected.map((source) => (
            <li key={source.id} className="space-y-1 px-3 py-2">
              <SourceTitle source={source} />
              <SourceLocation source={source} />
            </li>
          ))}
        </SourceList>
      </SourceGroup>

      <SourceGroup
        title="Não existem mais na conta"
        count={groups.gone.length}
        description="A autorização destas fontes foi retirada, e a última descoberta não as achou mais."
      >
        <SourceList label="Fontes que não existem mais na conta">
          {groups.gone.map((source) => (
            <li key={source.id} className="px-3 py-2">
              <span className="font-medium">{AWS_SOURCE_KIND_TEXTS[source.kind].label}</span>
              {awsSourceName(source) !== '' && (
                <>
                  {' · '}
                  <span className="break-all font-mono text-xs">{awsSourceName(source)}</span>
                </>
              )}
              <span className="text-muted-foreground">
                {' · '}
                <SourceRegion region={source.region} />
              </span>
            </li>
          ))}
        </SourceList>
      </SourceGroup>
    </Section>
  );
}
