import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { Layout } from '@/components/layout';
import { AccountPage } from '@/features/auth/account-page';
import { LoginPage } from '@/features/auth/login-page';
import {
  CostModelEditorPage,
  CostModelListPage,
  CostModelNewPage,
} from '@/features/cost-models/cost-model-pages';
import {
  PricingTableEditorPage,
  PricingTableListPage,
  PricingTableNewPage,
} from '@/features/pricing-tables/pricing-table-pages';
import { LegalEditorPage } from '@/features/legal/legal-editor-page';
import { LegalHistoryPage } from '@/features/legal/legal-history-page';
import { LegalNewPage } from '@/features/legal/legal-new-page';
import { LegalOverviewPage } from '@/features/legal/legal-overview-page';
import { SimulatorPage } from '@/features/simulator/simulator-page';
import { NewTenantPage } from '@/features/tenants/new-tenant-page';
import { TenantDetailPage } from '@/features/tenants/tenant-detail-page';
import { TenantListPage } from '@/features/tenants/tenant-list-page';
import { NotFoundPage } from './not-found-page';

/**
 * A tela de entrada (`/entrar`) fica fora da moldura: abre sem sessão. Não há tela de cadastro (a conta nasce pela
 * linha de comando do operador, `cadastro-responsavel`). Todo o resto fica dentro dela, que só desenha a tela depois
 * de a API confirmar a sessão.
 */
export const routes: RouteObject[] = [
  { path: 'entrar', element: <LoginPage /> },
  {
    element: <Layout />,
    children: [
      { index: true, element: <Navigate to="/modelos-de-custo" replace /> },
      { path: 'modelos-de-custo', element: <CostModelListPage /> },
      { path: 'modelos-de-custo/novo', element: <CostModelNewPage /> },
      { path: 'modelos-de-custo/:version', element: <CostModelEditorPage /> },
      { path: 'tabelas-de-preco', element: <PricingTableListPage /> },
      { path: 'tabelas-de-preco/novo', element: <PricingTableNewPage /> },
      { path: 'tabelas-de-preco/:version', element: <PricingTableEditorPage /> },
      { path: 'simulador', element: <SimulatorPage /> },
      { path: 'clientes', element: <TenantListPage /> },
      { path: 'clientes/novo', element: <NewTenantPage /> },
      { path: 'clientes/:id', element: <TenantDetailPage /> },
      { path: 'textos-legais', element: <LegalOverviewPage /> },
      { path: 'textos-legais/:kind/novo', element: <LegalNewPage /> },
      { path: 'textos-legais/:kind/historico', element: <LegalHistoryPage /> },
      { path: 'textos-legais/:kind/:version', element: <LegalEditorPage /> },
      { path: 'conta', element: <AccountPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
