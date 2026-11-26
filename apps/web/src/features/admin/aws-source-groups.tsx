import {
  AWS_AUTHORIZE_MAX_SOURCES,
  AWS_MAX_AUTHORIZED_WEB_SOURCES,
  type AwsOnboarding,
  type AwsSource,
  type CloudAccount,
} from '@verax/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AwsLogGroupList } from '@/features/admin/aws-log-groups';
import { type SourceRetry, useNow } from '@/features/admin/aws-hooks';
import { useAwsAuthorizeSources } from '@/features/admin/aws-onboarding-api';
import {
  AWS_SOURCE_COLLECTION_NOTES,
  AWS_SOURCE_KIND_TEXTS,
  AWS_SOURCE_NOTE_TEXTS,
  awsAvailabilityText,
  awsOnboardingErrorText,
  awsSourceName,
  isAwsCostNote,
} from '@/features/admin/aws-onboarding-labels';
import {
  PermissionFix,
  RetryButton,
  RetryError,
  SensitiveTag,
  SourceCollectionNote,
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
import { AlbLoggingControl, AlbLoggingOwned } from '@/features/web-attacks/alb-logging-control';
import { UnsupportedBalancerReason } from '@/features/web-attacks/alb-logging-steps';
import {
  acknowledgementOf,
  acknowledgementText,
  estimateKey,
  projectionText,
  usableEstimate,
  type UsableEstimate,
} from '@/features/web-attacks/estimate';
import { EstimateStep } from '@/features/web-attacks/estimate-step';
import { useWebLogSources, webLogsKeys } from '@/features/web-attacks/web-logs-api';
import { WEB_DATA_TEXT } from '@/features/web-attacks/web-logs-labels';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
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
 * fontes de volume alto, o que a autorização de um flow log de fato lê (todos os que gravam no mesmo bucket, e só o
 * tráfego recusado) e, para os grupos do CloudWatch Logs, o aviso de dado pessoal com a confirmação explícita e o que
 * esperar dos alertas deles. Só com a confirmação marcada o pedido leva os grupos em `sensitiveSourceIds`, como a API
 * exige. Para os balanceadores, o volume estimado de cada um, o que é feito com o log e, quando a estimativa pede, a
 * confirmação de cada um (a estimativa refeita no meio a desmarca).
 */
function AuthorizeConfirmation({
  selected,
  sources,
  balancers,
  acknowledged,
  onAcknowledge,
  confirmed,
  onConfirmedChange,
  onConfirm,
  onCancel,
  busy,
  error,
}: {
  selected: readonly AwsSource[];
  sources: readonly AwsSource[];
  balancers: readonly Balancer[];
  /** As estimativas confirmadas (`estimateKey`). */
  acknowledged: ReadonlySet<string>;
  onAcknowledge: (key: string, value: boolean) => void;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  error: unknown;
}) {
  const titleId = useId();
  const sensitive = selected.filter((source) => source.sensitive);
  // O balanceador tem o volume estimado, logo abaixo: o aviso genérico é das outras.
  const highVolume = selected.filter((source) => source.kind !== 'elb_logs' && isHighVolumeSource(source));
  const unacknowledged = balancers.some(
    ({ key, estimate }) => estimate.projection.acknowledgementRequired && !acknowledged.has(key),
  );
  const flowLogs = selected.filter((source) => source.kind === 'vpc_flow_logs');
  const readTogether = flowLogs.some((source) => source.notes.includes('flow_logs_read_together'));
  const logGroups = selected.filter((source) => source.kind === 'cloudwatch_log_group');
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
      {flowLogs.length > 0 && (
        <Notice
          tone="medium"
          title={
            readTogether
              ? 'A autorização vale para todos os Flow Logs do mesmo bucket.'
              : 'O que o Verax lê dos Flow Logs.'
          }
        >
          {readTogether && <p>{AWS_SOURCE_NOTE_TEXTS.flow_logs_read_together}</p>}
          <p>{AWS_SOURCE_COLLECTION_NOTES.vpc_flow_logs}</p>
        </Notice>
      )}
      {balancers.length > 0 && (
        <Notice
          tone="medium"
          title={
            balancers.length === 1
              ? 'O volume do balanceador conta no plano.'
              : 'O volume dos balanceadores conta no plano.'
          }
        >
          <ul className="list-disc space-y-0.5 pl-5">
            {balancers.map(({ source, key, estimate }) => (
              <li key={key} className="wrap-anywhere">
                <span className="font-mono text-xs">{awsSourceName(source)}</span>:{' '}
                {projectionText(estimate.projection, estimate.truncated) ?? 'sem amostra para estimar'}
              </li>
            ))}
          </ul>
          <p>{WEB_DATA_TEXT}</p>
          <p>
            Todo balanceador começa só observando, por 72 horas: conta o que teria virado alerta, sem abrir
            nenhum. Depois, você decide quando ele passa a alertar, em &ldquo;Ataques web&rdquo;.
          </p>
          {balancers
            .filter(({ estimate }) => estimate.projection.acknowledgementRequired)
            .map(({ source, key, estimate }) => (
              <label key={key} className="flex items-start gap-2 font-medium">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0"
                  checked={acknowledged.has(key)}
                  onChange={(event) => onAcknowledge(key, event.target.checked)}
                />
                <span className="min-w-0 wrap-anywhere">
                  {acknowledgementText(awsSourceName(source), estimate)}
                </span>
              </label>
            ))}
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
      {logGroups.length > 0 && (
        <Notice tone="low" title="Os alertas dos grupos de logs demoram um pouco mais.">
          <p>{AWS_SOURCE_COLLECTION_NOTES.cloudwatch_log_group}</p>
        </Notice>
      )}
      {error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(error)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={onConfirm}
          disabled={busy || unacknowledged || (sensitive.length > 0 && !confirmed)}
        >
          {busy ? 'Autorizando…' : 'Confirmar autorização'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

/** Um balanceador escolhido, com a estimativa que vale e a identidade dela. */
interface Balancer {
  source: AwsSource;
  key: string;
  estimate: UsableEstimate;
}

/** De quanto em quanto tempo a validade das estimativas é conferida de novo. */
const ESTIMATE_CLOCK_MS = 30_000;

/**
 * "Fontes de log": o que a descoberta achou e ainda não está autorizado, em grupos: as disponíveis para coletar (com a
 * caixa de marcar e o "Autorizar selecionadas"), os grupos do CloudWatch Logs (a lista com busca), as que precisam de
 * permissão adicional (com a correção exata de cada uma e o "Verificar de novo"), as não habilitadas na AWS (com o
 * aviso de custo: ligar é decisão do cliente, e a Verax nunca liga nada), as que gravam onde o Verax não lê e as ainda
 * não coletadas. Nada é marcado de antemão, e a autorização só vale quando a API responde com o estado novo.
 *
 * O balanceador só pode ser marcado com a estimativa de volume que vale: até lá, a linha dele mostra o passo da estimativa.
 * Num nó em que os ataques web não existem (404), não há o que marcar, e nada aparece como erro.
 */
export function AwsSourceGroups({
  account,
  onboarding,
  canWrite,
  retry,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
  retry: SourceRetry;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const authorize = useAwsAuthorizeSources(account.id);
  const { sources } = onboarding;
  const { authorized, groups, logGroups } = useMemo(() => groupAwsSources(sources), [sources]);
  const canAuthorize = canWrite && account.status === 'active';
  const queryClient = useQueryClient();
  const hasBalancers = groups.available.some((source) => source.kind === 'elb_logs');
  const web = useWebLogSources(account.id, hasBalancers);
  const webById = useMemo(() => new Map((web.data ?? []).map((item) => [item.id, item])), [web.data]);
  const now = useNow(ESTIMATE_CLOCK_MS);
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const estimateOf = (source: AwsSource): UsableEstimate | null =>
    source.kind === 'elb_logs' ? usableEstimate(webById.get(source.id), now) : null;
  const isSelectable = (source: AwsSource): boolean =>
    isAuthorizableSource(source) && (source.kind !== 'elb_logs' || estimateOf(source) !== null);
  // Só o que ainda pode ser autorizado conta como escolhido: a fonte que mudou numa releitura (ou a estimativa que venceu)
  // sai da escolha.
  const selected = sources.filter((source) => picked.has(source.id) && isSelectable(source));
  const balancers = selected.flatMap((source): Balancer[] => {
    const estimate = estimateOf(source);
    return estimate === null ? [] : [{ source, estimate, key: estimateKey(source.id, estimate) }];
  });

  const toggle = (sourceId: string) => {
    const next = new Set(picked);
    if (next.has(sourceId)) next.delete(sourceId);
    else next.add(sourceId);
    setPicked(next);
    // Outra lista de fontes pede outra confirmação; sem nenhuma marcada, a confirmação fecha.
    setConfirmed(false);
    setAcknowledged(new Set());
    if (next.size === 0) setConfirming(false);
    authorize.reset();
  };
  const acknowledge = (key: string, value: boolean) =>
    setAcknowledged((current) => {
      const next = new Set(current);
      if (value) next.add(key);
      else next.delete(key);
      return next;
    });
  const cancel = () => {
    setConfirming(false);
    setConfirmed(false);
    setAcknowledged(new Set());
    authorize.reset();
  };
  const confirm = () => {
    const sensitive = selected.filter((source) => source.sensitive).map((source) => source.id);
    authorize.mutate(
      {
        sourceIds: selected.map((source) => source.id),
        ...(sensitive.length > 0 && { sensitiveSourceIds: sensitive }),
        // Só com um balanceador: o nó de antes recusaria o campo.
        ...(balancers.length > 0 && {
          webLogs: balancers.map(({ source, key, estimate }) =>
            acknowledgementOf(source.id, estimate, acknowledged.has(key)),
          ),
        }),
      },
      {
        onSuccess: () => {
          setPicked(new Set());
          setConfirming(false);
          setConfirmed(false);
          setAcknowledged(new Set());
          // Os balanceadores autorizados ganharam a configuração (observando).
          if (balancers.length > 0)
            void queryClient.invalidateQueries({ queryKey: webLogsKeys.sources(account.id) });
        },
        onError: (error) => {
          // A estimativa do pedido não é mais a de agora: a tela relê os números antes da próxima tentativa.
          if (error instanceof ApiRequestError && error.code?.startsWith('WEB_LOGS_') === true) {
            void queryClient.invalidateQueries({ queryKey: webLogsKeys.sources(account.id) });
          }
        },
      },
    );
  };
  const retryButton = (source: AwsSource) =>
    canAuthorize ? <RetryButton source={source} retry={retry} /> : undefined;

  const total = Object.values(groups).reduce((sum, list) => sum + list.length, 0) + logGroups.length;
  const tooMany = selected.length > AWS_AUTHORIZE_MAX_SOURCES;
  const authorizedBalancers = authorized.filter((source) => source.kind === 'elb_logs').length;
  const tooManyBalancers =
    balancers.length > 0 && authorizedBalancers + balancers.length > AWS_MAX_AUTHORIZED_WEB_SOURCES;

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
        {hasBalancers && web.isPending && (
          <p role="status" className="text-xs text-muted-foreground">
            Carregando a estimativa de volume dos balanceadores…
          </p>
        )}
        {hasBalancers && web.error && web.data === undefined ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <p role="alert" className="text-critical-text">
              A estimativa de volume dos balanceadores não pôde ser lida. {errorMessage(web.error)}
            </p>
            <Button type="button" variant="secondary" size="sm" onClick={() => void web.refetch()}>
              Ler de novo
            </Button>
          </div>
        ) : null}
        <SourceList label="Fontes disponíveis para coletar">
          {groups.available.map((source) => {
            const fieldId = `aws-fonte-${source.id}`;
            const covered = isCoveredByGuardDutyApi(source, sources);
            const balancer = source.kind === 'elb_logs';
            const selectable =
              canAuthorize && isAuthorizableSource(source) && (!balancer || web.data != null);
            const waiting = balancer && !isSelectable(source);
            return (
              <li key={source.id} className="flex items-start gap-2 px-3 py-2">
                {selectable && (
                  <input
                    id={fieldId}
                    type="checkbox"
                    className="mt-0.5 size-4 shrink-0 disabled:opacity-40"
                    checked={picked.has(source.id) && !waiting}
                    disabled={waiting}
                    aria-describedby={waiting ? `${fieldId}-espera` : undefined}
                    onChange={() => toggle(source.id)}
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <label htmlFor={selectable ? fieldId : undefined} className="block">
                    <SourceTitle source={source} tags={sourceTags(source, sources)} />
                  </label>
                  {selectable && waiting && (
                    <p id={`${fieldId}-espera`} className="text-xs font-medium">
                      Para marcar, falta a estimativa de volume, abaixo.
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {AWS_SOURCE_KIND_TEXTS[source.kind].description}
                  </p>
                  <SourceCollectionNote source={source} />
                  <SourceLocation source={source} />
                  {covered && !source.notes.includes('covered_by_api') && (
                    <p className="text-xs text-muted-foreground">
                      Coberto pela API: os mesmos achados já chegam pela API do GuardDuty.
                    </p>
                  )}
                  <SourceNotes source={source} />
                  {balancer && (
                    <EstimateStep source={source} web={webById.get(source.id)} canWrite={canAuthorize} />
                  )}
                  {balancer && web.data != null && (
                    <AlbLoggingOwned source={source} canWrite={canAuthorize} />
                  )}
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
          retry={retry}
        />
      </SourceGroup>

      {canAuthorize && (groups.available.length > 0 || logGroups.length > 0) && (
        <div className="space-y-2">
          {confirming && selected.length > 0 && !tooManyBalancers ? (
            <AuthorizeConfirmation
              selected={selected}
              sources={sources}
              balancers={balancers}
              acknowledged={acknowledged}
              onAcknowledge={acknowledge}
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
              disabled={selected.length === 0 || tooMany || tooManyBalancers}
            >
              {selected.length === 0
                ? 'Autorizar selecionadas'
                : `Autorizar selecionadas (${selected.length})`}
            </Button>
          )}
          {tooManyBalancers && (
            <p role="alert" className="text-sm text-critical-text">
              Cada conta pode ter até {AWS_MAX_AUTHORIZED_WEB_SOURCES} balanceadores autorizados: com os já
              autorizados, esta escolha passa do limite. Desmarque alguns.
            </p>
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
      <RetryError retry={retry} sources={[...groups.needs_permission, ...logGroups]} />

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
        description='Ligar um destes serviços tem custo na AWS, e a decisão é sua: o Verax só liga, a seu pedido, o log de acesso de um balanceador, e nada mais. Se você ligar um deles, clique em Descobrir de novo, em "O que encontramos": a fonte passa a aparecer entre as disponíveis.'
      >
        <SourceList label="Fontes não habilitadas na AWS">
          {groups.not_enabled.map((source) => (
            <li key={source.id} className="space-y-1 px-3 py-2">
              <SourceTitle source={source} />
              <p className="text-xs text-muted-foreground">
                {awsAvailabilityText(source)}. {AWS_SOURCE_KIND_TEXTS[source.kind].description}
              </p>
              <SourceNotes source={source} omit={source.notes.filter((note) => !isAwsCostNote(note))} />
              {source.kind === 'elb_logs' && source.availability === 'no_destination' && (
                <AlbLoggingControl
                  source={source}
                  account={account}
                  onboarding={onboarding}
                  canWrite={canWrite}
                />
              )}
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
              <p className="text-xs text-muted-foreground">{awsAvailabilityText(source)}.</p>
              {source.kind === 'elb_logs' && <UnsupportedBalancerReason source={source} />}
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
