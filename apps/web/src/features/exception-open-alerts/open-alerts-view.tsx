import type { ExceptionOpenPreview, ExceptionOpenResolution } from '@verax/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/features/admin/admin-ui';
import { type ExceptionKind, useResolveMoreOpen } from './open-alerts-api';
import { openPreviewText, openResolutionText } from './open-alerts-text';

/** A linha da prévia: o que a exceção resolve agora, antes de salvar. Sem prévia (nó de antes), nada. */
export function OpenAlertsPreview({ preview }: { preview: ExceptionOpenPreview | undefined }) {
  if (preview === undefined) return null;
  return <p className="rounded-md border p-2 text-sm font-medium">{openPreviewText(preview)}</p>;
}

/**
 * O que a criação fez com os alertas em aberto e, se parou no teto, "Resolver os próximos" (com o id da exceção). Sem a
 * contagem (nó de antes), nada.
 */
export function OpenAlertsResult({
  resolution,
  kind,
  exceptionId,
}: {
  resolution: ExceptionOpenResolution | undefined;
  kind: ExceptionKind;
  exceptionId?: string;
}) {
  const [total, setTotal] = useState(resolution);
  const more = useResolveMoreOpen(kind, exceptionId ?? '');
  if (total === undefined) return null;
  const next = () =>
    more.mutate(undefined, {
      onSuccess: (step) =>
        setTotal((current) =>
          current === undefined
            ? step
            : {
                resolved: current.resolved + step.resolved,
                keptInIncident: Math.max(current.keptInIncident, step.keptInIncident),
                more: step.more,
              },
        ),
    });
  return (
    <div className="space-y-2">
      <p role="status" className="text-sm">
        {openResolutionText(total)}
      </p>
      <FormError error={more.error} />
      {total.more && exceptionId !== undefined && (
        <Button
          size="sm"
          variant="secondary"
          className="max-md:h-11"
          disabled={more.isPending}
          onClick={next}
        >
          {more.isPending ? 'Resolvendo…' : 'Resolver os próximos'}
        </Button>
      )}
    </div>
  );
}
