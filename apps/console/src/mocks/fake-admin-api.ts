import type {
  CostModel,
  PriceTable,
  SimulationRequest,
  ValidationIssue,
  VersionedRecord,
  VersionStatus,
  VersionSummary,
} from '@/lib/api-types';
import { getAt } from '@/lib/paths';
import { createFakeAuth, type FakeAuthState, handleAuthRequest } from './fake-auth';
import { dre, guard, quote } from './fake-engine';
import { createFakeTenants, type FakeTenantsState, handleTenantsRequest } from './fake-tenants';
import { FICTITIOUS_OWNER, fictitiousCostModel, fictitiousPriceTable } from './fixtures';

/**
 * A API do console simulada (`/v1/admin/...`), em memória, para os testes de componente (pelo MSW) e os de navegador
 * (pelo `page.route` do Playwright). Imita os contratos de `apps/control-plane/src/admin`: os códigos de erro, o 400
 * com `details.issues`, o 422 da publicação com `details.report`, a vigente por `effectiveFrom` e a aposentadoria da
 * anterior. A validação é só uma amostra (alguns campos obrigatórios e duas regras): a de verdade é o zod da API.
 */
type Kind = 'pricing-tables' | 'cost-models';
type AnyRecord = VersionedRecord<PriceTable> | VersionedRecord<CostModel>;

export interface FakeResponse {
  status: number;
  body: unknown;
}

export interface FakeAdminState {
  'pricing-tables': Map<string, VersionedRecord<PriceTable>>;
  'cost-models': Map<string, VersionedRecord<CostModel>>;
  now: () => Date;
  email: string;
  /** Os clientes (`fake-tenants.ts`). */
  tenants: FakeTenantsState;
  /** A sessão e a conta do responsável (`fake-auth.ts`); por padrão, com a sessão aberta. */
  auth: FakeAuthState;
}

const DAY = 86_400_000;

function iso(date: Date): string {
  return date.toISOString();
}

/**
 * O estado inicial: um modelo de custos e uma tabela publicados (os vigentes), uma tabela anterior aposentada e um
 * rascunho de tabela. Todos FICTÍCIOS. `empty` começa sem nada (a primeira vez do responsável).
 */
export function createFakeState(
  options: { empty?: boolean; now?: () => Date; loggedIn?: boolean; setupOpen?: boolean } = {},
): FakeAdminState {
  const now = options.now ?? (() => new Date());
  const state: FakeAdminState = {
    'pricing-tables': new Map(),
    'cost-models': new Map(),
    now,
    email: FICTITIOUS_OWNER,
    tenants: options.empty === true ? { tenants: new Map(), workerDown: false } : createFakeTenants(now),
    auth: createFakeAuth({ loggedIn: options.loggedIn, setupOpen: options.setupOpen }),
  };
  if (options.empty === true) return state;
  const at = (days: number): string => iso(new Date(now().getTime() - days * DAY));
  const base = { createdBy: FICTITIOUS_OWNER, updatedBy: FICTITIOUS_OWNER };
  state['cost-models'].set('custos-teste-v1', {
    version: 'custos-teste-v1',
    status: 'published',
    content: fictitiousCostModel(),
    effectiveFrom: at(20),
    publishedAt: at(20),
    publishedBy: FICTITIOUS_OWNER,
    createdAt: at(21),
    updatedAt: at(20),
    ...base,
  });
  state['pricing-tables'].set('teste-v1', {
    version: 'teste-v1',
    status: 'retired',
    content: fictitiousPriceTable(),
    effectiveFrom: at(19),
    publishedAt: at(19),
    publishedBy: FICTITIOUS_OWNER,
    retiredAt: at(10),
    supersededBy: 'teste-v2',
    createdAt: at(19),
    updatedAt: at(10),
    ...base,
  });
  state['pricing-tables'].set('teste-v2', {
    version: 'teste-v2',
    status: 'published',
    content: fictitiousPriceTable(),
    effectiveFrom: at(10),
    publishedAt: at(10),
    publishedBy: FICTITIOUS_OWNER,
    createdAt: at(11),
    updatedAt: at(10),
    ...base,
  });
  state['pricing-tables'].set('teste-v3', {
    version: 'teste-v3',
    status: 'draft',
    content: fictitiousPriceTable(),
    createdAt: at(1),
    updatedAt: at(1),
    ...base,
  });
  return state;
}

function error(
  status: number,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): FakeResponse {
  return {
    status,
    body: { statusCode: status, message, code, ...(details === undefined ? {} : { details }) },
  };
}

function current<R extends { effectiveFrom?: string }>(records: Map<string, R>, now: Date): R | undefined {
  let best: R | undefined;
  for (const record of records.values()) {
    if (record.effectiveFrom === undefined || new Date(record.effectiveFrom) > now) continue;
    if (best === undefined || (best.effectiveFrom ?? '') < record.effectiveFrom) best = record;
  }
  return best;
}

function summary(record: AnyRecord, currentVersion: string | undefined): VersionSummary {
  const { content: _content, publishCheck: _check, createdAt: _created, createdBy: _by, ...rest } = record;
  return { ...rest, current: record.version === currentVersion };
}

