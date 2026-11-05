import { type EscalationContact, escalationContactInputSchema } from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { AdminShell, FormError } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import {
  useEscalationContact,
  useRequestEscalationConfirmation,
  useUpdateEscalationContact,
} from '@/features/escalation/escalation-api';
import { EscalationContactStatus } from '@/features/escalation/escalation-contact-status';
import { useMe } from '@/features/session/session';

/**
 * Contato de escalonamento do próprio cliente (D8), para quem administra o cliente: quem a Verax e a equipe acionam num
 * incidente grave. O endereço novo só recebe os avisos críticos depois de confirmar pelo link do e-mail, e cada e-mail
 * tem o link para deixar de receber. A equipe da Verax chega aqui com um cliente escolhido.
 */
export function EscalationContactPage() {
  const { data: me } = useMe();
  const hasTenant = me?.scopeTenantId != null;
  return (
    <AdminShell
      title="Contato de escalonamento"
      description="Quem a Verax e a sua equipe acionam num incidente grave. Depois de confirmar o endereço pelo link do e-mail, ele recebe só os avisos críticos (incidente crítico e achado crítico), sem detalhes, e pode deixar de receber pelo link de qualquer e-mail."
    >
      {hasTenant && <EscalationContactContent />}
    </AdminShell>
  );
}

function EscalationContactContent() {
  const query = useEscalationContact();
  const resend = useRequestEscalationConfirmation();
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState rows={4} label="Carregando o contato" />;
  const { contact } = query.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card aria-labelledby="contato-situacao">
        <CardTitle id="contato-situacao">Situação do contato</CardTitle>
        <div className="mt-3">
          {contact ? (
            <EscalationContactStatus contact={contact} resend={resend} />
          ) : (
            <p className="text-sm">
              Nenhum contato cadastrado. Cadastre quem deve ser acionado num incidente grave.
            </p>
          )}
        </div>
      </Card>
      <ContactForm contact={contact} />
    </div>
  );
}

function ContactForm({ contact }: { contact: EscalationContact | null }) {
  const update = useUpdateEscalationContact();
  const [values, setValues] = useState({
    name: contact?.name ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = escalationContactInputSchema.safeParse({
      name: values.name,
      email: values.email,
      phone: values.phone.trim() || null,
    });
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    update.mutate(input.data);
  };

  return (
    <Card aria-labelledby="contato-cadastro">
      <CardTitle id="contato-cadastro">{contact ? 'Trocar o contato' : 'Cadastrar o contato'}</CardTitle>
      <CardDescription className="mt-1">
        Trocar o e-mail pede uma nova confirmação ao endereço novo; até lá, ninguém de fora do painel recebe
        os avisos. Mudar só o nome ou o telefone não mexe na confirmação.
      </CardDescription>
      <form onSubmit={submit} noValidate className="mt-3 space-y-3">
        <Field
          label="Nome do contato"
          value={values.name}
          onChange={set('name')}
          error={errors['name']}
          maxLength={120}
          autoComplete="off"
        />
        <Field
          label="E-mail do contato"
          type="email"
          value={values.email}
          onChange={set('email')}
          error={errors['email']}
          maxLength={254}
          autoComplete="off"
        />
        <Field
          label="Telefone do contato (opcional)"
          type="tel"
          value={values.phone}
          onChange={set('phone')}
          error={errors['phone']}
          maxLength={20}
          autoComplete="off"
        />
        <FormError error={update.error} />
        {update.isSuccess && (
          <p role="status" className="text-sm">
            {update.data.contact?.status === 'pending'
              ? 'Contato salvo. O e-mail de confirmação vai para o endereço em alguns minutos.'
              : 'Contato salvo.'}
          </p>
        )}
        <Button type="submit" disabled={update.isPending}>
          Salvar contato
        </Button>
      </form>
    </Card>
  );
}
