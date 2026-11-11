import { useId, useState } from 'react';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useVersions } from '@/features/versions/queries';
import { api } from '@/lib/api';
import type { CheckResult } from '@/lib/api-types';
import { STATUS_LABELS } from '@/lib/format';
import { GuardReportView } from './guard-report';

const CURRENT = '';

/**
 * "Conferir": a checagem de publicação sem publicar (`POST .../check`), com o modelo de custos vigente ou outro (um
 * rascunho de custos, para ver o efeito antes de publicá-lo). Roda sobre a versão salva da tabela.
 */
export function CheckPanel({ version, blockedReason }: { version: string; blockedReason?: string }) {
  const ids = useId();
  const models = useVersions('cost-models');
  const [model, setModel] = useState(CURRENT);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckResult | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  async function check(): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api.check(version, model === CURRENT ? undefined : model));
    } catch (caught) {
      setResult(undefined);
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${ids}-titulo`} className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id={`${ids}-titulo`} className="text-base font-semibold">
        Conferir (checagem sem publicar)
      </h2>
      <p className="text-sm text-muted-foreground">
        Percorre todas as configurações que a tabela vende, no cartão e na alíquota padrão do modelo de
        custos, e mostra as piores, as abaixo da margem mínima e do alerta, por plano e por lugar.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-modelo`} className="text-sm font-medium">
            Modelo de custos
          </label>
          <select
            id={`${ids}-modelo`}
            className="h-9 min-w-56 rounded-md border border-border-strong bg-surface-raised px-2 text-sm"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          >
            <option value={CURRENT}>O vigente</option>
            {(models.data ?? [])
              .filter((entry) => entry.legacy !== true)
              .map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {entry.version} ({STATUS_LABELS[entry.status].toLowerCase()}
                  {entry.current ? ', vigente' : ''})
                </option>
              ))}
          </select>
        </div>
        <Button
          variant="secondary"
          onClick={() => void check()}
          disabled={busy || blockedReason !== undefined}
        >
          {busy ? 'Conferindo…' : 'Conferir'}
        </Button>
      </div>
      {blockedReason !== undefined && <p className="text-sm font-medium">{blockedReason}</p>}
      {error !== undefined && <ErrorState error={error} />}
      {result !== undefined && (
        <GuardReportView
          report={result.report}
          costModelVersion={result.costModelVersion}
          title={`Checagem de ${version}`}
        />
      )}
    </section>
  );
}
