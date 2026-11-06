import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { Layout } from '@/components/layout';
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
import { SimulatorPage } from '@/features/simulator/simulator-page';
import { NewTenantPage } from '@/features/tenants/new-tenant-page';
import { TenantDetailPage } from '@/features/tenants/tenant-detail-page';
import { TenantListPage } from '@/features/tenants/tenant-list-page';
import { NotFoundPage } from './not-found-page';

export const routes: RouteObject[] = [
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
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export function createRouter() {
  return createBrowserRouter(routes);
}
