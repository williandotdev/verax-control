import { describe, expect, it } from 'vitest';
import {
  cloudAccountCreateSchema,
  cloudAccountRefSchema,
  cloudAccountSchema,
  cloudAccountUpdateSchema,
  fieldsOutsideProvider,
  GCP_SINK_LOG_FILTER,
  gcpSinkCommand,
  gcpSinkIdentityCommand,
  isAwsRegion,
  isDomainName,
  isPubsubSubscriptionName,
  normalizeSinkWriterIdentity,
  qualifyPubsubSubscription,
  readOnlyRoleArn,
  sinkWriterIdentitySchema,
} from './cloud-accounts.js';

describe('contas cloud (T3.3)', () => {
  it.each(['sa-east-1', 'us-east-1', 'ap-southeast-4', 'us-gov-west-1', 'us-isob-east-1'])(
    'região válida: %s',
    (region) => {
      expect(isAwsRegion(region)).toBe(true);
    },
  );

  it.each(['marte-1', 'sa-east', 'SA-EAST-1', 'sa-east-10', 'us-xyz-west-1', 'sa--1', 'a-east-1'])(
    'região inválida: %s',
    (region) => {
      expect(isAwsRegion(region)).toBe(false);
    },
  );

  it('o papel de leitura é sempre o do conector, na conta informada', () => {
    expect(readOnlyRoleArn('123456789012')).toBe('arn:aws:iam::123456789012:role/VeraxControlReadOnly');
  });

  it.each([
    ['bucket com maiúscula', { cloudtrail: 'Trilha' }],
    ['bucket com formato de IP', { cloudtrail: '192.168.0.1' }],
    ['bucket com pontos seguidos', { cloudtrail: 'trilha..logs' }],
    ['WAF sem o prefixo da AWS', { waf: 'logs-waf' }],
  ])('recusa %s', (_label, buckets) => {
    const result = cloudAccountCreateSchema.safeParse({
      provider: 'aws',
      accountId: '123456789012',
      regions: ['sa-east-1'],
      buckets,
    });
    expect(result.success).toBe(false);
  });
});

