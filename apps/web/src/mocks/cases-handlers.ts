import {
  type CaseDetail,
  CASE_MODES,
  type CaseMode,
  caseFindingsQuerySchema,
  caseGroupsQuerySchema,
  caseListQuerySchema,
  CASE_SPLIT_WHOLE_CODE,
  caseSplitSchema,
  type FindingDetail,
  hasPermission,
  INVALID_CASE_CURSOR_CODE,
  MAX_TRIAGE_AUTHORS,
  type Permission,
  TRIAGE_AUTHORS_DAYS,
  triageFilterSchema,
  triageOperationCreateSchema,
  triageOperationListQuerySchema,
  triageUndoSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import type { AdminStore } from './admin';
import { DEMO_VULNERABILITIES, demoCaseFindings } from './case-fixtures';
import { DemoCases, isPending } from './case-store';
import type { MockState } from './handlers';
import { DEMO_ASSIGNEES, type IncidentState, incidentSummaries, newIncidentId } from './incidents-handlers';
import { demoPeriodRefusal, demoRangeRefusal } from './plan-handlers';
import { DemoTriage, TRIAGE_SCENARIOS, TriageRefusal, type TriageScenario } from './triage-engine';

const url = (path: string): string => `${API_URL}${path}`;

const problem = (status: number, message: string, code?: string, details?: Record<string, number>) =>
  HttpResponse.json(
    { statusCode: status, message, ...(code ? { code } : {}), ...(details ? { details } : {}) },
    { status },
  );

const refusal = (error: unknown) => {
  if (!(error instanceof TriageRefusal)) throw error;
  return problem(error.status, error.message, error.code, error.details);
};

const stored = (key: string): string | null =>
  typeof window === 'undefined' ? null : window.localStorage.getItem(key);

/** Os casos na demonstração: ligados, a não ser que o teste (ou `localStorage['verax.mock.cases']`) diga outra coisa. */
export function demoCaseMode(state: Pick<MockState, 'cases'>): CaseMode {
  return state.cases ?? CASE_MODES.find((mode) => mode === stored('verax.mock.cases')) ?? 'on';
}

/** O que dá errado na triagem em massa da demonstração (`localStorage['verax.mock.triage']`); nada, sem ele. */
function demoScenario(state: Pick<MockState, 'triage'>): TriageScenario | null {
  return state.triage ?? TRIAGE_SCENARIOS.find((value) => value === stored('verax.mock.triage')) ?? null;
}

function demoVolume(state: Pick<MockState, 'caseVolume'>): number {
  const asked = state.caseVolume ?? Number.parseInt(stored('verax.mock.cases.volume') ?? '', 10);
  return Number.isInteger(asked) && asked >= 0 ? asked : DEMO_VULNERABILITIES;
}

/** Junta os alertas a mais dos casos aos da demonstração (só com os casos ligados). */
export function addCaseFindings(
  state: Pick<MockState, 'cases' | 'caseVolume'>,
  findings: Map<string, FindingDetail[]>,
): void {
  if (demoCaseMode(state) === 'off') return;
  for (const [tenantId, extra] of demoCaseFindings(demoVolume(state))) {
    findings.set(
      tenantId,
      [...(findings.get(tenantId) ?? []), ...extra].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    );
  }
}

interface World {
  cases: DemoCases;
  triage: DemoTriage;
}

/** Os casos da demonstração, compartilhados pelas rotas deles, pela Torre e pelos relatórios. */
export interface CaseWorlds {
  mode: CaseMode;
  /** O modo para quem está vendo: com `shadow`, só a equipe da Verax. */
  visibleMode: () => CaseMode;
  worldOf: (tenantId: string) => World;
  /** Os casos do cliente, se quem pede os quer (`cases=true`) e pode vê-los; senão, null. */
  requested: (tenantId: string, query: { cases?: 'true' | undefined }) => DemoCases | null;
}

const CURSOR_MARK = '.';
const encodeCursor = (text: string): string =>
  [...btoa(text)]
    .map((char) => (char === '+' ? '-' : char === '/' ? '_' : char))
    .filter((char) => char !== '=')
    .join('');
const decodeCursor = (text: string): string | null => {
  try {
    return atob([...text].map((char) => (char === '-' ? '+' : char === '_' ? '/' : char)).join(''));
  } catch {
    return null;
  }
};

export function createCaseWorlds(
  state: MockState,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState>,
  admin: AdminStore,
): CaseWorlds {
  const mode = demoCaseMode(state);
  const worlds = new Map<string, World>();

  const worldOf = (tenantId: string): World => {
    const existing = worlds.get(tenantId);
    if (existing) return existing;
    const own = findings.get(tenantId) ?? [];
    findings.set(tenantId, own);
    const cases = new DemoCases(
      own,
      (admin.protectedResources.get(tenantId) ?? []).map((item) => item.identifier),
    );
    const triage = new DemoTriage(
      {
        cases,
        openIncident: (author) => {
          const id = newIncidentId();
          incidents.set(id, { status: 'open', assignee: null, createdBy: author });
          return id;
        },
        incidentStatus: (id) =>
          incidentSummaries(tenantId, findings, incidents).find((incident) => incident.id === id)?.status,
        resolveIncident: (id) => {
          const incident = incidents.get(id);
          if (incident) incident.status = 'resolved';
        },
      },
      () => demoScenario(state),
    );
    const world = { cases, triage };
    worlds.set(tenantId, world);
    seedHistory(world);
    return world;
  };

  const visibleMode = (): CaseMode => {
    if (mode === 'shadow' && state.me?.role !== 'admin_verax') return 'off';
    return mode;
  };
  return {
    mode,
    visibleMode,
    worldOf,
    requested: (tenantId, { cases }) =>
      cases === 'true' && visibleMode() !== 'off' ? worldOf(tenantId).cases : null,
  };
}

/**
 * Casos e triagem em massa do modo mock, com o mesmo contrato da API, montados dos mesmos alertas das outras telas. Com os
 * casos desligados, só a situação responde (`off`), e as outras rotas são 404, como num nó com eles desligados.
 */
export function createCaseHandlers(
  state: MockState,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState>,
  { mode, visibleMode, worldOf }: CaseWorlds,
) {
  const scoped = (permission: Permission = 'findings:read') => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    if (!state.me.permissions.includes(permission)) return { error: problem(403, 'Sem permissão') } as const;
    if (visibleMode() === 'off') return { error: problem(404, 'Não encontrado') } as const;
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') } as const;
    return { me: state.me, tenantId, ...worldOf(tenantId) } as const;
  };
  const writable = (request: Request) => {
    const scope = scoped('findings:triage');
    if ('error' in scope) return scope;
    if (mode !== 'on') return { error: problem(404, 'Não encontrado') } as const;
    if (request.headers.get('X-CSRF-Token') === null) {
      return { error: problem(403, 'CSRF', 'CSRF_INVALID') } as const;
    }
    return scope;
  };
  const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);
  const page = <T>(items: readonly T[], pageNumber: number, pageSize: number) =>
    HttpResponse.json({
      items: items.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
      page: pageNumber,
      pageSize,
      total: items.length,
    });

  return [
    http.get(url('/v1/cases/status'), () => {
      if (!state.me) return problem(401, 'Não autenticado');
      const visible = visibleMode();
      return HttpResponse.json({
        mode: visible,
        asOf: visible === 'off' ? null : new Date(Date.now() - 8_000).toISOString(),
        oldestUnassignedMinutes: null,
      });
    }),

    http.get(url('/v1/cases'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const parsed = caseListQuerySchema.safeParse(query(request));
      if (!parsed.success) return problem(400, 'Filtro inválido');
      const { page: number, pageSize, ...filter } = parsed.data;
      const beyond = demoPeriodRefusal(state, filter.period) ?? demoRangeRefusal(state, filter.from);
      if (beyond) return beyond;
      return page(scope.cases.list(filter), number, pageSize);
    }),

    http.get(url('/v1/cases/groups'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const parsed = caseGroupsQuerySchema.safeParse(query(request));
      if (!parsed.success) return problem(400, 'Filtro inválido');
      const { page: number, pageSize, by, queue: _queue, ...filter } = parsed.data;
      return page(scope.cases.groups(by, filter), number, pageSize);
    }),

    http.get(url('/v1/cases/:id'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const row = scope.cases.byId(String(params['id']));
      if (!row) return problem(404, 'Caso não encontrado');
      const summaries = incidentSummaries(scope.tenantId, findings, incidents);
      const triage = mode === 'on' && hasPermission(scope.me.role, 'findings:triage');
      const { me } = scope;
      const detail: CaseDetail = {
        ...scope.cases.detail(row, (id) => {
          const incident = summaries.find((candidate) => candidate.id === id);
          return incident && { status: incident.status, severity: incident.severity };
        }),
        operations: scope.triage.ofFindings(row.findingIds).map((operation) => {
          const alone = scope.triage.get(me, operation.id);
          return alone ? { ...operation, can: readOnlyIn(mode)(alone).can } : operation;
        }),
        can: { triage, promote: triage && hasPermission(scope.me.role, 'incidents:write') },
      };
      return HttpResponse.json(detail);
    }),

    http.get(url('/v1/cases/:id/findings'), ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const row = scope.cases.byId(String(params['id']));
      if (!row) return problem(404, 'Caso não encontrado');
      const parsed = caseFindingsQuerySchema.safeParse(query(request));
      if (!parsed.success) return problem(400, 'Filtro inválido');
      const { cursor, pageSize, status, severity, group } = parsed.data;
      const mark = [row.id, status, severity, group].join('|');
      const items = scope.cases
        .findingsOf(row)
        .filter(
          (finding) =>
            (!status || finding.status === status) &&
            (!severity || finding.severity === severity) &&
            (!group || scope.cases.groupOfFinding.get(finding.id) === group),
        );
      let start = 0;
      if (cursor !== undefined) {
        const [lastId, scopeMark] = decodeCursor(cursor)?.split(CURSOR_MARK) ?? [];
        const index = items.findIndex((finding) => finding.id === lastId);
        if (index < 0 || scopeMark !== String(mark.length)) {
          return problem(400, 'A página pedida não é desta lista.', INVALID_CASE_CURSOR_CODE);
        }
        start = index + 1;
      }
      const shown = items.slice(start, start + pageSize);
      const last = shown.at(-1);
      return HttpResponse.json({
        items: shown.map((finding) => ({
          finding: summaryOf(finding),
          group: scope.cases.groupOfFinding.get(finding.id) ?? null,
          lastSeenAt: scope.cases.stillActive(finding)
            ? new Date(Date.now() - 3_600_000).toISOString()
            : null,
          stillActive: scope.cases.stillActive(finding),
        })),
        nextCursor:
          last && start + pageSize < items.length
            ? encodeCursor(`${last.id}${CURSOR_MARK}${String(mark.length)}`)
            : null,
      });
    }),

    http.get(url('/v1/cases/:id/timeline'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const row = scope.cases.byId(String(params['id']));
      if (!row) return problem(404, 'Caso não encontrado');
      return HttpResponse.json(scope.cases.timeline(row));
    }),

    http.get(url('/v1/findings/:id/triage'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const id = String(params['id']);
      if (!scope.cases.findings.some((finding) => finding.id === id)) {
        return problem(404, 'Alerta não encontrado');
      }
      return HttpResponse.json(scope.triage.ofFinding(id));
    }),

    http.post(url('/v1/cases/:id/split'), async ({ params, request }) => {
      const scope = writable(request);
      if ('error' in scope) return scope.error;
      const row = scope.cases.byId(String(params['id']));
      if (!row) return problem(404, 'Caso não encontrado');
      const parsed = caseSplitSchema.safeParse(await request.json());
      if (!parsed.success) return problem(400, 'Dados inválidos');
      const body = parsed.data;
      const own = scope.cases.findingsOf(row);
      const chosen =
        'group' in body
          ? own.filter((finding) => scope.cases.groupOfFinding.get(finding.id) === body.group)
          : own.filter((finding) => body.findingIds.includes(finding.id));
      if (chosen.length === 0 || ('findingIds' in body && chosen.length !== body.findingIds.length)) {
        return problem(404, 'Alerta não encontrado neste caso');
      }
      if (chosen.length >= own.length) {
        return problem(409, 'O caso precisa ficar com pelo menos um alerta.', CASE_SPLIT_WHOLE_CODE);
      }
      const created = scope.cases.split(
        row,
        new Set(chosen.map((finding) => finding.id)),
        new Date().toISOString(),
      );
      return HttpResponse.json(
        { caseId: created.id, moved: chosen.length, remaining: own.length - chosen.length },
        { status: 201 },
      );
    }),

    http.get(url('/v1/triage-operations'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const parsed = triageOperationListQuerySchema.safeParse(query(request));
      if (!parsed.success) return problem(400, 'Filtro inválido');
      const { page: number, pageSize, ...filter } = parsed.data;
      return page(scope.triage.list(scope.me, filter).map(readOnlyIn(mode)), number, pageSize);
    }),

    http.get(url('/v1/triage-operations/authors'), () => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const since = Date.now() - TRIAGE_AUTHORS_DAYS * 24 * 3_600_000;
      const authors = new Map<string, string>();
      for (const { author, createdAt } of scope.triage.list(scope.me, {})) {
        if (author && Date.parse(createdAt) >= since) authors.set(author.id, author.name);
      }
      return HttpResponse.json({
        items: [...authors].map(([id, name]) => ({ id, name })).slice(0, MAX_TRIAGE_AUTHORS),
        truncated: authors.size > MAX_TRIAGE_AUTHORS,
      });
    }),

    http.get(url('/v1/triage-operations/preview'), ({ request }) => {
      const scope = scoped('findings:triage');
      if ('error' in scope) return scope.error;
      const parsed = triageFilterSchema.safeParse(query(request));
      if (!parsed.success) return problem(400, 'Filtro inválido');
      const rows = scope.cases.matching(parsed.data);
      const pending = rows.flatMap((row) => scope.cases.findingsOf(row)).filter(isPending);
      const tally = (chosen: readonly FindingDetail[]) => {
        const counts = { critical: 0, high: 0, medium: 0, low: 0 };
        for (const finding of chosen) counts[finding.severity] += 1;
        return counts;
      };
      const investigating = pending.filter((finding) => finding.status === 'investigating');
      const fresh = pending.filter((finding) => finding.status === 'new');
      return HttpResponse.json({
        cases: rows.length,
        alerts: pending.length,
        new: fresh.length,
        investigating: investigating.length,
        pending: tally(pending),
        protectedCases: rows.filter((row) => scope.cases.summary(row).protected).length,
        byStatus: { new: tally(fresh), investigating: tally(investigating) },
      });
    }),

    http.get(url('/v1/triage-operations/:id'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const operation = scope.triage.get(scope.me, String(params['id']));
      return operation
        ? HttpResponse.json(readOnlyIn(mode)(operation))
        : problem(404, 'Operação não encontrada');
    }),

    http.post(url('/v1/triage-operations'), async ({ request }) => {
      const scope = writable(request);
      if ('error' in scope) return scope.error;
      const parsed = triageOperationCreateSchema.safeParse(await request.json());
      if (!parsed.success) return problem(400, 'Dados inválidos');
      try {
        const answer = scope.triage.create(scope.me, parsed.data);
        return HttpResponse.json(answer.operation, { status: answer.status });
      } catch (error) {
        return refusal(error);
      }
    }),

    http.post(url('/v1/triage-operations/:id/:action'), async ({ params, request }) => {
      const scope = writable(request);
      if ('error' in scope) return scope.error;
      const id = String(params['id']);
      try {
        switch (params['action']) {
          case 'cancel':
            return HttpResponse.json(scope.triage.cancel(scope.me, id));
          case 'continue':
            return HttpResponse.json(scope.triage.continue(scope.me, id), { status: 202 });
          case 'undo': {
            const parsed = triageUndoSchema.safeParse(await request.json());
            if (!parsed.success) return problem(400, 'Dados inválidos');
            const answer = scope.triage.undo(scope.me, id, parsed.data);
            return HttpResponse.json(answer.operation, { status: answer.status });
          }
          default:
            return problem(404, 'Não encontrado');
        }
      } catch (error) {
        return refusal(error);
      }
    }),
  ];
}

