import { UserPlus } from 'lucide-react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button-variants';
import { formatDateTime, PLAN_LABELS, plural } from '@/lib/format';
import { stepLabel } from './labels';
import { useTenants } from './queries';
import { BillingBadge, HostingBadge, TenantStateBadge } from './tenant-badges';

/**
 * Os clientes (os mais novos primeiro): o estado, como paga, o passo do provisionamento e, se parou, o código. O
 * cadastro de um cliente de contrato direto começa aqui.
 */
export function TenantListPage() {
  const tenants = useTenants();
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1">
          <h1 className="text-2xl font-semibold">Clientes</h1>
          <p className="text-sm text-muted-foreground">
            Os ambientes dos clientes: os que compraram pelo site e os de contrato direto, cadastrados aqui. O
            provisionamento é o mesmo para os dois; o detalhe mostra cada passo.
          </p>
        </div>
        <Link to="/clientes/novo" className={buttonVariants()}>
          <UserPlus aria-hidden />
          Novo cliente (contrato direto)
        </Link>
      </header>

      {tenants.isPending && <LoadingState label="Carregando os clientes" />}
      {tenants.isError && <ErrorState error={tenants.error} onRetry={() => void tenants.refetch()} />}
      {tenants.data !== undefined && tenants.data.unreadable > 0 && (
        <p role="status" className="text-sm text-critical-text">
          {plural(tenants.data.unreadable, 'cliente ficou', 'clientes ficaram')} fora da lista: o documento no
          Firestore está fora do formato (o log do cp-admin tem o id, em admin_tenant_unreadable).
        </p>
      )}
      {tenants.data?.tenants.length === 0 && (
        <EmptyState
          title="Nenhum cliente ainda"
          description="Os clientes do site aparecem aqui depois do pagamento. Um contrato negociado direto com a Verax começa no botão acima."
        />
      )}
      {tenants.data !== undefined && tenants.data.tenants.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">Clientes, dos mais novos para os mais antigos</caption>
            <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Cliente
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Estado
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Cobrança
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Onde roda
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Provisionamento
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Criado em
                </th>
              </tr>
            </thead>
            <tbody>
              {tenants.data.tenants.map((tenant) => (
                <tr key={tenant.id} className="border-t">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <Link
                      to={`/clientes/${tenant.id}`}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {tenant.companyName}
                    </Link>
                    <span className="block font-mono text-xs font-normal text-muted-foreground">
                      {tenant.slug} ·{' '}
                      {tenant.plan === undefined ? 'modelo anterior' : PLAN_LABELS[tenant.plan]} · porte{' '}
                      {tenant.size}
                    </span>
                  </th>
                  <td className="px-3 py-2">
                    <TenantStateBadge state={tenant.state} />
                  </td>
                  <td className="px-3 py-2">
                    <BillingBadge mode={tenant.billingMode} />
                  </td>
                  <td className="px-3 py-2">
                    <HostingBadge hosting={tenant.hosting} />
                  </td>
                  <td className="px-3 py-2">
                    {tenant.step === undefined ? '—' : stepLabel(tenant.step)}
                    {tenant.lastErrorCode !== undefined && (
                      <span className="block font-mono text-xs text-critical-text">
                        {tenant.lastErrorCode}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(tenant.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
