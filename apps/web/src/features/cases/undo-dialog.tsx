import {
  type Author,
  TRIAGE_REASON_MAX,
  type TriageOperationDetail,
  type TriageOperationView,
} from '@verax/shared';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { formatCount } from '@/lib/format';
import { bulkProblem, cleanReason } from './bulk';
import { alertCount } from './labels';
import { Modal } from './modal';
import { OperationOutcome } from './operation-outcome';
import { operationTitle } from './operation-text';
import { useRequestId, useUndoAllOf, useUndoTriage } from './triage-api';

function ReasonField({
  id,
  value,
  required,
  onChange,
}: {
  id: string;
  value: string;
  required: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-sm font-medium">
        Motivo {required ? '(obrigatório)' : '(opcional)'}
      </label>
      <Textarea
        id={id}
        value={value}
        required={required}
        maxLength={TRIAGE_REASON_MAX}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-muted-foreground">Fica na auditoria e no histórico.</p>
    </div>
  );
}

const CANCEL = 'max-md:h-11';

/** Desfazer uma operação: diz o que volta e o que não volta, e depois acompanha. */
export function UndoDialog({
  operation,
  onClose,
}: {
  operation: Pick<TriageOperationView, 'id' | 'action' | 'status' | 'changed'>;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [accepted, setAccepted] = useState<TriageOperationDetail | null>(null);
  const requestIdOf = useRequestId();
  const undo = useUndoTriage();
  const incident = operation.action === 'promote' || operation.action === 'attach';

  const submit = () => {
    const text = cleanReason(reason);
    const body = { operationId: operation.id, ...(text !== '' && { reason: text }) };
    undo.mutate({ ...body, requestId: requestIdOf(body) }, { onSuccess: setAccepted });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Desfazer: ${operationTitle(operation)}`}
      description={
        accepted === null
          ? `${alertCount(operation.changed)} ${operation.changed === 1 ? 'foi mudado' : 'foram mudados'} por esta operação.`
          : 'O pedido foi aceito e fica na auditoria.'
      }
      footer={
        accepted === null ? (
          <>
            <Button variant="ghost" size="sm" className={CANCEL} onClick={onClose}>
              Manter como está
            </Button>
            <Button size="sm" className={CANCEL} disabled={undo.isPending} onClick={submit}>
              {undo.isPending ? 'Enviando…' : 'Desfazer'}
            </Button>
          </>
        ) : (
          <Button size="sm" className={CANCEL} onClick={onClose}>
            Fechar
          </Button>
        )
      }
    >
      {accepted !== null ? (
        <OperationOutcome operation={accepted} onUndo={onClose} onFollowLink={onClose} />
      ) : (
        <>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>
              Cada alerta volta ao que era antes desta operação, menos os que alguém mudou depois: esses ficam
              como estão.
            </li>
            {operation.action === 'promote' && (
              <>
                <li>O alerta que abriu o incidente continua nele, e o incidente é encerrado.</li>
                <li>O aviso por e-mail do incidente já saiu, e não volta.</li>
              </>
            )}
            {operation.action === 'attach' && (
              <li>Os alertas saem do incidente e voltam a esperar validação.</li>
            )}
            <li>Desfazer não se desfaz: para refazer, peça a operação de novo.</li>
          </ul>
          {incident && (
            <p className="text-xs text-muted-foreground">
              Um incidente resolvido não muda de alertas: reabra-o antes.
            </p>
          )}
          <ReasonField id={`${id}-motivo`} value={reason} required={false} onChange={setReason} />
          {undo.error && (
            <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 p-3 text-sm">
              {undoMessage(undo.error)}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/** A recusa de um desfazer: as do motor já vêm em português da API; o resto, como no pedido. */
function undoMessage(error: unknown): string {
  return bulkProblem(error).message;
}

/** Desfaz tudo o que uma pessoa fez em massa: só de quem administra, com o nome digitado e o motivo. */
export function UndoAllDialog({ author, onClose }: { author: Author; onClose: () => void }) {
  const id = useId();
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [accepted, setAccepted] = useState<TriageOperationDetail | null>(null);
  const requestIdOf = useRequestId();
  const undoAll = useUndoAllOf();
  const ready = typed.trim() === author.name && cleanReason(reason) !== '' && !undoAll.isPending;

  const submit = () => {
    if (!ready) return;
    const body = { userId: author.id, reason: cleanReason(reason) };
    undoAll.mutate({ ...body, requestId: requestIdOf(body) }, { onSuccess: setAccepted });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Desfazer tudo de ${author.name}`}
      description={
        accepted === null
          ? 'Para quando a conta de alguém foi usada por outra pessoa, ou tratou o que não devia.'
          : 'O pedido foi aceito e fica na auditoria.'
      }
      footer={
        accepted === null ? (
          <>
            <Button variant="ghost" size="sm" className={CANCEL} onClick={onClose}>
              Manter como está
            </Button>
            <Button variant="danger" size="sm" className={CANCEL} disabled={!ready} onClick={submit}>
              {undoAll.isPending ? 'Enviando…' : 'Desfazer tudo'}
            </Button>
          </>
        ) : (
          <Button size="sm" className={CANCEL} onClick={onClose}>
            Fechar
          </Button>
        )
      }
    >
      {accepted !== null ? (
        <OperationOutcome operation={accepted} onUndo={onClose} onFollowLink={onClose} />
      ) : (
        <>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>As operações dessa pessoa na fila ou em andamento são canceladas.</li>
            <li>
              As que terminaram há até 24 horas são desfeitas, da mais recente para a mais antiga (até{' '}
              {formatCount(100)} de uma vez).
            </li>
            <li>O que outra pessoa mudou depois fica como está.</li>
          </ul>
          <ReasonField id={`${id}-motivo`} value={reason} required onChange={setReason} />
          <div className="space-y-1">
            <label htmlFor={`${id}-nome`} className="text-sm font-medium wrap-anywhere">
              Digite {author.name} para confirmar
            </label>
            <Input
              id={`${id}-nome`}
              autoComplete="off"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {undoAll.error && (
            <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 p-3 text-sm">
              {undoAllMessage(undoAll.error)}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

function undoAllMessage(error: unknown): string {
  const problem = bulkProblem(error);
  return problem.kind === 'empty' || problem.kind === 'only_critical'
    ? 'Esta pessoa não tem operação que ainda possa ser desfeita.'
    : problem.message;
}
