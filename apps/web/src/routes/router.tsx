import { createBrowserRouter, type RouteObject } from 'react-router';
import { AppLayout } from '@/layout/app-layout';
import { NAVIGATION } from '@/layout/navigation';
import { ForbiddenPage } from '@/pages/forbidden-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';
import { PlaceholderPage } from '@/pages/placeholder-page';
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

/** Páginas internas, geradas do menu: cada uma exige a mesma permissão do item (só UX; a API decide). */
const appPages: RouteObject[] = NAVIGATION.flatMap((group) => group.items).map((item) => {
  const element = (
    <RequirePermission permission={item.permission}>
      <PlaceholderPage title={item.label} />
    </RequirePermission>
  );
  return item.to === '/' ? { index: true, element } : { path: item.to.slice(1), element };
});

export const routes: RouteObject[] = [
  ...devRoutes,
  { path: '/login', element: <LoginPage /> },
  { path: '/mfa/cadastro', element: <PlaceholderPage title="Cadastro da verificação em duas etapas" /> },
  { path: '/sem-permissao', element: <ForbiddenPage /> },
  {
    element: <RequireSession />,
    children: [{ path: '/', element: <AppLayout />, children: appPages }],
  },
  { path: '*', element: <NotFoundPage /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
