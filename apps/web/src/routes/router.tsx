import { type ComponentType, createElement } from 'react';
import { ESCALATION_CONFIRM_PATH, ESCALATION_UNSUBSCRIBE_PATH } from '@verax/shared';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { LegacyRedirect } from '@/features/detections/legacy';
import { DemoTourMount } from '@/features/tour/entry';
import { AppLayout } from '@/layout/app-layout';
import { NAVIGATION } from '@/layout/navigation';
import { ChangePasswordPage } from '@/pages/change-password-page';
// Os links do e-mail de escalonamento leem o token do endereço e o apagam na hora: ficam no arquivo principal, como o
// login, para nenhuma recarga da página no meio perder o token.
import { EscalationConfirmPage, EscalationUnsubscribePage } from '@/pages/escalation-link-pages';
import { ForbiddenPage } from '@/pages/forbidden-page';
import { ForgotPasswordPage } from '@/pages/forgot-password-page';
import { LoginPage } from '@/pages/login-page';
import { MfaVerifyPage } from '@/pages/mfa-verify-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { PlaceholderPage } from '@/pages/placeholder-page';
import { SetPasswordPage } from '@/pages/set-password-page';
import { RequirePermission, RequireSession } from './guards';
import { lazyPage } from './lazy-page';
import { Loaded } from './loaded';

const DetectionsPage = lazyPage(
  () => import('@/pages/detections-page'),
  (m) => m.DetectionsPage,
);
const PosturePage = lazyPage(
  () => import('@/pages/posture-page'),
  (m) => m.PosturePage,
);
const AssetsPage = lazyPage(
  () => import('@/pages/assets-page'),
  (m) => m.AssetsPage,
);
const TenantsPage = lazyPage(
  () => import('@/pages/admin/tenants-page'),
  (m) => m.TenantsPage,
);
const UsersPage = lazyPage(
  () => import('@/pages/admin/users-page'),
  (m) => m.UsersPage,
);
const CloudAccountsPage = lazyPage(
  () => import('@/pages/admin/cloud-accounts-page'),
  (m) => m.CloudAccountsPage,
);
const AgentsPage = lazyPage(
  () => import('@/pages/agents-page'),
  (m) => m.AgentsPage,
);
const ProtectedResourcesPage = lazyPage(
  () => import('@/pages/admin/protected-resources-page'),
  (m) => m.ProtectedResourcesPage,
);
const ExceptionsPage = lazyPage(
  () => import('@/pages/admin/exceptions-page'),
  (m) => m.ExceptionsPage,
);
const PlanPage = lazyPage(
  () => import('@/pages/admin/plan-page'),
  (m) => m.PlanPage,
);
const EscalationContactPage = lazyPage(
  () => import('@/pages/admin/escalation-contact-page'),
  (m) => m.EscalationContactPage,
);
const AuditPage = lazyPage(
  () => import('@/pages/audit-page'),
  (m) => m.AuditPage,
);
const UnownedAlertsPage = lazyPage(
  () => import('@/pages/unowned-alerts-page'),
  (m) => m.UnownedAlertsPage,
);
const AccountPage = lazyPage(
  () => import('@/pages/account-page'),
  (m) => m.AccountPage,
);
// O cadastro do MFA traz o gerador de QR: só quem cadastra o baixa.
const MfaEnrollPage = lazyPage(
  () => import('@/pages/mfa-enroll-page'),
  (m) => m.MfaEnrollPage,
);

/** Catálogo do design system: só no build de desenvolvimento (o Vite remove este ramo do build final). */
const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: '/catalogo',
        lazy: async () => {
          const { CatalogPage } = await import('@/pages/catalog/catalog-page');
          return { Component: CatalogPage };
        },
      },
    ]
  : [];

/** Telas do E7 já construídas, por caminho do menu; as demais mostram o aviso de construção. */
const pageByPath: Partial<Record<string, ComponentType>> = {
  '/': DetectionsPage,
  '/postura': PosturePage,
  '/ativos': AssetsPage,
  '/cadastros/clientes': TenantsPage,
  '/cadastros/usuarios': UsersPage,
  '/cadastros/contas': CloudAccountsPage,
  '/cadastros/agentes': AgentsPage,
  '/cadastros/protecao': ProtectedResourcesPage,
  '/cadastros/excecoes': ExceptionsPage,
  '/cadastros/plano': PlanPage,
  '/cadastros/escalonamento': EscalationContactPage,
  '/auditoria': AuditPage,
  '/alertas-sem-dono': UnownedAlertsPage,
};

/** Páginas internas, geradas do menu: cada uma exige a mesma permissão do item (só UX; a API decide). */
const appPages: RouteObject[] = NAVIGATION.flatMap((group) => group.items).map((item) => {
  const page = pageByPath[item.to];
  const element = (
    <RequirePermission permission={item.permission}>
      {page ? <Loaded>{createElement(page)}</Loaded> : <PlaceholderPage title={item.label} />}
    </RequirePermission>
  );
  return item.to === '/' ? { index: true, element } : { path: item.to.slice(1), element };
});

/**
 * Os endereços de antes da tela Detecções (Torre, Incidentes, Achados e Relatórios): os links dos e-mails, do tour e
 * dos favoritos levam à visão equivalente. A permissão é conferida na tela de destino.
 */
const legacyPages: RouteObject[] = ['incidentes', 'incidentes/:id', 'achados', 'relatorios'].map((path) => ({
  path,
  element: <LegacyRedirect />,
}));

/** Páginas fora do menu, com a permissão do que mostram. */
const detailPages: RouteObject[] = [
  ...legacyPages,
  // A própria conta, pelo link do cabeçalho (fase 2, PR-17').
  {
    path: 'minha-conta',
    element: (
      <RequirePermission permission="notification_preferences:read">
        <Loaded>
          <AccountPage />
        </Loaded>
      </RequirePermission>
    ),
  },
];

export const routes: RouteObject[] = [
  ...devRoutes,
  { path: '/login', element: <LoginPage /> },
  { path: '/login/codigo', element: <MfaVerifyPage /> },
  { path: '/trocar-senha', element: <ChangePasswordPage /> },
  {
    path: '/mfa/cadastro',
    element: (
      <Loaded>
        <MfaEnrollPage />
      </Loaded>
    ),
  },
  { path: '/esqueci-senha', element: <ForgotPasswordPage /> },
  { path: '/redefinir-senha', element: <SetPasswordPage /> },
  // Os links do e-mail ao contato de escalonamento (D8): públicos, sem login.
  { path: ESCALATION_CONFIRM_PATH, element: <EscalationConfirmPage /> },
  { path: ESCALATION_UNSUBSCRIBE_PATH, element: <EscalationUnsubscribePage /> },
  { path: '/sem-permissao', element: <ForbiddenPage /> },
  {
    element: <RequireSession />,
    children: [
      {
        path: '/',
        // O tour guiado da demonstração fica ao lado do painel; fora do modo `mock`, `DemoTourMount` não renderiza nada.
        element: (
          <>
            <AppLayout />
            <DemoTourMount />
          </>
        ),
        children: [...appPages, ...detailPages],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
