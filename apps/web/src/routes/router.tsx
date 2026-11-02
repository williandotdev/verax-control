import { createBrowserRouter, type RouteObject } from 'react-router';
import { ForbiddenPage } from '@/pages/forbidden-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';

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

export const routes: RouteObject[] = [
  ...devRoutes,
  { path: '/login', element: <LoginPage /> },
  { path: '/sem-permissao', element: <ForbiddenPage /> },
  { path: '/', element: <main className="p-8">Torre</main> },
  { path: '*', element: <NotFoundPage /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
