import type { Me } from '@verax/shared';
import { useId } from 'react';
import { useSwitchTenant, useTenantOptions } from '@/features/session/session';
import { errorMessage } from '@/lib/errors';

const NO_TENANT = '';

/**
 * Seletor de cliente do admin_verax. A troca vale só para a sessão atual, é feita e auditada pela API
 * (POST /v1/session/tenant) e descarta todos os dados em cache.
 */
export function TenantSwitcher({ me }: { me: Me }) {
  const id = useId();
  const tenants = useTenantOptions(me);
  const switchTenant = useSwitchTenant();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Cliente
      </label>
      <select
        id={id}
        className="h-9 min-w-56 rounded-md border bg-surface-raised px-2 text-sm"
        value={me.activeTenantId ?? NO_TENANT}
        disabled={tenants.isPending || switchTenant.isPending}
        onChange={(event) =>
          switchTenant.mutate(event.target.value === NO_TENANT ? null : event.target.value)
        }
      >
        <option value={NO_TENANT}>Nenhum (visão Verax)</option>
        {tenants.data?.map((tenant) => (
          <option key={tenant.id} value={tenant.id}>
            {tenant.name}
          </option>
        ))}
      </select>
      {switchTenant.error && (
        <p role="alert" className="text-xs text-critical-text">
          {errorMessage(switchTenant.error)}
        </p>
      )}
    </div>
  );
}