/** Campos que a amostra de validação exige (a API exige todos). */
const REQUIRED: Readonly<Record<Kind, readonly string[]>> = {
  'cost-models': [
    'exchange.brlPerUsd',
    'exchange.cloudBuffer',
    'infrastructure.diskUsdPerGibMonth',
    'paymentFees.card.rate',
    'refundReserveRate',
    'support.hourlyCost',
    'fixedCosts.allocationCustomers',
    'margins.minimum',
    'margins.alert',
  ],
  'pricing-tables': [
    'cloudAccounts.included',
    'cloudAccounts.max',
    'cloudAccounts.additional.amount',
    'volume.includedMonthlyGib',
    'agents.packSize',
    'prioritySupport.amount',
    'users.max',
  ],
};

function validate(kind: Kind, content: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const path of REQUIRED[kind]) {
    const value = getAt(content, path.split('.'));
    if (typeof value !== 'number') {
      issues.push({
        path,
        message: `Entrada inválida: esperado number, recebido ${value === undefined ? 'undefined' : typeof value}`,
      });
    }
  }
  const minimum = getAt(content, ['margins', 'minimum']);
  const alert = getAt(content, ['margins', 'alert']);
  if (kind === 'cost-models' && typeof minimum === 'number' && typeof alert === 'number' && alert < minimum) {
    issues.push({ path: 'margins.alert', message: 'menor que a mínima' });
  }
  const included = getAt(content, ['cloudAccounts', 'included']);
  const max = getAt(content, ['cloudAccounts', 'max']);
  if (
    kind === 'pricing-tables' &&
    typeof included === 'number' &&
    typeof max === 'number' &&
    max < included
  ) {
    issues.push({ path: 'cloudAccounts.max', message: 'menor que o incluído' });
  }
  return issues;
}

