import { useQueryClient } from '@tanstack/react-query';
import type { CloudAccount, CloudflareZone, CloudflareZones } from '@verax/shared';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SEVERITY_STYLES } from '@/design/severity';
import { useUpdateCloudAccount } from '@/features/admin/admin-api';
import { FormError } from '@/features/admin/admin-ui';
import { cn } from '@/lib/cn';
import { formatList, formatRelative, plural } from '@/lib/format';
import { isNotFound, useCloudflareZones } from './cloudflare-oauth-api';
import { ZONE_STATE_SEVERITY, ZONE_STATE_TEXTS } from './labels';

/**
 * A saúde das zonas e da auditoria da conta do Cloudflare (vale para token colado e OAuth). No nó anterior, a rota não
 * existe (404) e a seção não aparece: a tela fica como antes. Com `quiet` (o nó sem OAuth, que pode ser um nó anterior),
 * a seção só aparece com os dados já lidos: nem carregando, nem com erro. Os nomes vêm do Cloudflare e são sempre texto
 * puro.
 */
export function CloudflareZoneHealth({
  account,
  canEdit,
  quiet = false,
}: {
  account: CloudAccount;
  canEdit: boolean;
  quiet?: boolean;
}) {
  const zones = useCloudflareZones(account.id);
  if (zones.error && isNotFound(zones.error)) return null;
  if (quiet && !zones.isSuccess) return null;
  return (
    <section aria-labelledby="zonas-saude" className="space-y-3 rounded-md border p-3">
      <h3 id="zonas-saude" className="text-sm font-semibold">
        Zonas e auditoria
      </h3>
      {zones.isPending ? (
        <LoadingState rows={2} label="Carregando as zonas" />
      ) : zones.data === undefined ? (
        <FormError error={zones.error} />
      ) : (
        <ZoneDetails account={account} data={zones.data} canEdit={canEdit} />
      )}
    </section>
  );
}

function ZoneDetails({
  account,
  data,
  canEdit,
}: {
  account: CloudAccount;
  data: CloudflareZones;
  canEdit: boolean;
}) {
  const overLimit = data.zones.filter((zone) => zone.state === 'over_limit');
  return (
    <div className="space-y-3 text-sm">
      <p>
        Auditoria da conta:{' '}
        {data.audit.lastReadAt ? `última leitura ${formatRelative(data.audit.lastReadAt)}` : 'ainda não lida'}
        {data.audit.lastErrorCode && (
          <>
            {' '}
            · último erro <code className="font-mono text-xs">{data.audit.lastErrorCode}</code>
          </>
        )}
        .
      </p>
      {data.monitored === 'all' ? (
        <p>Monitorando todas as zonas da conta, inclusive as que forem criadas depois.</p>
      ) : (
        <MonitorAll account={account} canEdit={canEdit} />
      )}
      {overLimit.length > 0 && (
        <p className="rounded-md border border-medium/70 bg-medium/15 p-2">
          O Verax lê os eventos de segurança de até {data.limit} zonas por conta.{' '}
          {plural(overLimit.length, 'Ficou de fora', 'Ficaram de fora')}:{' '}
          {formatList(overLimit.map((zone) => zone.name))}. A auditoria da conta continua sendo lida inteira.
        </p>
      )}
      {data.zones.length === 0 ? (
        <p className="text-muted-foreground">
          Nenhuma zona lida ainda. As zonas aparecem aqui depois da primeira leitura da conta.
        </p>
      ) : (
        <ul aria-label="Zonas da conta" className="divide-y rounded-md border">
          {data.zones.map((zone) => (
            <ZoneRow key={zone.zoneId} zone={zone} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ZoneRow({ zone }: { zone: CloudflareZone }) {
  const { icon: Icon, tone } = SEVERITY_STYLES[ZONE_STATE_SEVERITY[zone.state]];
  return (
    <li className="space-y-0.5 p-2">
      <p className="break-all font-medium">{zone.name}</p>
      <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-foreground">
          <Icon aria-hidden className={cn('size-3.5', tone)} />
          {ZONE_STATE_TEXTS[zone.state]}
        </span>
        {zone.plan && <span>Plano {zone.plan}</span>}
        <span>
          {zone.state === 'missing' && zone.missingSince
            ? `sumiu ${formatRelative(zone.missingSince)}`
            : zone.lastReadAt
              ? `lida ${formatRelative(zone.lastReadAt)}`
              : 'ainda não lida'}
        </span>
        {zone.lastErrorCode && (
          <span>
            erro <code className="font-mono">{zone.lastErrorCode}</code>
          </span>
        )}
      </p>
    </li>
  );
}

/** A conta com lista de zonas fica como está; "Monitorar todas" esvazia a lista (todas, inclusive as novas). */
function MonitorAll({ account, canEdit }: { account: CloudAccount; canEdit: boolean }) {
  const update = useUpdateCloudAccount(account.id);
  const queryClient = useQueryClient();
  return (
    <div className="space-y-2">
      <p>Monitorando só as zonas da lista cadastrada ({formatList(account.zones)}).</p>
      {canEdit && (
        <>
          <Button
            type="button"
            variant="secondary"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { zones: [] },
                {
                  onSuccess: () =>
                    void queryClient.invalidateQueries({ queryKey: ['cloudflare-zones', account.id] }),
                },
              )
            }
          >
            Monitorar todas as zonas
          </Button>
          <FormError error={update.error} />
        </>
      )}
    </div>
  );
}
