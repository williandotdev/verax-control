import { createBrowserRouter, type RouteObject } from 'react-router';
import { ForbiddenPage } from '@/pages/forbidden-page';
import { LoginPage } from '@/pages/login-page';
import { NotFoundPage } from '@/pages/not-found-page';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/sem-permissao', element: <ForbiddenPage /> },
  { path: '/', element: <main className="p-8">Torre</main> },
  { path: '*', element: <NotFoundPage /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
