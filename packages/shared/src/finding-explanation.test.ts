import { describe, expect, it } from 'vitest';
import {
  changeBytes,
  extractFindingChange,
  type FindingChange,
  findingChangeContextSchema,
  findingChangeSchema,
  findingChangeSubject,
  MAX_CHANGE_ADDRESSES,
  MAX_FINDING_CHANGE_BYTES,
} from './finding-change.js';
import {
  describeActor,
  type ExplainableFinding,
  explainFinding,
  permissionText,
} from './finding-explanation.js';

/**
 * Eventos fictícios do CloudTrail, no formato em que o Wazuh os grava em `data.aws` (números e booleanos podem chegar como
 * texto, e a lista de um item como o próprio item). Contas, chaves e endereços são de exemplo (RFC 5737).
 */
const ACCOUNT = '111111111111';
const LAMBDA_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/waf-auto-block-role-x1y2/waf-auto-block`;

function cloudTrail(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    source: 'cloudtrail',
    eventVersion: '1.09',
    eventTime: '2026-11-20T10:00:00Z',
    awsRegion: 'us-east-1',
    recipientAccountId: ACCOUNT,
    sourceIPAddress: '203.0.113.10',
    userAgent: 'aws-cli/2.17.0 Python/3.12',
    userIdentity: { type: 'IAMUser', arn: `arn:aws:iam::${ACCOUNT}:user/ana`, accountId: ACCOUNT },
    ...fields,
  };
}

const lambdaIdentity = {
  userIdentity: { type: 'AssumedRole', arn: LAMBDA_ARN, accountId: ACCOUNT },
  userAgent:
    'Boto3/1.34.0 md/Botocore#1.34.0 ua/2.0 os/linux lang/python#3.12 exec-env/AWS_Lambda_python3.12',
  sourceIPAddress: '198.51.100.20',
};

function updateIpSet(addresses: unknown): Record<string, unknown> {
  return cloudTrail({
    ...lambdaIdentity,
    eventSource: 'wafv2.amazonaws.com',
    eventName: 'UpdateIPSet',
    requestParameters: {
      name: 'blocked-ips',
      scope: 'REGIONAL',
      id: 'a1b2c3d4-5678-90ab-cdef-111111111111',
      description: 'lista mantida pela automação',
      addresses,
      lockToken: 'token-de-concorrencia-ficticio',
    },
  });
}

function finding(change: FindingChange | null, over: Partial<ExplainableFinding> = {}): ExplainableFinding {
  return {
    source: 'cloudtrail',
    ruleId: '100323',
    title: 'Regras do WAF alteradas',
    eventName: change?.eventName ?? null,
    region: 'us-east-1',
    resource: null,
    actor: { user: LAMBDA_ARN, type: 'AssumedRole' },
    ...over,
  };
}

const must = (change: FindingChange | null): FindingChange => {
  if (change === null) throw new Error('alteração esperada');
  return change;
};

describe('extractFindingChange', () => {
  it('guarda o nome, o id, o escopo e os endereços da lista de IPs do WAF, sem o token nem a descrição', () => {
    const change = must(
      extractFindingChange(updateIpSet(['203.0.113.7/32', '198.51.100.0/24', '2001:DB8::1/128'])),
    );
    expect(change).toEqual({
      version: 1,
      eventSource: 'wafv2.amazonaws.com',
      eventName: 'UpdateIPSet',
      via: 'lambda',
      target: {
        kind: 'waf_ip_set',
        id: 'a1b2c3d4-5678-90ab-cdef-111111111111',
        name: 'blocked-ips',
        scope: 'REGIONAL',
      },
      lists: { addresses: { items: ['203.0.113.7/32', '198.51.100.0/24', '2001:db8::1/128'], total: 3 } },
    });
    expect(JSON.stringify(change)).not.toContain('token-de-concorrencia');
    expect(JSON.stringify(change)).not.toContain('automação');
    expect(findingChangeSchema.safeParse(change).success).toBe(true);
  });

  it('aceita a lista de um item só, como o Wazuh a grava, e descarta o que não é endereço', () => {
    const change = must(extractFindingChange(updateIpSet('203.0.113.7/32')));
    expect(change.lists?.['addresses']).toEqual({ items: ['203.0.113.7/32'], total: 1 });
    const mixed = must(extractFindingChange(updateIpSet(['203.0.113.7/32', '<script>', 'a\nb'])));
    expect(mixed.lists?.['addresses']).toEqual({ items: ['203.0.113.7/32'], total: 1 });
  });

  it('corta a lista grande no teto e guarda o total, sem passar do limite de bytes', () => {
    const many = Array.from(
      { length: 1200 },
      (_, index) => `10.${Math.floor(index / 250)}.${index % 250}.1/32`,
    );
    const change = must(extractFindingChange(updateIpSet(many)));
    const addresses = change.lists?.['addresses'];
    expect(addresses?.total).toBe(1200);
    expect(addresses?.items.length).toBeLessThanOrEqual(MAX_CHANGE_ADDRESSES);
    expect(changeBytes(change)).toBeLessThanOrEqual(MAX_FINDING_CHANGE_BYTES);
  });

  it('lê o WAF clássico como operações de incluir e retirar', () => {
    const change = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'waf-regional.amazonaws.com',
          eventName: 'UpdateIPSet',
          requestParameters: {
            iPSetId: 'classic-set-1',
            changeToken: 'abc',
            updates: [
              { action: 'INSERT', iPSetDescriptor: { type: 'IPV4', value: '203.0.113.9/32' } },
              { action: 'DELETE', iPSetDescriptor: { type: 'IPV4', value: '198.51.100.4/32' } },
            ],
          },
        }),
      ),
    );
    expect(change.lists).toEqual({
      added: { items: ['203.0.113.9/32'], total: 1 },
      removed: { items: ['198.51.100.4/32'], total: 1 },
    });
    expect(change.via).toBe('cli');
  });

  it('nunca guarda o documento de política: só o que ele concede', () => {
    const policyDocument = JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*', Sid: 'segredo-nao-deveria-sair' }],
    });
    const change = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'iam.amazonaws.com',
          eventName: 'PutUserPolicy',
          requestParameters: { userName: 'bruno', policyName: 'tudo', policyDocument },
        }),
      ),
    );
    expect(change.values).toEqual({ policyName: 'tudo', grantsEverything: true });
    expect(JSON.stringify(change)).not.toContain('segredo');
  });

  it('nunca guarda a senha nem os dados de inicialização', () => {
    const change = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'iam.amazonaws.com',
          eventName: 'UpdateLoginProfile',
          requestParameters: {
            userName: 'bruno',
            password: 'HIDDEN_DUE_TO_SECURITY_REASONS',
            passwordResetRequired: 'true',
          },
        }),
      ),
    );
    expect(change.values).toEqual({ passwordResetRequired: true });
    expect(JSON.stringify(change)).not.toContain('HIDDEN');
  });

  it('ignora serviço e chamada desconhecidos, e marca a chamada recusada', () => {
    expect(
      extractFindingChange(cloudTrail({ eventSource: 'ec2.amazonaws.com', eventName: 'RunInstances' })),
    ).toBeNull();
    expect(
      extractFindingChange(cloudTrail({ eventSource: 'exemplo.amazonaws.com', eventName: 'X' })),
    ).toBeNull();
    expect(extractFindingChange({ eventSource: 42 })).toBeNull();
    expect(extractFindingChange(null)).toBeNull();
    const failed = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'cloudtrail.amazonaws.com',
          eventName: 'StopLogging',
          errorCode: 'AccessDenied',
          requestParameters: { name: 'trilha-principal' },
        }),
      ),
    );
    expect(failed.failed).toBe(true);
  });

  it('não confunde o IP de origem com um serviço da AWS', () => {
    const viaService = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'kms.amazonaws.com',
          eventName: 'DisableKey',
          userAgent: 'AWS Internal',
          sourceIPAddress: 'cloudformation.amazonaws.com',
          userIdentity: {
            type: 'AssumedRole',
            arn: `arn:aws:sts::${ACCOUNT}:assumed-role/deploy/sessao`,
            invokedBy: 'cloudformation.amazonaws.com',
          },
          requestParameters: { keyId: '1234abcd-12ab-34cd-56ef-111111111111' },
        }),
      ),
    );
    expect(viaService.via).toBe('cloudformation');
    const plain = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'kms.amazonaws.com',
          eventName: 'DisableKey',
          userAgent: 'x',
          requestParameters: { keyId: 'k-1' },
        }),
      ),
    );
    expect(plain.via).toBeUndefined();
    expect(plain.invokedBy).toBeUndefined();
  });

  it('a chave do objeto só existe na lista inteira do WAF v2', () => {
    const v2 = must(extractFindingChange(updateIpSet(['203.0.113.7/32'])));
    expect(findingChangeSubject(v2, 'us-east-1')).toBe(
      'wafv2.amazonaws.com/waf_ip_set/REGIONAL/us-east-1/a1b2c3d4-5678-90ab-cdef-111111111111',
    );
    const sg = must(
      extractFindingChange(
        cloudTrail({
          eventSource: 'ec2.amazonaws.com',
          eventName: 'AuthorizeSecurityGroupIngress',
          requestParameters: { groupId: 'sg-0123456789abcdef0', ipPermissions: { items: [] } },
        }),
      ),
    );
    expect(findingChangeSubject(sg, 'us-east-1')).toBeNull();
  });

  it('o contrato da rota recusa campo a mais', () => {
    const context = { change: null, previous: null, repeats: { days: 30, count: 0 } };
    expect(findingChangeContextSchema.safeParse(context).success).toBe(true);
    expect(findingChangeContextSchema.safeParse({ ...context, extra: 1 }).success).toBe(false);
  });
});

describe('describeActor', () => {
  it('reconhece a função Lambda pelo ambiente de execução', () => {
    expect(describeActor({ user: LAMBDA_ARN, type: 'AssumedRole' }, { via: 'lambda' })).toEqual({
      kind: 'automation',
      text: 'uma automação (função Lambda waf-auto-block)',
    });
  });

  it('separa a conta root, a pessoa do login único, o serviço da AWS e o usuário IAM', () => {
    expect(describeActor({ user: `arn:aws:iam::${ACCOUNT}:root`, type: 'Root' }, null).kind).toBe('root');
    const sso = describeActor(
      {
        user: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSReservedSSO_AdminAccess_0a1b2c3d/carla`,
        type: 'AssumedRole',
      },
      { via: 'console' },
    );
    expect(sso).toEqual({ kind: 'person', text: 'a pessoa carla (login único, permissão AdminAccess)' });
    const service = describeActor(
      { user: `arn:aws:sts::${ACCOUNT}:assumed-role/AWSServiceRoleForConfig/sessao`, type: 'AssumedRole' },
      null,
    );
    expect(service.kind).toBe('service');
    expect(
      describeActor({ user: `arn:aws:iam::${ACCOUNT}:user/ana`, type: 'IAMUser' }, { via: 'console' }),
    ).toEqual({
      kind: 'person',
      text: 'a pessoa com o usuário IAM ana (pelo console)',
    });
    expect(describeActor({ user: null, type: null }, null).kind).toBe('unknown');
  });
});

