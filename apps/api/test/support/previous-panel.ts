import {
  awsOnboardingSchema,
  awsSourceDetailsSchema,
  awsSourceSchema,
  findingDetailSchema,
  findingSchema,
  meSchema,
} from '@verax/shared';
import { z } from 'zod';

/**
 * O que um painel da versão 5e53ae48 (antes dos contratos dos logs do ALB) aceita: as listas fechadas de então, congeladas
 * (`packages/shared/src/web-logs-skew.test.ts` confere que o resto dos contratos não mudou).
 */

const { internetFacing: _added, ...previousDetails } = awsSourceDetailsSchema.shape;

const previousSource = awsSourceSchema.extend({
  notes: z.array(
    z.enum([
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
    ]),
  ),
  details: z.strictObject(previousDetails),
});
export const previousOnboardingSchema = awsOnboardingSchema.extend({ sources: z.array(previousSource) });

const previousFindingSource = z.enum([
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
]);
export const previousFindingSchema = findingSchema.extend({ source: previousFindingSource });
export const previousFindingDetailSchema = findingDetailSchema.extend({ source: previousFindingSource });

export const previousMeSchema = meSchema.extend({
  permissions: z.array(
    z.enum([
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
    ]),
  ),
});
