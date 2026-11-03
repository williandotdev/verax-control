import { describe, expect, it } from 'vitest';
import { logEntrySchema, parseLogMessage, projectOf } from '../../src/gcp/gcp-log-entry.js';
import {
  detect,
  gcpEventId,
  GCP_RULES,
  severityOfLevel,
  toGcpFindingDraft,
} from '../../src/gcp/gcp-rules.js';
import { auditEntry, type AuditEntryOptions, encode } from './fixtures.js';

const ruleOf = (options: AuditEntryOptions) =>
  detect(logEntrySchema.parse(auditEntry(options)).protoPayload)?.id ?? null;

/** T1234 ou T1234.567, conferido sem regex com grupo opcional. */
function isTechniqueId(value: string): boolean {
  const [base = '', sub] = value.split('.');
  return /^T\d{4}$/.test(base) && (sub === undefined || /^\d{3}$/.test(sub));
}

describe('regras da auditoria da GCP', () => {
  it('IDs únicos na faixa 9901xx, cabendo na coluna da regra, com MITRE e título em português', () => {
    const ids = GCP_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of GCP_RULES) {
      expect(rule.id).toMatch(/^9901\d{2}$/);
      expect(rule.tactics.length).toBeGreaterThan(0);
      expect(rule.techniques.every(isTechniqueId)).toBe(true);
      expect(rule.title.length).toBeLessThanOrEqual(500);
    }
  });

  it.each<[string, AuditEntryOptions, string | null]>([
    [
      'sink do Cloud Logging alterado',
      { serviceName: 'logging.googleapis.com', methodName: 'google.logging.v2.ConfigServiceV2.UpdateSink' },
      '990101',
    ],
    [
      'exclusão criada (esconde logs)',
      { methodName: 'google.logging.v2.ConfigServiceV2.CreateExclusion' },
      '990101',
    ],
    ['log apagado', { methodName: 'google.logging.v2.LoggingServiceV2.DeleteLog' }, '990101'],
    [
      'auditoria de acesso a dados desligada',
      { auditConfigDeltas: [{ action: 'REMOVE', service: 'allServices', logType: 'DATA_READ' }] },
      '990102',
    ],
    [
      'bucket público por delta',
      {
        serviceName: 'storage.googleapis.com',
        methodName: 'storage.setIamPermissions',
        bindingDeltas: [{ action: 'ADD', role: 'roles/storage.objectViewer', member: 'allUsers' }],
      },
      '990103',
    ],
    [
      'serviço público sem delta (política enviada inteira)',
      {
        serviceName: 'run.googleapis.com',
        methodName: 'google.cloud.run.v2.Services.SetIamPolicy',
        request: {
          policy: { bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }] },
        },
      },
      '990103',
    ],
    [
      'dono concedido',
      { bindingDeltas: [{ action: 'ADD', role: 'roles/owner', member: 'user:x@exemplo.com' }] },
      '990104',
    ],
    [
      'editor concedido',
      { bindingDeltas: [{ action: 'ADD', role: 'roles/editor', member: 'user:x@exemplo.com' }] },
      '990105',
    ],
    [
      'papel removido não é suspeito',
      { bindingDeltas: [{ action: 'REMOVE', role: 'roles/owner', member: 'user:x@exemplo.com' }] },
      null,
    ],
    [
      'papel comum concedido não é suspeito',
      { bindingDeltas: [{ action: 'ADD', role: 'roles/viewer', member: 'user:x@exemplo.com' }] },
      null,
    ],
    [
      'chave de conta de serviço criada',
      { methodName: 'google.iam.admin.v1.CreateServiceAccountKey' },
      '990106',
    ],
    ['conta de serviço criada', { methodName: 'google.iam.admin.v1.CreateServiceAccount' }, '990107'],
    [
      'firewall aberto para SSH',
      {
        methodName: 'v1.compute.firewalls.insert',
        request: { sourceRanges: ['0.0.0.0/0'], alloweds: [{ IPProtocol: 'tcp', ports: ['22'] }] },
      },
      '990108',
    ],
    [
      'firewall aberto numa faixa que inclui o RDP',
      {
        methodName: 'v1.compute.firewalls.patch',
        request: { sourceRanges: ['::/0'], alloweds: [{ IPProtocol: 'tcp', ports: ['3000-4000'] }] },
      },
      '990108',
    ],
    [
      'firewall aberto só para HTTPS',
      {
        methodName: 'v1.compute.firewalls.insert',
        request: { sourceRanges: ['0.0.0.0/0'], alloweds: [{ IPProtocol: 'tcp', ports: ['443'] }] },
      },
      '990109',
    ],
    [
      'firewall de saída não conta',
      {
        methodName: 'v1.compute.firewalls.insert',
        request: { direction: 'EGRESS', sourceRanges: ['0.0.0.0/0'], alloweds: [{ IPProtocol: 'all' }] },
      },
      null,
    ],
    [
      'firewall interno não conta',
      {
        methodName: 'v1.compute.firewalls.insert',
        request: { sourceRanges: ['10.0.0.0/8'], alloweds: [{ IPProtocol: 'all' }] },
      },
      null,
    ],
    ['firewall apagado', { methodName: 'v1.compute.firewalls.delete' }, '990110'],
    [
      'chave SSH nos metadados do projeto',
      {
        methodName: 'v1.compute.projects.setCommonInstanceMetadata',
        request: { items: [{ key: 'ssh-keys' }] },
      },
      '990111',
    ],
    [
      'metadados sem chave SSH não contam',
      {
        methodName: 'v1.compute.projects.setCommonInstanceMetadata',
        request: { items: [{ key: 'startup-script' }] },
      },
      null,
    ],
    [
      'chave KMS destruída',
      { methodName: 'google.cloud.kms.v1.KeyManagementService.DestroyCryptoKeyVersion' },
      '990112',
    ],
    ['projeto apagado', { methodName: 'DeleteProject' }, '990113'],
    ['API desativada', { methodName: 'google.api.serviceusage.v1.ServiceUsage.DisableService' }, '990114'],
    [
      'bucket apagado',
      { serviceName: 'storage.googleapis.com', methodName: 'storage.buckets.delete' },
      '990115',
    ],
    ['política da organização alterada', { methodName: 'SetOrgPolicy' }, '990116'],
    [
      'federação de identidade criada',
      { methodName: 'google.iam.v1.WorkloadIdentityPools.CreateWorkloadIdentityPoolProvider' },
      '990117',
    ],
    ['VM criada', { methodName: 'v1.compute.instances.insert' }, '990118'],
    ['acesso negado', { methodName: 'storage.objects.get', statusCode: 7 }, '990119'],
    [
      'acesso negado de agente do Google não conta',
      {
        methodName: 'storage.objects.get',
        statusCode: 7,
        principal: 'service-123456789@gcp-sa-pubsub.iam.gserviceaccount.com',
      },
      null,
    ],
    [
      'mudança que falhou não conta',
      { methodName: 'google.iam.admin.v1.CreateServiceAccountKey', statusCode: 3 },
      null,
    ],
    ['leitura comum não é suspeita', { methodName: 'v1.compute.instances.list' }, null],
  ])('%s', (_case, options, expected) => {
    expect(ruleOf(options)).toBe(expected);
  });

  it('com mais de uma regra, vale a de nível mais alto', () => {
    expect(
      ruleOf({
        bindingDeltas: [
          { action: 'ADD', role: 'roles/editor', member: 'user:x@exemplo.com' },
          { action: 'ADD', role: 'roles/owner', member: 'user:y@exemplo.com' },
        ],
      }),
    ).toBe('990104');
  });

  it('nível vira severidade na mesma escala do Wazuh', () => {
    expect([12, 10, 7, 4].map(severityOfLevel)).toEqual(['critical', 'high', 'medium', 'low']);
  });
});

