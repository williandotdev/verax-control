import { type ComponentType, createElement } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppLayout } from '@/layout/app-layout';
import { NAVIGATION } from '@/layout/navigation';
import { CloudAccountsPage } from '@/pages/admin/cloud-accounts-page';
import { ExceptionsPage } from '@/pages/admin/exceptions-page';
import { ProtectedResourcesPage } from '@/pages/admin/protected-resources-page';
import { TenantsPage } from '@/pages/admin/tenants-page';
import { UsersPage } from '@/pages/admin/users-page';
import { AssetsPage } from '@/pages/assets-page';
import { FindingsPage } from '@/pages/findings-page';
import { ForbiddenPage } from '@/pages/forbidden-page';
import { IncidentPage } from '@/pages/incident-page';
import { IncidentsPage } from '@/pages/incidents-page';
import { ForgotPasswordPage } from '@/pages/forgot-password-page';
import { LoginPage } from '@/pages/login-page';
import { MfaEnrollPage } from '@/pages/mfa-enroll-page';
import { MfaVerifyPage } from '@/pages/mfa-verify-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { PosturePage } from '@/pages/posture-page';
import { ReportsPage } from '@/pages/reports-page';
import { PlaceholderPage } from '@/pages/placeholder-page';
import { SetPasswordPage } from '@/pages/set-password-page';
import { TowerPage } from '@/pages/tower-page';
import { RequirePermission, RequireSession } from './guards';

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
  '/': TowerPage,
  '/achados': FindingsPage,
  '/incidentes': IncidentsPage,
  '/postura': PosturePage,
  '/ativos': AssetsPage,
  '/relatorios': ReportsPage,
  '/cadastros/clientes': TenantsPage,
  '/cadastros/usuarios': UsersPage,
  '/cadastros/contas': CloudAccountsPage,
  '/cadastros/protecao': ProtectedResourcesPage,
  '/cadastros/excecoes': ExceptionsPage,
};

/** Páginas internas, geradas do menu: cada uma exige a mesma permissão do item (só UX; a API decide). */
const appPages: RouteObject[] = NAVIGATION.flatMap((group) => group.items).map((item) => {
  const page = pageByPath[item.to];
  const element = (
    <RequirePermission permission={item.permission}>
      {page ? createElement(page) : <PlaceholderPage title={item.label} />}
    </RequirePermission>
  );
  return item.to === '/' ? { index: true, element } : { path: item.to.slice(1), element };
});

/** Páginas de detalhe, fora do menu, com a permissão da lista a que pertencem. */
const detailPages: RouteObject[] = [
  {
    path: 'incidentes/:id',
    element: (
      <RequirePermission permission="incidents:read">
        <IncidentPage />
      </RequirePermission>
    ),
  },
];

export const routes: RouteObject[] = [
  ...devRoutes,
  { path: '/login', element: <LoginPage /> },
  { path: '/login/codigo', element: <MfaVerifyPage /> },
  { path: '/mfa/cadastro', element: <MfaEnrollPage /> },
  { path: '/esqueci-senha', element: <ForgotPasswordPage /> },
  { path: '/redefinir-senha', element: <SetPasswordPage mode="reset" /> },
  { path: '/convite', element: <SetPasswordPage mode="invite" /> },
  { path: '/sem-permissao', element: <ForbiddenPage /> },
  {
    element: <RequireSession />,
    children: [{ path: '/', element: <AppLayout />, children: [...appPages, ...detailPages] }],
  },
  { path: '*', element: <NotFoundPage /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
