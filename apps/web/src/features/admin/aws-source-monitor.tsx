import { type AwsOnboarding, type AwsSource, type CloudAccount } from '@verax/shared';
import { Fragment } from 'react';
import { ConfirmButton } from '@/features/admin/admin-ui';
import type { SourceRetry } from '@/features/admin/aws-hooks';
import { useAwsRevokeSource } from '@/features/admin/aws-onboarding-api';
import {
  AWS_SOURCE_KIND_TEXTS,
  awsOnboardingErrorText,
  awsSourceHealthText,
  awsSourceName,
} from '@/features/admin/aws-onboarding-labels';
import {
  PermissionFix,
  RetryButton,
  RetryError,
  SensitiveTag,
  SourceCollectionNote,
  SourceLocation,
  SourceRegion,
} from '@/features/admin/aws-source-parts';
import { awsAuthorizedSourceAnchor, groupAwsSources, isFirstOfKind } from '@/features/admin/aws-sources';
import { awsConnectionErrorHint } from '@/features/admin/labels';
import { ScrollTable, Section, Tag, ToneBadge } from '@/features/admin/aws-ui';
import { webAttacksAnchor } from '@/features/web-attacks/anchors';
import { formatGb } from '@/features/plan/plan-format';
import { formatDay, formatDuration, formatRelative } from '@/lib/format';

const numberFormat = new Intl.NumberFormat('pt-BR');

/**
 * Os estados em que ler a fonte de novo na AWS pode destravá-la: a permissão corrigida, a leitura que voltou a dar
 * certo, a fonte parada e a que sumiu (religada ou recriada; a conferência dela pede uma descoberta da conta).
 */
const RETRYABLE_STATES: readonly AwsSource['state'][] = [
  'permission_error',
  'ingestion_error',
  'stalled',
  'source_missing',
];

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
 *
 * Cada linha tem um `id` (`awsAuthorizedSourceAnchor`): as conferências da conexão apontam para ele a fonte que as
 * deixa pendentes ou com falha. A linha apontada (o alvo do endereço) fica em destaque, com um contorno e a marca
 * "Apontada pela conferência", nunca só com cor.
 */
export function AwsSourceMonitor({
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
  const revoke = useAwsRevokeSource(account.id);
  const { authorized } = groupAwsSources(onboarding.sources);
  const active = account.status === 'active';
  if (authorized.length === 0) return null;

  return (
    <Section id="aws-autorizadas" title="Fontes autorizadas">
      <p className="text-sm text-muted-foreground">
        O que o Verax coleta desta conta, com a situação de cada fonte. A coleta de cada uma começou no dia da
        autorização.
      </p>
      <RetryError retry={retry} sources={authorized} />
      {revoke.error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(revoke.error)}
        </p>
      ) : null}
      <ScrollTable
        caption="Saúde da coleta de cada fonte autorizada"
        className="rounded-lg"
        tableClassName="min-w-[64rem] text-sm"
      >
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
          {authorized.map((source, index) => {
            const health = awsSourceHealthText(source);
            const legacy = source.origin === 'legacy';
            const name = awsSourceName(source);
            const label = `${AWS_SOURCE_KIND_TEXTS[source.kind].label} ${name}`.trim();
            const retryable = RETRYABLE_STATES.includes(source.state);
            return (
              <Fragment key={source.id}>
                <tr
                  id={awsAuthorizedSourceAnchor(source.id)}
                  className="group/fonte scroll-mt-4 border-t target:bg-low/10 target:outline-2 target:-outline-offset-2 target:outline-ring"
                >
                  <th scope="row" className="min-w-64 space-y-1 px-3 py-2 text-left align-top font-normal">
                    <p className="hidden text-xs font-semibold group-target/fonte:block">
                      Apontada pela conferência
                    </p>
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
                    {/* Como o tipo é coletado: uma vez, na primeira fonte do tipo (E-04). */}
                    {!legacy && isFirstOfKind(authorized, index) && <SourceCollectionNote source={source} />}
                    {source.collectFrom !== null && (
                      <p className="text-xs text-muted-foreground">
                        Coleta desde {formatDay(source.collectFrom)}
                      </p>
                    )}
                    {source.kind === 'elb_logs' && source.collectable && (
                      <p className="text-xs">
                        <a
                          href={`#${webAttacksAnchor(source.id)}`}
                          className="underline"
                          aria-label={`Ver em Ataques web: ${name}`}
                        >
                          Ver em Ataques web
                        </a>
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
                          <RetryButton source={source} retry={retry} label="Tentar de novo" />
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
                      <PermissionFix
                        source={source}
                        account={account}
                        onboarding={onboarding}
                        again="Tentar de novo"
                      />
                    </td>
                  </tr>
                )}
                {source.state === 'permission_error' && legacy && (
                  <tr>
                    <td colSpan={8} className="px-3 pb-3 text-xs">
                      {legacyBucketHint(source) ?? 'O Verax não conseguiu ler este bucket.'} Corrija e clique
                      em Verificar conexão.
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </ScrollTable>
    </Section>
  );
}