describe('estado da conexão (T7.3 e fase 2)', () => {
  const account = {
    id: '018f2c1e-0000-7000-8000-0000000c0001',
    provider: 'aws',
    accountId: '111122223333',
    regions: ['sa-east-1'],
    roleArn: readOnlyRoleArn('111122223333'),
    externalId: null,
    buckets: { cloudtrail: null, guardduty: null, waf: null },
    pubsubSubscription: null,
    sinkTopic: null,
    sinkWriterIdentity: null,
    zones: [],
    status: 'active',
    connection: 'waiting',
    connectionError: null,
    lastCollectedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

  it('aguardando, conectada (com a última coleta) ou com erro (com o tipo)', () => {
    expect(cloudAccountSchema.safeParse(account).success).toBe(true);
    expect(
      cloudAccountSchema.safeParse({
        ...account,
        connection: 'connected',
        lastCollectedAt: '2026-11-02T12:01:00.000Z',
        lastEventAt: '2026-11-02T12:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      cloudAccountSchema.safeParse({ ...account, connection: 'error', connectionError: 'AccessDenied' })
        .success,
    ).toBe(true);
    expect(cloudAccountSchema.safeParse({ ...account, connection: 'talvez' }).success).toBe(false);
  });

  it('a conexão é obrigatória, e o erro é só o tipo: nada de mensagem', () => {
    const { connection: _connection, ...withoutConnection } = account;
    expect(cloudAccountSchema.safeParse(withoutConnection).success).toBe(false);
    expect(
      cloudAccountSchema.safeParse({
        ...account,
        connection: 'error',
        connectionError: 'Pub/Sub pull respondeu 403 em projects/x',
      }).success,
    ).toBe(false);
    expect(
      cloudAccountSchema.safeParse({ ...account, connection: 'error', connectionError: 'x'.repeat(65) })
        .success,
    ).toBe(false);
  });
});

describe('provedores: AWS, GCP e Cloudflare', () => {
  const CLOUDFLARE_ID = '0123456789abcdef0123456789abcdef';

  it('cada provedor com o próprio formato de ID e os próprios campos', () => {
    expect(cloudAccountCreateSchema.safeParse({ provider: 'gcp', accountId: 'verax-prod-123' }).success).toBe(
      true,
    );
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        pubsubSubscription: 'projects/verax-prod-123/subscriptions/verax-soc-logs',
      }).success,
    ).toBe(true);
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'cloudflare',
        accountId: CLOUDFLARE_ID,
        zones: ['exemplo.com.br', 'api.exemplo.com.br'],
      }).success,
    ).toBe(true);
  });

  it.each([
    ['projeto da GCP com ID de conta AWS', { provider: 'gcp', accountId: '123456789012' }],
    ['projeto da GCP começando com número', { provider: 'gcp', accountId: '1verax-prod' }],
    ['projeto da GCP terminando em hífen', { provider: 'gcp', accountId: 'verax-prod-' }],
    ['projeto da GCP curto demais', { provider: 'gcp', accountId: 'vx-1' }],
    ['projeto da GCP com maiúscula', { provider: 'gcp', accountId: 'Verax-prod' }],
    ['Cloudflare com 31 caracteres', { provider: 'cloudflare', accountId: CLOUDFLARE_ID.slice(1) }],
    ['Cloudflare com maiúsculas', { provider: 'cloudflare', accountId: CLOUDFLARE_ID.toUpperCase() }],
    ['AWS com ID de projeto', { provider: 'aws', accountId: 'verax-prod-123', regions: ['sa-east-1'] }],
    ['provedor desconhecido', { provider: 'azure', accountId: 'verax-prod-123' }],
  ])('recusa %s', (_label, input) => {
    expect(cloudAccountCreateSchema.safeParse(input).success).toBe(false);
  });

  it('campos de outro provedor são recusados no cadastro, inclusive credencial', () => {
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        regions: ['sa-east-1'],
      }).success,
    ).toBe(false);
    expect(
      cloudAccountCreateSchema.safeParse({ provider: 'cloudflare', accountId: CLOUDFLARE_ID, apiToken: 'x' })
        .success,
    ).toBe(false);
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        credentialsJson: '{}',
      }).success,
    ).toBe(false);
  });

  it.each([
    'verax-logs',
    'projects/verax-prod-123/subscriptions/goog-logs',
    'projects/verax-prod-123/subscriptions/a',
    'projects/verax-prod-123/subscriptions/1logs',
    'projects/verax-prod-123/subscriptions/logs com espaço',
    'projects/verax-prod-123/subscriptions/logs/../x',
    'projects/123456789012/subscriptions/verax-logs',
    'projects/verax-prod-123/topics/verax-logs',
    'organizations/verax-prod-123/subscriptions/verax-logs',
  ])('assinatura do Pub/Sub inválida: %s', (name) => {
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'verax-prod-123',
        pubsubSubscription: name,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['exemplo.com.br', true],
    ['xn--exmplo-dva.com', true],
    ['localhost', false],
    ['Exemplo.com', false],
    ['-exemplo.com', false],
    ['exemplo..com', false],
    ['https://exemplo.com', false],
    [`${'a'.repeat(64)}.com`, false],
  ])('domínio %s: %s', (name, valid) => {
    expect(isDomainName(name)).toBe(valid);
  });

  it('o ID da assinatura vira o nome completo no projeto da conta; o nome completo fica como está', () => {
    expect(qualifyPubsubSubscription('verax-prod-123', ' verax-logs ')).toBe(
      'projects/verax-prod-123/subscriptions/verax-logs',
    );
    expect(
      qualifyPubsubSubscription('verax-prod-123', 'projects/verax-logs-hub/subscriptions/verax-logs'),
    ).toBe('projects/verax-logs-hub/subscriptions/verax-logs');
    expect(isPubsubSubscriptionName(qualifyPubsubSubscription('verax-prod-123', 'verax-logs'))).toBe(true);
  });

  it('zona repetida é recusada', () => {
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'cloudflare',
        accountId: CLOUDFLARE_ID,
        zones: ['exemplo.com.br', 'exemplo.com.br'],
      }).success,
    ).toBe(false);
  });

  it('a referência de conta aceita os três formatos, e nada além deles', () => {
    for (const id of ['123456789012', 'verax-prod-123', CLOUDFLARE_ID]) {
      expect(cloudAccountRefSchema.safeParse(id).success).toBe(true);
    }
    for (const id of ['12345', 'Verax', `${CLOUDFLARE_ID}0`, "x' OR 1=1"]) {
      expect(cloudAccountRefSchema.safeParse(id).success).toBe(false);
    }
  });

  it('a alteração aponta os campos que não existem no provedor da conta', () => {
    const update = cloudAccountUpdateSchema.parse({ regions: ['sa-east-1'], zones: ['exemplo.com.br'] });
    expect(fieldsOutsideProvider('aws', update)).toEqual(['zones']);
    expect(fieldsOutsideProvider('gcp', update)).toEqual(['regions', 'zones']);
    expect(fieldsOutsideProvider('cloudflare', update)).toEqual(['regions']);
    expect(fieldsOutsideProvider('gcp', cloudAccountUpdateSchema.parse({ status: 'inactive' }))).toEqual([]);
  });
});

