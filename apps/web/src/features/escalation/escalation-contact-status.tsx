import {
  ESCALATION_CONFIRMATION_TTL_HOURS,
  ESCALATION_CONTACT_STATUS_LABELS,
  type EscalationContact,
  type EscalationContactStatus,
} from '@verax/shared';
import { Button } from '@/components/ui/button';
import { FormError } from '@/features/admin/admin-ui';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';

const STATUS_STYLE: Readonly<Record<EscalationContactStatus, string>> = {
  pending: 'border-medium/60 bg-medium/10',
  confirmed: 'border-ok/60 bg-ok/10',
  unsubscribed: 'border-border-strong bg-surface-raised',
};

/** O que o estado quer dizer, com a data e o último e-mail de confirmação. */
function statusDetail(contact: EscalationContact): string {
  switch (contact.status) {
    case 'confirmed':
      return `Confirmado em ${formatTimestamp(contact.confirmedAt ?? '')}. Recebe por e-mail só os avisos críticos (incidente crítico e achado crítico), sem detalhes.`;
    case 'unsubscribed':
      return `Saiu pelo link de um e-mail em ${formatTimestamp(contact.unsubscribedAt ?? '')} e não recebe mais avisos. Peça a confirmação de novo só se a pessoa pedir para voltar.`;
    case 'pending': {
      const email = contact.confirmationEmail;
      if (email === null) {
        return 'Nenhum e-mail de confirmação foi pedido para este endereço ainda. Até a confirmação, ele não recebe avisos.';
      }
      switch (email.status) {
        case 'queued':
          return 'O e-mail de confirmação está na fila e sai em alguns minutos. Até a confirmação, o endereço não recebe avisos.';
        case 'sent':
          return `E-mail de confirmação enviado em ${formatTimestamp(email.at)}. O link vale por ${ESCALATION_CONFIRMATION_TTL_HOURS} horas; até a confirmação, o endereço não recebe avisos.`;
        case 'failed':
          return 'O e-mail de confirmação não saiu depois de 5 tentativas. Confira o endereço e peça a confirmação de novo.';
        case 'skipped':
          return 'O e-mail de confirmação não saiu: o ambiente está sem envio de e-mail, ou o cliente está desativado.';
      }
    }
  }
}

/**
 * O estado do contato de escalonamento (D8) e a ação de pedir a confirmação de novo: no cadastro de clientes da Verax e
 * na tela do administrador do cliente. A mutação vem de quem usa, para o aviso de "pedido na fila" sobreviver à releitura
 * do cadastro.
 */
export function EscalationContactStatus({
  contact,
  resend,
}: {
  contact: EscalationContact;
  resend: { mutate: () => void; isPending: boolean; isSuccess: boolean; error: unknown };
}) {
  return (
    <div className={cn('space-y-2 rounded-md border p-3 text-sm', STATUS_STYLE[contact.status])}>
      <p>
        <span className="font-medium">Situação:</span>{' '}
        <span>{ESCALATION_CONTACT_STATUS_LABELS[contact.status]}</span>
      </p>
      <p className="text-muted-foreground">{statusDetail(contact)}</p>
      {contact.status !== 'confirmed' && (
        <Button type="button" variant="secondary" disabled={resend.isPending} onClick={() => resend.mutate()}>
          Reenviar confirmação
        </Button>
      )}
      {resend.isSuccess && contact.status === 'pending' && (
        <p role="status">Pedido de confirmação na fila. Os links dos e-mails anteriores deixaram de valer.</p>
      )}
      <FormError error={resend.error} />
    </div>
  );
}
