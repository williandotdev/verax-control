import { useMutation } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import { fleetApi, type NodeAction, type RolloutAction, type RolloutNode } from './api';
import { failureHint, hostStateLabel, NODE_STATE_LABELS, ROLLOUT_STATE_LABELS, WAVE_LABELS } from './labels';
import { useInvalidateFleet, useRollout } from './queries';

const TH = 'px-3 py-2 font-medium';
const TD = 'px-3 py-2';
const IN_FLIGHT = new Set(['updating', 'checking', 'publishing']);

/** O que o nó está fazendo agora, em uma linha. */
function progressOf(node: RolloutNode): string {
  if (node.state === 'updating') return hostStateLabel(node.nodeState) ?? 'esperando o host';
  if (node.state === 'publishing') return `${node.panelsDone} de ${node.panels.length} sites`;
  return '';
}

/**
 * Uma rodada da frota ao vivo (atualiza sozinha enquanto anda): a situação, a falha que a parou, as operações (parar,
 * retomar, abortar) e cada nó, com o que o host relatou e as operações dele (pular, voltar para a versão de antes).
 */
export function RolloutPage() {
  const { id = '' } = useParams();
  const detail = useRollout(id);
  const invalidate = useInvalidateFleet();
  const act = useMutation({
    mutationFn: (action: RolloutAction) => fleetApi.act(id, action),
    onSuccess: invalidate,
  });
  const actOnNode = useMutation({
    mutationFn: ({ key, action }: { key: string; action: NodeAction }) => fleetApi.actOnNode(id, key, action),
    onSuccess: invalidate,
  });
  const busy = act.isPending || actOnNode.isPending;

  if (detail.isPending) return <LoadingState label="Carregando a rodada" />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  const { rollout, nodes } = detail.data;
  const stopped = rollout.state === 'paused' || rollout.state === 'paused_on_failure';
  const open = rollout.state === 'running' || stopped;
  const failedNode = nodes.find((node) => node.key === rollout.failure?.nodeKey);

  return (
    <div className="space-y-4">
      <header className="max-w-3xl space-y-1">
        <p className="text-sm">
          <Link to="/versoes" className="text-primary underline underline-offset-2">
            Versões
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">
          Rodada <span className="font-mono">{rollout.release}</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          {ROLLOUT_STATE_LABELS[rollout.state]} · começou em {formatDateTime(rollout.createdAt)} por{' '}
          {rollout.createdBy} · {rollout.concurrency} {rollout.concurrency === 1 ? 'dedicado' : 'dedicados'}{' '}
          por vez
          {rollout.window !== undefined && ` · janela ${rollout.window} (Brasília)`}
        </p>
      </header>

      <p role="status" className="text-sm tabular-nums">
        {rollout.totals.done} de {rollout.totals.nodes} nós atualizados · {rollout.totals.inFlight} mudando
        agora · {rollout.totals.pending} na fila · {rollout.totals.failed} com falha ·{' '}
        {rollout.totals.skipped} pulados
      </p>

      {rollout.failure !== undefined && rollout.state === 'paused_on_failure' && (
        <div
          role="alert"
          className="space-y-1 rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm"
        >
          <p className="font-medium">
            A rodada parou em {failedNode?.label ?? rollout.failure.nodeKey}:{' '}
            <span className="font-mono">{rollout.failure.code}</span>
          </p>
          <p>{failureHint(rollout.failure.code)}</p>
          <p className="text-muted-foreground">
            Os outros nós não foram tocados. Retomar tenta este nó de novo; pular segue sem ele.
          </p>
        </div>
      )}

      {open && (
        <div className="flex flex-wrap gap-2">
          {rollout.state === 'running' && (
            <Button variant="secondary" disabled={busy} onClick={() => act.mutate('pause')}>
              Parar a rodada
            </Button>
          )}
          {stopped && (
            <Button disabled={busy} onClick={() => act.mutate('resume')}>
              Retomar
            </Button>
          )}
          <Button variant="danger" disabled={busy} onClick={() => act.mutate('abort')}>
            Abortar
          </Button>
        </div>
      )}
      {(act.isError || actOnNode.isError) && <ErrorState error={act.error ?? actOnNode.error} />}

      <Card aria-labelledby="nos-da-rodada">
        <CardHeader>
          <div>
            <CardTitle id="nos-da-rodada">Nós</CardTitle>
            <CardDescription>
              Na ordem das ondas. O painel de cada nó só é publicado depois do host pronto e da API pública no
              ar.
            </CardDescription>
          </div>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Nós da rodada, na ordem das ondas</caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className={TH}>
                  Nó
                </th>
                <th scope="col" className={TH}>
                  Onda
                </th>
                <th scope="col" className={TH}>
                  Situação
                </th>
                <th scope="col" className={TH}>
                  Antes
                </th>
                <th scope="col" className={TH}>
                  Painel
                </th>
                <th scope="col" className={TH}>
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.key} className="border-t align-top">
                  <th scope="row" className={`${TD} text-left font-medium`}>
                    {node.label}
                    <span className="block font-mono text-xs font-normal text-muted-foreground">
                      {node.instance}
                    </span>
                  </th>
                  <td className={TD}>{WAVE_LABELS[node.wave] ?? node.wave}</td>
                  <td className={TD}>
                    {NODE_STATE_LABELS[node.state]}
                    {node.operation?.kind === 'revert' && (
                      <span className="block text-xs">voltando para {node.operation.release}</span>
                    )}
                    {progressOf(node) !== '' && (
                      <span className="block text-xs text-muted-foreground">{progressOf(node)}</span>
                    )}
                    {node.errorCode !== undefined && (
                      <span className="block font-mono text-xs text-critical-text">{node.errorCode}</span>
                    )}
                  </td>
                  <td className={`${TD} font-mono text-xs`}>{node.fromVersion ?? '—'}</td>
                  <td className={TD}>{node.panels.length === 0 ? '—' : node.panels.join(', ')}</td>
                  <td className={`${TD} text-right`}>
                    <div className="flex flex-wrap justify-end gap-1">
                      {(node.state === 'pending' || node.state === 'failed') &&
                        !IN_FLIGHT.has(node.state) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            aria-label={`Pular ${node.label}`}
                            onClick={() => actOnNode.mutate({ key: node.key, action: 'skip' })}
                          >
                            Pular
                          </Button>
                        )}
                      {(node.state === 'done' || node.state === 'failed') &&
                        node.fromVersion?.startsWith('node-v') === true &&
                        node.operation?.kind !== 'revert' && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            aria-label={`Voltar ${node.label} para ${node.fromVersion}`}
                            onClick={() => actOnNode.mutate({ key: node.key, action: 'rollback' })}
                          >
                            Voltar para {node.fromVersion}
                          </Button>
                        )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