describe('explainFinding: WAF', () => {
  const current = must(
    extractFindingChange(
      updateIpSet(['203.0.113.7/32', '203.0.113.8/32', '203.0.113.9/32', '198.51.100.1/32']),
    ),
  );
  const before = must(extractFindingChange(updateIpSet(['198.51.100.1/32', '198.51.100.2/32'])));

  it('compara a lista de IPs com o estado anterior conhecido', () => {
    const explanation = explainFinding({
      finding: finding(current),
      change: current,
      previous: { occurredAt: '2026-11-19T10:00:00.000Z', change: before },
      repeats: { count: 1, days: 30 },
      basis: 'stored',
    });
    expect(explanation?.family).toBe('waf');
    expect(explanation?.actor.kind).toBe('automation');
    expect(explanation?.summary).toBe(
      'Uma automação (função Lambda waf-auto-block) alterou a lista de IPs "blocked-ips" (id a1b2c3d4-5678-90ab-cdef-111111111111) do WAF. Incluiu 3 endereços e retirou 1 endereço.',
    );
    expect(explanation?.change).toMatchObject({
      kind: 'diff',
      added: ['203.0.113.7', '203.0.113.8', '203.0.113.9'],
      removed: ['198.51.100.2'],
      previousAt: '2026-11-19T10:00:00.000Z',
    });
    expect(explanation?.facts).toContainEqual({ label: 'Escopo', value: 'Regional' });
    expect(explanation?.suggestion).toBeNull();
  });

  it('sem o estado anterior, diz que ele não está disponível e mostra a lista de agora', () => {
    const explanation = explainFinding({
      finding: finding(current),
      change: current,
      previous: null,
      repeats: null,
      basis: 'raw_event',
    });
    expect(explanation?.change?.kind).toBe('snapshot');
    expect(explanation?.change?.note).toBe(
      'O estado anterior não está disponível (não há alerta anterior deste objeto); a lista agora tem 4 endereços.',
    );
    expect(explanation?.change?.current).toHaveLength(4);
  });

  it('com a lista anterior cortada no teto, não compara', () => {
    const big = { ...before, lists: { addresses: { items: ['198.51.100.1/32'], total: 900 } } };
    const explanation = explainFinding({
      finding: finding(current),
      change: current,
      previous: { occurredAt: '2026-11-19T10:00:00.000Z', change: big },
      repeats: null,
      basis: 'stored',
    });
    expect(explanation?.change?.kind).toBe('snapshot');
    expect(explanation?.change?.note).toContain('grande demais');
  });

  it('a lista igual à anterior aparece como sem mudança', () => {
    const explanation = explainFinding({
      finding: finding(current),
      change: current,
      previous: { occurredAt: '2026-11-19T10:00:00.000Z', change: current },
      repeats: null,
      basis: 'stored',
    });
    expect(explanation?.change?.kind).toBe('unchanged');
  });

  it('sugere a exceção para a automação que repete a mesma mudança', () => {
    const explanation = explainFinding({
      finding: finding(current),
      change: current,
      previous: null,
      repeats: { count: 12, days: 30 },
      basis: 'stored',
    });
    expect(explanation?.suggestion).toContain(
      'Esta mesma automação gerou 12 alertas desta regra nos últimos 30 dias',
    );
    expect(explanation?.suggestion).toContain('"Usuário"');
    // A regra 100323 não aceita a exceção ampla.
    expect(explanation?.suggestion).not.toContain('exceção ampla');
  });

  it('compara as regras da Web ACL por nome e pela ação', () => {
    const rules = (list: unknown) =>
      must(
        extractFindingChange(
          cloudTrail({
            eventSource: 'wafv2.amazonaws.com',
            eventName: 'UpdateWebACL',
            requestParameters: {
              name: 'site-principal',
              scope: 'CLOUDFRONT',
              id: 'acl-0001',
              defaultAction: { Allow: {} },
              rules: list,
              visibilityConfig: { sampledRequestsEnabled: 'true' },
            },
          }),
        ),
      );
    const now = rules([
      { name: 'sqli', priority: '1', action: { Count: {} } },
      { name: 'rate-limit', priority: '2', action: { Block: {} } },
    ]);
    const then = rules([
      { name: 'sqli', priority: '1', action: { Block: {} } },
      { name: 'geo', priority: '3', action: { Block: {} } },
    ]);
    const explanation = explainFinding({
      finding: finding(now),
      change: now,
      previous: { occurredAt: '2026-11-18T10:00:00.000Z', change: then },
      repeats: null,
      basis: 'stored',
    });
    expect(explanation?.summary).toContain(
      'alterou as regras da Web ACL (o conjunto de regras) "site-principal"',
    );
    expect(explanation?.change).toMatchObject({
      kind: 'diff',
      added: ['rate-limit (bloquear)'],
      removed: ['geo (bloquear)'],
      changed: ['sqli: de bloquear para só contar'],
    });
    expect(explanation?.facts).toContainEqual({ label: 'Ação padrão', value: 'permitir' });
  });

  it('sem a alteração (nó de antes, evento fora da retenção), explica pelos campos do alerta', () => {
    const explanation = explainFinding({
      finding: finding(null, { eventName: 'DeleteRuleGroup' }),
      change: null,
      previous: null,
      repeats: null,
      basis: 'fields',
    });
    expect(explanation?.family).toBe('waf');
    expect(explanation?.summary).toContain('apagou');
  });
});

