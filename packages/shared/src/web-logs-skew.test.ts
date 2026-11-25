import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AWS_SOURCE_NOTES,
  awsOnboardingSchema,
  awsSourceDetailsSchema,
  awsSourceSchema,
} from './aws-onboarding.js';
import { FINDING_SOURCES, findingDetailSchema, findingListQuerySchema, findingSchema } from './findings.js';
import { PERMISSIONS } from './permissions.js';
import { coverageReportSchema, summaryReportSchema } from './reports.js';
import { meSchema } from './session.js';
import { radarDetectionSchema, radarSectorOf, towerRadarSchema, towerSummarySchema } from './tower.js';

/**
 * A diferença de versão entre o painel e o nó (a aba aberta desde antes da atualização; o painel da Verax e a VM do cliente
 * em versões diferentes): o que a versão 5e53ae48 lê e manda, congelado aqui, contra os contratos de agora.
 *
 * - **Nenhuma resposta ganhou campo.** O que é novo tem rota própria (`web-logs.ts`).
 * - **Painel novo, nó de antes:** toda lista fechada de agora contém a de antes.
 * - **Painel de antes, nó novo:** os valores novos só saem com os ataques web ligados. É o que os testes da API conferem com
 *   estas mesmas listas; aqui fica o que aquele painel faria com cada um (`docs/ARQUITETURA.md`, "Logs de acesso do ALB").
 */

const FINDING_SOURCES_BEFORE = [
  'cloudtrail',
  'guardduty',
  'waf',
  'security_hub',
  'inspector',
  'access_analyzer',
  'vpc_flow',
  'cloudwatch_logs',
  'gcp_audit',
  'cloudflare_audit',
  'cloudflare_waf',
  'wazuh_agent',
];
const NOTES_BEFORE = [
  'aws_cost_guardduty',
  'aws_cost_security_hub',
  'aws_cost_inspector',
  'aws_cost_access_analyzer',
  'aws_cost_new_trail',
  'aws_cost_flow_logs',
  'aws_cost_waf_logging',
  'high_volume',
  'flow_logs_read_together',
  'tag_required',
  'stack_update_required',
  'additional_bucket_required',
  'central_bucket',
  'covered_by_api',
  'covered_by_legacy',
  'recommended',
  'not_security_events',
  'not_collected_yet',
];
const PERMISSIONS_BEFORE = [
  'tenants:read',
  'tenants:write',
  'users:read',
  'users:write',
  'cloud_accounts:read',
  'cloud_accounts:write',
  'cloud_credentials:write',
  'protected_resources:read',
  'protected_resources:write',
  'alert_exceptions:read',
  'alert_exceptions:write',
  'tower:read',
  'reports:read',
  'findings:read',
  'findings:triage',
  'incidents:read',
  'incidents:write',
  'posture:read',
  'assets:read',
  'audit:read',
  'agents:read',
  'agents:enroll',
  'plan:read',
  'notification_preferences:read',
  'notification_preferences:write',
  'escalation_contact:read',
  'escalation_contact:write',
  'plan_history:read',
  'session:switch_tenant',
  'unowned_alerts:read',
];

const keysOf = (schema: z.ZodObject): string[] => Object.keys(schema.shape).sort();
const NOW = '2026-11-24T12:00:00.000Z';
const ID = '018f0000-0000-7000-8000-000000000001';

function finding(source: string) {
  return {
    id: ID,
    accountId: '111111111111',
    occurredAt: NOW,
    severity: 'high',
    status: 'new',
    title: 'Força bruta numa rota de login',
    source,
    eventName: null,
    region: 'sa-east-1',
    resource: 'alb:app/loja/0123456789abcdef',
    actor: { user: null, type: null, accessKeyId: null, ip: '203.0.113.7' },
    mitreTactics: ['Credential Access'],
    incidentId: null,
    commentCount: 0,
  };
}

