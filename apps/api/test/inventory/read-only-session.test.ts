import { inspect } from 'node:util';
import type { STSClient } from '@aws-sdk/client-sts';
import { describe, expect, it } from 'vitest';
import { InventoryError, assumeReadOnlyRole } from '../../src/inventory/read-only-session.js';
import { awsError, fakeClient } from './fake-aws.js';

const ACCOUNT = '111122223333';
const EXTERNAL_ID = 'exemplo-external-id-conta-a-0000000000';
const SECRET = 'segredo-temporario-de-teste-0000000000';

function sts(
  handler: () => unknown = () => ({
    Credentials: {
      AccessKeyId: 'ASIAEXEMPLO000000000',
      SecretAccessKey: SECRET,
      SessionToken: 'token-de-sessao-de-teste',
      Expiration: new Date('2026-11-02T12:15:00.000Z'),
    },
  }),
) {
  return fakeClient<STSClient>({ AssumeRoleCommand: handler });
}

describe('sessão no papel de leitura do cliente (T5.9)', () => {
  it('assume o papel derivado da conta, com o ExternalId e por 15 minutos', async () => {
    const fake = sts();
    const credentials = await assumeReadOnlyRole(
      { accountId: ACCOUNT, externalId: EXTERNAL_ID },
      fake.client,
    );
    expect(fake.calls).toEqual([
      {
        command: 'AssumeRoleCommand',
        input: {
          RoleArn: `arn:aws:iam::${ACCOUNT}:role/VeraxControlReadOnly`,
          RoleSessionName: 'verax-control-inventory',
          ExternalId: EXTERNAL_ID,
          DurationSeconds: 900,
        },
      },
    ]);
    expect(credentials.identity()).toMatchObject({
      accessKeyId: 'ASIAEXEMPLO000000000',
      secretAccessKey: SECRET,
    });
    expect(credentials.expiration?.toISOString()).toBe('2026-11-02T12:15:00.000Z');
  });

  it('as credenciais não viram JSON, texto nem saída de log', async () => {
    const credentials = await assumeReadOnlyRole(
      { accountId: ACCOUNT, externalId: EXTERNAL_ID },
      sts().client,
    );
    for (const rendered of [
      JSON.stringify({ credentials }),
      String(credentials),
      inspect(credentials),
      inspect({ nested: { credentials } }, { depth: 5 }),
    ]) {
      expect(rendered).not.toContain(SECRET);
      expect(rendered).not.toContain('token-de-sessao');
    }
    // Além do campo privado, o objeto se apresenta com um marcador explícito no log e no JSON.
    expect(inspect(credentials)).toBe('[credenciais temporárias]');
    expect(JSON.stringify({ credentials })).toBe('{"credentials":"[credenciais temporárias]"}');
  });

  it('recusa conta ou ExternalId fora do formato sem chamar a AWS', async () => {
    const fake = sts();
    for (const target of [
      { accountId: '1111', externalId: EXTERNAL_ID },
      { accountId: `${ACCOUNT}:role/Admin`, externalId: EXTERNAL_ID },
      { accountId: ACCOUNT, externalId: 'curto' },
      { accountId: ACCOUNT, externalId: `${EXTERNAL_ID}\n[profile x]` },
    ]) {
      await expect(assumeReadOnlyRole(target, fake.client)).rejects.toThrow(InventoryError);
    }
    expect(fake.calls).toEqual([]);
  });

  it('erro da AWS cita a conta e o código, nunca o ExternalId nem a mensagem da AWS', async () => {
    const promise = assumeReadOnlyRole(
      { accountId: ACCOUNT, externalId: EXTERNAL_ID },
      sts(() => {
        throw awsError('AccessDenied');
      }).client,
    );
    await expect(promise).rejects.toThrow(`papel de leitura na conta ${ACCOUNT} (AccessDenied)`);
    const message = await promise.catch((error: Error) => error.message);
    expect(message).not.toContain(EXTERNAL_ID);
    expect(message).not.toContain('detalhe-interno');
  });

  it('resposta sem credenciais é erro', async () => {
    await expect(
      assumeReadOnlyRole({ accountId: ACCOUNT, externalId: EXTERNAL_ID }, sts(() => ({})).client),
    ).rejects.toThrow(/não devolveu credenciais/);
  });
});
