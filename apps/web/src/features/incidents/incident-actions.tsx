import { type Finding, type FindingDetail, MAX_INCIDENT_FINDINGS_PER_REQUEST } from '@verax/shared';
import { X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type FormEvent, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { withChanges } from '@/features/detections/url-state';
import { useRelatedFindings } from '@/features/findings/findings-api';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { errorMessage } from '@/lib/errors';
import { formatRelative, plural } from '@/lib/format';
import {
  useAttachFindings,
  useCreateIncident,
  useIncidentAssignees,
  useOpenIncidents,
} from './incidents-api';
import { incidentTitle } from './narrative';

const NO_ASSIGNEE = '';

/** Abre o incidente no painel da tela Detecções, no lugar do alerta. */
function useOpenIncident() {
  const [, setParams] = useSearchParams();
  return (incidentId: string) =>
    setParams((current) => withChanges(current, { incident: incidentId, finding: null }, { keepPage: true }));
}

/**
 * O diálogo de promover: o alerta, os relacionados pré-selecionados (mesmo usuário, chave, IP ou recurso, a até 60
 * minutos, ainda em validação) e o responsável opcional. O incidente confirmado abre no painel.
 */
export function PromoteDialog({
  finding,
  open,
  onOpenChange,
  onCreated,
}: {
  finding: FindingDetail;
  /** Aberto por quem decide (E-03: "É uma ameaça real"); o diálogo não tem botão próprio. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Depois de criar o incidente (o comentário da decisão vai junto). */
  onCreated?: () => void;
}) {
  const setOpen = onOpenChange;
  const assigneeHint = useId();
  const related = useRelatedFindings(finding.id, open);
  const assignees = useIncidentAssignees(open);
  const create = useCreateIncident();
  const openIncident = useOpenIncident();
  // Os relacionados começam todos marcados; a pessoa desmarca o que não é da mesma ameaça.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [assigneeId, setAssigneeId] = useState(NO_ASSIGNEE);

  const chosen = (related.data ?? []).filter((item) => !unchecked.has(item.id));
  const toggle = (id: string) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const findingIds = [finding.id, ...chosen.map((item) => item.id)].slice(
      0,
      MAX_INCIDENT_FINDINGS_PER_REQUEST,
    );
    create.mutate(
      { findingIds, ...(assigneeId !== NO_ASSIGNEE && { assigneeId }) },
      {
        onSuccess: (incident) => {
          setOpen(false);
          onCreated?.();
          openIncident(incident.id);
        },
      },
    );
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <Dialog.Portal>
        {/* O fundo é uma div comum (a CSP recusa o estilo que o overlay do Radix injeta); ver `Sheet`. */}
        <div aria-hidden className="pointer-events-auto fixed inset-0 z-50 bg-foreground/30" />
        <Dialog.Content
          data-sheet=""
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-surface shadow-lg focus:outline-none"
        >
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
              <div className="min-w-0 space-y-1">
                <Dialog.Title className="text-lg font-semibold">Promover a incidente</Dialog.Title>
                <Dialog.Description className="text-sm text-muted-foreground">
                  Confirma que o alerta é uma ameaça real. O incidente nasce com ele e com os relacionados
                  marcados, e quem recebe os avisos é avisado por e-mail.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon" aria-label="Fechar">
                  <X aria-hidden />
                </Button>
              </Dialog.Close>
            </header>
            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold">Alertas do incidente</legend>
                <ul className="divide-y rounded-md border">
                  <li className="flex items-start gap-2 px-3 py-2 text-sm">
                    <input type="checkbox" checked disabled aria-label={`Este alerta: ${finding.title}`} />
                    <AlertLine finding={finding} note="este alerta" />
                  </li>
                  {(related.data ?? []).map((item) => (
                    <li key={item.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                      <input
                        id={`relacionado-${item.id}`}
                        type="checkbox"
                        checked={!unchecked.has(item.id)}
                        onChange={() => toggle(item.id)}
                      />
                      <label htmlFor={`relacionado-${item.id}`} className="min-w-0 flex-1">
                        <AlertLine finding={item} />
                      </label>
                    </li>
                  ))}
                </ul>
                <p role="status" className="text-xs text-muted-foreground">
                  {related.isPending
                    ? 'Buscando alertas relacionados…'
                    : related.isError
                      ? 'Não foi possível buscar os relacionados. O incidente pode nascer só com este alerta.'
                      : related.data?.length
                        ? `${plural(related.data.length, 'alerta relacionado', 'alertas relacionados')} pelo mesmo usuário, chave, IP ou recurso, a até 60 minutos. Desmarque o que não for da mesma ameaça.`
                        : 'Nenhum outro alerta em validação com o mesmo usuário, chave, IP ou recurso a até 60 minutos.'}
                </p>
              </fieldset>
              <div className="space-y-1">
                <SelectField
                  label="Responsável (opcional)"
                  value={assigneeId}
                  onChange={setAssigneeId}
                  options={[
                    { value: NO_ASSIGNEE, label: 'Ninguém por enquanto' },
                    ...(assignees.data ?? []).map((person) => ({ value: person.id, label: person.name })),
                  ]}
                />
                <p id={assigneeHint} className="text-xs text-muted-foreground">
                  Dá para escolher depois, no detalhe do incidente.
                </p>
              </div>
              {create.error && (
                <p role="alert" className="text-sm text-critical-text">
                  {errorMessage(create.error)}
                </p>
              )}
            </div>
            <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm">
                  Cancelar
                </Button>
              </Dialog.Close>
              <Button type="submit" size="sm" disabled={create.isPending}>
                {create.isPending
                  ? 'Confirmando…'
                  : `Confirmar incidente com ${plural(chosen.length + 1, 'alerta', 'alertas')}`}
              </Button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AlertLine({ finding, note }: { finding: Finding; note?: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-1.5">
        <SeverityBadge severity={finding.severity} />
        <span className="font-medium">{finding.title}</span>
      </span>
      <span className="text-xs text-muted-foreground">
        {[
          note,
          FINDING_SOURCE_LABELS[finding.source],
          finding.actor.user ?? finding.actor.ip,
          formatRelative(finding.occurredAt),
        ]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </span>
  );
}

/** Anexar o alerta a um incidente aberto ou em análise; o incidente abre no painel. */
export function AttachForm({ finding, onCancel }: { finding: FindingDetail; onCancel: () => void }) {
  const incidents = useOpenIncidents(true);
  const attach = useAttachFindings();
  const openIncident = useOpenIncident();
  const [incidentId, setIncidentId] = useState('');
  const options = incidents.data ?? [];
  const chosen = incidentId || options[0]?.id || '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!chosen) return;
    attach.mutate(
      { incidentId: chosen, findingIds: [finding.id] },
      { onSuccess: (incident) => openIncident(incident.id) },
    );
  };

  if (incidents.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Carregando os incidentes em aberto…
      </p>
    );
  }
  if (incidents.isError) {
    return (
      <p role="alert" className="text-sm text-critical-text">
        {errorMessage(incidents.error)}
      </p>
    );
  }
  if (options.length === 0) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Nenhum incidente aberto ou em análise. Promova o alerta para abrir um.
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <SelectField
        label="Incidente"
        value={chosen}
        onChange={setIncidentId}
        options={options.map((incident) => ({
          value: incident.id,
          label: `${incidentTitle(incident)} (nota ${incident.riskScore}, ${plural(incident.findingCount, 'alerta', 'alertas')})`,
        }))}
      />
      {attach.error && (
        <p role="alert" className="text-sm text-critical-text">
          {errorMessage(attach.error)}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={attach.isPending || !chosen}>
          {attach.isPending ? 'Anexando…' : 'Anexar'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
