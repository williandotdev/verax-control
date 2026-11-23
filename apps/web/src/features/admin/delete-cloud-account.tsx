import { type CloudAccount, type CloudProvider, DELETE_CONFIRMATION_MISMATCH_CODE } from '@verax/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { useDeleteCloudAccount } from '@/features/admin/admin-api';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

/** Como o ID da conta se chama em cada provedor. */
const ID_LABELS: Readonly<Record<CloudProvider, string>> = {
  aws: 'o ID da conta',
  gcp: 'o ID do projeto',
  cloudflare: 'o ID da conta',
};

/** A recusa da exclusão, com o que fazer. */
function deleteErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === DELETE_CONFIRMATION_MISMATCH_CODE) {
      return 'O ID digitado não é o desta conta: nada foi excluído. Confira e digite de novo.';
    }
    if (error.status === 404)
      return 'Esta conta não existe mais (talvez já tenha sido excluída). Atualize a lista.';
    if (error.status === 403) return 'Sem permissão para excluir contas: peça a um administrador do cliente.';
  }
  return errorMessage(error);
}

/**
 * "Excluir conta", na zona de perigo do detalhe da conta, à parte do "Desativar monitoramento": o cadastro sai do painel
 * e o mesmo ID pode ser cadastrado de novo (por exemplo, para refazer a conexão da AWS pelo "Conectar com AWS"). A
 * confirmação fica no próprio painel, sem outra janela por cima dele (como a remoção do token e a confirmação pelo
 * subdomínio no console): ela diz o que sai e o que fica, e o botão só libera com o ID da conta digitado, que a API
 * confere de novo. Vale também para a conta que a Verax cadastrou (a Verax é avisada pela sincronização do nó).
 */
export function DeleteCloudAccount({
  account,
  onDeleted,
}: {
  account: CloudAccount;
  /** Excluída: quem abriu o detalhe fecha o painel e avisa. */
  onDeleted: (account: CloudAccount) => void;
}) {
  const ids = useId();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const field = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const remove = useDeleteCloudAccount(account.id, () => onDeleted(account));
  const matches = typed === account.accountId;
  const managed = account.managedBy === 'verax';
  const idLabel = ID_LABELS[account.provider];

  // Aberta a confirmação, o foco vai para o campo do ID.
  useEffect(() => {
    if (confirming) field.current?.querySelector('input')?.focus();
  }, [confirming]);

  const cancel = () => {
    setConfirming(false);
    setTyped('');
    remove.reset();
    // O botão volta a existir no próximo quadro: o foco volta para ele.
    requestAnimationFrame(() => opener.current?.focus());
  };

  return (
    <section aria-labelledby={`${ids}-titulo`} className="space-y-3 rounded-md border border-critical/40 p-3">
      <h3 id={`${ids}-titulo`} className="text-sm font-semibold">
        Excluir conta
      </h3>
      <p className="text-sm text-muted-foreground">
        Diferente de desativar: o cadastro sai do painel e {idLabel} fica livre para ser cadastrado de novo.
      </p>
      {!confirming ? (
        <Button ref={opener} type="button" variant="secondary" onClick={() => setConfirming(true)}>
          Excluir conta…
        </Button>
      ) : (
        <div
          role="group"
          aria-labelledby={`${ids}-confirmacao`}
          aria-describedby={`${ids}-efeitos`}
          className="space-y-3 rounded-md border border-critical/40 bg-critical/5 p-3 text-sm"
        >
          <p id={`${ids}-confirmacao`} className="font-semibold">
            Confirmar a exclusão de {account.accountId}
          </p>
          <div id={`${ids}-efeitos`} className="space-y-2">
            <ul className="list-disc space-y-1 pl-5">
              <li>O cadastro some do painel e a coleta desta conta para.</li>
              <li>Os achados, os incidentes e o histórico já registrados ficam.</li>
              <li>Nada é apagado na nuvem do cliente.</li>
              {account.provider === 'aws' && (
                <li>
                  Na AWS, a pilha <code className="font-mono">verax-control-reader</code> continua na conta:
                  apague-a no CloudFormation se não for conectar de novo, ou deixe-a para reconectar (a mesma
                  pilha serve quando a conta for cadastrada outra vez).
                </li>
              )}
            </ul>
            {managed && (
              <p className="font-medium">Esta conta foi cadastrada pela Verax; a Verax será avisada.</p>
            )}
          </div>
          <div ref={field}>
            <Field
              label={`Digite ${idLabel} (${account.accountId}) para confirmar`}
              hint={matches ? 'Confere.' : 'O botão libera quando o texto for igual ao ID.'}
              className="max-w-sm"
              inputMode={account.provider === 'aws' ? 'numeric' : undefined}
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value.trim())}
            />
          </div>
          {remove.error !== null && (
            <p role="alert" className="text-critical-text">
              {deleteErrorText(remove.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="danger"
              disabled={!matches || remove.isPending}
              onClick={() => remove.mutate({ confirmAccountId: typed })}
            >
              {remove.isPending ? 'Excluindo…' : 'Excluir definitivamente'}
            </Button>
            <Button type="button" variant="ghost" disabled={remove.isPending} onClick={cancel}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
