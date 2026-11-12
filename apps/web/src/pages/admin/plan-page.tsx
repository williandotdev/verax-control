import {
  GIB_BYTES,
  PLAN_VOLUME_WARNING_RATIO,
  type PlanUsage,
  planVolumeRatio,
  RAW_EVENT_RETENTION_DAYS,
} from '@verax/shared';
import { CircleAlert, TriangleAlert } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { AdminShell } from '@/features/admin/admin-ui';
import { FranchiseCard, FranchiseDaysCard } from '@/features/plan/franchise-card';
import { usePlanUsage } from '@/features/plan/plan-api';
import { formatPercent, formatUsageMonth, formatVolume } from '@/features/plan/plan-format';
import { useMe } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { plural } from '@/lib/format';

/** Estado de um contador: dentro do plano, no aviso (volume a partir de 80%, vagas no limite) ou acima do plano. */
type UsageState = 'ok' | 'warning' | 'over';

const FILL: Readonly<Record<UsageState, string>> = {
  ok: 'bg-ok',
  warning: 'bg-medium',
  over: 'bg-high',
};

/**
 * "Plano e uso" (fase 2, PR-18): o plano do ambiente e quanto dele o cliente já usa. Só leitura: os limites vêm da
 * configuração do nó (`PLAN` e os ajustes), e para ampliar o cliente fala com a Verax. A partir de 80% do volume do mês,
 * uma faixa avisa; acima de 100%, a coleta continua e nenhum log é descartado. Na Plataforma (com franquia em GB/dia,
 * CE-10), o volume do mês dá lugar ao contador da franquia e ao volume por dia dos últimos 30 dias.
 */
export function PlanPage() {
  const { data: me } = useMe();
  const hasTenant = me?.scopeTenantId != null;
  return (
    <AdminShell
      title="Plano e uso"
      description="O plano do seu ambiente e quanto dele já está em uso. Os limites vêm da configuração do ambiente: para ampliar, fale com a Verax."
    >
      {hasTenant && <PlanContent />}
    </AdminShell>
  );
}

function PlanContent() {
  const query = usePlanUsage(true);
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data) return <LoadingState rows={4} label="Carregando o plano" />;
  const data = query.data;
  const { plan, usage } = data;
  const ratio = planVolumeRatio(data);
  const franchise = data.franchise;
  return (
    <div className="space-y-4">
      {ratio !== null && ratio >= PLAN_VOLUME_WARNING_RATIO && <VolumeBand ratio={ratio} data={data} />}
      <Card aria-labelledby="plano-atual">
        <CardTitle id="plano-atual">Plano {plan.label}</CardTitle>
        <CardDescription className="mt-1 max-w-3xl">
          Uso de {formatUsageMonth(usage.month)}, no calendário de Brasília. Só a criação de contas e usuários
          acima do plano é bloqueada: nada do que já existe é desativado, e a coleta dos logs nunca para.
        </CardDescription>
      </Card>
      <div
        className={cn(
          'grid gap-4 md:grid-cols-2',
          franchise === undefined ? 'xl:grid-cols-4' : 'xl:grid-cols-3',
        )}
      >
        <SeatTile
          title="Contas cloud"
          used={usage.cloudAccounts}
          limit={plan.limits.maxCloudAccounts}
          detail="Contas AWS, projetos da GCP e contas do Cloudflare ativos. Desativar uma conta libera a vaga."
        />
        <SeatTile
          title="Usuários"
          used={usage.users}
          limit={plan.limits.maxUsers}
          detail="Usuários convidados e ativos. Desativar um usuário libera a vaga; a equipe da Verax não conta."
        />
        {franchise === undefined && (
          <VolumeTile bytes={usage.monthlyBytes} limitGib={plan.limits.monthlyGib} ratio={ratio} />
        )}
        <HistoryTile days={plan.limits.historyDays} />
      </div>
      {franchise !== undefined && (
        <>
          <FranchiseCard franchise={franchise} />
          <FranchiseDaysCard franchise={franchise} />
        </>
      )}
    </div>
  );
}

