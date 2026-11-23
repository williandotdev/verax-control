import {
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_KINDS,
  type AwsInfrastructureSummary,
  type AwsOnboarding,
  type AwsSource,
  type AwsSourceKind,
  type CloudAccount,
} from '@verax/shared';
import { Fragment } from 'react';
import { Button } from '@/components/ui/button';
import { useAwsDiscovery } from '@/features/admin/aws-onboarding-api';
import {
  AWS_DISCOVERY_SERVICE_LABELS,
  AWS_DISCOVERY_STATUS_LABELS,
  AWS_INFRASTRUCTURE_LABELS,
  AWS_SOURCE_KIND_TEXTS,
  awsDiscoveryErrorHint,
  awsOnboardingErrorText,
  type Tone,
} from '@/features/admin/aws-onboarding-labels';
import { isAuthorizedSource } from '@/features/admin/aws-sources';
import { Notice, ScrollTable, Section, ToneBadge } from '@/features/admin/aws-ui';
import { formatRelative, plural } from '@/lib/format';

const numberFormat = new Intl.NumberFormat('pt-BR');

type CountKey = Exclude<keyof AwsInfrastructureSummary, 'rootMfaEnabled'>;

/** O recorte no singular, quando ele muda com o número ("1 público", "2 públicos"). */
const SINGULAR_PARTS: Partial<Record<CountKey, string>> = {
  openSecurityGroups: 'aberto para a internet',
  publicBuckets: 'público',
  rdsPublic: 'público',
  internetFacingLoadBalancers: 'voltado para a internet',
};

/** O retrato da conta: cada linha tem o total e, quando há, os recortes que importam para a segurança. */
const INFRASTRUCTURE_ROWS: readonly { total: CountKey; parts: readonly CountKey[] }[] = [
  { total: 'instances', parts: ['publicInstances'] },
  { total: 'securityGroups', parts: ['openSecurityGroups'] },
  { total: 'buckets', parts: ['publicBuckets'] },
  { total: 'rdsInstances', parts: ['rdsPublic', 'rdsUnencrypted'] },
  { total: 'rdsClusters', parts: [] },
  { total: 'loadBalancers', parts: ['internetFacingLoadBalancers'] },
  { total: 'vpcs', parts: [] },
  { total: 'webAcls', parts: [] },
  { total: 'trails', parts: [] },
  { total: 'logGroups', parts: [] },
  { total: 'iamUsers', parts: [] },
];

function regionLabel(region: string): string {
  return region === AWS_SOURCE_GLOBAL_REGION ? 'conta inteira' : region;
}

/** O retrato da infraestrutura em números. Uma leitura recusada aparece como "não lido", nunca como zero. */
function InfrastructureSummary({
  summary,
  regions,
}: {
  summary: AwsInfrastructureSummary;
  regions: string[];
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      <dt className="text-muted-foreground">Regiões com recursos</dt>
      <dd>{regions.length > 0 ? regions.join(', ') : 'nenhuma encontrada'}</dd>
      {INFRASTRUCTURE_ROWS.map(({ total, parts }) => {
        const value = summary[total];
        const details = parts.flatMap((part) => {
          const count = summary[part];
          if (count === null) return [];
          const label =
            count === 1
              ? (SINGULAR_PARTS[part] ?? AWS_INFRASTRUCTURE_LABELS[part])
              : AWS_INFRASTRUCTURE_LABELS[part];
          return [`${numberFormat.format(count)} ${label}`];
        });
        return (
          <Fragment key={total}>
            <dt className="text-muted-foreground">{AWS_INFRASTRUCTURE_LABELS[total]}</dt>
            <dd>
              {value === null ? (
                <span className="text-muted-foreground">não lido</span>
              ) : (
                <>
                  {numberFormat.format(value)}
                  {details.length > 0 && (
                    <span className="text-muted-foreground"> ({details.join(', ')})</span>
                  )}
                </>
              )}
            </dd>
          </Fragment>
        );
      })}
      <dt className="text-muted-foreground">{AWS_INFRASTRUCTURE_LABELS.rootMfaEnabled}</dt>
      <dd>
        {summary.rootMfaEnabled === null ? (
          <span className="text-muted-foreground">não lido</span>
        ) : summary.rootMfaEnabled ? (
          <ToneBadge tone="ok">ligado</ToneBadge>
        ) : (
          <ToneBadge tone="high">desligado</ToneBadge>
        )}
      </dd>
    </dl>
  );
}

/** O que a descoberta diz de um serviço, pelas fontes dele: quantas dá para ler, quantas já são coletadas. */
function serviceSummary(
  kind: AwsSourceKind,
  sources: readonly AwsSource[],
): { tone: Tone; text: string } | null {
  const own = sources.filter((source) => source.kind === kind);
  if (own.length === 0) return null;
  const readable = own.filter((source) => source.availability === 'available');
  const authorized = own.filter(isAuthorizedSource);
  if (readable.length === 0) {
    const enabled = own.some((source) => source.availability !== 'not_enabled');
    return {
      tone: 'idle',
      text: enabled ? 'encontrado, mas não dá para ler de onde está' : 'não habilitado',
    };
  }
  const found = plural(readable.length, 'fonte encontrada', 'fontes encontradas');
  if (authorized.length === 0) return { tone: 'low', text: `${found}, nenhuma autorizada` };
  return { tone: 'ok', text: `${found}, ${plural(authorized.length, 'autorizada', 'autorizadas')}` };
}

