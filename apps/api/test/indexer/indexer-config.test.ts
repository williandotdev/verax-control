import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { afterAll, describe, expect, it } from 'vitest';
import { loadIndexerConfig } from '../../src/indexer/indexer.config.js';
import { AwsIndexerSecrets, EnvIndexerSecrets, type AwsClients } from '../../src/indexer/indexer-secrets.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const PASSWORD = 'senha-do-indexer-de-teste-0000';
const production = {
  NODE_ENV: 'production',
  INDEXER_URL: 'https://wazuh-indexer.exemplo.internal:9200',
  INDEXER_CREDENTIALS_SECRET_ARN: 'arn:aws:secretsmanager:sa-east-1:111122223333:secret:x/wazuh-api-read',
  INDEXER_CA_PARAMETER: '/verax-control/exemplo/wazuh/indexer-ca',
  AWS_REGION: 'sa-east-1',
};

describe('configuração do indexer (T5.1)', () => {
  it('produção usa Secrets Manager e SSM, com TLS e timeout padrão de 10 s', () => {
    const config = loadIndexerConfig(production);
    expect(config.INDEXER_TIMEOUT_MS).toBe(10000);
  });

  it('produção recusa credencial no ambiente, http e falta de segredo, CA ou região', () => {
    expect(() => loadIndexerConfig({ ...production, INDEXER_PASSWORD: PASSWORD })).toThrow(
      /nunca do ambiente/,
    );
    expect(() => loadIndexerConfig({ ...production, INDEXER_URL: 'http://indexer:9200' })).toThrow(/https/);
    for (const key of ['INDEXER_CREDENTIALS_SECRET_ARN', 'INDEXER_CA_PARAMETER', 'AWS_REGION'] as const) {
      expect(() => loadIndexerConfig({ ...production, [key]: undefined })).toThrow(key);
    }
  });

  it('a mensagem de erro cita as variáveis, nunca os valores', () => {
    try {
      loadIndexerConfig({ ...production, INDEXER_PASSWORD: PASSWORD });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain(PASSWORD);
    }
  });

  it('fora da AWS exige usuário, senha e arquivo da CA', () => {
    expect(() =>
      loadIndexerConfig({ NODE_ENV: 'development', INDEXER_URL: 'https://localhost:9200' }),
    ).toThrow(/INDEXER_USERNAME/);
  });

  it('timeout entre 1 e 30 s', () => {
    expect(() => loadIndexerConfig({ ...production, INDEXER_TIMEOUT_MS: '500' })).toThrow();
    expect(() => loadIndexerConfig({ ...production, INDEXER_TIMEOUT_MS: '60000' })).toThrow();
  });
});

describe('segredos do indexer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verax-indexer-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function aws(secretString: string, ca = PEM) {
    const calls: string[] = [];
    const clients: AwsClients = {
      secrets: {
        send: (command: unknown) => {
          calls.push((command as GetSecretValueCommand).constructor.name);
          return Promise.resolve({ SecretString: secretString });
        },
      } as AwsClients['secrets'],
      ssm: {
        send: (command: unknown) => {
          calls.push((command as GetParameterCommand).constructor.name);
          return Promise.resolve({ Parameter: { Value: ca } });
        },
      } as AwsClients['ssm'],
    };
    return { clients, calls };
  }

  it('lê a credencial do Secrets Manager com cache de 5 minutos e renova quando pedido', async () => {
    let now = 0;
    const { clients, calls } = aws(JSON.stringify({ username: 'verax_api_read', password: PASSWORD }));
    const secrets = new AwsIndexerSecrets(loadIndexerConfig(production), clients, () => now);
    expect(await secrets.credentials()).toEqual({ username: 'verax_api_read', password: PASSWORD });
    await secrets.credentials();
    expect(calls.filter((name) => name === 'GetSecretValueCommand')).toHaveLength(1);
    now += 5 * 60 * 1000 + 1;
    await secrets.credentials();
    await secrets.credentials(true);
    expect(calls.filter((name) => name === 'GetSecretValueCommand')).toHaveLength(3);
  });

  it('recusa segredo malformado sem expor o conteúdo', async () => {
    const { clients } = aws(`não é json ${PASSWORD}`);
    const secrets = new AwsIndexerSecrets(loadIndexerConfig(production), clients);
    await expect(secrets.credentials()).rejects.toThrow(/não é JSON/);
    await expect(secrets.credentials()).rejects.not.toThrow(new RegExp(PASSWORD));
    const short = new AwsIndexerSecrets(
      loadIndexerConfig(production),
      aws('{"username":"u","password":"curta"}').clients,
    );
    await expect(short.credentials()).rejects.toThrow(/username\/password/);
  });

  it('exige a CA em PEM (do SSM ou do arquivo)', async () => {
    const secrets = new AwsIndexerSecrets(
      loadIndexerConfig(production),
      aws('{}', 'pendente: publicado pelo bootstrap').clients,
    );
    await expect(secrets.certificateAuthority()).rejects.toThrow(/PEM/);

    const caFile = join(dir, 'ca.pem');
    writeFileSync(caFile, PEM);
    const local = new EnvIndexerSecrets(
      loadIndexerConfig({
        NODE_ENV: 'development',
        INDEXER_URL: 'https://localhost:9200',
        INDEXER_USERNAME: 'verax_api_read',
        INDEXER_PASSWORD: PASSWORD,
        INDEXER_CA_FILE: caFile,
      }),
    );
    expect(await local.certificateAuthority()).toBe(PEM);
    expect(await local.credentials()).toEqual({ username: 'verax_api_read', password: PASSWORD });
  });
});
