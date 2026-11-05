import { ESCALATION_LINK_INVALID_CODE } from '@verax/shared';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { AuthShell, FormError, FormNotice } from '@/features/auth/auth-shell';
import { followEscalationLink } from '@/features/escalation/escalation-api';
import { ApiRequestError } from '@/lib/api-client';
import { takeTokenFromFragment } from '@/lib/fragment-token';

type Action = 'confirm' | 'unsubscribe';

/**
 * O texto de cada página. A página pede um clique: um verificador de links de e-mail que abre o endereço sozinho não
 * confirma nem descadastra ninguém.
 */
const COPY: Readonly<
  Record<
    Action,
    { title: string; description: string; button: string; done: string; invalid: string; incomplete: string }
  >
> = {
  confirm: {
    title: 'Confirmar o contato de escalonamento',
    description:
      'Ao confirmar, este endereço passa a receber por e-mail só os avisos críticos do Verax Control: incidente de severidade crítica e achado crítico. Os e-mails não trazem detalhes, e cada um tem o link para deixar de receber.',
    button: 'Confirmar o endereço',
    done: 'Endereço confirmado. A partir de agora, ele recebe os avisos críticos.',
    invalid:
      'Este link é inválido, já foi usado ou venceu (ele vale por 72 horas). Peça um novo e-mail de confirmação a quem cadastrou o contato.',
    incomplete: 'Este link está incompleto. Abra de novo o link do e-mail.',
  },
  unsubscribe: {
    title: 'Deixar de receber os avisos críticos',
    description:
      'Este endereço é o contato de escalonamento de um cliente no Verax Control. Ao confirmar, ele deixa de receber os avisos por e-mail. Para voltar a receber, quem administra o cliente precisa pedir uma nova confirmação.',
    button: 'Deixar de receber',
    done: 'Pronto. Este endereço não recebe mais os avisos do Verax Control.',
    invalid:
      'Este link é inválido ou venceu. Use o link do e-mail mais recente ou fale com quem administra o cliente.',
    incomplete: 'Este link está incompleto. Abra de novo o link do e-mail.',
  },
};

function linkErrorMessage(error: unknown, action: Action): string {
  if (error instanceof ApiRequestError) {
    if (error.code === ESCALATION_LINK_INVALID_CODE) return COPY[action].invalid;
    if (error.status === 429) return 'Muitas tentativas. Tente de novo em alguns minutos.';
  }
  return 'Não foi possível concluir agora. Tente de novo em alguns minutos.';
}

/**
 * As páginas públicas dos links do e-mail ao contato de escalonamento (D8), sem login: o token vem do fragmento do
 * link (que nenhum servidor vê), sai da barra de endereço na hora, e vai no corpo do pedido. Nada do cliente nem do
 * endereço aparece aqui.
 */
function EscalationLinkPage({ action }: { action: Action }) {
  const copy = COPY[action];
  const [token] = useState(takeTokenFromFragment);
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState<string>();

  async function follow() {
    if (!token || state !== 'idle') return;
    setError(undefined);
    setState('sending');
    try {
      await followEscalationLink(action, token);
      setState('done');
    } catch (caught) {
      setError(linkErrorMessage(caught, action));
      setState('idle');
    }
  }

  if (!token) {
    return (
      <AuthShell title={copy.title}>
        <FormError message={copy.incomplete} />
      </AuthShell>
    );
  }
  if (state === 'done') {
    return (
      <AuthShell title={copy.title}>
        <FormNotice message={copy.done} />
      </AuthShell>
    );
  }
  return (
    <AuthShell title={copy.title} description={copy.description}>
      <div className="space-y-4">
        <FormError message={error} />
        <Button type="button" className="w-full" disabled={state === 'sending'} onClick={() => void follow()}>
          {copy.button}
        </Button>
      </div>
    </AuthShell>
  );
}

export function EscalationConfirmPage() {
  return <EscalationLinkPage action="confirm" />;
}

export function EscalationUnsubscribePage() {
  return <EscalationLinkPage action="unsubscribe" />;
}
