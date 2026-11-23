import { type CloudAccount, type CloudCredentialStatus, daysUntilExpiry } from '@verax/shared';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SEVERITY_STYLES } from '@/design/severity';
import { useCloudCredential } from '@/features/admin/admin-api';
import { ConfirmButton } from '@/features/admin/admin-ui';
import {
  type CredentialFormProps,
  type CredentialTexts,
  credentialErrorText,
} from '@/features/admin/credential-texts';
import { CREDENTIAL_STATUS_LABELS } from '@/features/admin/labels';
import { cn } from '@/lib/cn';
import { formatDate, formatRelative, plural } from '@/lib/format';

/**
 * O passo de colar a credencial (o token do Cloudflare ou a chave de leitura da VM própria): o cartão com os metadados
 * da guardada ou o formulário. A última escrita feita aqui vale só até chegar um estado mais novo da conta: no detalhe,
 * a lista relida depois dela ou depois de outra escrita (desativar o monitoramento apaga a credencial); no cadastro, a
 * conta da resposta não é relida, e a escrita daqui continua valendo. Só os metadados; o segredo nunca fica guardado.
 */
export function CredentialStep({
  account,
  canWrite,
  texts,
  renderForm,
}: {
  account: CloudAccount;
  canWrite: boolean;
  texts: CredentialTexts;
  renderForm: (props: CredentialFormProps) => ReactNode;
}) {
  const [local, setLocal] = useState<LocalCredential | null>(null);
  const current = local !== null && local.accountUpdatedAt === account.updatedAt ? local : null;
  const keyStatus = current ? current.keyStatus : account.keyStatus;
  // Os avisos seguem o que está na tela: "guardado" só com a mesma credencial, "removido" só sem credencial.
  const justSaved = local?.event === 'saved' && keyStatus?.keyIdSuffix === local.keyStatus?.keyIdSuffix;
  const justRemoved = local?.event === 'removed' && keyStatus === null;
  const remember = (next: Omit<LocalCredential, 'accountUpdatedAt'>) =>
    setLocal({ ...next, accountUpdatedAt: account.updatedAt });
  if (keyStatus) {
    return (
      <CredentialCard
        account={account}
        status={keyStatus}
        canWrite={canWrite}
        justSaved={justSaved}
        onChange={remember}
        texts={texts}
        renderForm={renderForm}
      />
    );
  }
  if (canWrite && account.status !== 'active') return <p>{texts.inactive}</p>;
  if (!canWrite) return <p>{texts.readOnly}</p>;
  return (
    <>
      {justRemoved && (
        <p role="status" className="text-muted-foreground">
          {texts.removed}
        </p>
      )}
      <p>{texts.pastePrompt}</p>
      {renderForm({
        focusOnMount: justRemoved,
        onSaved: (saved) => remember({ keyStatus: saved, event: 'saved' }),
      })}
    </>
  );
}

/**
 * O que esta tela acabou de fazer com a credencial: guardou (com os metadados da resposta) ou removeu, e sobre qual
 * versão da conta (`updatedAt`). Chegando outra versão, vale a da conta.
 */
interface LocalCredential {
  keyStatus: CloudCredentialStatus | null;
  event: 'saved' | 'removed' | 'idle';
  accountUpdatedAt: string;
}

const CREDENTIAL_SEVERITY = {
  active: 'ok',
  expiring: 'medium',
  expired: 'critical',
} as const satisfies Record<CloudCredentialStatus['status'], keyof typeof SEVERITY_STYLES>;

/**
 * O token guardado: só os metadados. Vencendo em até 14 dias, o aviso pede a troca; vencido, a coleta parou. Quem
 * administra troca (cola outro) ou remove.
 */
function CredentialCard({
  account,
  status,
  canWrite,
  justSaved,
  onChange,
  texts,
  renderForm,
}: {
  account: CloudAccount;
  status: CloudCredentialStatus;
  canWrite: boolean;
  justSaved: boolean;
  onChange: (local: Omit<LocalCredential, 'accountUpdatedAt'>) => void;
  texts: CredentialTexts;
  renderForm: (props: CredentialFormProps) => ReactNode;
}) {
  const titleId = useId();
  const title = useRef<HTMLParagraphElement>(null);
  const [replacing, setReplacing] = useState(false);
  const credential = useCloudCredential(account.id);
  const { icon: Icon, tone } = SEVERITY_STYLES[CREDENTIAL_SEVERITY[status.status]];
  const days = daysUntilExpiry(status.expiresAt);
  // Guardado o token, o formulário sai da tela: o foco vai para o título do cartão, ao lado da confirmação.
  useEffect(() => {
    if (justSaved) title.current?.focus();
  }, [justSaved, status.keyIdSuffix]);

  const remove = async () => {
    if (await credential.remove()) onChange({ keyStatus: null, event: 'removed' });
  };

  return (
    <div role="group" aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
      <p id={titleId} ref={title} tabIndex={-1} className="font-semibold">
        {texts.title}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">{texts.idLabel}</dt>
        <dd>
          <code className="font-mono">…{status.keyIdSuffix}</code>
        </dd>
        <dt className="text-muted-foreground">Situação</dt>
        <dd className="inline-flex items-center gap-1">
          <Icon aria-hidden className={cn('size-4', tone)} />
          {CREDENTIAL_STATUS_LABELS[status.status]}
        </dd>
        <dt className="text-muted-foreground">Validade</dt>
        <dd>{status.expiresAt ? `vence em ${formatDate(status.expiresAt)}` : 'sem data de vencimento'}</dd>
        <dt className="text-muted-foreground">Conferido</dt>
        <dd>{formatRelative(status.verifiedAt)}</dd>
      </dl>
      {status.status === 'expiring' && days !== null && (
        <p className="rounded-md border border-medium/70 bg-medium/15 p-2">
          O token vence em {plural(days, 'dia', 'dias')}. Crie outro no Cloudflare e cole aqui antes disso, ou
          a coleta para.
        </p>
      )}
      {status.status === 'expired' && (
        <p className="rounded-md border border-critical/50 bg-critical/10 p-2">
          O token venceu e a coleta parou. Crie outro no Cloudflare e cole aqui.
        </p>
      )}
      {justSaved && (
        <p role="status" className="text-muted-foreground">
          {texts.saved(status.keyIdSuffix)}
        </p>
      )}
      {canWrite && !replacing && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              credential.reset();
              onChange({ keyStatus: status, event: 'idle' });
              setReplacing(true);
            }}
          >
            {texts.replace}
          </Button>
          <ConfirmButton
            label={texts.remove}
            confirmLabel="Confirmar remoção"
            busy={credential.pending}
            warning={texts.removeWarning}
            onConfirm={() => void remove()}
          />
        </div>
      )}
      {!replacing && credential.error ? (
        <p role="alert" className="text-critical-text">
          {credentialErrorText(credential.error, texts)}
        </p>
      ) : null}
      {replacing &&
        renderForm({
          replacing: true,
          focusOnMount: true,
          onCancel: () => setReplacing(false),
          onSaved: (saved) => {
            setReplacing(false);
            onChange({ keyStatus: saved, event: 'saved' });
          },
        })}
    </div>
  );
}
