import { randomBytes } from 'node:crypto';
import type { PubsubMessage } from '../../src/gcp/pubsub.client.js';

/**
 * Entradas fictícias da auditoria da GCP, no formato que o sink entrega pelo Pub/Sub (LogEntry em JSON). Projetos,
 * pessoas e IPs são de exemplo (faixas de documentação), nunca dados reais.
 */

export interface AuditEntryOptions {
  project?: string;
  insertId?: string;
  timestamp?: string;
  methodName?: string;
  serviceName?: string;
  resourceName?: string;
  principal?: string;
  callerIp?: string;
  statusCode?: number;
  request?: Record<string, unknown>;
  bindingDeltas?: { action: string; role: string; member: string }[];
  auditConfigDeltas?: { action: string; service: string; logType: string }[];
  resource?: { type: string; labels: Record<string, string> };
  serviceAccountKeyName?: string;
}

export const randomProject = (): string => `projeto-${randomBytes(6).toString('hex')}`;

export function auditEntry(options: AuditEntryOptions = {}): Record<string, unknown> {
  const project = options.project ?? 'projeto-exemplo';
  return {
    insertId: options.insertId ?? randomBytes(6).toString('hex'),
    logName: `projects/${project}/logs/cloudaudit.googleapis.com%2Factivity`,
    timestamp: options.timestamp ?? '2026-11-03T10:00:00.123456789Z',
    receiveTimestamp: '2026-11-03T10:00:01.000000000Z',
    severity: 'NOTICE',
    resource: options.resource ?? { type: 'project', labels: { project_id: project } },
    protoPayload: {
      '@type': 'type.googleapis.com/google.cloud.audit.AuditLog',
      serviceName: options.serviceName ?? 'cloudresourcemanager.googleapis.com',
      methodName: options.methodName ?? 'SetIamPolicy',
      resourceName: options.resourceName ?? `projects/${project}`,
      status: options.statusCode === undefined ? {} : { code: options.statusCode, message: 'negado' },
      authenticationInfo: {
        principalEmail: options.principal ?? 'pessoa@exemplo.com',
        ...(options.serviceAccountKeyName && { serviceAccountKeyName: options.serviceAccountKeyName }),
      },
      requestMetadata: {
        callerIp: options.callerIp ?? '203.0.113.10',
        callerSuppliedUserAgent: 'google-cloud-sdk',
      },
      ...(options.request && { request: options.request }),
      ...((options.bindingDeltas || options.auditConfigDeltas) && {
        serviceData: {
          '@type': 'type.googleapis.com/google.iam.v1.logging.AuditData',
          policyDelta: {
            ...(options.bindingDeltas && { bindingDeltas: options.bindingDeltas }),
            ...(options.auditConfigDeltas && { auditConfigDeltas: options.auditConfigDeltas }),
          },
        },
      }),
    },
  };
}

export const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64');

let sequence = 0;
export function pubsubMessage(entry: unknown, data: string = encode(entry)): PubsubMessage {
  sequence += 1;
  return { ackId: `ack-${sequence}`, data, messageId: `msg-${sequence}` };
}