function VolumeBand({ ratio, data }: { ratio: number; data: PlanUsage }) {
  const over = ratio >= 1;
  const Icon = over ? TriangleAlert : CircleAlert;
  const included = `${data.plan.limits.monthlyGib ?? 0} GiB`;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2 rounded-md border p-3 text-sm',
        over ? 'border-high/60 bg-high/10' : 'border-medium/70 bg-medium/15',
      )}
    >
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', over ? 'text-high' : 'text-medium')} />
      <div className="space-y-1">
        <p className="font-medium">
          {over
            ? `O volume do mês passou do incluído no plano: ${formatVolume(data.usage.monthlyBytes)} de ${included} (${formatPercent(ratio)}).`
            : `O volume do mês já chegou a ${formatPercent(ratio)} do incluído no plano (${included}).`}
        </p>
        <p>
          {over
            ? 'A coleta continua: nenhum log é descartado e os achados continuam chegando. Fale com a Verax para ampliar o plano.'
            : 'A coleta continua normalmente, mesmo se passar do plano: nenhum log é descartado. Se o volume seguir crescendo, fale com a Verax para ampliar.'}
        </p>
      </div>
    </div>
  );
}

/** Barra de uso: o preenchimento leva o estado, e o texto do valor dá o número sem depender da cor. */
function UsageBar({
  ratio,
  state,
  labelledBy,
  valueText,
}: {
  ratio: number;
  state: UsageState;
  labelledBy: string;
  valueText: string;
}) {
  const percent = Math.min(100, Math.max(0, ratio * 100));
  return (
    <div
      role="meter"
      aria-labelledby={labelledBy}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={valueText}
      className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
    >
      <div className={cn('h-full rounded-full', FILL[state])} style={{ width: `${percent}%` }} />
    </div>
  );
}

function Tile({
  title,
  titleId,
  value,
  children,
}: {
  title: string;
  titleId: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-2">
      <CardTitle id={titleId} className="text-sm font-medium text-muted-foreground">
        {title}
      </CardTitle>
      <p className="text-2xl font-semibold">{value}</p>
      {children}
    </Card>
  );
}

function SeatTile({
  title,
  used,
  limit,
  detail,
}: {
  title: string;
  used: number;
  limit: number | null;
  detail: string;
}) {
  const id = useId();
  if (limit === null) {
    return (
      <Tile title={title} titleId={id} value={String(used)}>
        <p className="text-sm text-muted-foreground">Sem limite no plano.</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </Tile>
    );
  }
  const state: UsageState = used > limit ? 'over' : used === limit ? 'warning' : 'ok';
  const status = {
    ok: plural(limit - used, 'vaga livre', 'vagas livres'),
    warning: 'Limite do plano atingido: para cadastrar outro, desative um ou fale com a Verax.',
    over: 'Acima do limite do plano: nada foi desativado, mas novos cadastros ficam bloqueados.',
  }[state];
  return (
    <Tile title={title} titleId={id} value={`${used} de ${limit}`}>
      <UsageBar ratio={used / limit} state={state} labelledBy={id} valueText={`${used} de ${limit}`} />
      <p className={cn('text-sm', state === 'ok' ? 'text-muted-foreground' : 'font-medium')}>{status}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </Tile>
  );
}

function VolumeTile({
  bytes,
  limitGib,
  ratio,
}: {
  bytes: number;
  limitGib: number | null;
  ratio: number | null;
}) {
  const id = useId();
  const detail = 'Volume de log lido no mês, somadas as fontes. Acima do plano, a coleta continua.';
  if (limitGib === null || ratio === null) {
    return (
      <Tile title="Volume do mês" titleId={id} value={formatVolume(bytes)}>
        <p className="text-sm text-muted-foreground">Sem limite no plano.</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </Tile>
    );
  }
  const state: UsageState = ratio >= 1 ? 'over' : ratio >= PLAN_VOLUME_WARNING_RATIO ? 'warning' : 'ok';
  const value = `${formatVolume(bytes)} de ${limitGib} GiB`;
  const remaining = limitGib * GIB_BYTES - bytes;
  return (
    <Tile title="Volume do mês" titleId={id} value={value}>
      <UsageBar
        ratio={ratio}
        state={state}
        labelledBy={id}
        valueText={`${value}, ${formatPercent(ratio)} do incluído`}
      />
      <p className={cn('text-sm', state === 'ok' ? 'text-muted-foreground' : 'font-medium')}>
        {state === 'over'
          ? `${formatPercent(ratio)} do incluído no plano.`
          : `${formatPercent(ratio)} do incluído; restam ${formatVolume(remaining)}.`}
      </p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </Tile>
  );
}

function HistoryTile({ days }: { days: number | null }) {
  const id = useId();
  return (
    <Tile title="Histórico" titleId={id} value={days === null ? 'Sem limite' : plural(days, 'dia', 'dias')}>
      <p className="text-xs text-muted-foreground">
        Por quanto tempo achados, incidentes e a postura ficam guardados, e até onde vão os filtros de
        período. A trilha de auditoria fica ao menos 13 meses; o evento bruto do log,{' '}
        {RAW_EVENT_RETENTION_DAYS} dias.
      </p>
    </Tile>
  );
}