describe('explainFinding: demais famílias', () => {
  const explain = (aws: Record<string, unknown>, over: Partial<ExplainableFinding> = {}) => {
    const change = extractFindingChange(aws);
    const identity = aws['userIdentity'] as { arn?: string; type?: string };
    return explainFinding({
      finding: finding(change, {
        actor: { user: identity.arn ?? null, type: identity.type ?? null },
        ruleId: '100300',
        ...over,
      }),
      change,
      previous: null,
      repeats: null,
      basis: 'stored',
    });
  };

  it('IAM: chave de acesso criada', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'iam.amazonaws.com',
        eventName: 'CreateAccessKey',
        requestParameters: { userName: 'bruno' },
        responseElements: {
          accessKey: { accessKeyId: 'AKIAEXEMPLO000000000', status: 'Active', userName: 'bruno' },
        },
      }),
      { ruleId: '100304' },
    );
    expect(explanation?.family).toBe('iam');
    expect(explanation?.summary).toBe(
      'O usuário IAM ana (por linha de comando ou programa: pode ser uma pessoa ou uma automação) criou uma chave de acesso para o usuário IAM bruno.',
    );
    expect(explanation?.facts).toContainEqual({ label: 'Chave criada', value: 'AKIAEXEMPLO000000000' });
  });

  it('IAM: política de administrador anexada e papel aberto a qualquer conta', () => {
    const attach = explain(
      cloudTrail({
        eventSource: 'iam.amazonaws.com',
        eventName: 'AttachUserPolicy',
        requestParameters: { userName: 'bruno', policyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' },
      }),
    );
    expect(attach?.summary).toContain(
      'deu a política AdministratorAccess ao usuário IAM bruno (acesso de administrador)',
    );
    const trust = explain(
      cloudTrail({
        eventSource: 'iam.amazonaws.com',
        eventName: 'UpdateAssumeRolePolicy',
        requestParameters: {
          roleName: 'parceiro',
          policyDocument: JSON.stringify({
            Statement: { Effect: 'Allow', Principal: { AWS: '*' }, Action: 'sts:AssumeRole' },
          }),
        },
      }),
    );
    expect(trust?.summary).toContain('qualquer conta da AWS assuma o papel');
  });

  it('IAM: usuário criado e senha trocada', () => {
    expect(
      explain(
        cloudTrail({
          eventSource: 'iam.amazonaws.com',
          eventName: 'CreateUser',
          requestParameters: { userName: 'novo' },
        }),
      )?.summary,
    ).toContain('criou o usuário IAM novo');
    expect(
      explain(
        cloudTrail({
          eventSource: 'iam.amazonaws.com',
          eventName: 'UpdateLoginProfile',
          requestParameters: { userName: 'novo', passwordResetRequired: false },
        }),
      )?.summary,
    ).toContain('trocou a senha de console do usuário IAM novo');
  });

  it('grupo de segurança aberto para a internet', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'ec2.amazonaws.com',
        eventName: 'AuthorizeSecurityGroupIngress',
        requestParameters: {
          groupId: 'sg-0123456789abcdef0',
          ipPermissions: {
            items: [
              {
                ipProtocol: 'tcp',
                fromPort: '22',
                toPort: '22',
                ipRanges: { items: [{ cidrIp: '0.0.0.0/0', description: 'x' }] },
              },
            ],
          },
        },
      }),
      { ruleId: '100317' },
    );
    expect(explanation?.family).toBe('security_group');
    expect(explanation?.summary).toContain(
      'liberou entradas no grupo de segurança sg-0123456789abcdef0: TCP porta 22 (SSH, acesso remoto) de qualquer endereço IPv4',
    );
    expect(explanation?.change?.kind).toBe('delta');
    expect(explanation?.check).toContain('limite a faixa');
  });

  it('grupo de segurança pelo ModifySecurityGroupRules, com chaves em maiúscula', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'ec2.amazonaws.com',
        eventName: 'ModifySecurityGroupRules',
        requestParameters: {
          ModifySecurityGroupRulesRequest: {
            GroupId: 'sg-0123456789abcdef0',
            SecurityGroupRule: {
              SecurityGroupRuleId: 'sgr-0123456789abcdef0',
              SecurityGroupRule: { IpProtocol: '-1', CidrIpv4: '0.0.0.0/0' },
            },
          },
        },
      }),
    );
    expect(explanation?.summary).toContain('todo o tráfego de qualquer endereço IPv4');
  });

  it('permissionText', () => {
    expect(permissionText('tcp|1000|2000|10.0.0.0/8')).toBe('TCP portas 1000 a 2000 de 10.0.0.0/8');
    expect(permissionText('udp|||::/0')).toBe(
      'UDP em todas as portas de qualquer endereço IPv6 (::/0, a internet inteira)',
    );
    expect(permissionText('tcp|5432|5432|sg-0abc')).toBe('TCP porta 5432 (PostgreSQL) do grupo sg-0abc');
  });

  it('S3: política pública e bloqueio de acesso público desligado', () => {
    const policy = explain(
      cloudTrail({
        eventSource: 's3.amazonaws.com',
        eventName: 'PutBucketPolicy',
        requestParameters: {
          bucketName: 'cliente-demo-a-arquivos',
          bucketPolicy: {
            Statement: [
              { Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: 'arn:aws:s3:::x/*' },
            ],
          },
        },
      }),
      { ruleId: '100314' },
    );
    expect(policy?.summary).toContain(
      'trocou a política do bucket "cliente-demo-a-arquivos". A nova configuração permite acesso a qualquer pessoa',
    );
    const block = explain(
      cloudTrail({
        eventSource: 's3.amazonaws.com',
        eventName: 'PutBucketPublicAccessBlock',
        requestParameters: {
          bucketName: 'cliente-demo-a-arquivos',
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: 'true',
            IgnorePublicAcls: 'true',
            BlockPublicPolicy: 'false',
            RestrictPublicBuckets: 'false',
          },
        },
      }),
    );
    expect(block?.summary).toContain('Desligou: bloquear políticas públicas e restringir buckets públicos.');
  });

  it('S3: ACL pública', () => {
    const acl = explain(
      cloudTrail({
        eventSource: 's3.amazonaws.com',
        eventName: 'PutBucketAcl',
        requestParameters: { bucketName: 'cliente-demo-b', 'x-amz-acl': ['public-read'] },
      }),
    );
    expect(acl?.summary).toContain('qualquer pessoa na internet');
  });

  it('CloudTrail parado', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'cloudtrail.amazonaws.com',
        eventName: 'StopLogging',
        requestParameters: { name: 'trilha-principal' },
      }),
      { ruleId: '100310' },
    );
    expect(explanation?.summary).toContain('parou o registro da trilha do CloudTrail "trilha-principal"');
    expect(explanation?.why).toContain('sem deixar rastro');
  });

  it('GuardDuty desligado, filtro que arquiva e lista de IPs confiáveis', () => {
    expect(
      explain(
        cloudTrail({
          eventSource: 'guardduty.amazonaws.com',
          eventName: 'UpdateDetector',
          requestParameters: { detectorId: 'd1', enable: 'false' },
        }),
      )?.summary,
    ).toContain('desligou o detector do GuardDuty na região us-east-1');
    expect(
      explain(
        cloudTrail({
          eventSource: 'guardduty.amazonaws.com',
          eventName: 'CreateFilter',
          requestParameters: { detectorId: 'd1', name: 'silencio', action: 'ARCHIVE' },
        }),
      )?.summary,
    ).toContain('arquiva achados automaticamente');
    const trusted = explain(
      cloudTrail({
        eventSource: 'guardduty.amazonaws.com',
        eventName: 'UpdateIPSet',
        requestParameters: {
          detectorId: 'd1',
          ipSetId: 'ips-1',
          name: 'confiaveis',
          location: 'https://s3.amazonaws.com/x/y.txt',
          activate: 'true',
        },
      }),
      { ruleId: '100311' },
    );
    expect(trusted?.family).toBe('guardduty');
    expect(trusted?.why).toContain('invisível para a detecção');
    expect(
      JSON.stringify(
        extractFindingChange(
          cloudTrail({
            eventSource: 'guardduty.amazonaws.com',
            eventName: 'UpdateIPSet',
            requestParameters: { location: 'https://s3.amazonaws.com/x/y.txt' },
          }),
        ),
      ),
    ).not.toContain('s3.amazonaws.com/x');
  });

  it('login da conta root sem MFA', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'signin.amazonaws.com',
        eventName: 'ConsoleLogin',
        userAgent: 'Mozilla/5.0',
        userIdentity: { type: 'Root', arn: `arn:aws:iam::${ACCOUNT}:root` },
        responseElements: { ConsoleLogin: 'Success' },
        additionalEventData: { MFAUsed: 'No' },
      }),
      { ruleId: '100301' },
    );
    expect(explanation?.actor.kind).toBe('root');
    expect(explanation?.summary).toBe(
      'A conta root (o usuário principal da conta AWS) entrou no console da AWS sem MFA (só com a senha).',
    );
  });

  it('KMS: exclusão de chave agendada', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'kms.amazonaws.com',
        eventName: 'ScheduleKeyDeletion',
        requestParameters: { keyId: '1234abcd-12ab-34cd-56ef-111111111111', pendingWindowInDays: '7' },
      }),
      { ruleId: '100324' },
    );
    expect(explanation?.family).toBe('kms');
    expect(explanation?.summary).toContain(
      'agendou a exclusão da chave KMS 1234abcd-12ab-34cd-56ef-111111111111 em 7 dias',
    );
  });

  it('snapshot público', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'ec2.amazonaws.com',
        eventName: 'ModifySnapshotAttribute',
        requestParameters: {
          snapshotId: 'snap-0123456789abcdef0',
          createVolumePermission: { add: { items: [{ group: 'all' }] } },
        },
      }),
      { ruleId: '100319' },
    );
    expect(explanation?.summary).toContain('tornou público o snapshot de disco snap-0123456789abcdef0');
  });

  it('achado do GuardDuty', () => {
    const explanation = explainFinding({
      finding: {
        source: 'guardduty',
        ruleId: '80301',
        title: 'Achado do GuardDuty',
        eventName: 'UnauthorizedAccess:EC2/SSHBruteForce',
        region: 'us-east-1',
        resource: 'ec2:i-0123456789abcdef0',
        actor: { user: null, type: null },
      },
      change: null,
      previous: null,
      repeats: null,
      basis: 'fields',
    });
    expect(explanation?.summary).toBe(
      'O GuardDuty (a detecção de ameaças da própria AWS) apontou acesso não autorizado envolvendo um servidor EC2 (ec2:i-0123456789abcdef0).',
    );
  });

  it('chamada recusada pela AWS', () => {
    const explanation = explain(
      cloudTrail({
        eventSource: 'cloudtrail.amazonaws.com',
        eventName: 'DeleteTrail',
        errorCode: 'AccessDenied',
        requestParameters: { name: 'trilha-principal' },
      }),
    );
    expect(explanation?.failed).toBe(true);
    expect(explanation?.check).toContain('recusou a chamada');
  });

  it('alerta que não é de mudança na conta fica sem explicação', () => {
    expect(
      explainFinding({
        finding: { ...finding(null), source: 'wazuh_agent', ruleId: '5710', eventName: 'sshd' },
        change: null,
        previous: null,
        repeats: null,
        basis: 'fields',
      }),
    ).toBeNull();
  });

  it('evento da trilha sem família conhecida tem a explicação genérica', () => {
    const explanation = explainFinding({
      finding: {
        ...finding(null),
        ruleId: '100324',
        eventName: 'PutAlternateContact',
        actor: { user: `arn:aws:iam::${ACCOUNT}:root`, type: 'Root' },
      },
      change: null,
      previous: null,
      repeats: null,
      basis: 'fields',
    });
    expect(explanation?.family).toBe('generic');
    expect(explanation?.summary).toContain('fez a chamada PutAlternateContact');
  });
});
