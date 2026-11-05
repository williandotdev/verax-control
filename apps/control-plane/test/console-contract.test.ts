import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type * as Console from '../../console/src/lib/api-types.js';
import type {
  DirectTenantCreated,
  DirectTenantPreview,
  directTenantRequestSchema,
  TenantAction,
  TenantActionResult,
  tenantActionSchemas,
  TenantDetail,
  TenantList,
} from '../src/admin/admin-tenants.schema.js';
import type { AdminSession } from '../src/admin/admin-session.controller.js';
import type { PublishResult, SimulationResult } from '../src/admin/admin-pricing.service.js';
import { CONSOLE_CSP } from '../src/admin/console-assets.js';
import type { DreResult } from '../src/pricing/dre.js';
import type { VersionedRecord, VersionSummary } from '../src/pricing/pricing-store.js';
import type {
  ConfigurationInput,
  CostModel,
  CostModelInput,
  PriceTable,
  PriceTableInput,
} from '../src/pricing/pricing.schema.js';
import type { GuardReport } from '../src/pricing/publish-guard.js';

/** O que o JSON faz com um tipo do servidor: datas viram texto ISO; o resto fica igual. */
type Json<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? Json<U>[]
    : T extends object
      ? { [K in keyof T]: Json<T[K]> }
      : T;

/**
 * O contrato entre a API do console (`src/admin`) e as telas (`apps/console/src/lib/api-types.ts`, escritas à mão para
 * o console não importar o servidor): o que a API devolve, depois do JSON, cabe no que a tela lê; o que a tela manda
 * cabe no que a API aceita. A conferência é de tipo: quebra no `pnpm typecheck`, não em execução.
 */
describe('contrato com as telas do console', () => {
  it('as respostas da API cabem nos tipos que as telas leem', () => {
    expectTypeOf<Json<VersionSummary>>().toEqualTypeOf<Console.VersionSummary>();
    expectTypeOf<Json<GuardReport>>().toEqualTypeOf<Console.GuardReport>();
    expectTypeOf<Json<DreResult>>().toEqualTypeOf<Console.DreResult>();
    expectTypeOf<Json<SimulationResult>>().toEqualTypeOf<Console.SimulationResult>();
    expectTypeOf<Json<PublishResult>>().toEqualTypeOf<Console.PublishResult>();
    expectTypeOf<AdminSession>().toEqualTypeOf<Console.AdminSession>();
    expectTypeOf<Json<VersionedRecord<PriceTable>>>().toExtend<Console.VersionedRecord<Console.PriceTable>>();
    expectTypeOf<Json<VersionedRecord<CostModel>>>().toExtend<Console.VersionedRecord<Console.CostModel>>();
    // Os clientes: a lista, o detalhe com a linha do tempo, a cotação de referência, o cadastro e as operações.
    expectTypeOf<Json<TenantList>>().toEqualTypeOf<Console.TenantList>();
    expectTypeOf<Json<TenantDetail>>().toEqualTypeOf<Console.TenantDetail>();
    expectTypeOf<Json<DirectTenantPreview>>().toEqualTypeOf<Console.DirectTenantPreview>();
    expectTypeOf<Json<DirectTenantCreated>>().toEqualTypeOf<Console.DirectTenantCreated>();
    expectTypeOf<TenantActionResult>().toEqualTypeOf<Console.TenantActionResult>();
    expectTypeOf<TenantAction>().toEqualTypeOf<Console.TenantAction>();
  });

  it('o que as telas mandam cabe no que a API aceita', () => {
    expectTypeOf<Console.PriceTable>().toExtend<PriceTableInput>();
    expectTypeOf<Console.CostModel>().toExtend<CostModelInput>();
    expectTypeOf<Console.ConfigurationInput>().toEqualTypeOf<ConfigurationInput>();
    expectTypeOf<Console.DirectTenantRequest>().toExtend<z.input<typeof directTenantRequestSchema>>();
    expectTypeOf<Required<Console.TenantActionRequest>>().toExtend<
      z.input<(typeof tenantActionSchemas)['export']>
    >();
  });

  it('o vite preview dos testes de navegador do console manda a mesma CSP do cp-admin', () => {
    const viteConfig = readFileSync(new URL('../../console/vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain(`"${CONSOLE_CSP}"`);
  });
});
