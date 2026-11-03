import { type Me, CREDENTIAL_CHANGE_REQUIRED_CODE, type Role, ROLES } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { createAdminHandlers, demoAdminStore } from './admin';
import { createAuditHandlers } from './audit-handlers';
import { createAuthHandlers } from './auth-handlers';
import { DEMO_TENANTS, demoMe, demoTower } from './fixtures';
import { demoFindings } from './findings-fixtures';
import { createFindingHandlers } from './findings-handlers';
import { createIncidentHandlers, incidentSummaries, initialIncidents } from './incidents-handlers';
import { createReportHandlers, demoMitre } from './reports-handlers';
import { createInventoryHandlers } from './inventory';
import { createPostureHandlers } from './posture';
import { createUnownedHandlers, demoUnownedAlerts } from './unowned-handlers';

/** Estado em memória do modo mock: quem está logado e qual cliente está selecionado. */
export interface MockState {
  me: Me | null;
  /** Login com MFA: devolve só o desafio do código (padrão). */
  mfa?: boolean;
  pendingCode?: boolean;
}

const url = (path: string): string => `${API_URL}${path}`;

/**
 * O que a sessão aberta com a senha temporária alcança, como na API: a identidade, o token CSRF, sair e trocar a senha.
 * Entrar e redefinir a senha pelo link não usam a sessão.
 */
const ALLOWED_WITH_TEMPORARY_PASSWORD = new Set([
  'GET /v1/me',
  'GET /v1/csrf-token',
  'POST /v1/auth/sign-out',
  'GET /v1/auth/get-session',
  'POST /v1/auth/change-password',
  'POST /v1/auth/sign-in/email',
  'POST /v1/auth/request-password-reset',
  'POST /v1/auth/reset-password',
]);

function roleFromStorage(): Role {
  const stored = typeof window === 'undefined' ? null : window.localStorage.getItem('verax.mock.role');
  return (ROLES as readonly string[]).includes(stored ?? '') ? (stored as Role) : 'admin_verax';
}

/** O admin_verax da demonstração já começa com o primeiro cliente selecionado, para a Torre abrir com dados. */
function defaultMe(): Me {
  const role = roleFromStorage();
  const first = DEMO_TENANTS[0]?.id ?? null;
  return role === 'admin_verax'
    ? demoMe(role, { activeTenantId: first, scopeTenantId: first })
    : demoMe(role);
}

/**
 * Handlers do Mock Service Worker com o mesmo contrato da API. No modo `dev:mock`, o papel do usuário
 * fictício sai de `localStorage['verax.mock.role']` (padrão: admin_verax).
 */
export function createHandlers(state: MockState = { me: defaultMe() }) {
  // Achados, incidentes e Torre compartilham o mesmo estado: a triagem aparece em todas as telas.
  const findings = demoFindings();
  const admin = demoAdminStore();
  const incidents = initialIncidents();
  const unowned = demoUnownedAlerts();
  // A Torre conta a fila sem dono dos últimos 7 dias, como a API.
  const recentUnowned = () =>
    unowned.filter((alert) => Date.parse(alert.createdAt) >= Date.now() - 7 * 24 * 3_600_000).length;
  const towerCounts = (tenantId: string) => {
    const open = incidentSummaries(tenantId, findings, incidents).filter(
      (incident) => incident.status !== 'resolved',
    );
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const incident of open) bySeverity[incident.severity] += 1;
    return {
      openIncidents: bySeverity,
      unassignedIncidents: open.filter((incident) => incident.assignee === null).length,
      untriagedFindings: (findings.get(tenantId) ?? []).filter(
        (finding) =>
          (finding.severity === 'critical' || finding.severity === 'high') &&
          finding.status === 'new' &&
          finding.incidentId === null,
      ).length,
    };
  };
  return [
    // Antes de todos: sessão com senha temporária só passa para as rotas da troca (as demais seguem adiante).
    http.all(url('/v1/*'), ({ request }) => {
      if (!state.me?.mustChangePassword) return undefined;
      const path = request.url.slice(API_URL.length).split('?')[0] ?? '';
      if (ALLOWED_WITH_TEMPORARY_PASSWORD.has(`${request.method} ${path}`)) return undefined;
      return HttpResponse.json(
        {
          statusCode: 403,
          code: CREDENTIAL_CHANGE_REQUIRED_CODE,
          message: 'Troque a senha temporária para continuar',
        },
        { status: 403 },
      );
    }),
    ...createAuthHandlers(state),
    ...createAdminHandlers(state, admin),
    ...createFindingHandlers(state, findings),
    ...createIncidentHandlers(state, findings, incidents),
    ...createPostureHandlers(state),
    ...createInventoryHandlers(state),
    ...createReportHandlers(state, findings, incidents, admin),
    ...createAuditHandlers(state),
    ...createUnownedHandlers(state, admin, unowned),
    http.get(url('/v1/me'), () =>
      state.me
        ? HttpResponse.json(state.me)
        : HttpResponse.json({ statusCode: 401, message: 'Não autenticado' }, { status: 401 }),
    ),
    http.get(url('/v1/csrf-token'), () => HttpResponse.json({ token: 'token-csrf-ficticio' })),
    http.get(url('/v1/tower'), () => {
      if (!state.me)
        return HttpResponse.json({ statusCode: 401, message: 'Não autenticado' }, { status: 401 });
      if (!state.me.scopeTenantId) {
        return HttpResponse.json(
          { statusCode: 400, code: 'TENANT_REQUIRED', message: 'Escolha um cliente' },
          { status: 400 },
        );
      }
      return HttpResponse.json(
        demoTower(state.me.scopeTenantId, {
          includeUnowned: state.me.role === 'admin_verax',
          unownedAlerts: recentUnowned(),
          ...towerCounts(state.me.scopeTenantId),
          mitre: demoMitre(state.me.scopeTenantId, findings, incidents),
        }),
      );
    }),
    http.post(url('/v1/session/tenant'), async ({ request }) => {
      if (!state.me || state.me.role !== 'admin_verax')
        return HttpResponse.json({ statusCode: 403, message: 'Sem permissão' }, { status: 403 });
      if (request.headers.get('X-CSRF-Token') === null) {
        return HttpResponse.json({ statusCode: 403, code: 'CSRF_INVALID', message: 'CSRF' }, { status: 403 });
      }
      const body = (await request.json()) as { tenantId?: string };
      const tenant = admin.tenants.find(
        (candidate) => candidate.id === body.tenantId && candidate.status === 'active',
      );
      if (!tenant)
        return HttpResponse.json(
          { statusCode: 404, message: 'Cliente não encontrado ou inativo' },
          { status: 404 },
        );
      state.me = { ...state.me, activeTenantId: tenant.id, scopeTenantId: tenant.id };
      return HttpResponse.json({ activeTenantId: tenant.id });
    }),
    http.delete(url('/v1/session/tenant'), () => {
      if (state.me) state.me = { ...state.me, activeTenantId: null, scopeTenantId: null };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(url('/v1/auth/sign-out'), () => {
      state.me = null;
      return HttpResponse.json({ success: true });
    }),
  ];
}
