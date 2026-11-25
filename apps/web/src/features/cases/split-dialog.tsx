import {
  CASE_SPLIT_TOO_LARGE_CODE,
  CASE_SPLIT_WHOLE_CODE,
  type CaseDetail,
  type CaseSplitResult,
  MAX_SPLIT_ALERTS,
  TRIAGE_REASON_MAX,
} from '@verax/shared';
import { useId, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { selectionSearch } from '@/features/detections/url-state';
import { ApiRequestError } from '@/lib/api-client';
import { formatCount } from '@/lib/format';
import { bulkProblem, cleanReason } from './bulk';
import { alertCount } from './labels';
import { Modal } from './modal';
import { useSplitCase } from './triage-api';

export type SplitTarget =
  | { kind: 'group'; group: string; count: number }
  | { kind: 'findings'; findingIds: string[]; count: number; onDone: () => void };

/** Dividir um caso: tira dele o que não é da mesma história. */
export function SplitDialog({
  detail,
  target,
  onClose,
}: {
  detail: CaseDetail;
  target: SplitTarget;
  onClose: () => void;
}) {
  const id = useId();
  const [params] = useSearchParams();
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<CaseSplitResult | null>(null);
  const split = useSplitCase(detail.id);
  const whole = target.count >= detail.counts.total;

  const submit = () => {
    if (whole || split.isPending) return;
    const text = cleanReason(reason);
    split.mutate(
      {
        ...(target.kind === 'group' ? { group: target.group } : { findingIds: target.findingIds }),
        ...(text !== '' && { reason: text }),
      },
      {
        onSuccess: (done) => {
          setResult(done);
          if (target.kind === 'findings') target.onDone();
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Separar em outro caso"
      description={
        result === null
          ? `${alertCount(target.count)} ${target.count === 1 ? 'sai' : 'saem'} deste caso para um caso novo.`
          : 'O caso foi dividido, e o registro fica na auditoria.'
      }
      footer={
        result === null ? (
          <>
            <Button variant="ghost" size="sm" className="max-md:h-11" onClick={onClose}>
              Cancelar
            </Button>
            <Button size="sm" className="max-md:h-11" disabled={whole || split.isPending} onClick={submit}>
              {split.isPending ? 'Separando…' : `Separar ${alertCount(target.count)}`}
            </Button>
          </>
        ) : (
          <Button size="sm" className="max-md:h-11" onClick={onClose}>
            Fechar
          </Button>
        )
      }
    >
      {result === null ? (
        <>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>Nenhum alerta muda de status: só o agrupamento muda.</li>
            <li>O caso novo nasce fechado para alertas novos; os seguintes continuam entrando neste.</li>
            <li>Juntar de volta não dá: se for o caso, trate os dois.</li>
          </ul>
          {target.kind === 'group' && (
            <p className="rounded-md border bg-foreground/[0.03] p-2 font-mono text-xs wrap-anywhere">
              {target.group}
            </p>
          )}
          <div className="space-y-1">
            <label htmlFor={`${id}-motivo`} className="text-sm font-medium">
              Motivo (opcional)
            </label>
            <Textarea
              id={`${id}-motivo`}
              value={reason}
              maxLength={TRIAGE_REASON_MAX}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {whole && (
            <p role="alert" className="text-sm text-critical-text">
              O caso precisa ficar com pelo menos um alerta.
            </p>
          )}
          {split.error && (
            <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 p-3 text-sm">
              {splitMessage(split.error)}
            </p>
          )}
        </>
      ) : (
        <div role="status" className="space-y-2 text-sm">
          <p className="font-medium">
            {alertCount(result.moved)} {result.moved === 1 ? 'separado' : 'separados'};{' '}
            {alertCount(result.remaining)} {result.remaining === 1 ? 'ficou' : 'ficaram'} neste caso.
          </p>
          <Link
            className="font-medium underline"
            to={{ search: selectionSearch(params, { kind: 'case', id: result.caseId }) }}
            onClick={onClose}
          >
            Abrir o caso novo
          </Link>
        </div>
      )}
    </Modal>
  );
}

function splitMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === CASE_SPLIT_WHOLE_CODE) return 'O caso precisa ficar com pelo menos um alerta.';
    if (error.code === CASE_SPLIT_TOO_LARGE_CODE) {
      return `São alertas demais para dividir de uma vez (o máximo é ${formatCount(error.details?.['max'] ?? MAX_SPLIT_ALERTS)}).`;
    }
    if (error.status === 404)
      return 'Um dos alertas não está mais neste caso. Feche, confira e tente de novo.';
  }
  return bulkProblem(error).message;
}
