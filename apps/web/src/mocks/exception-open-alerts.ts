import {
  alertExceptionOpenPreviewQuerySchema,
  type ExceptionOpenPreview,
  type ExceptionOpenResolution,
  type FindingDetail,
  scopedExceptionPreviewQuerySchema,
  severityWithin,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import type { MockState } from './handlers';

/**
 * Os alertas em aberto que uma exceção nova resolve, na demonstração: a mesma ideia da API (só os em aberto, os de
 * incidente ficam), com a comparação simplificada (o IP só igual, sem faixa). A API tem a regra de verdade.
 */

type Match = (finding: FindingDetail) => boolean;

const url = (path: string): string => `${API_URL}${path}`;
const isOpen = (finding: FindingDetail) => finding.status === 'new' || finding.status === 'investigating';

/** A de usuário, IP ou recurso. */
export const alertMatch =
  (target: { ruleId: string; field: string; value: string }): Match =>
  (finding) =>
    finding.ruleId === target.ruleId &&
    (target.field === 'user'
      ? finding.actor.user === target.value
      : target.field === 'ip'
        ? finding.actor.ip === target.value
        : finding.resource === target.value);

/** A ampla: crítico nunca, até a severidade máxima, o evento e o começo do recurso. */
export const scopedMatch =
  (target: {
    ruleId: string;
    logSource: string;
    accountId: string;
    eventName?: string | undefined;
    resourcePrefix?: string | undefined;
    maxSeverity: 'low' | 'medium' | 'high';
  }): Match =>
  (finding) =>
    finding.ruleId === target.ruleId &&
    finding.source === target.logSource &&
    finding.accountId === target.accountId &&
    severityWithin(finding.severity, target.maxSeverity) &&
    (target.eventName === undefined || finding.eventName === target.eventName) &&
    (target.resourcePrefix === undefined || (finding.resource ?? '').startsWith(target.resourcePrefix));

export function previewOpen(findings: readonly FindingDetail[], match: Match): ExceptionOpenPreview {
  const covered = findings.filter((finding) => isOpen(finding) && match(finding));
  const kept = covered.filter((finding) => finding.incidentId !== null).length;
  return { resolve: covered.length - kept, keptInIncident: kept, complete: true };
}

/** Resolve os em aberto que casam (legítimo, com o comentário) e devolve a contagem. */
export function resolveOpen(
  findings: readonly FindingDetail[],
  match: Match,
  author: { id: string; name: string },
): ExceptionOpenResolution {
  let resolved = 0;
  let keptInIncident = 0;
  for (const finding of findings) {
    if (!isOpen(finding) || !match(finding)) continue;
    if (finding.incidentId !== null) {
      keptInIncident += 1;
      continue;
    }
    finding.status = 'legitimate';
    finding.comments = [
      {
        id: crypto.randomUUID(),
        author,
        body: `Resolvido automaticamente pela exceção criada por ${author.name}.`,
        createdAt: new Date().toISOString(),
      },
      ...finding.comments,
    ];
    finding.commentCount += 1;
    resolved += 1;
  }
  return { resolved, keptInIncident, more: false };
}

/** A resposta com a contagem só para quem a pediu (`openAlerts=true`), como na API. */
export function withOpenAlerts<T extends object>(
  request: Request,
  body: T,
  resolution: ExceptionOpenResolution,
): T | (T & { openAlerts: ExceptionOpenResolution }) {
  return new URL(request.url).searchParams.get('openAlerts') === 'true'
    ? { ...body, openAlerts: resolution }
    : body;
}

/** As prévias e o "resolver os próximos" (na demonstração, a criação já resolve tudo: nada a mais). */
export function createExceptionOpenAlertHandlers(state: MockState, findings: Map<string, FindingDetail[]>) {
  const scope = (permission = 'alert_exceptions:write') => {
    if (!state.me) return null;
    if (!state.me.permissions.some((item) => item === permission)) return null;
    return state.me.scopeTenantId;
  };
  const query = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);
  return [
    http.get(url('/v1/alert-exceptions/open-alerts'), ({ request }) => {
      const tenantId = scope();
      if (!tenantId) return HttpResponse.json({ message: 'Sem permissão' }, { status: 403 });
      const target = alertExceptionOpenPreviewQuerySchema.safeParse(query(request));
      if (!target.success) return HttpResponse.json({ message: 'Dados inválidos' }, { status: 400 });
      return HttpResponse.json(previewOpen(findings.get(tenantId) ?? [], alertMatch(target.data)));
    }),
    http.get(url('/v1/scoped-exceptions/open-alerts'), ({ request }) => {
      const tenantId = scope();
      const role = state.me?.role;
      if (!tenantId || (role !== 'admin_cliente' && role !== 'admin_verax')) {
        return HttpResponse.json({ message: 'Sem permissão' }, { status: 403 });
      }
      const target = scopedExceptionPreviewQuerySchema.safeParse(query(request));
      if (!target.success) return HttpResponse.json({ message: 'Dados inválidos' }, { status: 400 });
      return HttpResponse.json(previewOpen(findings.get(tenantId) ?? [], scopedMatch(target.data)));
    }),
    http.post(url('/v1/:kind/:id/resolve-open'), ({ request }) => {
      if (!scope()) return HttpResponse.json({ message: 'Sem permissão' }, { status: 403 });
      if (request.headers.get('X-CSRF-Token') === null) {
        return HttpResponse.json({ message: 'CSRF', code: 'CSRF_INVALID' }, { status: 403 });
      }
      return HttpResponse.json({ resolved: 0, keptInIncident: 0, more: false });
    }),
  ];
}
