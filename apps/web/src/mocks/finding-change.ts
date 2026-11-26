import {
  extractFindingChange,
  FINDING_CHANGE_REPEAT_DAYS,
  type FindingChangeContext,
  findingChangeContextSchema,
  type FindingDetail,
} from '@verax/shared';

/**
 * A alteração dos alertas da trilha na demonstração (`GET /v1/findings/:id/change`): o evento fictício de cada um, no formato
 * em que o Wazuh o grava, passa pela mesma redução da API (`extractFindingChange`). Contas, grupos e buckets de exemplo;
 * endereços das faixas de documentação (RFC 5737). Nenhuma chave de acesso no formato real (a varredura do bundle a barra).
 */

const DEMO_EVENTS: Readonly<Record<string, (finding: FindingDetail) => Record<string, unknown>>> = {
  StopLogging: () => ({
    eventSource: 'cloudtrail.amazonaws.com',
    eventName: 'StopLogging',
    userAgent: 'aws-cli/2.17.0 Python/3.12',
    requestParameters: { name: 'trilha-principal' },
  }),
  CreateAccessKey: () => ({
    eventSource: 'iam.amazonaws.com',
    eventName: 'CreateAccessKey',
    userAgent: 'aws-cli/2.17.0 Python/3.12',
    requestParameters: { userName: 'admin-financeiro' },
  }),
  AttachUserPolicy: () => ({
    eventSource: 'iam.amazonaws.com',
    eventName: 'AttachUserPolicy',
    userAgent: 'aws-cli/2.17.0 Python/3.12',
    requestParameters: { userName: 'suporte-temp', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' },
  }),
  PutBucketPolicy: (finding) => ({
    eventSource: 's3.amazonaws.com',
    eventName: 'PutBucketPolicy',
    userAgent: 'console.amazonaws.com',
    requestParameters: {
      bucketName: finding.resource ?? 'loja-exemplo-imagens',
      bucketPolicy: {
        Statement: [
          { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::x/*' },
        ],
      },
    },
  }),
  AuthorizeSecurityGroupIngress: () => ({
    eventSource: 'ec2.amazonaws.com',
    eventName: 'AuthorizeSecurityGroupIngress',
    userAgent: 'console.amazonaws.com',
    requestParameters: {
      groupId: 'sg-0a1b2c3d4e5f60789',
      ipPermissions: {
        items: [
          { ipProtocol: 'tcp', fromPort: '22', toPort: '22', ipRanges: { items: [{ cidrIp: '0.0.0.0/0' }] } },
          {
            ipProtocol: 'tcp',
            fromPort: '443',
            toPort: '443',
            ipRanges: { items: [{ cidrIp: '0.0.0.0/0' }] },
          },
        ],
      },
    },
  }),
  ConsoleLogin: () => ({
    eventSource: 'signin.amazonaws.com',
    eventName: 'ConsoleLogin',
    userAgent: 'Mozilla/5.0',
    responseElements: { ConsoleLogin: 'Success' },
    additionalEventData: { MFAUsed: 'No' },
  }),
  DeleteDetector: () => ({
    eventSource: 'guardduty.amazonaws.com',
    eventName: 'DeleteDetector',
    userAgent: 'aws-cli/2.17.0 Python/3.12',
    requestParameters: { detectorId: 'd0a1b2c3d4e5f60718293a4b5c6d7e8f' },
  }),
};

export function demoFindingChange(
  finding: FindingDetail,
  all: readonly FindingDetail[],
): FindingChangeContext {
  const event = finding.source === 'cloudtrail' ? DEMO_EVENTS[finding.eventName ?? ''] : undefined;
  const user = finding.actor.user;
  const count =
    user === null
      ? 0
      : all.filter((other) => other.ruleId === finding.ruleId && other.actor.user === user).length;
  return findingChangeContextSchema.parse({
    change: event ? extractFindingChange(event(finding)) : null,
    previous: null,
    repeats: { days: FINDING_CHANGE_REPEAT_DAYS, count },
  });
}