/** Na medição ninguém opera: a operação aparece sem o que fazer com ela. */
const readOnlyIn =
  (mode: CaseMode) =>
  <T extends { can: { cancel: boolean; continue: boolean; undo: boolean } }>(operation: T): T =>
    mode === 'on' ? operation : { ...operation, can: { cancel: false, continue: false, undo: false } };

function summaryOf({
  ruleId: _rule,
  ruleLevel: _level,
  mitreTechniques: _techniques,
  comments: _comments,
  rawEvent: _raw,
  ...item
}: FindingDetail) {
  return item;
}

/** O histórico de quando a demonstração abre: o caso tratado há dias (sem prazo de desfazer) e um de horas atrás. */
function seedHistory({ cases, triage }: World): void {
  const [, ana, joao] = DEMO_ASSIGNEES;
  const treated = cases.cases.find((row) => row.sealReason === 'treated' && row.queue === 'detection');
  if (treated && ana) {
    triage.seed({
      author: ana,
      status: 'legitimate',
      previousStatus: 'new',
      reason: 'Limpeza programada dos grupos de log antigos.',
      ids: [...treated.findingIds],
      target: { kind: 'cases', caseIds: [treated.id], group: null },
      createdAt: Date.now() - 9 * 24 * 3_600_000,
    });
  }
  const resolved = cases.cases.find((row) =>
    row.keyParts.some((part) => part.name === 'package' && part.value === 'zlib'),
  );
  if (resolved && joao) {
    const ids = cases
      .findingsOf(resolved)
      .filter((finding) => finding.status === 'resolved')
      .map((finding) => finding.id);
    triage.seed({
      author: joao,
      status: 'resolved',
      previousStatus: 'new',
      reason: 'Pacote atualizado na imagem base.',
      ids,
      target: { kind: 'findings', count: ids.length },
      createdAt: Date.now() - 5 * 3_600_000,
    });
  }
}