describe('diferença de versão: o que não mudou', () => {
  it('nenhuma resposta que um painel de antes lê ganhou ou perdeu campo', () => {
    expect(keysOf(awsSourceSchema)).toEqual(
      [
        'authorization',
        'availability',
        'collectFrom',
        'collectable',
        'details',
        'firstSeenAt',
        'health',
        'id',
        'kind',
        'lastSeenAt',
        'loggingState',
        'method',
        'missingSince',
        'name',
        'notes',
        'origin',
        'permission',
        'permissionCheckedAt',
        'permissionDetail',
        'probeRequestedAt',
        'region',
        'resourceId',
        'sensitive',
        'state',
        'stateCode',
        'stateSince',
      ].sort(),
    );
    expect(keysOf(awsOnboardingSchema)).toEqual(
      [
        'checks',
        'cloudAccountId',
        'connect',
        'credentialMode',
        'discovery',
        'discoveryAvailable',
        'infrastructure',
        'sources',
        'state',
        'template',
        'updatedAt',
      ].sort(),
    );
    expect(keysOf(findingSchema)).toEqual(Object.keys(finding('waf')).sort());
    expect(keysOf(findingDetailSchema)).toEqual(
      [
        ...Object.keys(finding('waf')),
        'comments',
        'mitreTechniques',
        'rawEvent',
        'ruleId',
        'ruleLevel',
      ].sort(),
    );
    expect(keysOf(radarDetectionSchema)).toEqual(
      ['id', 'incident', 'occurredAt', 'severity', 'source', 'status', 'title'].sort(),
    );
    // `cases` só vem para quem o pede (`towerQuerySchema`): o painel de antes não pede.
    expect(keysOf(towerSummarySchema)).toEqual(
      [
        'cases',
        'coverage',
        'generatedAt',
        'light',
        'mitre',
        'openIncidents',
        'pendingDecisions',
        'posture',
        'pulse',
        'radar',
        'reasons',
      ].sort(),
    );
    // A fonte nova cai num setor que já existe: as contagens do radar não ganham campo.
    expect(radarSectorOf('alb')).toBe('aws');
    expect(Object.keys(towerRadarSchema.shape.bySector.shape).sort()).toEqual([
      'agents',
      'aws',
      'cloudflare',
      'gcp',
    ]);
  });

  it('nenhuma permissão nova: o painel de antes recusaria a resposta inteira do GET /v1/me', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...PERMISSIONS_BEFORE].sort());
    const before = meSchema.extend({ permissions: z.array(z.enum(PERMISSIONS_BEFORE)) });
    const me = {
      userId: 'u1',
      email: 'admin@example.com',
      role: 'admin_verax',
      tenantId: null,
      activeTenantId: null,
      scopeTenantId: null,
      mfaEnabled: true,
      mustChangePassword: false,
      permissions: Object.keys(PERMISSIONS),
    };
    expect(before.safeParse(me).success).toBe(true);
  });
});

describe('diferença de versão: painel novo com nó de antes', () => {
  it('as listas fechadas de agora contêm as de antes', () => {
    expect(FINDING_SOURCES).toEqual(expect.arrayContaining(FINDING_SOURCES_BEFORE));
    expect(AWS_SOURCE_NOTES).toEqual(expect.arrayContaining(NOTES_BEFORE));
    expect(FINDING_SOURCES.filter((source) => !FINDING_SOURCES_BEFORE.includes(source))).toEqual(['alb']);
    expect(AWS_SOURCE_NOTES.filter((note) => !NOTES_BEFORE.includes(note))).toEqual(['aws_cost_alb_logs']);
    for (const source of FINDING_SOURCES_BEFORE) {
      expect(findingSchema.safeParse(finding(source)).success).toBe(true);
    }
    // O detalhe novo da fonte é opcional: a resposta do nó de antes, sem ele, vale.
    expect(awsSourceDetailsSchema.safeParse({ arn: 'arn:aws:elasticloadbalancing:x' }).success).toBe(true);
  });

  it('o filtro pela fonte nova num nó de antes é um 400, e só quando alguém o escolhe', () => {
    const before = z.strictObject({ source: z.enum(FINDING_SOURCES_BEFORE).optional() });
    expect(before.safeParse({ source: 'alb' }).success).toBe(false);
    expect(before.safeParse({}).success).toBe(true);
    expect(findingListQuerySchema.safeParse({ source: 'alb' }).success).toBe(true);
  });
});

describe('diferença de versão: painel de antes com nó novo', () => {
  const before = findingSchema.extend({ source: z.enum(FINDING_SOURCES_BEFORE) });

  it('a página com um achado do ALB é recusada inteira por ele; as outras, não', () => {
    const page = z.strictObject({ items: z.array(before) });
    expect(page.safeParse({ items: [finding('waf'), finding('cloudtrail')] }).success).toBe(true);
    expect(page.safeParse({ items: [finding('waf'), finding('alb')] }).success).toBe(false);
    expect(findingSchema.safeParse(finding('alb')).success).toBe(true);
  });

  it('o resumo e a cobertura dos relatórios não usam lista fechada: continuam lidos', () => {
    const bySource = [{ source: 'alb', count: 3 }];
    expect(summaryReportSchema.shape.findings.shape.bySource.safeParse(bySource).success).toBe(true);
    const account = {
      provider: 'aws',
      accountId: '111111111111',
      active: true,
      lastEventAt: null,
      findings: 3,
      bySource,
    };
    expect(coverageReportSchema.shape.accounts.safeParse([account]).success).toBe(true);
  });

  it('a nota nova e o detalhe novo da fonte também são recusados: só saem com os ataques web ligados', () => {
    expect(z.array(z.enum(NOTES_BEFORE)).safeParse(['aws_cost_alb_logs']).success).toBe(false);
    const { internetFacing: _added, ...shape } = awsSourceDetailsSchema.shape;
    expect(z.strictObject(shape).safeParse({ internetFacing: true }).success).toBe(false);
    expect(Object.keys(shape)).toHaveLength(Object.keys(awsSourceDetailsSchema.shape).length - 1);
  });
});
