import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  AWS_READER_ROLE_TAGS,
  AWS_READER_TEMPLATE_VERSION,
  awsReaderCapabilitiesTagValue,
  awsReaderUserCommands,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { CredentialRejected, CredentialSourceUnavailable } from '../credentials/credential-check.js';
import { parsePrivateKeys, parsePublicKey } from '../credentials/credential-keys.js';
import { AwsAccessKey, credentialBinding, seal } from '../credentials/credential-vault.js';
import { REDACTED, scrubString } from '../common/logger/sanitize.js';
import type { AwsCheckTarget } from './aws-connection-check.js';
import { AwsAccessKeyCheck, isIamUserArn } from './aws-key-check.js';
import { VaultKeyCredentials } from './vault-key-credentials.js';
import { type AwsCheckClients, WebIdentityAwsConnectionChecker } from './web-identity-checker.js';
import type { AwsReaderCredentials, ReaderSession } from './web-identity.js';
import { TemporaryCredentials } from '../inventory/read-only-session.js';

// Valores fictícios: contas de documentação, chaves geradas na hora no formato da AWS.
const ACCOUNT = '111111111111';
const USER_ARN = `arn:aws:iam::${ACCOUNT}:user/verax/verax-control-reader`;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const awsKeyId = () => `AKIA${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;
const awsSecret = () => randomBytes(30).toString('base64');
const signal = new AbortController().signal;

function awsError(name: string, status = 403): Error {
  const error = Object.assign(new Error(`${name}: detalhe da AWS`), {
    $metadata: { httpStatusCode: status },
  });
  error.name = name;
  return error;
}

type Send = (command: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown>;

describe('conferência da chave colada (API)', () => {
  const stsAnswering = (answer: () => unknown) => {
    const seen: { region: string; keyId: string }[] = [];
    const check = new AwsAccessKeyCheck((region, key) => {
      seen.push({ region, keyId: key.accessKeyId });
      const send: Send = () => {
        try {
          return Promise.resolve(answer());
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      return Promise.resolve({ send } as never);
    });
    return { check, seen };
  };

  it('a chave de um usuário IAM da conta: o sufixo do ID, sem validade', async () => {
    const key = new AwsAccessKey(awsKeyId(), awsSecret());
    const { check, seen } = stsAnswering(() => ({ Account: ACCOUNT, Arn: USER_ARN, UserId: 'AIDAEXEMPLO' }));
    expect(await check.check(key, ACCOUNT)).toEqual({
      keyIdSuffix: key.accessKeyId.slice(-4),
      issuedAt: null,
      expiresAt: null,
    });
    expect(seen).toEqual([{ region: 'us-east-1', keyId: key.accessKeyId }]);
  });

  it.each([
    [
      'de outra conta',
      () => ({ Account: '222222222222', Arn: USER_ARN.replace(ACCOUNT, '222222222222') }),
      'no_account_access',
    ],
    ['do root', () => ({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:root` }), 'wrong_identity'],
    [
      'de uma sessão de papel',
      () => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/x/y` }),
      'wrong_identity',
    ],
    [
      'desconhecida',
      () => {
        throw awsError('InvalidClientTokenId');
      },
      'invalid',
    ],
    [
      'com o segredo errado',
      () => {
        throw awsError('SignatureDoesNotMatch');
      },
      'invalid',
    ],
  ])('a chave %s é recusada', async (_name, answer, reason) => {
    const { check } = stsAnswering(answer);
    await expect(check.check(new AwsAccessKey(awsKeyId(), awsSecret()), ACCOUNT)).rejects.toEqual(
      expect.objectContaining({ reason }),
    );
  });

  it('a AWS fora (5xx, rede ou resposta fora do formato) é indisponibilidade, não recusa', async () => {
    for (const answer of [
      () => {
        throw awsError('InternalFailure', 500);
      },
      () => {
        throw new Error('ECONNRESET');
      },
      () => ({ Conta: ACCOUNT }),
    ]) {
      const { check } = stsAnswering(answer);
      const failure = await check
        .check(new AwsAccessKey(awsKeyId(), awsSecret()), ACCOUNT)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CredentialSourceUnavailable);
      expect(failure).not.toBeInstanceOf(CredentialRejected);
    }
  });

  it('o ARN de usuário IAM: com ou sem caminho, da própria conta; nunca o root, um papel ou outra conta', () => {
    expect(isIamUserArn(USER_ARN, ACCOUNT)).toBe(true);
    expect(isIamUserArn(`arn:aws:iam::${ACCOUNT}:user/leitor`, ACCOUNT)).toBe(true);
    expect(isIamUserArn(`arn:aws-us-gov:iam::${ACCOUNT}:user/leitor`, ACCOUNT)).toBe(true);
    expect(isIamUserArn(`arn:aws:iam::${ACCOUNT}:root`, ACCOUNT)).toBe(false);
    expect(isIamUserArn(`arn:aws:iam::${ACCOUNT}:role/verax/verax-control-reader`, ACCOUNT)).toBe(false);
    expect(isIamUserArn(USER_ARN, '222222222222')).toBe(false);
  });
});

/** O cadastro falso: uma conta AWS com (ou sem) a credencial cifrada, como o Prisma devolveria. */
function fakePrisma(row: () => unknown): PrismaService {
  return { cloudAccount: { findFirst: () => Promise.resolve(row()) } } as unknown as PrismaService;
}

describe('a chave do cofre no worker (VaultKeyCredentials)', () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const publicKey = parsePublicKey(
    Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
    1,
  );
  const keyring = parsePrivateKeys(
    `1:${Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')}`,
    1,
  );
  const account = { id: randomUUID(), tenantId: randomUUID(), accountId: ACCOUNT };
  const sealedKey = (keyId: string, secret: string) =>
    seal(
      publicKey,
      credentialBinding({ ...account, provider: 'aws' }, 'aws_access_key'),
      new AwsAccessKey(keyId, secret),
    ).ciphertext;

  it('abre a chave da conta e a guarda enquanto o texto cifrado for o mesmo; a troca vale na hora', async () => {
    const first = { keyId: awsKeyId(), secret: awsSecret() };
    let ciphertext = sealedKey(first.keyId, first.secret);
    let reads = 0;
    const credentials = new VaultKeyCredentials(
      fakePrisma(() => {
        reads += 1;
        return { ...account, credential: { kind: 'aws_access_key', ciphertext } };
      }),
      keyring,
    );
    const session = await credentials.session(ACCOUNT, 'sa-east-1');
    expect(session).toMatchObject({ stsRegion: 'us-east-1', regionFallback: false, principal: 'iam_user' });
    expect(session.credentials.identity()).toEqual({
      accessKeyId: first.keyId,
      secretAccessKey: first.secret,
    });
    expect(await credentials.session(ACCOUNT, 'sa-east-1')).toBe(session);
    expect(reads).toBe(2);
    // O segredo aberto no worker é ocultado pelo logger, e a sessão não vira texto.
    expect(scrubString(`chave ${first.secret}`)).toBe(`chave ${REDACTED}`);
    expect(JSON.stringify(session)).not.toContain(first.secret);

    const second = { keyId: awsKeyId(), secret: awsSecret() };
    ciphertext = sealedKey(second.keyId, second.secret);
    const provider = credentials.credentialsFor(ACCOUNT, 'sa-east-1');
    expect(await provider()).toEqual({ accessKeyId: second.keyId, secretAccessKey: second.secret });
    // A chave anterior deixou de ser segredo vivo; a nova não.
    expect(scrubString(first.secret)).toBe(first.secret);
    expect(scrubString(second.secret)).toBe(REDACTED);
  });

  it('sem chave, com a de outro tipo, ou com um texto que não abre: key_missing', async () => {
    for (const row of [
      null,
      { ...account, credential: null },
      { ...account, credential: { kind: 'cloudflare_api_token', ciphertext: 'v1:AAAA' } },
      {
        ...account,
        credential: { kind: 'aws_access_key', ciphertext: `v1:${randomBytes(384).toString('base64')}` },
      },
    ]) {
      const credentials = new VaultKeyCredentials(
        fakePrisma(() => row),
        keyring,
      );
      await expect(credentials.session(ACCOUNT, 'sa-east-1')).rejects.toMatchObject({ code: 'key_missing' });
    }
  });
});

