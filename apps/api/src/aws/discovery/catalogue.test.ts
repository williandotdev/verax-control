import { awsSourceDetailsSchema } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  analyzerSource,
  awsLogsPrefix,
  type CatalogueContext,
  cleanPrefix,
  configSource,
  detectorSources,
  type FlowLogFact,
  flowLogGroup,
  flowLogSource,
  inspectorSource,
  isDefaultFlowLogFormat,
  loadBalancerSource,
  logGroupCategory,
  type LogGroupFact,
  logGroupSource,
  NOT_ENABLED_KINDS,
  notEnabledSource,
  parseLogGroupArn,
  parseS3Destination,
  securityHubSource,
  type TrailFact,
  trailSource,
  type WebAclFact,
  webAclLogGroup,
  webAclSource,
} from './catalogue.js';

const ACCOUNT = '111111111111';
const context: CatalogueContext = {
  accountId: ACCOUNT,
  legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
  capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
};

function trail(overrides: Partial<TrailFact> = {}): TrailFact {
  return {
    arn: `arn:aws:cloudtrail:sa-east-1:${ACCOUNT}:trail/principal`,
    name: 'principal',
    homeRegion: 'sa-east-1',
    bucket: `trilha-${ACCOUNT}`,
    keyPrefix: null,
    multiRegion: true,
    organizationTrail: false,
    kmsKeyId: null,
    logGroupArn: null,
    logging: true,
    managementEvents: true,
    ...overrides,
  };
}

function flow(overrides: Partial<FlowLogFact> = {}): FlowLogFact {
  return {
    id: 'fl-0aaa0000000000001',
    attachedTo: 'vpc-0aaa0000000000001',
    trafficType: 'ALL',
    destinationType: 's3',
    destination: `arn:aws:s3:::rede-${ACCOUNT}`,
    logGroupName: null,
    logFormat: null,
    fileFormat: 'plain-text',
    hivePartitions: false,
    ...overrides,
  };
}

function acl(overrides: Partial<WebAclFact> = {}): WebAclFact {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'loja',
    arn: `arn:aws:wafv2:sa-east-1:${ACCOUNT}:regional/webacl/loja/11111111-2222-3333-4444-555555555555`,
    scope: 'REGIONAL',
    destinations: [`arn:aws:s3:::aws-waf-logs-${ACCOUNT}`],
    ...overrides,
  };
}

function group(overrides: Partial<LogGroupFact> = {}): LogGroupFact {
  return {
    name: '/app/api',
    arn: `arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:/app/api`,
    storedBytes: 1024,
    retentionDays: 30,
    kmsKeyId: null,
    tagged: false,
    ...overrides,
  };
}

describe('caminhos no S3', () => {
  it('o prefixo exato de cada serviço, no padrão da AWS, com a barra no fim', () => {
    expect(
      awsLogsPrefix({ customPrefix: null, accountId: ACCOUNT, service: 'CloudTrail', region: 'sa-east-1' }),
    ).toBe(`AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`);
    expect(
      awsLogsPrefix({
        customPrefix: 'auditoria/prod',
        organizationId: 'o-abcde12345',
        accountId: ACCOUNT,
        service: 'CloudTrail',
        region: 'us-east-1',
      }),
    ).toBe(`auditoria/prod/AWSLogs/o-abcde12345/${ACCOUNT}/CloudTrail/us-east-1/`);
  });

  it('o destino no S3 vira bucket e prefixo; o que não é um bucket é recusado', () => {
    expect(parseS3Destination('arn:aws:s3:::rede-logs')).toEqual({ bucket: 'rede-logs', customPrefix: null });
    expect(parseS3Destination('arn:aws:s3:::rede-logs/')).toEqual({
      bucket: 'rede-logs',
      customPrefix: null,
    });
    expect(parseS3Destination('arn:aws:s3:::rede-logs/vpc/prod/')).toEqual({
      bucket: 'rede-logs',
      customPrefix: 'vpc/prod',
    });
    expect(parseS3Destination('arn:aws-us-gov:s3:::rede-logs')).toEqual({
      bucket: 'rede-logs',
      customPrefix: null,
    });
    for (const value of [
      null,
      'rede-logs',
      'arn:aws:firehose:sa-east-1:111111111111:deliverystream/aws-waf-logs-x',
      'arn:aws:s3:::Bucket_Invalido',
      'arn:aws:s3:::',
    ]) {
      expect(parseS3Destination(value)).toBeNull();
    }
    expect(cleanPrefix('/a/b/')).toBe('a/b');
    expect(cleanPrefix('///')).toBeNull();
    expect(cleanPrefix('')).toBeNull();
    expect(cleanPrefix(null)).toBeNull();
  });

  it('o ARN de um grupo de logs vira região e nome, com ou sem o :* do fim', () => {
    expect(parseLogGroupArn(`arn:aws:logs:us-east-1:${ACCOUNT}:log-group:aws-waf-logs-loja:*`)).toEqual({
      region: 'us-east-1',
      name: 'aws-waf-logs-loja',
    });
    expect(parseLogGroupArn(`arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:/aws/vpc/fluxo`)).toEqual({
      region: 'sa-east-1',
      name: '/aws/vpc/fluxo',
    });
    expect(parseLogGroupArn('arn:aws:s3:::bucket')).toBeNull();
    expect(parseLogGroupArn(null)).toBeNull();
  });
});

