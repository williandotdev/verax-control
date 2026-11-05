import { useId, useState } from 'react';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { GuardReportView } from '@/features/pricing-tables/guard-report';
import { ApiError, api } from '@/lib/api';
import type { PublishResult } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import type { KindConfig } from './kinds';
import { useInvalidateVersions } from './queries';

/** O `datetime-local` (horário deste navegador) em ISO; vazio é "agora" (a API usa o relógio dela). */
function effectiveFromOf(local: string): string | undefined {
  if (local === '') return undefined;
  const date = new Date(local);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Publicar o rascunho salvo: a confirmação fica aberta na própria página (sem janela modal), com a vigência na tabela
 * de preços. Aprovada, mostra a vigência e o relatório; recusada pela checagem (422), mostra o relatório da recusa;
 * outro conflito (rascunho mudou, vigência inválida, sem modelo de custos), a mensagem da API.
 */
export function PublishPanel({
  config,
  version,
  blockedReason,
  canPublish,
  onPublished,
}: {
  config: KindConfig;
  version: string;
  /** Por que não dá para publicar agora (ex.: alterações não salvas). */
  blockedReason?: string;
  /** Falso depois que a versão deixou de ser rascunho: o painel fica só com o resultado. */
  canPublish: boolean;
  /** Avisa a página antes de recarregar a versão (ela mantém o painel aberto para o resultado continuar). */
  onPublished: () => void;
}) {
  const ids = useId();
  const invalidate = useInvalidateVersions();
  const [open, setOpen] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PublishResult | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  async function publish(): Promise<void> {
    // A publicação leva o rascunho salvo, não o que está na tela: com alteração não salva (editada ou importada depois
    // de abrir a confirmação), ela publicaria outro conteúdo, e a releitura descartaria as alterações.
    if (blockedReason !== undefined || busy) return;
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const published = await api.publish(
        config.kind,
        version,
        config.scheduledPublish ? effectiveFromOf(effectiveFrom) : undefined,
      );
      setResult(published);
      setOpen(false);
      onPublished();
      await invalidate();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const refusal = error instanceof ApiError && error.report !== undefined ? error.report : undefined;
  return (
    <section aria-labelledby={`${ids}-titulo`} className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id={`${ids}-titulo`} className="text-base font-semibold">
        Publicar
      </h2>
      {canPublish && <p className="text-sm text-muted-foreground">{config.publishNote}</p>}
      {canPublish && blockedReason !== undefined && <p className="text-sm font-medium">{blockedReason}</p>}
      {canPublish && !open && (
        <Button onClick={() => setOpen(true)} disabled={blockedReason !== undefined}>
          Publicar…
        </Button>
      )}
      {canPublish && open && (
        <div className="space-y-3 rounded-lg border p-3">
          {config.scheduledPublish && (
            <div className="flex max-w-sm flex-col gap-1">
              <label htmlFor={`${ids}-vigencia`} className="text-sm font-medium">
                Vigente a partir de
              </label>
              <input
                id={`${ids}-vigencia`}
                type="datetime-local"
                className="h-9 rounded-md border border-border-strong bg-surface-raised px-3 text-sm"
                value={effectiveFrom}
                onChange={(event) => setEffectiveFrom(event.target.value)}
                aria-describedby={`${ids}-vigencia-dica`}
              />
              <p id={`${ids}-vigencia-dica`} className="text-xs text-muted-foreground">
                No horário deste navegador. Vazio: agora. Não pode ser no passado nem antes da última
                publicada.
              </p>
            </div>
          )}
          <p className="text-sm">
            Publicar <span className="font-mono">{version}</span>? Publicada, a versão não muda mais: um
            ajuste vira outro rascunho.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void publish()} disabled={busy || blockedReason !== undefined}>
              {busy ? 'Publicando…' : 'Confirmar a publicação'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {result !== undefined && (
        <div role="status" className="space-y-3">
          <p className="font-medium">
            Publicada: {result.version}, vigente a partir de {formatDateTime(result.effectiveFrom)}.
          </p>
          {result.report !== null && !config.scheduledPublish && !result.report.ok && (
            <p className="text-sm">
              Com este modelo, a tabela de preços vigente não passa na checagem: o alerta de margem
              (pricing_margin_alert) foi para o log. Ajuste a tabela num rascunho novo.
            </p>
          )}
          {result.report !== null && (
            <GuardReportView
              report={result.report}
              title={
                config.scheduledPublish
                  ? 'Checagem da publicação'
                  : 'A tabela de preços vigente conferida com este modelo'
              }
            />
          )}
        </div>
      )}
      {refusal !== undefined && (
        <GuardReportView
          report={refusal}
          title="Publicação recusada pela checagem"
          costModelVersion={error instanceof ApiError ? error.costModelVersion : undefined}
        />
      )}
      {error !== undefined && refusal === undefined && <ErrorState error={error} />}
    </section>
  );
}
