import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { afterAll, describe, expect, it } from 'vitest';
import { loadIndexerConfig } from '../../src/indexer/indexer.config.js';
import {
  AwsIndexerSecrets,
  indexerSecretsFor,
  NodeIndexerSecrets,
  type AwsClients,
} from '../../src/indexer/indexer-secrets.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
const PASSWORD = 'senha-do-indexer-de-teste-0000';
const production = {
  NODE_ENV: 'production',
  INDEXER_URL: 'https://wazuh-indexer.exemplo.internal:9200',
  INDEXER_CREDENTIALS_SECRET_ARN: 'arn:aws:secretsmanager:sa-east-1:111122223333:secret:x/wazuh-api-read',
  INDEXER_CA_PARAMETER: '/verax-control/exemplo/wazuh/indexer-ca',
  AWS_REGION: 'sa-east-1',
};
/** Nó com Wazuh (perfil standard): usuário só leitura e senha no ambiente, CA no volume público dos certificados. */
const node = {
  NODE_ENV: 'production',
  INDEXER_URL: 'https://wazuh.indexer:9200',
  INDEXER_AUTH: 'node',
  INDEXER_USERNAME: 'verax_api_read',
  INDEXER_PASSWORD: PASSWORD,
  INDEXER_CA_FILE: '/etc/verax/wazuh-certs/root-ca.pem',
};

describe('configuração do indexer (T5.1)', () => {
  it('produção usa Secrets Manager e SSM, com TLS e timeout padrão de 10 s', () => {
    const config = loadIndexerConfig(production);
    expect(config.INDEXER_TIMEOUT_MS).toBe(10000);
    // Sem INDEXER_AUTH, produção continua no modo da AWS.
    expect(config.INDEXER_AUTH).toBe('aws');
    expect(loadIndexerConfig({ ...production, INDEXER_AUTH: 'aws' }).INDEXER_AUTH).toBe('aws');
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

describe('configuração do indexer no nó (fase 2, PR-W2)', () => {
  it('INDEXER_AUTH=node em produção: credencial do ambiente e CA do arquivo, com TLS e timeout', () => {
    const config = loadIndexerConfig(node);
    expect(config).toMatchObject({
      INDEXER_AUTH: 'node',
      INDEXER_USERNAME: 'verax_api_read',
      INDEXER_CA_FILE: '/etc/verax/wazuh-certs/root-ca.pem',
      INDEXER_TIMEOUT_MS: 10000,
    });
    expect(indexerSecretsFor(config)).toBeInstanceOf(NodeIndexerSecrets);
    expect(indexerSecretsFor(loadIndexerConfig(production))).toBeInstanceOf(AwsIndexerSecrets);
    expect(() => loadIndexerConfig({ ...node, INDEXER_URL: 'http://wazuh.indexer:9200' })).toThrow(/https/);
  });

  it.each(['INDEXER_USERNAME', 'INDEXER_PASSWORD', 'INDEXER_CA_FILE'] as const)(
    'modo nó sem %s é recusado',
    (key) => {
      expect(() => loadIndexerConfig({ ...node, [key]: undefined })).toThrow(
        `${key}: obrigatória com INDEXER_AUTH=node`,
      );
    },
  );

  it('não mistura os modos: nó com variável da AWS, AWS com credencial do ambiente', () => {
    for (const key of ['INDEXER_CREDENTIALS_SECRET_ARN', 'INDEXER_CA_PARAMETER'] as const) {
      expect(() => loadIndexerConfig({ ...node, [key]: production[key] })).toThrow(
        `${key}: com INDEXER_AUTH=node`,
      );
    }
    for (const key of ['INDEXER_USERNAME', 'INDEXER_PASSWORD', 'INDEXER_CA_FILE'] as const) {
      expect(() => loadIndexerConfig({ ...production, INDEXER_AUTH: 'aws', [key]: node[key] })).toThrow(
        `${key}: com INDEXER_AUTH=aws`,
      );
    }
    // Fora de produção também: as variáveis dos dois modos juntas não escolhem um modo em silêncio.
    expect(() =>
      loadIndexerConfig({
        ...node,
        NODE_ENV: 'development',
        INDEXER_AUTH: undefined,
        INDEXER_CREDENTIALS_SECRET_ARN: production.INDEXER_CREDENTIALS_SECRET_ARN,
      }),
    ).toThrow(/INDEXER_PASSWORD: com INDEXER_AUTH=aws/);
  });

  it('produção sem INDEXER_AUTH=node recusa a credencial do ambiente, apontando o modo do nó', () => {
    expect(() => loadIndexerConfig({ ...node, INDEXER_AUTH: undefined })).toThrow(/use INDEXER_AUTH=node/);
  });

  it('modo inválido e senha curta em produção são recusados, sem o valor na mensagem', () => {
    expect(() => loadIndexerConfig({ ...node, INDEXER_AUTH: 'env' })).toThrow(
      /INDEXER_AUTH: deve ser aws ou node/,
    );
    const short = 'curta-0000';
    try {
      loadIndexerConfig({ ...node, INDEXER_PASSWORD: short });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toMatch(/INDEXER_PASSWORD: deve ter pelo menos 16 caracteres/);
      expect((error as Error).message).not.toContain(short);
    }
    // Fora de produção, a senha do indexer local de desenvolvimento pode ser curta.
    expect(
      loadIndexerConfig({ ...node, NODE_ENV: 'development', INDEXER_PASSWORD: short }).INDEXER_AUTH,
    ).toBe('node');
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
    const local = new NodeIndexerSecrets(
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

  it('no nó, a CA é lida na conexão: sem o arquivo na partida, nada cai, e o certificado vale quando chega', async () => {
    const caFile = join(dir, 'certs-public', 'root-ca.pem');
    const secrets = new NodeIndexerSecrets(loadIndexerConfig({ ...node, INDEXER_CA_FILE: caFile }));
    // A mensagem cita a variável, nunca o caminho nem o erro do sistema de arquivos.
    await expect(secrets.certificateAuthority()).rejects.toThrow(
      /^CA do indexer indisponível \(INDEXER_CA_FILE\)$/,
    );

    mkdirSync(join(dir, 'certs-public'));
    writeFileSync(caFile, 'ainda não é um certificado');
    await expect(secrets.certificateAuthority()).rejects.toThrow(/PEM/);
    writeFileSync(caFile, PEM);
    expect(await secrets.certificateAuthority()).toBe(PEM);
    expect(await secrets.credentials()).toEqual({ username: 'verax_api_read', password: PASSWORD });
  });
});