describe('a conferência da conexão com a chave do usuário IAM (VM própria)', () => {
  const TRAIL = 'trilha-111111111111';

  function setup({ caller = () => ({ Account: ACCOUNT, Arn: USER_ARN }), egressIps = [] as string[] } = {}) {
    const calls: { command: string; input: Record<string, unknown> }[] = [];
    const forgotten: string[] = [];
    const handlers: Record<string, (input: Record<string, unknown>) => unknown> = {
      GetCallerIdentityCommand: caller,
      ListObjectsV2Command: () => ({ Contents: [{ Key: `AWSLogs/${ACCOUNT}/CloudTrail/objeto.json.gz` }] }),
      GetObjectCommand: () => ({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([31])) },
      }),
      DescribeTrailsCommand: () => ({
        trailList: [{ TrailARN: 'arn:aws:cloudtrail:sa-east-1:1:trail/t', S3BucketName: TRAIL }],
      }),
      GetTrailStatusCommand: () => ({ IsLogging: true }),
      SimulatePrincipalPolicyCommand: () => ({ EvaluationResults: [{ EvalDecision: 'allowed' }] }),
    };
    const client = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ command: command.constructor.name, input: command.input });
        const handler = handlers[command.constructor.name];
        if (handler === undefined) return Promise.reject(awsError('NotSimulated', 400));
        try {
          return Promise.resolve(handler(command.input));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
    const clients = {
      sts: () => client,
      s3: () => client,
      iam: () => client,
      cloudtrail: () => client,
      guardduty: () => client,
    } as unknown as AwsCheckClients;
    const credentials: AwsReaderCredentials = {
      session: (): Promise<ReaderSession> =>
        Promise.resolve({
          credentials: new TemporaryCredentials({ accessKeyId: awsKeyId(), secretAccessKey: awsSecret() }),
          stsRegion: 'us-east-1',
          regionFallback: false,
          principal: 'iam_user',
        }),
      credentialsFor: () => () => Promise.reject(new Error('não usado')),
      forget: (accountId) => forgotten.push(accountId),
    };
    const checker = new WebIdentityAwsConnectionChecker({ credentials, egressIps, clients });
    return { checker, calls, forgotten };
  }

  const target = (overrides: Partial<AwsCheckTarget> = {}): AwsCheckTarget => ({
    cloudAccountId: randomUUID(),
    accountId: ACCOUNT,
    regions: ['sa-east-1'],
    buckets: { cloudtrail: TRAIL, guardduty: null, waf: null },
    daily: false,
    ...overrides,
  });

  it('o usuário IAM da conta conecta, com a leitura do bucket', async () => {
    const { checker, calls } = setup();
    expect(await checker.check(target(), signal)).toEqual({ ok: true, warnings: [] });
    expect(calls.map((call) => call.command)).toEqual([
      'GetCallerIdentityCommand',
      'ListObjectsV2Command',
      'GetObjectCommand',
    ]);
  });

  it('a chave do root (ou de outra conta) é account_mismatch; a recusada pela AWS é key_invalid', async () => {
    for (const [caller, code] of [
      [() => ({ Account: ACCOUNT, Arn: `arn:aws:iam::${ACCOUNT}:root` }), 'account_mismatch'],
      [() => ({ Account: '222222222222', Arn: USER_ARN }), 'account_mismatch'],
      [
        () => {
          throw awsError('InvalidClientTokenId');
        },
        'key_invalid',
      ],
    ] as const) {
      const { checker, forgotten } = setup({ caller });
      expect(await checker.check(target(), signal)).toMatchObject({ ok: false, code, retryable: false });
      expect(forgotten).toEqual([ACCOUNT]);
    }
  });

  it('a simulação diária é no próprio usuário; o IP da VM vai junto só quando o nó o informa', async () => {
    const withoutIp = setup();
    const outcome = await withoutIp.checker.check(target({ daily: true }), signal);
    expect(outcome).toMatchObject({ ok: true, daily: { warnings: ['excess_permissions'] } });
    const simulation = withoutIp.calls.find((call) => call.command === 'SimulatePrincipalPolicyCommand');
    expect(simulation?.input).toMatchObject({ PolicySourceArn: USER_ARN });
    expect(simulation?.input).not.toHaveProperty('ContextEntries');

    const withIp = setup({ egressIps: ['203.0.113.10/32'] });
    await withIp.checker.check(target({ daily: true }), signal);
    expect(
      withIp.calls.find((call) => call.command === 'SimulatePrincipalPolicyCommand')?.input,
    ).toMatchObject({
      PolicySourceArn: USER_ARN,
      ContextEntries: [{ ContextKeyName: 'aws:SourceIp', ContextKeyValues: ['203.0.113.10'] }],
    });
  });
});

