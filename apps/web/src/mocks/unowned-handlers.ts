import {
  type UnownedAccounts,
  unownedAccountsQuerySchema,
  type UnownedAlert,
  unownedAlertListQuerySchema,
  type UnownedReason,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import type { AdminStore } from './admin';
import { DEMO_ACCOUNTS } from './fixtures';
import type { MockState } from './handlers';

const url = (path: string): string => `${API_URL}${path}`;
const MINUTE = 60_000;
const PERIOD_HOURS = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 } as const;

const problem = (status: number, message: string) =>
  HttpResponse.json({ statusCode: status, message }, { status });

/** Contas fictícias que não estão em cliente nenhum (no formato da AWS, sem ser de ninguém). */
export const DEMO_UNKNOWN_ACCOUNTS = { forgotten: '210987654321', partner: '135792468024' } as const;

/**
 * Fila fictícia: uma conta esquecida que gera muitos alertas (a que falta cadastrar), uma conta de parceiro, um
 * bucket da Beta cadastrado na conta errada, um agente do Wazuh fora da lista do nó e os casos raros (sem conta,
 * contas conflitantes, formato inválido).
 */
export function demoUnownedAlerts(now: Date = new Date()): UnownedAlert[] {
  let index = 0;
  const alert = (
    minutesAgo: number,
    reason: UnownedReason,
    accounts: string[],
    rule: [string, number, string] | null,
  ): UnownedAlert => {
    index += 1;
    const at = new Date(now.getTime() - minutesAgo * MINUTE).toISOString();
    return {
      id: `018f2c1e-0000-7000-8000-0000000e${index.toString(16).padStart(4, '0')}`,
      source: 'wazuh',
      reason,
      accounts,
      occurredAt: rule ? new Date(now.getTime() - (minutesAgo + 4) * MINUTE).toISOString() : null,
      ruleId: rule?.[0] ?? null,
      ruleLevel: rule?.[1] ?? null,
      title: rule?.[2] ?? null,
      createdAt: at,
    };
  };
  const forgotten = DEMO_UNKNOWN_ACCOUNTS.forgotten;
  const consoleLogin: [string, number, string] = ['80253', 8, 'AWS CloudTrail: login no console sem MFA'];
  const accessDenied: [string, number, string] = ['80202', 5, 'AWS CloudTrail: acesso negado a uma API'];
  const trailOff: [string, number, string] = ['80254', 12, 'AWS CloudTrail: trilha de auditoria desligada'];
  return [
    ...Array.from({ length: 14 }, (_, n) =>
      alert(35 + n * 190, 'unknown_account', [forgotten], accessDenied),
    ),
    alert(50, 'unknown_account', [forgotten], consoleLogin),
    alert(3 * 60, 'unknown_account', [forgotten], trailOff),
    alert(2 * 60, 'conflicting_accounts', [DEMO_ACCOUNTS.alfaProducao, forgotten], accessDenied),
    alert(6 * 60, 'source_mismatch', [DEMO_ACCOUNTS.beta], consoleLogin),
    alert(26 * 60, 'source_mismatch', [DEMO_ACCOUNTS.beta], accessDenied),
    alert(3 * 24 * 60, 'unknown_account', [DEMO_UNKNOWN_ACCOUNTS.partner], consoleLogin),
    alert(9 * 24 * 60, 'unknown_account', [DEMO_UNKNOWN_ACCOUNTS.partner], accessDenied),
    alert(4 * 24 * 60, 'unknown_source', [DEMO_ACCOUNTS.alfaHomologacao], accessDenied),
    alert(12 * 60, 'no_account', [], ['80210', 6, 'AWS GuardDuty: atividade suspeita sem conta no evento']),
    alert(2 * 24 * 60, 'not_aws', [], null),
    alert(5 * 60, 'unknown_agent', ['agent:017'], ['5712', 10, 'sshd: força bruta com usuário inexistente']),
    alert(40 * 24 * 60, 'invalid_alert', [], null),
  ];
}

/** Fila sem dono do modo mock: só o admin_verax, com o mesmo contrato da API. */
export function createUnownedHandlers(state: MockState, admin: AdminStore, queue = demoUnownedAlerts()) {
  const denied = () => {
    if (!state.me) return problem(401, 'Não autenticado');
    if (!state.me.permissions.includes('unowned_alerts:read')) return problem(403, 'Sem permissão');
    return null;
  };
  return [
    http.get(url('/v1/unowned-alerts'), ({ request }) => {
      const error = denied();
      if (error) return error;
      const query = unownedAlertListQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return problem(400, 'Filtro inválido');
      const { page, pageSize, reason, account, period } = query.data;
      const from = period ? new Date(Date.now() - PERIOD_HOURS[period] * 3_600_000).toISOString() : null;
      const items = queue
        .filter(
          (alert) =>
            (!reason || alert.reason === reason) &&
            (!account || alert.accounts.includes(account)) &&
            (!from || alert.createdAt >= from),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      return HttpResponse.json({
        items: items.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: items.length,
      });
    }),
    http.get(url('/v1/unowned-alerts/accounts'), ({ request }) => {
      const error = denied();
      if (error) return error;
      const query = unownedAccountsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return problem(400, 'Filtro inválido');
      const from = new Date(Date.now() - PERIOD_HOURS[query.data.period] * 3_600_000).toISOString();
      const counts = new Map<string, { alerts: number; lastSeenAt: string }>();
      for (const alert of queue.filter((item) => item.createdAt >= from)) {
        for (const account of new Set(alert.accounts)) {
          const row = counts.get(account) ?? { alerts: 0, lastSeenAt: alert.createdAt };
          row.alerts += 1;
          if (alert.createdAt > row.lastSeenAt) row.lastSeenAt = alert.createdAt;
          counts.set(account, row);
        }
      }
      const registered = (account: string) => {
        for (const tenant of admin.tenants) {
          const found = (admin.accounts.get(tenant.id) ?? []).find((item) => item.accountId === account);
          if (found)
            return { tenantId: tenant.id, tenantName: tenant.name, active: found.status === 'active' };
        }
        return null;
      };
      const body: UnownedAccounts = {
        period: query.data.period,
        from,
        items: [...counts]
          .sort((a, b) => b[1].alerts - a[1].alerts || a[0].localeCompare(b[0]))
          .slice(0, 50)
          .map(([account, row]) => ({ account, ...row, registeredIn: registered(account) })),
      };
      return HttpResponse.json(body);
    }),
  ];
}
