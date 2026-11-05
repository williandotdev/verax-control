import { type Me, NOTICE_DIGEST_ITEMS, NOTICE_HOURLY_LIMIT, ROLE_LABELS } from '@verax/shared';
import { useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { FormError } from '@/features/admin/admin-ui';
import {
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from '@/features/notifications/notification-preferences-api';
import { useMe } from '@/features/session/session';

/**
 * Minha conta (fase 2, PR-17'): quem está na sessão e a preferência de aviso por e-mail da própria pessoa. Ninguém muda
 * a escolha de outra pessoa: na lista de usuários, quem administra só vê quem recebe.
 */
export function AccountPage() {
  const { data: me } = useMe();
  if (!me) return null;
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Minha conta</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Quem está nesta sessão e os avisos que chegam a você por e-mail.
        </p>
      </header>
      <Card aria-labelledby="conta-acesso">
        <CardTitle id="conta-acesso">Acesso</CardTitle>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">E-mail</dt>
          <dd className="break-all">{me.email}</dd>
          <dt className="text-muted-foreground">Papel</dt>
          <dd>{ROLE_LABELS[me.role]}</dd>
        </dl>
      </Card>
      <NoticePreference me={me} />
    </section>
  );
}

function NoticePreference({ me }: { me: Me }) {
  const preferences = useNotificationPreferences();
  const update = useUpdateNotificationPreferences();
  // A escolha em curso aparece na hora (no mesmo evento do clique), até a API responder; na falha, volta a guardada. A
  // caixa não fica desabilitada enquanto salva (o foco do teclado continuaria nela): o clique a mais é ignorado.
  const [choosing, setChoosing] = useState<boolean | null>(null);
  const choose = (incidentEmails: boolean) => {
    if (update.isPending) return;
    setChoosing(incidentEmails);
    update.mutate({ incidentEmails }, { onSettled: () => setChoosing(null) });
  };
  return (
    <Card aria-labelledby="conta-avisos">
      <CardTitle id="conta-avisos">Avisos por e-mail</CardTitle>
      <CardDescription className="mt-1 max-w-3xl">
        Incidente alto ou crítico aberto, incidente que sobe para alto ou crítico e achado crítico fora de
        incidente. O e-mail traz só o tipo e o link: os detalhes ficam no painel.
      </CardDescription>
      <div className="mt-3 space-y-2">
        {preferences.isError ? (
          <ErrorState error={preferences.error} onRetry={() => void preferences.refetch()} />
        ) : !preferences.data ? (
          <LoadingState rows={1} label="Carregando a preferência" />
        ) : !preferences.data.eligible ? (
          <p className="text-sm">
            {me.role === 'admin_verax'
              ? 'A equipe da Verax não recebe por e-mail os avisos dos clientes.'
              : `O papel ${ROLE_LABELS[me.role]} não recebe avisos por e-mail. Quem administra o cliente pode mudar o seu papel.`}
          </p>
        ) : (
          <>
            <label className="flex items-start gap-2 text-sm font-medium">
              <input
                type="checkbox"
                className="mt-0.5 size-4"
                checked={choosing ?? preferences.data.incidentEmails}
                aria-describedby="conta-avisos-dica"
                onChange={(event) => choose(event.target.checked)}
              />
              Receber os avisos de incidente por e-mail
            </label>
            <p id="conta-avisos-dica" className="text-xs text-muted-foreground">
              No máximo {NOTICE_HOURLY_LIMIT} e-mails por hora: os avisos seguintes da hora chegam num resumo
              só, quando ela fecha, com até {NOTICE_DIGEST_ITEMS} itens.
              {me.role === 'admin_cliente' &&
                ' Os avisos do volume do plano e da coleta da AWS chegam a quem administra o cliente mesmo com esta opção desligada.'}
            </p>
            <p role="status" className="text-xs text-muted-foreground">
              {update.isSuccess &&
                (update.data.incidentEmails
                  ? 'Pronto: você volta a receber os avisos de incidente.'
                  : 'Pronto: você deixa de receber os avisos de incidente por e-mail.')}
            </p>
            <FormError error={update.error} />
          </>
        )}
      </div>
    </Card>
  );
}
