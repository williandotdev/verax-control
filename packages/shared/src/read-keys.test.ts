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
  awsGuardrailsPolicy,
  awsReaderUserArn,
  awsReaderUserCommands,
  awsReaderUserPolicy,
  gcpReaderCommands,
  gcpReaderSubscription,
  type IamPolicy,
} from './read-keys.js';
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
    expect(isGcpPrivateKeyShape(key.replace('\n', '\n\n'))).toBe(false);
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

  it('a leitura é a do papel: as mesmas ações, com a autoinspeção no próprio usuário', () => {
    const user = bySid(awsReaderUserPolicy(values));
    const reader = bySid(role.VeraxControlReader);
    for (const sid of ['ValidarFontes', 'PosturaEAtivos', 'ListarBucketsDeLog', 'LerObjetosDeLog']) {
      expect(user.get(sid)?.Action).toEqual(reader.get(sid)?.Action);
    }
    expect(user.get('AutoInspecao')?.Resource).toBe(awsReaderUserArn('111111111111'));
    expect(awsReaderUserArn('111111111111')).toBe(
      'arn:aws:iam::111111111111:user/verax/verax-control-reader',
    );
    expect(user.get('ListarBucketsDeLog')?.Resource).toEqual([
      'arn:aws:s3:::trilha-111111111111',
      'arn:aws:s3:::guardduty-111111111111',
    ]);
    expect(user.get('DecifrarSoPeloS3')).toMatchObject({
      Resource: 'arn:aws:kms:*:111111111111:key/*',
      Condition: { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } },
    });
    // Nenhuma ação de escrita na leitura.
    const actions = awsReaderUserPolicy(values).Statement.flatMap((statement) => [statement.Action].flat());
    expect(actions.filter((action) => /:(Put|Create|Delete|Update|Attach)/.test(action))).toEqual([]);
  });

  it('sem bucket, nada de S3 nem KMS; as leituras da postura continuam', () => {
    const sids = awsReaderUserPolicy({ ...values, buckets: [] }).Statement.map((statement) => statement.Sid);
    expect(sids).toEqual(['AutoInspecao', 'ValidarFontes', 'PosturaEAtivos']);
  });

  it('as negações são as do papel; a de IP só com o IP da VM', () => {
    const guardrails = bySid(awsGuardrailsPolicy(values));
    const reference = bySid(role.VeraxControlGuardrails);
    for (const sid of ['NuncaAlterarLogs', 'NuncaAmpliarOProprioAcesso']) {
      expect(guardrails.get(sid)?.Action).toEqual(reference.get(sid)?.Action);
    }
    expect(guardrails.get('SoDoNoDaVerax')?.Condition).toEqual({
      NotIpAddress: { 'aws:SourceIp': ['203.0.113.10/32'] },
    });
    for (const egressIps of [[], ['203.0.113.10'], ['203.0.113.10/24']]) {
      expect(bySid(awsGuardrailsPolicy({ egressIps })).has('SoDoNoDaVerax')).toBe(false);
    }
  });

  it('os comandos criam o usuário com o limite de permissões e as duas políticas, e a chave', () => {
    const commands = awsReaderUserCommands('111111111111');
    expect(commands).toContain(
      'aws iam create-user --path /verax/ --user-name verax-control-reader --permissions-boundary arn:aws:iam::111111111111:policy/verax/VeraxControlReader',
    );
    expect(commands).toContain('policy/verax/VeraxControlGuardrails');
    expect(commands).toContain('aws iam create-access-key --user-name verax-control-reader');
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