function invalid(issues: ValidationIssue[]): FakeResponse {
  return error(400, 'Dados inválidos.', 'invalid_request', { issues });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validVersion(version: unknown): version is string {
  if (typeof version !== 'string' || version.length === 0 || version.length > 40) return false;
  for (const char of version) {
    const ok = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9') || char === '-';
    if (!ok) return false;
  }
  return version[0] !== '-';
}

function store(state: FakeAdminState, kind: Kind): Map<string, AnyRecord> {
  return state[kind];
}

/** Atende uma chamada; caminho sem o domínio (ex.: `/v1/admin/me`). */
export function handleAdminRequest(
  state: FakeAdminState,
  method: string,
  path: string,
  body: unknown,
): FakeResponse {
  const now = state.now();
  const parts = path.split('?')[0]?.split('/').filter(Boolean).slice(2) ?? [];
  const [first, second, third] = parts.map(decodeURIComponent);

  // O acesso (primeiro acesso, entrada, saída e conta) e, sem sessão, o 401 de toda rota protegida.
  const access = handleAuthRequest(state.auth, state.email, now, method, [first, second, third], body);
  if (access !== undefined) return access;

  if (method === 'GET' && first === 'me' && parts.length === 1)
    return { status: 200, body: { email: state.email } };

  if (method === 'POST' && first === 'dre' && second === 'simulate') return simulate(state, body);

  if (first === 'tenants') {
    const table = current(state['pricing-tables'], now);
    return handleTenantsRequest(
      state.tenants,
      table?.content,
      table?.version,
      now,
      method,
      second,
      third,
      body,
    );
  }

  if (first !== 'pricing-tables' && first !== 'cost-models')
    return error(404, 'Recurso não encontrado', 'not_found');
  const kind: Kind = first;
  const records = store(state, kind);
  const currentRecord = current(records, now);

  if (second === undefined) {
    if (method === 'GET') {
      const list = [...records.values()]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((record) => summary(record, currentRecord?.version));
      return { status: 200, body: list };
    }
    if (method === 'POST') {
      const version = isRecord(body) ? body['version'] : undefined;
      if (!validVersion(version)) {
        return invalid([{ path: 'version', message: 'versão inválida (minúsculas, números e traço)' }]);
      }
      if (records.has(version)) return error(409, 'Esta versão já existe.', 'version_exists');
      const content = isRecord(body) ? body['content'] : undefined;
      const issues = validate(kind, content);
      if (issues.length > 0) return invalid(issues);
      const record = {
        version,
        status: 'draft' as VersionStatus,
        content,
        createdAt: iso(now),
        createdBy: state.email,
        updatedAt: iso(now),
        updatedBy: state.email,
      } as AnyRecord;
      records.set(version, record);
      return { status: 201, body: record };
    }
  }

  if (second === undefined) return error(404, 'Recurso não encontrado', 'not_found');
  const record = records.get(second);
  if (record === undefined) return error(404, 'Versão inexistente.', 'version_not_found');

  if (third === undefined && method === 'GET') return { status: 200, body: record };

  if (third === undefined && method === 'PUT') {
    if (record.status !== 'draft') {
      return error(
        409,
        'Só o rascunho muda: para alterar uma versão publicada, crie outra.',
        'version_immutable',
      );
    }
    const content = isRecord(body) ? body['content'] : undefined;
    const issues = validate(kind, content);
    if (issues.length > 0) return invalid(issues);
    const next = { ...record, content, updatedAt: iso(now), updatedBy: state.email } as AnyRecord;
    records.set(second, next);
    return { status: 200, body: next };
  }

  const model = current(state['cost-models'], now);
  if (kind === 'pricing-tables' && third === 'check' && method === 'POST') {
    const requested =
      isRecord(body) && typeof body['costModelVersion'] === 'string' ? body['costModelVersion'] : undefined;
    const used = requested === undefined ? model : state['cost-models'].get(requested);
    if (used === undefined) {
      return error(
        409,
        'Nenhum modelo de custos publicado: publique um antes da tabela de preços.',
        'cost_model_missing',
      );
    }
    return {
      status: 200,
      body: { costModelVersion: used.version, report: guard(record.content as PriceTable, used.content) },
    };
  }

  if (third === 'publish' && method === 'POST') {
    if (record.status !== 'draft') {
      return error(
        409,
        'Só o rascunho muda: para alterar uma versão publicada, crie outra.',
        'version_immutable',
      );
    }
    const requestedFrom =
      isRecord(body) && typeof body['effectiveFrom'] === 'string' ? body['effectiveFrom'] : undefined;
    const effectiveFrom = requestedFrom === undefined ? now : new Date(requestedFrom);
    if (effectiveFrom.getTime() < now.getTime() - 60_000) {
      return error(
        409,
        'A vigência precisa ser agora ou depois, e depois da última versão publicada.',
        'effective_from_invalid',
      );
    }
    let report;
    if (kind === 'pricing-tables') {
      if (model === undefined) {
        return error(
          409,
          'Nenhum modelo de custos publicado: publique um antes da tabela de preços.',
          'cost_model_missing',
        );
      }
      report = guard(record.content as PriceTable, model.content);
      if (!report.ok) {
        return error(422, 'A tabela não passou na checagem de publicação.', 'publish_guard_failed', {
          costModelVersion: model.version,
          report,
        });
      }
    } else {
      const table = current(state['pricing-tables'], now);
      report = table === undefined ? null : guard(table.content, record.content as CostModel);
    }
    for (const [version, other] of records) {
      if (other.status === 'published') {
        records.set(version, {
          ...other,
          status: 'retired',
          retiredAt: iso(effectiveFrom),
          supersededBy: second,
          updatedAt: iso(now),
        });
      }
    }
    const published = {
      ...record,
      status: 'published' as VersionStatus,
      effectiveFrom: iso(effectiveFrom),
      publishedAt: iso(now),
      publishedBy: state.email,
      updatedAt: iso(now),
      updatedBy: state.email,
    } as AnyRecord;
    records.set(second, published);
    const { current: _current, ...publishedSummary } = summary(published, undefined);
    return { status: 200, body: { ...publishedSummary, report } };
  }

  return error(404, 'Recurso não encontrado', 'not_found');
}

function simulate(state: FakeAdminState, body: unknown): FakeResponse {
  const now = state.now();
  const request = body as Partial<SimulationRequest>;
  const configuration = request.configuration;
  const issues: ValidationIssue[] = [];
  for (const key of ['cloudAccounts', 'monthlyGib', 'agents', 'historyDays'] as const) {
    if (typeof configuration?.[key] !== 'number') {
      issues.push({
        path: `configuration.${key}`,
        message: 'Entrada inválida: esperado number, recebido undefined',
      });
    }
  }
  if (issues.length > 0 || configuration === undefined) return invalid(issues);
  const table =
    request.priceTableVersion === undefined
      ? current(state['pricing-tables'], now)
      : state['pricing-tables'].get(request.priceTableVersion);
  if (table === undefined) return error(409, 'Nenhuma tabela de preços vigente.', 'pricing_table_missing');
  const model =
    request.costModelVersion === undefined
      ? current(state['cost-models'], now)
      : state['cost-models'].get(request.costModelVersion);
  if (model === undefined) {
    return error(
      409,
      'Nenhum modelo de custos publicado: publique um antes da tabela de preços.',
      'cost_model_missing',
    );
  }
  const outcome = quote(configuration, table.content);
  const versions = { priceTableVersion: table.version, costModelVersion: model.version };
  if (outcome.kind === 'contact_us')
    return { status: 200, body: { contactUs: true, reason: outcome.reason, ...versions } };
  const result = dre(outcome.quote, table.content, model.content, {
    paymentMethod: request.paymentMethod ?? 'card',
    ...(request.taxRateId === undefined ? {} : { taxRateId: request.taxRateId }),
    ...(request.discountRate === undefined ? {} : { discountRate: request.discountRate }),
    ...(request.allocationCustomers === undefined
      ? {}
      : { allocationCustomers: request.allocationCustomers }),
  });
  const tax = model.content.taxes.rates.find((rate) => rate.id === result.taxRateId);
  return {
    status: 200,
    body: {
      contactUs: false,
      ...versions,
      dre: result,
      margins: model.content.margins,
      taxRate: tax,
    },
  };
}