describe('projeto GCP de cliente (fase 2, PR-05)', () => {
  const IDENTITY = 'serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com';

  it('a identidade do sink é o agente do Cloud Logging do projeto, na forma completa', () => {
    expect(sinkWriterIdentitySchema.safeParse(IDENTITY).success).toBe(true);
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'gcp',
        accountId: 'cliente-prod-123',
        sinkWriterIdentity: IDENTITY,
      }).success,
    ).toBe(true);
    expect(cloudAccountUpdateSchema.safeParse({ sinkWriterIdentity: IDENTITY }).success).toBe(true);
  });

  it.each([
    // A identidade compartilhada antiga serve a sinks de qualquer projeto.
    ['identidade compartilhada antiga', 'serviceAccount:cloud-logs@system.gserviceaccount.com'],
    ['conta de serviço comum', 'serviceAccount:coletor@cliente-prod-123.iam.gserviceaccount.com'],
    // Sinks de pasta e de organização, e o formato dos sinks de antes de 2023: não são o sink deste projeto.
    ['agente de pasta', 'serviceAccount:service-folder-123456789012@gcp-sa-logging.iam.gserviceaccount.com'],
    [
      'agente de organização',
      'serviceAccount:service-org-123456789012@gcp-sa-logging.iam.gserviceaccount.com',
    ],
    ['sink antigo', 'serviceAccount:p123456789012-123456@gcp-sa-logging.iam.gserviceaccount.com'],
    ['pessoa', 'user:alguem@example.com'],
    ['grupo', 'group:todos@example.com'],
    ['sem o tipo', 'service-123456789012@gcp-sa-logging.iam.gserviceaccount.com'],
    ['com maiúscula', 'serviceAccount:Service-123456789012@gcp-sa-logging.iam.gserviceaccount.com'],
    [
      'domínio parecido',
      'serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com.example',
    ],
    ['com o resto do aviso do gcloud', `${IDENTITY} the Pub/Sub Publisher role`],
    ['vazia', ''],
    ['longa demais', `serviceAccount:service-${'1'.repeat(120)}@gcp-sa-logging.iam.gserviceaccount.com`],
  ])('identidade do sink recusada: %s', (_label, identity) => {
    expect(sinkWriterIdentitySchema.safeParse(identity).success).toBe(false);
    expect(cloudAccountUpdateSchema.safeParse({ sinkWriterIdentity: identity }).success).toBe(false);
  });

  it('a identidade só existe na GCP; null apaga', () => {
    const update = cloudAccountUpdateSchema.parse({ sinkWriterIdentity: IDENTITY });
    expect(fieldsOutsideProvider('gcp', update)).toEqual([]);
    expect(fieldsOutsideProvider('aws', update)).toEqual(['sinkWriterIdentity']);
    expect(fieldsOutsideProvider('cloudflare', update)).toEqual(['sinkWriterIdentity']);
    expect(cloudAccountUpdateSchema.parse({ sinkWriterIdentity: null })).toEqual({
      sinkWriterIdentity: null,
    });
    expect(
      cloudAccountCreateSchema.safeParse({
        provider: 'aws',
        accountId: '123456789012',
        regions: ['sa-east-1'],
        sinkWriterIdentity: IDENTITY,
      }).success,
    ).toBe(false);
  });

  it('a identidade como o gcloud mostra (entre crases) ou só o e-mail vira a forma completa', () => {
    expect(normalizeSinkWriterIdentity(` \`${IDENTITY}\` `)).toBe(IDENTITY);
    expect(normalizeSinkWriterIdentity(`"${IDENTITY}"`)).toBe(IDENTITY);
    expect(normalizeSinkWriterIdentity('service-123456789012@gcp-sa-logging.iam.gserviceaccount.com')).toBe(
      IDENTITY,
    );
    // Outro tipo fica como está, e o schema recusa.
    expect(normalizeSinkWriterIdentity('user:alguem@example.com')).toBe('user:alguem@example.com');
  });

  it('o comando cria só o sink no projeto do cliente, com o filtro de segurança, apontando para o tópico do nó', () => {
    const topic = 'projects/nos-exemplo/topics/verax-c1-security-cliente-prod-123';
    const command = gcpSinkCommand('cliente-prod-123', topic);
    const lines = command.split('\n');
    expect(lines[0]).toBe(
      `gcloud logging sinks create verax-control-security pubsub.googleapis.com/${topic} \\`,
    );
    expect(lines[1]).toBe('  --project=cliente-prod-123 \\');
    expect(command).toContain(`--log-filter='${GCP_SINK_LOG_FILTER}'`);
    // As linhas continuam até o filtro; o filtro (entre aspas simples) não tem aspa simples nem a exclusão do nó.
    expect(lines.slice(0, 3).every((line) => line.endsWith(' \\'))).toBe(true);
    expect(GCP_SINK_LOG_FILTER).not.toContain("'");
    expect(GCP_SINK_LOG_FILTER).not.toContain('NOT');
    expect(command).not.toMatch(/add-iam-policy-binding|roles\//);
    expect(gcpSinkIdentityCommand('cliente-prod-123')).toBe(
      "gcloud logging sinks describe verax-control-security --project=cliente-prod-123 --format='value(writerIdentity)'",
    );
  });
});