describe('leitura da mensagem do Pub/Sub', () => {
  it('decodifica a LogEntry e diz o projeto pelo logName', () => {
    const parsed = parseLogMessage(encode(auditEntry({ project: 'projeto-alfa' })));
    expect(parsed).toMatchObject({ ok: true, project: 'projeto-alfa' });
  });

  it('log de organização não tem projeto', () => {
    expect(projectOf({ logName: 'organizations/123/logs/cloudaudit.googleapis.com%2Factivity' })).toBeNull();
  });

  it('mensagem que não é JSON ou fora do formato é inválida, guardando o insertId quando dá', () => {
    expect(parseLogMessage(Buffer.from('não é json').toString('base64'))).toEqual({
      ok: false,
      insertId: null,
    });
    expect(parseLogMessage(undefined)).toEqual({ ok: false, insertId: null });
    expect(parseLogMessage(encode({ insertId: 'abc', logName: 1 }))).toEqual({ ok: false, insertId: 'abc' });
  });

  it('texto grande demais é recusado (entrada externa com limite)', () => {
    const entry = auditEntry({ methodName: 'x'.repeat(300) });
    expect(parseLogMessage(encode(entry)).ok).toBe(false);
  });
});

describe('achado a partir do evento', () => {
  it('quem, de onde, qual chave e qual recurso, com o cliente da assinatura', () => {
    const entry = logEntrySchema.parse(
      auditEntry({
        project: 'projeto-alfa',
        insertId: 'abc123',
        methodName: 'google.iam.admin.v1.CreateServiceAccountKey',
        resourceName: 'projects/-/serviceAccounts/robo@projeto-alfa.iam.gserviceaccount.com',
        principal: 'automacao@projeto-alfa.iam.gserviceaccount.com',
        serviceAccountKeyName:
          '//iam.googleapis.com/projects/projeto-alfa/serviceAccounts/automacao@projeto-alfa.iam.gserviceaccount.com/keys/0f1e2d3c',
        resource: { type: 'service_account', labels: { project_id: 'projeto-alfa', location: 'us-east1' } },
      }),
    );
    const rule = detect(entry.protoPayload);
    expect(rule).not.toBeNull();
    const draft = toGcpFindingDraft(entry, { tenantId: 'cliente-a', project: 'projeto-alfa' }, rule!);
    expect(draft).toEqual({
      tenantId: 'cliente-a',
      accountId: 'projeto-alfa',
      source: 'gcp',
      sourceEventId: 'projeto-alfa/abc123',
      occurredAt: '2026-11-03T10:00:00.123Z',
      severity: 'high',
      ruleId: '990106',
      ruleLevel: 10,
      title: 'Chave de conta de serviço criada',
      logSource: 'gcp_audit',
      eventName: 'google.iam.admin.v1.CreateServiceAccountKey',
      region: 'us-east1',
      resource: 'projects/-/serviceAccounts/robo@projeto-alfa.iam.gserviceaccount.com',
      actorUser: 'automacao@projeto-alfa.iam.gserviceaccount.com',
      actorType: 'service_account',
      accessKeyId: '0f1e2d3c',
      sourceIp: '203.0.113.10',
      mitreTactics: ['Credential Access', 'Persistence'],
      mitreTechniques: ['T1098.001'],
    });
  });

  it('IP que não é IP (a GCP grava "private" para chamadas internas) fica vazio', () => {
    const entry = logEntrySchema.parse(
      auditEntry({ methodName: 'google.iam.admin.v1.CreateServiceAccount', callerIp: 'private' }),
    );
    expect(
      toGcpFindingDraft(entry, { tenantId: 't', project: 'projeto-exemplo' }, GCP_RULES[6]!).sourceIp,
    ).toBeNull();
  });

  it('o ID do evento cabe na chave única do achado', () => {
    expect(gcpEventId('projeto-alfa', 'x'.repeat(300))).toHaveLength(128);
    expect(gcpEventId(null, 'abc')).toBe('-/abc');
  });
});
