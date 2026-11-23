import { type AwsOnboarding, type AwsSource, type CloudAccount } from '@verax/shared';
import { Fragment } from 'react';
import { ConfirmButton } from '@/features/admin/admin-ui';
import { useAwsRetrySource, useAwsRevokeSource } from '@/features/admin/aws-onboarding-api';
import {
  AWS_SOURCE_KIND_TEXTS,
  awsOnboardingErrorText,
  awsSourceHealthText,
  awsSourceName,
} from '@/features/admin/aws-onboarding-labels';
import {
  PermissionFix,
  RetryButton,
  SensitiveTag,
  SourceLocation,
  SourceRegion,
} from '@/features/admin/aws-source-parts';
import { groupAwsSources } from '@/features/admin/aws-sources';
import { awsConnectionErrorHint } from '@/features/admin/labels';
import { Section, Tag, ToneBadge } from '@/features/admin/aws-ui';
import { formatGb } from '@/features/plan/plan-format';
import { formatDay, formatDuration, formatRelative } from '@/lib/format';

const numberFormat = new Intl.NumberFormat('pt-BR');

/** Os estados em que conferir a permissão de novo pode destravar a fonte. */
const RETRYABLE_STATES: readonly AwsSource['state'][] = ['permission_error', 'ingestion_error', 'stalled'];

function When({ at, never }: { at: string | null; never: string }) {
  return at === null ? <span className="text-muted-foreground">{never}</span> : <>{formatRelative(at)}</>;
}

/**
 * O que fazer com um bucket cadastrado manualmente que o Verax não leu: o texto de sempre da conferência da conexão,
 * que diz de qual fonte é o bucket (o `LogBucketArns` da pilha, a chave KMS, a política do bucket).
 */
function legacyBucketHint(source: AwsSource): string | null {
  const code = source.stateCode ?? source.permissionDetail;
  const legacySource = source.details.legacySource;
  if (code === null) return null;
  return awsConnectionErrorHint(legacySource === undefined ? code : `${code}:${legacySource}`);
}

/** O volume das últimas 24 horas, quando o coletor o mede. */
function Volume({ source }: { source: AwsSource }) {
  const { eventsLast24h, bytesLast24h } = source.health;
  if (eventsLast24h === null && bytesLast24h === null)
    return <span className="text-muted-foreground">—</span>;
  return (
    <>
      {eventsLast24h !== null &&
        `${numberFormat.format(eventsLast24h)} ${eventsLast24h === 1 ? 'evento' : 'eventos'}`}
      {eventsLast24h !== null && bytesLast24h !== null && ' · '}
      {bytesLast24h !== null && formatGb(bytesLast24h)}
    </>
  );
}

/**
 * "Fontes autorizadas": a tabela do acompanhamento, uma linha por fonte com a autorização valendo. O estado, o último
 * evento, a última leitura e o atraso são os que a API mandou (os coletores os gravam); sem medida, a célula diz que
 * não há, em vez de um valor inventado. As ações: retirar a autorização (com confirmação) e tentar de novo. As fontes
 * dos buckets cadastrados manualmente aparecem aqui e mudam só no cadastro dos buckets.
 */
export function AwsSourceMonitor({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const revoke = useAwsRevokeSource(account.id);
  const retry = useAwsRetrySource(account.id);
  const { authorized } = groupAwsSources(onboarding.sources);
  const active = account.status === 'active';
  const retryingId = retry.isPending ? (retry.variables ?? null) : null;
  const error = revoke.error ?? retry.error;
  if (authorized.length === 0) return null;

  return (
    <Section id="aws-autorizadas" title="Fontes autorizadas">
      <p className="text-sm text-muted-foreground">
        O que o Verax coleta desta conta, com a situação de cada fonte. A coleta de cada uma começou no dia da
        autorização.
      </p>
      {error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(error)}
        </p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[64rem] text-sm">
          <caption className="sr-only">
            Fontes autorizadas da conta AWS e a saúde da coleta de cada uma
          </caption>
          <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
            <tr>
              {[
                'Fonte',
                'Região',
                'Estado',
                'Último evento',
                'Última leitura',
                'Atraso',
                'Volume (24 h)',
                'Ações',
              ].map((header) => (
                <th key={header} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {authorized.map((source) => {
              const health = awsSourceHealthText(source);
              const legacy = source.origin === 'legacy';
              const name = awsSourceName(source);
              const label = `${AWS_SOURCE_KIND_TEXTS[source.kind].label} ${name}`.trim();
              const retryable = RETRYABLE_STATES.includes(source.state);
              return (
                <Fragment key={source.id}>
                  <tr className="border-t">
                    <th scope="row" className="min-w-64 space-y-1 px-3 py-2 text-left align-top font-normal">
                      <p>
                        <span className="font-medium">{AWS_SOURCE_KIND_TEXTS[source.kind].label}</span>
                        {name !== '' && (
                          <>
                            {' · '}
                            <span className="font-mono text-xs wrap-anywhere">{name}</span>
                          </>
                        )}
                      </p>
                      <p className="flex flex-wrap gap-1">
                        {legacy && <Tag>Cadastrada manualmente</Tag>}
                        {source.sensitive && <SensitiveTag />}
                      </p>
                      <SourceLocation source={source} />
                      {source.collectFrom !== null && (
                        <p className="text-xs text-muted-foreground">
                          Coleta desde {formatDay(source.collectFrom)}
                        </p>
                      )}
                    </th>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <SourceRegion region={source.region} />
                    </td>
                    <td className="min-w-44 space-y-1 px-3 py-2 align-top">
                      <ToneBadge tone={health.tone}>{health.label}</ToneBadge>
                      {health.detail !== null && (
                        <p className="text-xs text-muted-foreground">{health.detail}</p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <When at={source.health.lastEventAt} never="nenhum ainda" />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <When at={source.health.lastSyncAt} never="nenhuma ainda" />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      {source.health.lagSeconds === null ? (
                        <span className="text-muted-foreground">sem medida</span>
                      ) : (
                        formatDuration(source.health.lagSeconds)
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top">
                      <Volume source={source} />
                    </td>
                    <td className="min-w-40 space-y-2 px-3 py-2 align-top">
                      {legacy ? (
                        <p className="text-xs text-muted-foreground">
                          Muda em{' '}
                          <a href="#aws-buckets" className="underline">
                            Avançado: buckets fora do padrão
                          </a>
                          .
                        </p>
                      ) : canWrite ? (
                        <>
                          {retryable && active && (
                            <RetryButton
                              source={source}
                              onRetry={(id) => retry.mutate(id)}
                              pending={retryingId === source.id}
                              label="Tentar de novo"
                            />
                          )}
                          <ConfirmButton
                            label="Revogar"
                            ariaLabel={`Revogar: ${label}`}
                            size="sm"
                            confirmLabel="Confirmar revogação"
                            busy={revoke.isPending}
                            warning="O Verax para de ler esta fonte. O que já foi coletado continua no histórico, e você pode autorizar de novo depois (a coleta recomeça no dia da nova autorização)."
                            onConfirm={() => revoke.mutate(source.id)}
                          />
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                  {source.state === 'permission_error' && !legacy && (
                    <tr>
                      <td colSpan={8} className="px-3 pb-3">
                        <PermissionFix source={source} account={account} onboarding={onboarding} />
                      </td>
                    </tr>
                  )}
                  {source.state === 'permission_error' && legacy && (
                    <tr>
                      <td colSpan={8} className="px-3 pb-3 text-xs">
                        {legacyBucketHint(source) ?? 'O Verax não conseguiu ler este bucket.'} Corrija e
                        clique em Verificar conexão.
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