function IdentifiedServices({ sources }: { sources: readonly AwsSource[] }) {
  const rows = AWS_SOURCE_KINDS.flatMap((kind) => {
    const summary = serviceSummary(kind, sources);
    return summary === null ? [] : [{ kind, ...summary }];
  });
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-sm font-medium">Serviços identificados</h4>
      <ul className="space-y-1 text-sm">
        {rows.map(({ kind, tone, text }) => (
          <li key={kind}>
            <ToneBadge tone={tone}>
              {kind === 'cloudwatch_log_group'
                ? 'Grupos do CloudWatch Logs'
                : AWS_SOURCE_KIND_TEXTS[kind].label}
              : {text}
            </ToneBadge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Quantas leituras que ficaram de fora aparecem antes do "ver todas". */
const VISIBLE_ERRORS = 8;

/** O que a descoberta não conseguiu ler: o serviço, a região e o motivo de cada leitura que ficou de fora. */
function DiscoveryErrors({ onboarding }: { onboarding: AwsOnboarding }) {
  const errors = onboarding.discovery.run?.errors ?? [];
  if (errors.length === 0) return null;
  const rows = errors.map((error) => (
    <tr key={`${error.service}|${error.region}|${error.code}`} className="border-t">
      <td className="px-3 py-1.5 align-top">{AWS_DISCOVERY_SERVICE_LABELS[error.service]}</td>
      <td className="px-3 py-1.5 align-top">{regionLabel(error.region)}</td>
      <td className="px-3 py-1.5 align-top">{awsDiscoveryErrorHint(error.code)}</td>
    </tr>
  ));
  const table = (visible: typeof rows) => (
    <ScrollTable
      caption="O que a descoberta não conseguiu ler"
      className="bg-surface"
      tableClassName="text-xs"
    >
      <thead className="text-left text-muted-foreground">
        <tr>
          <th scope="col" className="px-3 py-1.5 font-medium">
            Serviço
          </th>
          <th scope="col" className="px-3 py-1.5 font-medium">
            Região
          </th>
          <th scope="col" className="px-3 py-1.5 font-medium">
            Motivo
          </th>
        </tr>
      </thead>
      <tbody>{visible}</tbody>
    </ScrollTable>
  );
  return (
    <Notice
      tone="high"
      title={`Descoberta parcial: ${plural(errors.length, 'leitura ficou de fora', 'leituras ficaram de fora')}.`}
    >
      <p>
        O resto da conta foi lido normalmente. O que ficou de fora pode esconder uma fonte de log: resolva o
        motivo e rode a descoberta de novo.
      </p>
      {errors.length <= VISIBLE_ERRORS ? (
        table(rows)
      ) : (
        <details className="space-y-2">
          <summary className="cursor-pointer">Ver as {errors.length} leituras que ficaram de fora</summary>
          {table(rows)}
        </details>
      )}
    </Notice>
  );
}

/**
 * "O que encontramos": quando a descoberta rodou e como terminou, o retrato da infraestrutura, os serviços
 * identificados e, na descoberta parcial, o que ficou de fora e por quê. "Descobrir de novo" pede outra execução (a API
 * aceita uma a cada 5 min; a recusa é explicada aqui).
 */
export function AwsDiscoveryResults({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const discovery = useAwsDiscovery(account.id);
  const { run, lastCompletedAt, regions } = onboarding.discovery;
  const running = run !== null && (run.status === 'pending' || run.status === 'running');
  const failed = run !== null && run.status === 'failed';
  return (
    <Section id="aws-descoberta" title="O que encontramos">
      <div role="status" className="space-y-1 text-sm">
        {running ? (
          <ToneBadge tone="progress">
            Descoberta {run.status === 'pending' ? 'na fila' : 'em andamento'}: o Verax está lendo a
            configuração da conta (só nomes e configuração, nenhum conteúdo).
          </ToneBadge>
        ) : run === null ? (
          <p>A descoberta ainda não rodou nesta conta.</p>
        ) : (
          <p>
            Última descoberta: {AWS_DISCOVERY_STATUS_LABELS[run.status]}
            {run.finishedAt !== null && <>, {formatRelative(run.finishedAt)}</>}.
            {run.regions.length > 0 && (
              <> {plural(run.regions.length, 'região lida', 'regiões lidas')} na conta.</>
            )}
          </p>
        )}
        {failed && lastCompletedAt !== null && (
          <p className="text-muted-foreground">
            O que aparece abaixo é da última descoberta que deu certo, {formatRelative(lastCompletedAt)}.
          </p>
        )}
      </div>
      {failed && (
        <Notice tone="critical" title="A última descoberta não conseguiu ler a conta.">
          <p>
            Motivo:{' '}
            {run.errors[0] === undefined ? 'não informado' : awsDiscoveryErrorHint(run.errors[0].code)}. Rode
            a descoberta de novo.
          </p>
        </Notice>
      )}
      {canWrite && (
        <div className="space-y-1">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => discovery.mutate()}
            disabled={running || discovery.isPending || account.status !== 'active'}
          >
            {run === null ? 'Descobrir as fontes' : 'Descobrir de novo'}
          </Button>
          {discovery.error ? (
            <p role="alert" className="text-sm text-critical-text">
              {awsOnboardingErrorText(discovery.error)}
            </p>
          ) : null}
        </div>
      )}
      {onboarding.infrastructure !== null && (
        <InfrastructureSummary summary={onboarding.infrastructure} regions={regions} />
      )}
      <IdentifiedServices sources={onboarding.sources} />
      {!failed && <DiscoveryErrors onboarding={onboarding} />}
    </Section>
  );
}
