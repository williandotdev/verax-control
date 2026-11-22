import { readFileSync } from 'node:fs';
import type {
  cloudAccountUpdateSchema,
  cloudCredentialInputSchema,
  NodeSyncNodeError,
  NodeSyncSourceCode,
} from '@verax/shared';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import type * as Console from '../../console/src/lib/api-types.js';
import type {
  logSourceCreateRequestSchema,
  logSourceRemoveRequestSchema,
  LogSourceWriteResult,
  NodeSyncOverview,
} from '../src/admin/admin-log-sources.schema.js';
import type {
  AccessRevealed,
  amendmentRequestSchema,
  ContractAmendmentResult,
  DirectTenantCreated,
  DirectTenantPreview,
  directTenantRequestSchema,
  EnrollmentCodeIssued,
  enrollmentCodeRequestSchema,
  revealAccessRequestSchema,
  TenantAction,
  TenantActionResult,
  tenantActionSchemas,
  TenantDetail,
  TenantInstallation,
  TenantList,
} from '../src/admin/admin-tenants.schema.js';
import type {
  LegalAuditEntry,
  legalCreateBodySchema,
  LegalOverview,
  legalPublishBodySchema,
  legalUpdateBodySchema,
} from '../src/admin/admin-legal.service.js';
import type { AdminSession } from '../src/admin/admin-session.controller.js';
import type {
  enrollmentConfirmRequestSchema,
  loginRequestSchema,
  passwordChangeRequestSchema,
  totpResetStartRequestSchema,
} from '../src/admin/auth/admin-auth.schema.js';
import type { AdminAuthController } from '../src/admin/auth/admin-auth.controller.js';
import type { TotpEnrollmentView } from '../src/admin/auth/admin-auth.service.js';
import type { PublishResult, SimulationResult } from '../src/admin/admin-pricing.service.js';
import { CONSOLE_CSP } from '../src/admin/console-assets.js';
import type { LegalTextRecord, LegalVersionSummary } from '../src/legal/legal.schema.js';
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
    expectTypeOf<Json<TenantInstallation>>().toEqualTypeOf<Console.TenantInstallation>();
    expectTypeOf<EnrollmentCodeIssued>().toEqualTypeOf<Console.EnrollmentCodeIssued>();
    expectTypeOf<AccessRevealed>().toEqualTypeOf<Console.AccessRevealed>();
    expectTypeOf<TenantActionResult>().toEqualTypeOf<Console.TenantActionResult>();
    expectTypeOf<TenantAction>().toEqualTypeOf<Console.TenantAction>();
    expectTypeOf<Json<ContractAmendmentResult>>().toEqualTypeOf<Console.ContractAmendmentResult>();
    // O login próprio: a troca do aplicativo e os códigos de recuperação.
    expectTypeOf<TotpEnrollmentView>().toEqualTypeOf<Console.TotpEnrollment>();
    expectTypeOf<
      Awaited<ReturnType<AdminAuthController['totpConfirm']>>
    >().toEqualTypeOf<Console.RecoveryCodes>();
    expectTypeOf<Awaited<ReturnType<AdminAuthController['login']>>>().toEqualTypeOf<Console.AdminSession>();
    expectTypeOf<
      ReturnType<AdminAuthController['clientConfig']>
    >().toEqualTypeOf<Console.AdminClientConfig>();
    // Os textos legais: a lista, a versão com o texto e a trilha.
    expectTypeOf<Json<LegalVersionSummary>>().toEqualTypeOf<Console.LegalVersionSummary>();
    expectTypeOf<Json<LegalOverview>>().toEqualTypeOf<Console.LegalOverview>();
    expectTypeOf<Json<LegalTextRecord>>().toExtend<Console.LegalTextRecord>();
    expectTypeOf<Json<LegalAuditEntry>>().toEqualTypeOf<Console.LegalAuditEntry>();
    // As fontes de log: o nó, as fontes com o relato dele e o que mandar ao cliente; os códigos do nó, todos.
    expectTypeOf<Json<NodeSyncOverview>>().toEqualTypeOf<Console.NodeSyncOverview>();
    expectTypeOf<Json<LogSourceWriteResult>>().toEqualTypeOf<Console.LogSourceWriteResult>();
    expectTypeOf<NodeSyncSourceCode>().toEqualTypeOf<Console.NodeSyncSourceCode>();
    expectTypeOf<NodeSyncNodeError>().toEqualTypeOf<Console.NodeSyncNodeError>();
  });

  it('o que as telas mandam cabe no que a API aceita', () => {
    expectTypeOf<Console.PriceTable>().toExtend<PriceTableInput>();
    expectTypeOf<Console.CostModel>().toExtend<CostModelInput>();
    expectTypeOf<Console.ConfigurationInput>().toEqualTypeOf<ConfigurationInput>();
    expectTypeOf<Console.DirectTenantRequest>().toExtend<z.input<typeof directTenantRequestSchema>>();
    expectTypeOf<Required<Console.TenantActionRequest>>().toExtend<
      z.input<(typeof tenantActionSchemas)['export']>
    >();
    expectTypeOf<Pick<Console.TenantActionRequest, 'confirmSlug'>>().toExtend<
      z.input<typeof enrollmentCodeRequestSchema>
    >();
    expectTypeOf<Pick<Console.TenantActionRequest, 'confirmSlug'>>().toExtend<
      z.input<typeof revealAccessRequestSchema>
    >();
    expectTypeOf<Console.AmendmentRequest>().toExtend<z.input<typeof amendmentRequestSchema>>();
    expectTypeOf<Console.LoginRequest>().toExtend<z.input<typeof loginRequestSchema>>();
    expectTypeOf<Console.TotpConfirmRequest>().toExtend<z.input<typeof enrollmentConfirmRequestSchema>>();
    expectTypeOf<Console.PasswordChangeRequest>().toExtend<z.input<typeof passwordChangeRequestSchema>>();
    expectTypeOf<Console.TotpResetStartRequest>().toExtend<z.input<typeof totpResetStartRequestSchema>>();
    expectTypeOf<Console.LegalCreateRequest>().toExtend<z.input<typeof legalCreateBodySchema>>();
    expectTypeOf<Console.LegalUpdateRequest>().toExtend<z.input<typeof legalUpdateBodySchema>>();
    expectTypeOf<Console.LegalPublishRequest>().toExtend<z.input<typeof legalPublishBodySchema>>();
    expectTypeOf<Console.LogSourceCreateRequest>().toExtend<z.input<typeof logSourceCreateRequestSchema>>();
    expectTypeOf<Console.LogSourceUpdateRequest>().toExtend<z.input<typeof cloudAccountUpdateSchema>>();
    expectTypeOf<Console.LogSourceCredentialInput>().toExtend<z.input<typeof cloudCredentialInputSchema>>();
    expectTypeOf<Console.LogSourceRemoveRequest>().toExtend<z.input<typeof logSourceRemoveRequestSchema>>();
  });

  it('o vite preview dos testes de navegador do console manda a mesma CSP do cp-admin', () => {
    const viteConfig = readFileSync(new URL('../../console/vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain(`"${CONSOLE_CSP}"`);
  });
});