describe('CloudTrail', () => {
  it('a trilha comum: disponível, gravando, no caminho da conta', () => {
    const source = trailSource(trail({ kmsKeyId: `arn:aws:kms:sa-east-1:${ACCOUNT}:key/k1` }), context);
    expect(source).toMatchObject({
      kind: 'cloudtrail',
      region: 'sa-east-1',
      resourceId: `arn:aws:cloudtrail:sa-east-1:${ACCOUNT}:trail/principal`,
      name: 'principal',
      availability: 'available',
      loggingState: 'logging',
      notes: [],
      permission: 'unknown',
      details: {
        bucket: `trilha-${ACCOUNT}`,
        prefix: `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`,
        destinationType: 's3',
        multiRegion: true,
        organizationTrail: false,
        managementEvents: true,
        kmsKeyArn: `arn:aws:kms:sa-east-1:${ACCOUNT}:key/k1`,
      },
    });
    expect(awsSourceDetailsSchema.safeParse(source?.details).success).toBe(true);
    expect(source?.details.customPrefix).toBeUndefined();
  });

  it('parada, sem o status lido, com a chave por apelido (que não é um ARN)', () => {
    expect(trailSource(trail({ logging: false }), context)?.loggingState).toBe('stopped');
    expect(trailSource(trail({ logging: null, managementEvents: null }), context)).toMatchObject({
      loggingState: null,
    });
    expect(trailSource(trail({ kmsKeyId: 'alias/trilha' }), context)?.details.kmsKeyArn).toBeUndefined();
  });

  it('trilha de organização: o bucket é de outra conta (a nota), e o ID da organização fica para a sondagem', () => {
    const source = trailSource(trail({ organizationTrail: true }), context);
    expect(source?.notes).toEqual(['central_bucket']);
    expect(source?.details).toMatchObject({
      organizationTrail: true,
      prefix: `AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`,
    });
    expect(source?.details.organizationId).toBeUndefined();
  });

  it('prefixo antes de AWSLogs: precisa do bucket nos adicionais, a não ser que ele já seja do cadastro', () => {
    const custom = trailSource(trail({ keyPrefix: 'auditoria/' }), context);
    expect(custom?.notes).toEqual(['additional_bucket_required']);
    expect(custom?.details).toMatchObject({
      customPrefix: 'auditoria',
      prefix: `auditoria/AWSLogs/${ACCOUNT}/CloudTrail/sa-east-1/`,
    });
    const legacy = trailSource(trail({ keyPrefix: 'auditoria/' }), {
      ...context,
      legacyBuckets: { cloudtrail: `trilha-${ACCOUNT}`, guardduty: null, waf: null },
    });
    // O bucket do cadastro é lido inteiro pela pilha; e a mesma trilha já é coletada por ele.
    expect(legacy?.notes).toEqual(['covered_by_legacy']);
  });

  it('o bucket do cadastro só cobre o mesmo tipo de log', () => {
    const other = trailSource(trail(), {
      ...context,
      legacyBuckets: { cloudtrail: null, guardduty: `trilha-${ACCOUNT}`, waf: null },
    });
    expect(other?.notes).toEqual([]);
  });

  it('a trilha sem bucket (só para o CloudWatch Logs) não vira fonte de S3', () => {
    expect(trailSource(trail({ bucket: null }), context)).toBeNull();
    expect(trailSource(trail({ bucket: 'Bucket_Invalido' }), context)).toBeNull();
  });
});

