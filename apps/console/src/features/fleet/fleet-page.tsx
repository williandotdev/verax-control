import { Rocket } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/format';
import {
  EXCLUSION_LABELS,
  hostStateLabel,
  RELEASE_STATUS_LABELS,
  ROLLOUT_STATE_LABELS,
  WAVE_LABELS,
} from './labels';
import { useInventory, useReleases, useRollouts } from './queries';

const TH = 'px-3 py-2 font-medium';
const TD = 'px-3 py-2';

/**
 * Versões do nó e da frota (decisão de 16/11/2026): as versões promovidas no bucket de releases (cada uma conferida pelo
 * cp-worker), a versão de cada nó e de cada site do painel agora, e as rodadas de "Promover para a frota".
 */
export function FleetPage() {
  const releases = useReleases();
  const inventory = useInventory();
  const rollouts = useRollouts();
  const active = rollouts.data?.rollouts.find((rollout) =>
    ['running', 'paused', 'paused_on_failure'].includes(rollout.state),
  );

  return (
    <div className="space-y-4">
      <header className="max-w-3xl space-y-1">
        <h1 className="text-2xl font-semibold">Versões</h1>
        <p className="text-sm text-muted-foreground">
          Cada nó (a célula e os dedicados) aplica a versão pedida no próprio host, com backup e volta
          automática, em ondas: a célula da Verax primeiro. O painel de cada destino é publicado só depois do
          nó dele, na mesma versão.
        </p>
      </header>

      {active !== undefined && (
        <p role="status" className="rounded-lg border border-border-strong p-3 text-sm">
          Rodada em andamento: <span className="font-mono">{active.release}</span>,{' '}
          {ROLLOUT_STATE_LABELS[active.state].toLowerCase()}.{' '}
          <Link to={`/versoes/rodadas/${active.id}`} className="text-primary underline underline-offset-2">
            Acompanhar a rodada
          </Link>
        </p>
      )}

      <Card aria-labelledby="versoes-promovidas">
        <CardHeader>
          <div>
            <CardTitle id="versoes-promovidas">Versões promovidas</CardTitle>
            <CardDescription>
              As do bucket de releases, a mais nova primeiro. Só uma versão conferida e com o bundle do painel
              vai para a frota.
            </CardDescription>
          </div>
        </CardHeader>
        {releases.isPending && <LoadingState label="Carregando as versões" />}
        {releases.isError && <ErrorState error={releases.error} onRetry={() => void releases.refetch()} />}
        {releases.data?.releases.length === 0 && (
          <EmptyState
            title="Nenhuma versão no bucket"
            description="Promova uma versão pelo workflow Versão do nó e copie o release para o bucket (docs/runbooks/versao-no.md)."
          />
        )}
        {releases.data !== undefined && releases.data.releases.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Versões promovidas, da mais nova para a mais antiga</caption>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className={TH}>
                    Versão
                  </th>
                  <th scope="col" className={TH}>
                    Commit
                  </th>
                  <th scope="col" className={TH}>
                    Situação
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Ação</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {releases.data.releases.map((entry) => (
                  <tr key={entry.release} className="border-t">
                    <th scope="row" className={`${TD} text-left font-mono font-medium`}>
                      {entry.release}
                    </th>
                    <td className={`${TD} font-mono text-xs`}>{entry.commit?.slice(0, 12) ?? '—'}</td>
                    <td className={TD}>{RELEASE_STATUS_LABELS[entry.status]}</td>
                    <td className={`${TD} text-right`}>
                      {entry.status === 'ok' && active === undefined && (
                        <Link
                          to={`/versoes/promover/${encodeURIComponent(entry.release)}`}
                          className={buttonVariants({ size: 'sm' })}
                          aria-label={`Promover ${entry.release} para a frota`}
                        >
                          <Rocket aria-hidden />
                          Promover para a frota
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card aria-labelledby="frota-agora">
        <CardHeader>
          <div>
            <CardTitle id="frota-agora">A frota agora</CardTitle>
            <CardDescription>
              A versão de cada nó (o que o host relatou) e a de cada site do painel (a última publicação).
            </CardDescription>
          </div>
        </CardHeader>
        {inventory.isPending && <LoadingState label="Lendo os nós e os sites" />}
        {inventory.isError && <ErrorState error={inventory.error} onRetry={() => void inventory.refetch()} />}
        {inventory.data?.nodes.length === 0 && (
          <EmptyState
            title="Nenhum nó na frota"
            description="A célula entra com os campos node e staffPanel."
          />
        )}
        {inventory.data !== undefined && inventory.data.nodes.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Nós da frota e a versão de cada um e dos sites do painel</caption>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className={TH}>
                    Nó
                  </th>
                  <th scope="col" className={TH}>
                    Onda
                  </th>
                  <th scope="col" className={TH}>
                    Versão do nó
                  </th>
                  <th scope="col" className={TH}>
                    Painel
                  </th>
                </tr>
              </thead>
              <tbody>
                {inventory.data.nodes.map((node) => (
                  <tr key={node.key} className="border-t align-top">
                    <th scope="row" className={`${TD} text-left font-medium`}>
                      {node.label}
                      <span className="block text-xs font-normal text-muted-foreground">
                        {node.kind === 'cell' ? 'Célula' : 'Dedicado'}
                      </span>
                    </th>
                    <td className={TD}>{WAVE_LABELS[node.wave] ?? node.wave}</td>
                    <td className={TD}>
                      {node.error === 'unreachable' ? (
                        <span className="text-critical-text">Sem resposta da VM</span>
                      ) : (
                        <>
                          <span className="font-mono">{node.version ?? 'desconhecida'}</span>
                          {node.updateState !== undefined && (
                            <span className="block text-xs text-muted-foreground">
                              Última atualização: {hostStateLabel(node.updateState)}
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className={TD}>
                      <ul className="space-y-0.5">
                        {node.panels.map((panel) => (
                          <li key={panel.slug}>
                            <span className="font-mono">{panel.slug}</span>:{' '}
                            {panel.error === 'unreachable'
                              ? 'sem resposta'
                              : (panel.release ?? 'fora da frota')}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {inventory.data !== undefined && inventory.data.excluded.length > 0 && (
          <div className="mt-3 space-y-1 text-sm">
            <h3 className="font-medium">Fora da frota agora</h3>
            <ul className="list-disc pl-5 text-muted-foreground">
              {inventory.data.excluded.map((entry) => (
                <li key={entry.key}>
                  <span className="font-mono">{entry.label}</span>: {EXCLUSION_LABELS[entry.reason]}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card aria-labelledby="rodadas">
        <CardHeader>
          <div>
            <CardTitle id="rodadas">Rodadas</CardTitle>
            <CardDescription>
              O histórico de "Promover para a frota", a mais recente primeiro.
            </CardDescription>
          </div>
        </CardHeader>
        {rollouts.isPending && <LoadingState label="Carregando as rodadas" />}
        {rollouts.isError && <ErrorState error={rollouts.error} onRetry={() => void rollouts.refetch()} />}
        {rollouts.data?.rollouts.length === 0 && (
          <EmptyState title="Nenhuma rodada ainda" description="Promova uma versão da lista acima." />
        )}
        {rollouts.data !== undefined && rollouts.data.rollouts.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Rodadas da frota, da mais recente para a mais antiga</caption>
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className={TH}>
                    Versão
                  </th>
                  <th scope="col" className={TH}>
                    Situação
                  </th>
                  <th scope="col" className={TH}>
                    Nós
                  </th>
                  <th scope="col" className={TH}>
                    Começou em
                  </th>
                </tr>
              </thead>
              <tbody>
                {rollouts.data.rollouts.map((rollout) => (
                  <tr key={rollout.id} className="border-t">
                    <th scope="row" className={`${TD} text-left font-medium`}>
                      <Link
                        to={`/versoes/rodadas/${rollout.id}`}
                        className="font-mono text-primary underline-offset-2 hover:underline"
                      >
                        {rollout.release}
                      </Link>
                    </th>
                    <td className={TD}>{ROLLOUT_STATE_LABELS[rollout.state]}</td>
                    <td className={`${TD} tabular-nums`}>
                      {rollout.totals.done} de {rollout.totals.nodes} atualizados
                      {rollout.totals.failed > 0 && `, ${rollout.totals.failed} com falha`}
                    </td>
                    <td className={`${TD} tabular-nums`}>{formatDateTime(rollout.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
