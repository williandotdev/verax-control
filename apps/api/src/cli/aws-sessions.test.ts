import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parsePrivateKeys, parsePublicKey } from '../credentials/credential-keys.js';
import { AwsAccessKey, credentialBinding, seal } from '../credentials/credential-vault.js';
import type { Prisma } from '../generated/prisma/client.js';
import { awsSessions, type SessionSts, WAZUH_SESSION_SECONDS } from './aws-sessions.js';

// Chaves geradas na hora, no formato da AWS: nenhuma credencial real no repositório. Contas de documentação.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const keyId = (prefix: string) =>
  `${prefix}${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;
const secret = () => randomBytes(30).toString('base64');

const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
const publicKey = parsePublicKey(
  Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64'),
  1,
);
const keyring = parsePrivateKeys(
  `1:${Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64')}`,
  1,
);

interface Account {
  id: string;
  tenantId: string;
  accountId: string;
  credential: { kind: string; ciphertext: string } | null;
}

function account(accountId: string, key?: AwsAccessKey): Account {
  const row = { id: randomUUID(), tenantId: randomUUID(), accountId };
  return {
    ...row,
    credential:
      key === undefined
        ? null
        : {
            kind: 'aws_access_key',
            ciphertext: seal(publicKey, credentialBinding({ ...row, provider: 'aws' }, 'aws_access_key'), key)
              .ciphertext,
          },
  };
}

/** O banco falso: a lista do manager e a busca da credencial de cada conta. */
function fakeDb(accounts: Account[]): Prisma.TransactionClient {
  return {
    cloudAccount: {
      findMany: () => Promise.resolve(accounts.map(({ credential: _credential, ...row }) => row)),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(accounts.find((candidate) => candidate.id === where.id) ?? null),
    },
  } as unknown as Prisma.TransactionClient;
}

describe('as sessões do Wazuh na VM própria (CLI aws-sessions)', () => {
  it('uma sessão de 1 hora por conta, no formato do credentials; só a sessão sai, nunca a chave', async () => {
    const keyA = new AwsAccessKey(keyId('AKIA'), secret());
    const keyB = new AwsAccessKey(keyId('AKIA'), secret());
    const used: string[] = [];
    const sessions = new Map<string, { id: string; secret: string; token: string }>();
    const sts: SessionSts = (key) => {
      used.push(key.accessKeyId);
      const session = { id: keyId('ASIA'), secret: secret(), token: randomBytes(200).toString('base64') };
      sessions.set(key.accessKeyId, session);
      return Promise.resolve({
        send: (command: { input: { DurationSeconds?: number } }) => {
          expect(command.input.DurationSeconds).toBe(WAZUH_SESSION_SECONDS);
          return Promise.resolve({
            Credentials: {
              AccessKeyId: session.id,
              SecretAccessKey: session.secret,
              SessionToken: session.token,
              Expiration: new Date(),
            },
          });
        },
      } as never);
    };
    const report = await awsSessions(
      fakeDb([account('111111111111', keyA), account('222222222222', keyB), account('333333333333')]),
      keyring,
      sts,
    );
    expect(report).toMatchObject({ accounts: 3, written: 2, skipped: { key_missing: 1 } });
    expect(used).toEqual([keyA.accessKeyId, keyB.accessKeyId]);
    const a = sessions.get(keyA.accessKeyId);
    expect(report.content.split('\n').slice(0, 4)).toEqual([
      '[verax-111111111111]',
      `aws_access_key_id = ${a?.id}`,
      `aws_secret_access_key = ${a?.secret}`,
      `aws_session_token = ${a?.token}`,
    ]);
    expect(report.content).toContain('[verax-222222222222]');
    expect(report.content).not.toContain('333333333333');
    for (const key of [keyA, keyB]) {
      expect(report.content).not.toContain(key.accessKeyId);
      expect(report.content).not.toContain(key.secret());
    }
  });

  it('a chave recusada pela AWS ou uma resposta fora do formato deixam a conta de fora, só com o tipo do erro', async () => {
    const refused = Object.assign(new Error('InvalidClientTokenId: detalhe'), {
      name: 'InvalidClientTokenId',
    });
    let call = 0;
    const sts: SessionSts = () => {
      call += 1;
      return Promise.resolve({
        send: () =>
          call === 1
            ? Promise.reject(refused)
            : Promise.resolve({ Credentials: { AccessKeyId: 'AKIA-NAO-E-SESSAO', SecretAccessKey: 'x' } }),
      } as never);
    };
    const report = await awsSessions(
      fakeDb([
        account('111111111111', new AwsAccessKey(keyId('AKIA'), secret())),
        account('222222222222', new AwsAccessKey(keyId('AKIA'), secret())),
      ]),
      keyring,
      sts,
    );
    expect(report).toEqual({
      content: '',
      accounts: 2,
      written: 0,
      skipped: { InvalidClientTokenId: 1, bad_response: 1 },
    });
  });
});