describe('VPC Flow Logs', () => {
  it('o formato padrão: os 14 campos na ordem, com ou sem ${}', () => {
    expect(isDefaultFlowLogFormat(null)).toBe(true);
    expect(
      isDefaultFlowLogFormat(
        '${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status}',
      ),
    ).toBe(true);
    expect(
      isDefaultFlowLogFormat(
        '${version} ${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${start} ${end} ${action} ${log-status} ${vpc-id}',
      ),
    ).toBe(false);
    expect(isDefaultFlowLogFormat('${srcaddr} ${dstaddr}')).toBe(false);
  });

  it('no S3, em texto e no formato padrão: disponível, com o aviso de volume', () => {
    const source = flowLogSource(flow(), 'sa-east-1', context);
    expect(source).toMatchObject({
      kind: 'vpc_flow_logs',
      region: 'sa-east-1',
      resourceId: 'fl-0aaa0000000000001',
      availability: 'available',
      notes: ['high_volume'],
      details: {
        flowLogId: 'fl-0aaa0000000000001',
        attachedTo: 'vpc-0aaa0000000000001',
        bucket: `rede-${ACCOUNT}`,
        prefix: `AWSLogs/${ACCOUNT}/vpcflowlogs/sa-east-1/`,
        fileFormat: 'plain-text',
        hivePartitions: false,
        customFormat: false,
      },
    });
    expect(awsSourceDetailsSchema.safeParse(source?.details).success).toBe(true);
  });

  it('partições do Hive, Parquet ou campos fora do padrão: formato que o nó não lê', () => {
    expect(flowLogSource(flow({ hivePartitions: true }), 'sa-east-1', context)).toMatchObject({
      availability: 'unsupported_format',
      details: { hivePartitions: true },
    });
    expect(flowLogSource(flow({ fileFormat: 'parquet' }), 'sa-east-1', context)).toMatchObject({
      availability: 'unsupported_format',
      details: { fileFormat: 'parquet' },
    });
    expect(
      flowLogSource(flow({ logFormat: '${version} ${srcaddr} ${dstaddr}' }), 'sa-east-1', context),
    ).toMatchObject({ availability: 'unsupported_format', details: { customFormat: true } });
  });

  it('para o CloudWatch Logs: não vira fonte de S3, e o grupo é oferecido como grupo de logs', () => {
    const toLogs = flow({
      destinationType: 'cloud-watch-logs',
      destination: null,
      logGroupName: '/aws/vpc/fluxo',
    });
    expect(flowLogSource(toLogs, 'sa-east-1', context)).toBeNull();
    expect(flowLogGroup(toLogs)).toBe('/aws/vpc/fluxo');
    expect(flowLogGroup(flow())).toBeNull();
  });

  it('para o Firehose: destino que o nó não lê', () => {
    const firehose = `arn:aws:firehose:sa-east-1:${ACCOUNT}:deliverystream/fluxo`;
    expect(
      flowLogSource(
        flow({ destinationType: 'kinesis-data-firehose', destination: firehose }),
        'sa-east-1',
        context,
      ),
    ).toMatchObject({
      availability: 'unsupported_destination',
      details: { destinationType: 'firehose', destination: firehose },
    });
  });

  it('com prefixo antes de AWSLogs: precisa do bucket nos adicionais', () => {
    const source = flowLogSource(
      flow({ destination: `arn:aws:s3:::rede-${ACCOUNT}/vpc/` }),
      'sa-east-1',
      context,
    );
    expect(source?.notes).toEqual(['high_volume', 'additional_bucket_required']);
    expect(source?.details.prefix).toBe(`vpc/AWSLogs/${ACCOUNT}/vpcflowlogs/sa-east-1/`);
  });
});

