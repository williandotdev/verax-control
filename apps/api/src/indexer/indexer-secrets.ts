import { readFile } from 'node:fs/promises';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import type { IndexerConfig } from './indexer.config.js';

export interface IndexerCredentials {
  username: string;
  password: string;
}

/** Credencial (usuário só leitura) e CA do indexer. Nada disso é registrado em log. */
export interface IndexerSecrets {
  /** `refresh` ignora o cache: usado quando o indexer recusa a credencial (senha rotacionada). */
  credentials(refresh?: boolean): Promise<IndexerCredentials>;
  certificateAuthority(): Promise<string>;
}

const credentialsSchema = z.object({ username: z.string().min(1), password: z.string().min(16) });
const MAX_CA_LENGTH = 16 * 1024;

function requirePem(value: string, origin: string): string {
  const pem = value.trim();
  const looksLikePem =
    pem.length <= MAX_CA_LENGTH &&
    pem.startsWith('-----BEGIN CERTIFICATE-----') &&
    pem.endsWith('-----END CERTIFICATE-----');
  if (!looksLikePem) {
    throw new Error(`CA do indexer inválida (${origin}): esperado um certificado PEM`);
  }
  return value;
}

/**
 * Modo `node` (e desenvolvimento e teste): credencial no ambiente e CA num arquivo. No nó, o arquivo vem do volume
 * público dos certificados do Wazuh, montado só leitura. A CA é lida a cada conexão nova, e não na partida: na primeira
 * subida do nó, a API e o worker sobem antes de o Wazuh gerar os certificados, e até lá a leitura falha sem derrubar
 * nada (o detalhe sai sem o evento bruto, e a tarefa `wazuh` tenta de novo no intervalo seguinte).
 */
export class NodeIndexerSecrets implements IndexerSecrets {
  constructor(private readonly config: IndexerConfig) {}

  credentials(): Promise<IndexerCredentials> {
    return Promise.resolve({
      username: this.config.INDEXER_USERNAME ?? '',
      password: this.config.INDEXER_PASSWORD ?? '',
    });
  }

  async certificateAuthority(): Promise<string> {
    let content: string;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho da configuração, não do request
      content = await readFile(this.config.INDEXER_CA_FILE ?? '', 'utf8');
    } catch {
      throw new Error('CA do indexer indisponível (INDEXER_CA_FILE)');
    }
    return requirePem(content, 'INDEXER_CA_FILE');
  }
}

/** Só o necessário dos clientes da AWS (os testes injetam versões falsas). */
export interface AwsClients {
  secrets: Pick<SecretsManagerClient, 'send'>;
  ssm: Pick<SSMClient, 'send'>;
}

const CREDENTIALS_TTL_MS = 5 * 60 * 1000;

/** Modo `aws`: credencial do Secrets Manager (com cache de 5 minutos) e CA do SSM Parameter Store. */
export class AwsIndexerSecrets implements IndexerSecrets {
  private cached: { value: IndexerCredentials; until: number } | null = null;
  private ca: string | null = null;

  constructor(
    private readonly config: IndexerConfig,
    private readonly clients: AwsClients = {
      secrets: new SecretsManagerClient({ region: config.AWS_REGION }),
      ssm: new SSMClient({ region: config.AWS_REGION }),
    },
    private readonly now: () => number = Date.now,
  ) {}

  async credentials(refresh = false): Promise<IndexerCredentials> {
    if (!refresh && this.cached && this.cached.until > this.now()) {
      return this.cached.value;
    }
    const response = await this.clients.secrets.send(
      new GetSecretValueCommand({ SecretId: this.config.INDEXER_CREDENTIALS_SECRET_ARN }),
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.SecretString ?? '');
    } catch {
      throw new Error('segredo do indexer não é JSON');
    }
    const result = credentialsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error('segredo do indexer sem username/password válidos');
    }
    this.cached = { value: result.data, until: this.now() + CREDENTIALS_TTL_MS };
    return result.data;
  }

  async certificateAuthority(): Promise<string> {
    if (this.ca === null) {
      const response = await this.clients.ssm.send(
        new GetParameterCommand({ Name: this.config.INDEXER_CA_PARAMETER }),
      );
      this.ca = requirePem(response.Parameter?.Value ?? '', 'INDEXER_CA_PARAMETER');
    }
    return this.ca;
  }
}

/** O provedor do modo em vigor (`INDEXER_AUTH`, já resolvido e conferido pela configuração). */
export function indexerSecretsFor(config: IndexerConfig): IndexerSecrets {
  return config.INDEXER_AUTH === 'aws' ? new AwsIndexerSecrets(config) : new NodeIndexerSecrets(config);
}