describe('as tags do usuário IAM de leitura (VM própria): a versão do template e as capacidades', () => {
  const target: AwsCheckTarget = {
    cloudAccountId: randomUUID(),
    accountId: ACCOUNT,
    regions: ['sa-east-1'],
    buckets: { cloudtrail: null, guardduty: null, waf: null },
    daily: true,
  };

  function setup(GetUserCommand: (input: Record<string, unknown>) => unknown) {
    const calls: { command: string; input: Record<string, unknown> }[] = [];
    const client = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ command: command.constructor.name, input: command.input });
        if (command.constructor.name !== 'GetUserCommand')
          return Promise.reject(awsError('NotSimulated', 400));
        try {
          return Promise.resolve(GetUserCommand(command.input));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    };
    const clients = { iam: () => client } as unknown as AwsCheckClients;
    const credentials: AwsReaderCredentials = {
      session: (): Promise<ReaderSession> =>
        Promise.resolve({
          credentials: new TemporaryCredentials({ accessKeyId: awsKeyId(), secretAccessKey: awsSecret() }),
          stsRegion: 'us-east-1',
          regionFallback: false,
          principal: 'iam_user',
        }),
      credentialsFor: () => () => Promise.reject(new Error('não usado')),
      forget: () => undefined,
    };
    return { checker: new WebIdentityAwsConnectionChecker({ credentials, clients }), calls };
  }

  it('lê as tags com um GetUser no próprio usuário (sem nome: o dono da chave), nunca com GetRole', async () => {
    // As mesmas tags que os comandos do painel põem no usuário de leitura (`awsReaderUserCommands`).
    const template = String(AWS_READER_TEMPLATE_VERSION);
    const granted = awsReaderCapabilitiesTagValue(['findings']);
    const commands = awsReaderUserCommands(ACCOUNT, ['findings']);
    expect(commands).toContain(`Key=${AWS_READER_ROLE_TAGS.template},Value=${template}`);
    expect(commands).toContain(`Key=${AWS_READER_ROLE_TAGS.capabilities},Value=${granted}`);

    const { checker, calls } = setup(() => ({
      User: {
        UserName: 'verax-control-reader',
        Tags: [
          { Key: AWS_READER_ROLE_TAGS.template, Value: template },
          { Key: AWS_READER_ROLE_TAGS.capabilities, Value: granted },
        ],
      },
    }));
    expect(await checker.readerFacts(target, signal)).toEqual({
      templateVersion: AWS_READER_TEMPLATE_VERSION,
      capabilities: ['discovery', 'findings'],
    });
    expect(calls).toEqual([{ command: 'GetUserCommand', input: {} }]);
  });

  it('sem tags, ou com a leitura negada: v1, só a descoberta; uma falha passageira: null', async () => {
    const v1 = { templateVersion: 1, capabilities: ['discovery'] };
    expect(await setup(() => ({ User: { UserName: 'leitor' } })).checker.readerFacts(target, signal)).toEqual(
      v1,
    );
    expect(
      await setup(() => {
        throw awsError('AccessDenied');
      }).checker.readerFacts(target, signal),
    ).toEqual(v1);
    expect(
      await setup(() => {
        throw awsError('Throttling', 400);
      }).checker.readerFacts(target, signal),
    ).toBeNull();
  });
});