describe('WAF', () => {
  it('para o S3: uma fonte por Web ACL, no caminho com a região e o nome dela', () => {
    const source = webAclSource(acl(), 'sa-east-1', context);
    expect(source).toMatchObject({
      kind: 'waf',
      region: 'sa-east-1',
      resourceId: '11111111-2222-3333-4444-555555555555',
      name: 'loja',
      availability: 'available',
      loggingState: 'logging',
      details: {
        webAclName: 'loja',
        webAclScope: 'REGIONAL',
        bucket: `aws-waf-logs-${ACCOUNT}`,
        // O caminho que o Wazuh lista (derivado do código dele): fixado aqui.
        prefix: `AWSLogs/${ACCOUNT}/WAFLogs/sa-east-1/loja/`,
      },
    });
    expect(awsSourceDetailsSchema.safeParse(source?.details).success).toBe(true);
  });

  it('do CloudFront: região global, e o caminho com "cloudfront" no lugar da região', () => {
    const source = webAclSource(
      acl({
        scope: 'CLOUDFRONT',
        name: 'site',
        arn: `arn:aws:wafv2:us-east-1:${ACCOUNT}:global/webacl/site/x`,
      }),
      'us-east-1',
      context,
    );
    expect(source).toMatchObject({
      region: 'global',
      details: { webAclScope: 'CLOUDFRONT', prefix: `AWSLogs/${ACCOUNT}/WAFLogs/cloudfront/site/` },
    });
  });

  it('sem logging: sem destino, com o aviso de que ligar tem custo', () => {
    expect(webAclSource(acl({ destinations: [] }), 'sa-east-1', context)).toMatchObject({
      availability: 'no_destination',
      loggingState: 'disabled',
      notes: ['aws_cost_waf_logging'],
      details: { destinationType: 'none' },
    });
  });

  it('para o Firehose: destino que o nó não lê', () => {
    const firehose = `arn:aws:firehose:sa-east-1:${ACCOUNT}:deliverystream/aws-waf-logs-loja`;
    expect(webAclSource(acl({ destinations: [firehose] }), 'sa-east-1', context)).toMatchObject({
      availability: 'unsupported_destination',
      details: { destinationType: 'firehose', destination: firehose },
    });
  });

  it('para o CloudWatch Logs: não vira fonte de S3, e o grupo é oferecido como grupo de logs', () => {
    const toLogs = acl({ destinations: [`arn:aws:logs:sa-east-1:${ACCOUNT}:log-group:aws-waf-logs-loja`] });
    expect(webAclSource(toLogs, 'sa-east-1', context)).toBeNull();
    expect(webAclLogGroup(toLogs)).toEqual({ region: 'sa-east-1', name: 'aws-waf-logs-loja' });
    expect(webAclLogGroup(acl())).toBeNull();
  });

  it('o bucket do WAF do cadastro: a mesma fonte já é coletada por ele', () => {
    const source = webAclSource(acl(), 'sa-east-1', {
      ...context,
      legacyBuckets: { cloudtrail: null, guardduty: null, waf: `aws-waf-logs-${ACCOUNT}` },
    });
    expect(source?.notes).toEqual(['covered_by_legacy']);
  });
});

describe('GuardDuty', () => {
  const destination = {
    id: 'dest0000000000000000000000000001',
    arn: `arn:aws:s3:::achados-${ACCOUNT}`,
    kmsKeyArn: `arn:aws:kms:sa-east-1:${ACCOUNT}:key/k1`,
    status: 'PUBLISHING',
  };

  it('o detector ligado: a API é a forma recomendada; o export fica como alternativa, coberto pela API', () => {
    const sources = detectorSources(
      { id: 'det1', enabled: true, destinations: [destination] },
      'sa-east-1',
      context,
    );
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      kind: 'guardduty',
      region: 'sa-east-1',
      resourceId: 'det1',
      availability: 'available',
      loggingState: 'enabled',
      notes: ['recommended'],
      details: { detectorId: 'det1' },
    });
    expect(sources[1]).toMatchObject({
      kind: 'guardduty_export',
      resourceId: 'dest0000000000000000000000000001',
      availability: 'available',
      loggingState: 'publishing',
      notes: ['covered_by_api'],
      details: {
        detectorId: 'det1',
        bucket: `achados-${ACCOUNT}`,
        prefix: `AWSLogs/${ACCOUNT}/GuardDuty/sa-east-1/`,
        kmsKeyArn: `arn:aws:kms:sa-east-1:${ACCOUNT}:key/k1`,
      },
    });
  });

  it('sem a capacidade de achados (ou sem saber), o export não é marcado como coberto', () => {
    for (const capabilities of [['discovery', 'service-logs'] as const, null]) {
      const [, exported] = detectorSources(
        { id: 'det1', enabled: true, destinations: [destination] },
        'sa-east-1',
        {
          ...context,
          capabilities,
        },
      );
      expect(exported?.notes).toEqual([]);
    }
  });

  it('o detector desligado: não habilitado, com o aviso de custo; o export parado', () => {
    const [api, exported] = detectorSources(
      { id: 'det1', enabled: false, destinations: [{ ...destination, status: 'STOPPED' }] },
      'sa-east-1',
      context,
    );
    expect(api).toMatchObject({
      availability: 'not_enabled',
      loggingState: 'disabled',
      notes: ['aws_cost_guardduty'],
    });
    expect(exported?.loggingState).toBe('stopped');
  });

  it('o detector que não pôde ser lido entra sem o estado; o destino sem ARN de bucket fica de fora', () => {
    const sources = detectorSources(
      { id: 'det1', enabled: null, destinations: [{ ...destination, arn: null }] },
      'sa-east-1',
      context,
    );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ availability: 'available', loggingState: null });
  });
});

