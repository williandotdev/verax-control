import {
  coverageReport,
  entitiesReport,
  exceptionsReport,
  type FindingDetail,
  incidentsReport,
  mitreReport,
  mitreTactics,
  REPORT_KINDS,
  reportQuerySchema,
  type ReportFinding,
  type ReportIncident,
  reportWindow,
  rulesReport,
  summaryReport,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import type { AdminStore } from './admin';
import type { MockState } from './handlers';
import { type IncidentState, incidentSummaries } from './incidents-handlers';

const url = (path: string): string => `${API_URL}${path}`;
const MINUTE = 60_000;

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

/**
 * Achados e incidentes do cliente no formato que os relatórios calculam, a partir do mesmo estado das outras telas:
 * triar um achado ou resolver um incidente na demonstração muda os relatórios também. Como as fixtures não guardam
 * quando cada um foi triado ou resolvido, a demonstração usa tempos fixos e plausíveis.
 */
export function reportInputs(
  tenantId: string,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState>,
  now: Date = new Date(),
): { findings: ReportFinding[]; incidents: ReportIncident[] } {
  const later = (at: string, minutes: number) =>
    new Date(Math.min(Date.parse(at) + minutes * MINUTE, now.getTime())).toISOString();
  return {
    findings: (findings.get(tenantId) ?? []).map((finding) => ({
      occurredAt: finding.occurredAt,
      createdAt: finding.occurredAt,
      triagedAt: finding.status === 'new' ? null : later(finding.occurredAt, 42),
      severity: finding.severity,
      status: finding.status,
      source: finding.source,
      ruleId: finding.ruleId,
      title: finding.title,
      accountId: finding.accountId,
      actorUser: finding.actor.user,
      accessKeyId: finding.actor.accessKeyId,
      sourceIp: finding.actor.ip,
      resource: finding.resource,
      mitreTactics: finding.mitreTactics,
      mitreTechniques: finding.mitreTechniques,
      incidentId: finding.incidentId,
      exceptionId: null,
    })),
    incidents: incidentSummaries(tenantId, findings, incidents).map((incident) => ({
      id: incident.id,
      severity: incident.severity,
      status: incident.status,
      riskScore: incident.riskScore,
      firstSeenAt: incident.firstSeenAt,
      createdAt: incident.firstSeenAt,
      resolvedAt: incident.status === 'resolved' ? later(incident.lastSeenAt, 3 * 60) : null,
      assignee: incident.assignee,
      mitreTactics: incident.mitreTactics,
    })),
  };
}

/** O resumo MITRE da Torre na demonstração: os últimos 30 dias, como a API calcula. */
export function demoMitre(
  tenantId: string,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState>,
  now: Date = new Date(),
) {
  const from = new Date(now.getTime() - 30 * 24 * 60 * MINUTE).toISOString();
  const inputs = reportInputs(tenantId, findings, incidents, now);
  return {
    periodDays: 30,
    tactics: mitreTactics(
      inputs.findings.filter((finding) => finding.occurredAt >= from),
      inputs.incidents.filter((incident) => incident.firstSeenAt >= from),
    ),
  };
}

/** Relatórios do modo mock, com o mesmo contrato e o mesmo cálculo da API. */
export function createReportHandlers(
  state: MockState,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState>,
  admin: AdminStore,
) {
  return [
    http.get(url('/v1/reports/:kind'), ({ params, request }) => {
      if (!state.me) return problem(401, 'Não autenticado');
      const tenantId = state.me.scopeTenantId;
      if (!tenantId) return problem(400, 'Escolha um cliente', 'TENANT_REQUIRED');
      const kind = REPORT_KINDS.find((value) => value === params['kind']);
      const query = reportQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!kind || !query.success) return problem(400, 'Relatório inválido');

      const now = new Date();
      const window = reportWindow(query.data.period, now);
      const inputs = reportInputs(tenantId, findings, incidents, now);
      switch (kind) {
        case 'summary':
          return HttpResponse.json(summaryReport(inputs.findings, inputs.incidents, window));
        case 'mitre':
          return HttpResponse.json(mitreReport(inputs.findings, inputs.incidents, window));
        case 'rules':
          return HttpResponse.json(rulesReport(inputs.findings, window));
        case 'entities':
          return HttpResponse.json(entitiesReport(inputs.findings, window));
        case 'incidents':
          return HttpResponse.json(incidentsReport(inputs.incidents, window));
        case 'coverage':
          return HttpResponse.json(
            coverageReport(
              (admin.accounts.get(tenantId) ?? []).map((account) => ({
                provider: account.provider,
                accountId: account.accountId,
                active: account.status === 'active',
                lastEventAt: account.lastEventAt ?? null,
              })),
              inputs.findings,
              window,
            ),
          );
        case 'exceptions':
          return HttpResponse.json(
            exceptionsReport(
              (admin.exceptions.get(tenantId) ?? []).map((exception) => ({
                id: exception.id,
                ruleId: exception.ruleId,
                field: exception.field,
                value: exception.value,
                reason: exception.reason,
                expiresAt: exception.expiresAt,
                matchedCount: exception.matchedCount,
                lastMatchedAt: exception.lastMatchedAt,
              })),
              inputs.findings,
              window,
            ),
          );
      }
    }),
  ];
}
