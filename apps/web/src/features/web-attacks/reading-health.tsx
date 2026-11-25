import type { AwsSource, WebSourceHealth, WebTrustedSource } from '@verax/shared';
import { Fragment, type ReactNode } from 'react';
import { Notice, ToneBadge } from '@/features/admin/aws-ui';
import { awsSourceHealthText } from '@/features/admin/aws-onboarding-labels';
import { formatGb } from '@/features/plan/plan-format';
import { formatCount, formatDuration, formatRelative, formatMinute, plural } from '@/lib/format';
import { engineNoteText, webRuleTitle } from './web-logs-labels';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Fragment>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mb-1.5 min-w-0 wrap-anywhere sm:mb-0">
        <span className="font-medium tabular-nums">{children}</span>
        {hint !== undefined && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </dd>
    </Fragment>
  );
}

/**
 * A leitura do log de um balanceador: o estado e o atraso (os da fonte), o que foi lido nas últimas 24 horas e o que ficou de
 * fora, com o motivo. O que não foi analisado aparece sempre, nunca some.
 */
export function ReadingHealth({
  source,
  health,
  trusted,
}: {
  source: AwsSource;
  /** Null enquanto não chegou, ou num nó que não tem a rota. */
  health: WebSourceHealth | null;
  trusted: readonly WebTrustedSource[];
}) {
  const state = awsSourceHealthText(source);
  // A lacuna e os arquivos recusados têm a contagem logo abaixo: o texto do estado, que manda olhar aqui, não se repete.
  const covered =
    health !== null && (source.stateCode === 'web_gap' || source.stateCode === 'web_quarantined');
  const { lagSeconds, lastSyncAt, lastEventAt } = source.health;
  const cidrOf = (id: string) => trusted.find((item) => item.id === id)?.cidr ?? null;
  return (
    <div className="space-y-3 text-sm">
      <div className="space-y-1">
        <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
        {state.detail !== null && !covered && <p className="text-xs text-muted-foreground">{state.detail}</p>}
      </div>
      <dl className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-y-1.5">
        <Row
          label="Atraso"
          hint={
            lagSeconds === null ? undefined : 'Em dia, fica entre 10 e 15 minutos: a AWS grava de 5 em 5.'
          }
        >
          {lagSeconds === null ? 'sem medida' : formatDuration(lagSeconds)}
        </Row>
        <Row label="Última leitura">{lastSyncAt === null ? 'nenhuma ainda' : formatRelative(lastSyncAt)}</Row>
        <Row label="Última requisição">
          {lastEventAt === null ? 'nenhuma ainda' : formatRelative(lastEventAt)}
        </Row>
      </dl>

      {health !== null && (
        <>
          <h6 className="font-semibold">Nas últimas 24 horas</h6>
          <dl className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[minmax(9rem,auto)_1fr] sm:gap-y-1.5">
            <Row label="Linhas analisadas" hint="Todas, uma vez cada. Nenhuma fica guardada.">
              {formatCount(health.lines.analysed)}
            </Row>
            <Row label="Volume lido" hint="Descompactado: é o que conta no plano.">
              {formatGb(health.bytes)}
            </Row>
            <Row
              label="Arquivos lidos"
              hint={
                health.objects.late > 0
                  ? `${plural(health.objects.late, 'deles chegou', 'deles chegaram')} depois da hora: as contagens ${health.objects.late === 1 ? 'dele' : 'deles'} são o mínimo.`
                  : undefined
              }
            >
              {formatCount(health.objects.read + health.objects.late)}
            </Row>
            <Row
              label="Arquivos recusados"
              hint={
                health.objects.quarantined > 0
                  ? 'Quebrados, grandes demais, arquivados no Glacier ou com data absurda: não são cobrados nem lidos de novo. O trecho lido antes da recusa segue na detecção, e as contagens dele são o mínimo.'
                  : undefined
              }
            >
              {formatCount(health.objects.quarantined)}
            </Row>
            <Row
              label="Linhas fora do formato"
              hint={
                health.lines.malformed > 0 ? 'Não seguem o formato do ALB: não foram analisadas.' : undefined
              }
            >
              {formatCount(health.lines.malformed)}
            </Row>
            <Row
              label="Linhas grandes demais"
              hint={health.lines.oversize > 0 ? 'Passam de 64 KB: não foram analisadas.' : undefined}
            >
              {formatCount(health.lines.oversize)}
            </Row>
            <Row
              label="Linhas de outro balanceador"
              hint={
                health.lines.foreign > 0
                  ? 'Dizem ser de outro balanceador, dentro do arquivo deste: não foram analisadas.'
                  : undefined
              }
            >
              {formatCount(health.lines.foreign)}
            </Row>
          </dl>

          {health.objects.gap > 0 && (
            <Notice tone="high" title="Parte do log ficou sem leitura.">
              <p>
                {plural(
                  health.objects.gap,
                  'arquivo com mais de um dia não foi',
                  'arquivos com mais de um dia não foram',
                )}{' '}
                {health.objects.gap === 1 ? 'analisado' : 'analisados'}
                {health.gap !== null && (
                  <>
                    , do tráfego de {formatMinute(health.gap.from)} a {formatMinute(health.gap.to)}
                  </>
                )}
                . Não dá para recuperar a detecção desse intervalo; o log continua no seu S3, para uma
                investigação.
              </p>
            </Notice>
          )}

          {health.notes.map((note) => {
            const { title, text } = engineNoteText(note);
            return (
              <Notice key={note} tone="medium" title={title}>
                {text !== null && <p>{text}</p>}
              </Notice>
            );
          })}

          {health.suppressed.length > 0 && (
            <div className="space-y-1">
              <h6 className="font-semibold">O que as fontes confiáveis calaram</h6>
              <ul className="space-y-1">
                {health.suppressed.map((item) => (
                  <li key={`${item.trustedId}|${item.ruleId}`} className="text-xs wrap-anywhere">
                    <span className="font-mono">
                      {cidrOf(item.trustedId) ?? 'fonte confiável já removida'}
                    </span>
                    : {webRuleTitle(item.ruleId)}, {plural(item.clients, 'endereço', 'endereços')},{' '}
                    {formatRelative(item.lastSeenAt)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {health.stateAt !== null && (
            <p className="text-xs text-muted-foreground">
              A detecção gravou estas contagens {formatRelative(health.stateAt)}.
            </p>
          )}
        </>
      )}
    </div>
  );
}