describe('Security Hub, Inspector e Access Analyzer', () => {
  it('uma fonte por região (e por analisador), pela API', () => {
    expect(
      securityHubSource('sa-east-1', `arn:aws:securityhub:sa-east-1:${ACCOUNT}:hub/default`),
    ).toMatchObject({
      kind: 'security_hub',
      region: 'sa-east-1',
      resourceId: 'hub',
      availability: 'available',
      details: { arn: `arn:aws:securityhub:sa-east-1:${ACCOUNT}:hub/default` },
    });
    expect(securityHubSource('sa-east-1', null).details).toEqual({});
    expect(inspectorSource('us-east-1')).toMatchObject({
      kind: 'inspector',
      region: 'us-east-1',
      resourceId: 'account',
    });
    expect(
      analyzerSource(
        {
          name: 'externo',
          arn: `arn:aws:access-analyzer:sa-east-1:${ACCOUNT}:analyzer/externo`,
          type: 'ACCOUNT',
        },
        'sa-east-1',
      ),
    ).toMatchObject({
      kind: 'access_analyzer',
      resourceId: 'externo',
      details: { analyzerType: 'ACCOUNT' },
    });
  });

  it('o serviço desligado na conta inteira: uma linha global por tipo, com o aviso de custo de ligar', () => {
    const notes = Object.fromEntries(
      NOT_ENABLED_KINDS.map((kind) => [kind, notEnabledSource(kind, ['us-east-1', 'sa-east-1']).notes]),
    );
    expect(notes).toEqual({
      cloudtrail: ['aws_cost_new_trail'],
      vpc_flow_logs: ['aws_cost_flow_logs'],
      guardduty: ['aws_cost_guardduty'],
      security_hub: ['aws_cost_security_hub'],
      inspector: ['aws_cost_inspector'],
      access_analyzer: ['aws_cost_access_analyzer'],
    });
    expect(notEnabledSource('guardduty', ['us-east-1', 'sa-east-1'])).toMatchObject({
      region: 'global',
      resourceId: 'none',
      availability: 'not_enabled',
      loggingState: 'disabled',
      details: { regionsChecked: ['sa-east-1', 'us-east-1'] },
    });
  });
});

