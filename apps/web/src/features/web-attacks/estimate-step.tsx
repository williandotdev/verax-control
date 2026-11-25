import {
  type AwsSource,
  WEB_ESTIMATE_ACK_PERCENT,
  WEB_ESTIMATE_REQUEST_INTERVAL_MS,
  type WebEstimate,
  type WebLogSource,
} from '@verax/shared';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ToneBadge } from '@/features/admin/aws-ui';
import { awsSourceName } from '@/features/admin/aws-onboarding-labels';
import { useNow } from '@/features/admin/aws-hooks';
import { formatDay, formatRelative, formatMinute, plural } from '@/lib/format';
import { type EstimateView, estimateView, projectionText } from './estimate';
import { estimateErrorText, webLogsErrorText } from './web-logs-labels';
import { ESTIMATE_SLOW_AFTER_MS, useEstimatePolling, useRequestEstimate } from './web-logs-api';

/** De quanto em quanto tempo a tela recalcula o que depende do relógio: com um pedido em andamento ou em espera, e sem nada. */
const TICK_MS = 5_000;
const IDLE_TICK_MS = 60_000;

/** "Medida no dia 23/11/2026 (UTC), em 864 arquivos." */
function Measured({ estimate }: { estimate: WebEstimate }) {
  if (estimate.day === null) return null;
  return (
    <>
      {' '}
      Medida no dia {formatDay(estimate.day)} (UTC)
      {estimate.objects !== null && estimate.objects > 0 && (
        <>, em {plural(estimate.objects, 'arquivo', 'arquivos')}</>
      )}
      .
    </>
  );
}

/** O resultado que vale (ou por que não vale), numa linha com o selo e a explicação embaixo. */
function Result({ view }: { view: EstimateView }): ReactNode {
  switch (view.kind) {
    case 'ready': {
      const { estimate, projection } = view;
      return (
        <>
          <ToneBadge tone={projection.acknowledgementRequired ? 'medium' : 'ok'}>
            Estimativa: {projectionText(projection, estimate.truncated)}.
          </ToneBadge>
          <p className="text-muted-foreground">
            <Measured estimate={estimate} /> Vale até {formatMinute(projection.validUntil)}.
            {estimate.truncated &&
              ' Havia mais arquivos do que o Verax lista de uma vez: o volume é um mínimo.'}
            {projection.acknowledgementRequired &&
              (estimate.truncated
                ? ' A autorização vai pedir a sua confirmação.'
                : ` Passa de ${WEB_ESTIMATE_ACK_PERCENT}% do plano: a autorização vai pedir a sua confirmação.`)}
          </p>
        </>
      );
    }
    case 'no_sample':
      return (
        <>
          <ToneBadge tone="medium">Sem amostra: não deu para medir o volume.</ToneBadge>
          <p className="text-muted-foreground">
            O balanceador não gravou nenhum arquivo
            {view.estimate.day !== null && <> no dia {formatDay(view.estimate.day)} (UTC)</>}, ou nenhum pôde
            ser medido. Se ele tem movimento, peça outra amanhã; se não, dá para autorizar assim mesmo, com a
            sua confirmação.
          </p>
        </>
      );
    case 'hidden':
      return (
        <>
          <ToneBadge tone="idle">Volume estimado {formatRelative(view.computedAt)}.</ToneBadge>
          <p className="text-muted-foreground">
            O volume e a parte do plano aparecem para quem administra o cliente.
          </p>
        </>
      );
    case 'expired':
      return (
        <>
          <ToneBadge tone="medium">
            A estimativa foi feita {formatRelative(view.computedAt)} e não vale mais.
          </ToneBadge>
          <p className="text-muted-foreground">
            Ela vale por 7 dias, porque o movimento muda. Peça outra para autorizar.
          </p>
        </>
      );
    case 'failed':
      return (
        <>
          <ToneBadge tone="high">A estimativa falhou.</ToneBadge>
          <p className="text-muted-foreground">Motivo: {estimateErrorText(view.code)}.</p>
        </>
      );
    default:
      return null;
  }
}

/**
 * A estimativa de volume de um balanceador, o passo antes da autorização: o volume por dia e quanto isso é do plano. Quem a
 * calcula é o servidor, a pedido, lendo só os nomes e os tamanhos dos arquivos de ontem; a tela acompanha até a resposta. Com
 * o pedido em andamento, o resultado anterior continua à vista. Pedir outra só vale 5 minutos depois.
 */
export function EstimateStep({
  source,
  web,
  canWrite,
}: {
  source: AwsSource;
  /** O balanceador em `/v1/web-logs`; ausente enquanto a lista não chega. */
  web: WebLogSource | undefined;
  canWrite: boolean;
}) {
  // Até quando o mesmo balanceador não aceita outro pedido, pelo que saiu desta tela.
  const [until, setUntil] = useState(0);
  const requested = web?.estimate?.requestedAt != null;
  const now = useNow(requested || until > 0 ? TICK_MS : IDLE_TICK_MS);
  useEstimatePolling(web, now);
  const request = useRequestEstimate();
  if (web === undefined) return null;

  const { current, previous } = estimateView(web.estimate, now, ESTIMATE_SLOW_AFTER_MS);
  const pending = current.kind === 'pending';
  // O relógio da tela pode estar um pouco atrás do clique: a espera nunca passa do intervalo.
  const waitMs = pending ? 0 : Math.min(WEB_ESTIMATE_REQUEST_INTERVAL_MS, Math.max(0, until - now));
  const label = current.kind === 'never' ? 'Estimar o volume' : 'Estimar de novo';
  const text = request.isPending
    ? 'Pedindo…'
    : waitMs > 0
      ? `${label} em ${Math.ceil(waitMs / 60_000)} min`
      : label;
  const ask = () =>
    request.mutate(source.id, {
      onSuccess: () => setUntil(Date.now() + WEB_ESTIMATE_REQUEST_INTERVAL_MS),
    });

  return (
    <div className="space-y-1.5 rounded-md border border-dashed p-2 text-xs">
      <div role="status" className="space-y-0.5">
        {current.kind === 'never' && (
          <p>
            Antes de autorizar, o Verax estima quanto este balanceador vai consumir do seu plano. Para isso,
            lê só os nomes e os tamanhos dos arquivos de ontem: nenhuma linha de log.
          </p>
        )}
        {pending && (
          <>
            <ToneBadge tone="progress">Estimativa pedida: aguardando o servidor do Verax.</ToneBadge>
            <p className="text-muted-foreground">
              {current.slow
                ? 'Está demorando mais do que o normal. O pedido continua na fila: dá para sair desta tela e voltar depois. Se passar de uma hora, fale com a Verax.'
                : 'Costuma levar menos de um minuto. Esta tela se atualiza sozinha.'}
            </p>
            {previous !== null && (
              <div className="space-y-0.5 border-t pt-1.5">
                <p className="font-medium">Enquanto isso, a anterior:</p>
                <Result view={previous} />
              </div>
            )}
          </>
        )}
        {!pending && <Result view={current} />}
      </div>
      {canWrite && !pending && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={request.isPending || waitMs > 0}
          onClick={ask}
          aria-label={`${text}: ${awsSourceName(source)}`}
        >
          {text}
        </Button>
      )}
      {!canWrite && current.kind === 'never' && (
        <p className="text-muted-foreground">Quem administra as contas pede a estimativa.</p>
      )}
      {request.error ? (
        <p role="alert" className="text-critical-text">
          {webLogsErrorText(request.error)}
        </p>
      ) : null}
    </div>
  );
}
