import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { fleetApi } from './api';
import { EXCLUSION_LABELS, WAVE_LABELS } from './labels';
import { useInvalidateFleet, usePlan } from './queries';

const WINDOW_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/;
const INPUT = 'h-9 rounded-md border border-border-strong bg-surface-raised px-3 text-sm';

/**
 * A revisão de "Promover para a frota": a versão conferida, as ondas e os nós de cada uma, os sites do painel que andam
 * com cada nó, quem fica fora, quantos dedicados ao mesmo tempo e a janela de manutenção. A rodada só começa com a
 * versão digitada de novo; o cp-worker confere tudo outra vez.
 */
export function PromotePage() {
  const { release = '' } = useParams();
  const ids = useId();
  const navigate = useNavigate();
  const invalidate = useInvalidateFleet();
  const plan = usePlan(release);
  const [concurrency, setConcurrency] = useState(1);
  const [updateWindow, setUpdateWindow] = useState('');
  const [typed, setTyped] = useState('');
  const windowInvalid = updateWindow !== '' && !WINDOW_PATTERN.test(updateWindow);
  const create = useMutation({
    mutationFn: () =>
      fleetApi.create({
        release,
        confirmRelease: typed,
        concurrency,
        ...(updateWindow === '' ? {} : { window: updateWindow }),
      }),
    onSuccess: async ({ rollout }) => {
      await invalidate();
      await navigate(`/versoes/rodadas/${rollout.id}`);
    },
  });

  const waves = [0, 1, 2]
    .map((wave) => ({ wave, nodes: plan.data?.nodes.filter((node) => node.wave === wave) ?? [] }))
    .filter((entry) => entry.nodes.length > 0);

  return (
    <div className="space-y-4">
      <header className="max-w-3xl space-y-1">
        <p className="text-sm">
          <Link to="/versoes" className="text-primary underline underline-offset-2">
            Versões
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">
          Promover <span className="font-mono">{release}</span> para a frota
        </h1>
        <p className="text-sm text-muted-foreground">
          Uma onda por vez. A primeira falha para a rodada, e o resto fica como está até você decidir.
        </p>
      </header>

      {plan.isPending && <LoadingState label="Montando a revisão" />}
      {plan.isError && <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />}
      {plan.data !== undefined && (
        <>
          {plan.data.activeRolloutId !== undefined && (
            <p role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
              Já existe uma rodada em andamento.{' '}
              <Link
                to={`/versoes/rodadas/${plan.data.activeRolloutId}`}
                className="text-primary underline underline-offset-2"
              >
                Acompanhar a rodada
              </Link>
            </p>
          )}
          <Card aria-labelledby={`${ids}-ondas`}>
            <CardHeader>
              <div>
                <CardTitle id={`${ids}-ondas`}>As ondas</CardTitle>
                <CardDescription>
                  Commit <span className="font-mono">{plan.data.release.commit.slice(0, 12)}</span>. Cada nó:
                  o pedido ao host, o host pronto, a API pública e só então o painel dos sites dele.
                </CardDescription>
              </div>
            </CardHeader>
            {waves.length === 0 && <p className="text-sm">Nenhum nó pode receber a versão agora.</p>}
            {waves.map(({ wave, nodes }) => (
              <section key={wave} aria-labelledby={`${ids}-onda-${wave}`} className="mt-3 space-y-1">
                <h3 id={`${ids}-onda-${wave}`} className="text-sm font-medium">
                  {WAVE_LABELS[wave]}
                </h3>
                <ul className="space-y-1 text-sm">
                  {nodes.map((node) => (
                    <li key={node.key}>
                      <span className="font-medium">{node.label}</span>{' '}
                      <span className="font-mono text-xs text-muted-foreground">({node.instance})</span>
                      {node.panels.length > 0 && (
                        <span className="text-muted-foreground"> · painel: {node.panels.join(', ')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {plan.data.excluded.length > 0 && (
              <section aria-labelledby={`${ids}-fora`} className="mt-3 space-y-1">
                <h3 id={`${ids}-fora`} className="text-sm font-medium">
                  Ficam fora desta rodada
                </h3>
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {plan.data.excluded.map((entry) => (
                    <li key={entry.key}>
                      <span className="font-mono">{entry.label}</span>: {EXCLUSION_LABELS[entry.reason]}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </Card>

          <Card aria-labelledby={`${ids}-confirmar-titulo`}>
            <CardHeader>
              <CardTitle id={`${ids}-confirmar-titulo`}>Confirmar</CardTitle>
            </CardHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-lote`} className="text-sm font-medium">
                  Nós dedicados ao mesmo tempo
                </label>
                <select
                  id={`${ids}-lote`}
                  className={INPUT}
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label htmlFor={`${ids}-janela`} className="text-sm font-medium">
                  Janela de manutenção (opcional, horário de Brasília)
                </label>
                <input
                  id={`${ids}-janela`}
                  className={`${INPUT} font-mono`}
                  placeholder="02:00-05:00"
                  value={updateWindow}
                  onChange={(event) => setUpdateWindow(event.target.value.trim())}
                  aria-invalid={windowInvalid}
                  aria-describedby={`${ids}-janela-dica`}
                />
                <p id={`${ids}-janela-dica`} className="text-xs text-muted-foreground">
                  {windowInvalid
                    ? 'Use HH:MM-HH:MM (pode passar da meia-noite).'
                    : 'Fora da janela, o host espera; vazia, atualiza assim que recebe o pedido.'}
                </p>
              </div>
              <div className="flex flex-col gap-1 sm:col-span-2 sm:max-w-sm">
                <label htmlFor={`${ids}-versao`} className="text-sm font-medium">
                  Digite a versão <span className="font-mono">{release}</span> para confirmar
                </label>
                <input
                  id={`${ids}-versao`}
                  className={`${INPUT} font-mono`}
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(event) => setTyped(event.target.value.trim())}
                />
              </div>
            </div>
            {create.isError && <ErrorState error={create.error} className="mt-3" />}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                onClick={() => create.mutate()}
                disabled={
                  typed !== release ||
                  windowInvalid ||
                  create.isPending ||
                  waves.length === 0 ||
                  plan.data.activeRolloutId !== undefined
                }
              >
                {create.isPending ? 'Começando a rodada…' : 'Promover para a frota'}
              </Button>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