describe('grupos do CloudWatch Logs', () => {
  it('a categoria sai do nome (os padrões da AWS); as métricas não são eventos de segurança', () => {
    expect(
      Object.fromEntries(
        [
          '/aws/rds/instance/banco/error',
          '/aws/apigateway/welcome',
          'API-Gateway-Execution-Logs_abc/prod',
          '/aws/route53/exemplo.com.br',
          '/aws/lambda/funcao',
          '/aws/eks/cluster/cluster',
          '/aws/amplify/app',
          'aws-waf-logs-loja',
          '/aws/ecs/containerinsights/cluster/performance',
          '/aws/lambda-insights',
          'RDSOSMetrics',
          '/app/api',
        ].map((name) => [name, logGroupCategory(name)]),
      ),
    ).toEqual({
      '/aws/rds/instance/banco/error': 'rds',
      '/aws/apigateway/welcome': 'api_gateway',
      'API-Gateway-Execution-Logs_abc/prod': 'api_gateway',
      '/aws/route53/exemplo.com.br': 'route53',
      '/aws/lambda/funcao': 'lambda',
      '/aws/eks/cluster/cluster': 'eks',
      '/aws/amplify/app': 'amplify',
      'aws-waf-logs-loja': 'waf',
      '/aws/ecs/containerinsights/cluster/performance': 'metrics',
      '/aws/lambda-insights': 'metrics',
      RDSOSMetrics: 'metrics',
      '/app/api': 'other',
    });
  });

  it('sem a tag: precisa dela; com a tag: sem a nota; as tags não lidas: a nota fica', () => {
    const untagged = logGroupSource(group(), 'sa-east-1');
    expect(untagged).toMatchObject({
      kind: 'cloudwatch_log_group',
      region: 'sa-east-1',
      resourceId: '/app/api',
      availability: 'available',
      notes: ['tag_required'],
      details: {
        logGroup: '/app/api',
        storedBytes: 1024,
        retentionDays: 30,
        category: 'other',
        tagged: false,
        destinationType: 'cloudwatch',
      },
    });
    expect(awsSourceDetailsSchema.safeParse(untagged.details).success).toBe(true);
    expect(logGroupSource(group({ tagged: true }), 'sa-east-1')).toMatchObject({
      notes: [],
      details: { tagged: true },
    });
    const unread = logGroupSource(group({ tagged: null }), 'sa-east-1');
    expect(unread.notes).toEqual(['tag_required']);
    expect(unread.details.tagged).toBeUndefined();
  });

  it('volume alto: mais de 1 GiB por dia, 50 GiB sem retenção, ou os flow logs', () => {
    const gib = 1024 ** 3;
    expect(
      logGroupSource(group({ tagged: true, storedBytes: 31 * gib, retentionDays: 30 }), 'sa-east-1').notes,
    ).toEqual(['high_volume']);
    expect(
      logGroupSource(group({ tagged: true, storedBytes: 29 * gib, retentionDays: 30 }), 'sa-east-1').notes,
    ).toEqual([]);
    expect(
      logGroupSource(group({ tagged: true, storedBytes: 50 * gib, retentionDays: null }), 'sa-east-1').notes,
    ).toEqual(['high_volume']);
    expect(logGroupSource(group({ tagged: true }), 'sa-east-1', 'vpc_flow_logs')).toMatchObject({
      notes: ['high_volume'],
      details: { category: 'vpc_flow_logs' },
    });
  });

  it('quem grava no grupo decide a categoria, antes do nome', () => {
    expect(logGroupSource(group({ name: '/app/api' }), 'sa-east-1', 'cloudtrail').details.category).toBe(
      'cloudtrail',
    );
    expect(logGroupSource(group({ name: 'RDSOSMetrics' }), 'sa-east-1').notes).toEqual([
      'tag_required',
      'not_security_events',
    ]);
  });
});

describe('descobertos, ainda não coletados', () => {
  it('o Config gravando, com o bucket do canal de entrega', () => {
    const source = configSource(
      { name: 'default', recording: true, bucket: 'config-central', keyPrefix: null },
      'sa-east-1',
      context,
    );
    expect(source).toMatchObject({
      kind: 'config',
      availability: 'available',
      loggingState: 'logging',
      notes: ['not_collected_yet'],
      details: { recording: true, bucket: 'config-central', prefix: `AWSLogs/${ACCOUNT}/Config/sa-east-1/` },
    });
    expect(
      configSource(
        { name: 'default', recording: false, bucket: 'config-central', keyPrefix: null },
        'sa-east-1',
        context,
      ),
    ).toMatchObject({ availability: 'not_enabled', loggingState: 'stopped' });
    expect(
      configSource({ name: 'default', recording: true, bucket: null, keyPrefix: null }, 'sa-east-1', context),
    ).toMatchObject({ availability: 'no_destination' });
  });

  it('o load balancer só vira fonte com o log de acesso ligado', () => {
    const balancer = {
      name: 'loja',
      arn: `arn:aws:elasticloadbalancing:sa-east-1:${ACCOUNT}:loadbalancer/app/loja/abc`,
      internetFacing: true,
    };
    expect(loadBalancerSource({ ...balancer, accessLogs: null }, 'sa-east-1', context)).toBeNull();
    expect(loadBalancerSource({ ...balancer, accessLogs: undefined }, 'sa-east-1', context)).toBeNull();
    expect(
      loadBalancerSource(
        { ...balancer, accessLogs: { bucket: 'acessos', prefix: 'alb' } },
        'sa-east-1',
        context,
      ),
    ).toMatchObject({
      kind: 'elb_logs',
      resourceId: 'loja',
      notes: ['not_collected_yet'],
      details: {
        bucket: 'acessos',
        customPrefix: 'alb',
        prefix: `alb/AWSLogs/${ACCOUNT}/elasticloadbalancing/sa-east-1/`,
      },
    });
  });
});
