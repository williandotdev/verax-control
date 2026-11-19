import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import { findWazuhSourceRows } from '../aws/wazuh-sources.js';
import { requiresVerifiedTls } from '../common/config/env.schema.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { errorKind } from '../common/logger/error-kind.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { parsePrivateKeys, type VaultKeyring } from '../credentials/credential-keys.js';
import {
  AwsAccessKey,
  CredentialVaultError,
  credentialBinding,
  open,
} from '../credentials/credential-vault.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * As sessões da AWS do Wazuh na VM própria do cliente (`NODE_PLATFORM=vm`; `docs/ARQUITETURA.md`, "Cofre de
 * credenciais"), na saída padrão: o arquivo `credentials` dos profiles do manager, que o `infra/node/bin/aws-token.sh`
 * confere linha a linha e grava na pasta que o manager monta em `/root/.aws`. Roda no job `aws-sessions` do
 * `infra/node/compose.vault.yaml` (imagem da API, ambiente do worker, a rede do banco e o cofre de credenciais).
 *
 * Para cada conta AWS que o manager lê (a mesma lista do `wazuh-sources`), a chave do usuário IAM de leitura sai do
 * cofre só aqui e é trocada por uma sessão de 1 hora (`GetSessionToken`, no STS de us-east-1). Só a sessão é impressa: a
 * chave de longo prazo nunca chega ao manager, e a sessão herda as permissões (e as negações) do usuário. A sessão do
 * `GetSessionToken` não chama o IAM, e o Wazuh só lê o S3 (e o KMS por ele).
 *
 * Uma conta sem chave, com a chave recusada ou com o STS fora fica de fora (o profile dela fica sem credencial, e a
 * conferência da conexão já mostra o problema); no erro padrão, só as contagens e os tipos dos erros, nunca a conta, a
 * chave nem a sessão. Um erro do banco ou do cofre sai com o código 1 e nada na saída padrão: o aws-token.sh então
 * mantém as sessões anteriores.
 */

/** As sessões valem 1 hora (o mínimo do STS é 15 min); o timer do host as renova a cada 10 min. */
export const WAZUH_SESSION_SECONDS = 3600;
const STS_REGION = 'us-east-1';

const cliEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/),
    CREDENTIALS_PRIVATE_KEYS_FILE: z.string().min(1),
    CREDENTIALS_KEY_CURRENT: z.coerce.number().int().min(1),
  })
  .refine((env) => env.NODE_ENV !== 'production' || requiresVerifiedTls(env.DATABASE_URL), {
    path: ['DATABASE_URL'],
    error: 'deve usar sslmode=verify-full em produção',
  });

/** A sessão que o STS devolve, conferida antes de ir para o arquivo (o aws-token.sh confere de novo). */
const sessionSchema = z.object({
  AccessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/),
  SecretAccessKey: z.string().regex(/^[A-Za-z0-9/+]{40}$/),
  SessionToken: z.string().regex(/^[A-Za-z0-9/+=]{16,4096}$/),
});

/** O STS com a chave de uma conta (os testes trocam por um falso). */
export type SessionSts = (key: AwsAccessKey) => Promise<Pick<STSClient, 'send'>>;

const sdkSts: SessionSts = async (key) => {
  const { STSClient } = await import('@aws-sdk/client-sts');
  return new STSClient({
    region: STS_REGION,
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000 },
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secret() },
  });
};

export interface SessionsReport {
  /** O arquivo `credentials` (vazio sem conta). */
  content: string;
  accounts: number;
  written: number;
  /** As contas que ficaram de fora, por tipo do erro (`key_missing`, `InvalidClientTokenId`...). */
  skipped: Record<string, number>;
}

/** O arquivo `credentials` com uma sessão por conta que o manager lê. */
export async function awsSessions(
  db: Prisma.TransactionClient,
  keyring: VaultKeyring,
  sts: SessionSts = sdkSts,
  tenantIds?: readonly string[],
): Promise<SessionsReport> {
  const { GetSessionTokenCommand } = await import('@aws-sdk/client-sts');
  const rows = await findWazuhSourceRows(db, tenantIds);
  const blocks: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (kind: string) => {
    skipped[kind] = (skipped[kind] ?? 0) + 1;
  };
  for (const row of rows) {
    const account = await db.cloudAccount.findUnique({
      where: { id: row.id },
      select: {
        id: true,
        tenantId: true,
        accountId: true,
        credential: { select: { kind: true, ciphertext: true } },
      },
    });
    const credential = account?.credential;
    if (account == null || credential == null || credential.kind !== 'aws_access_key') {
      skip('key_missing');
      continue;
    }
    let key: AwsAccessKey;
    try {
      const opened = open(
        keyring,
        credentialBinding({ ...account, provider: 'aws' }, credential.kind),
        credential.ciphertext,
      );
      if (!(opened instanceof AwsAccessKey)) throw new CredentialVaultError('payload_invalid');
      key = opened;
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      skip(`vault_${error.code}`);
      continue;
    }
    const client = await sts(key);
    try {
      const response = await client.send(
        new GetSessionTokenCommand({ DurationSeconds: WAZUH_SESSION_SECONDS }),
      );
      const session = sessionSchema.safeParse(response.Credentials);
      if (!session.success) {
        skip('bad_response');
        continue;
      }
      blocks.push(
        [
          `[verax-${account.accountId}]`,
          `aws_access_key_id = ${session.data.AccessKeyId}`,
          `aws_secret_access_key = ${session.data.SecretAccessKey}`,
          `aws_session_token = ${session.data.SessionToken}`,
        ].join('\n'),
      );
    } catch (error) {
      skip(errorKind(error));
    } finally {
      (client as { destroy?: () => void }).destroy?.();
    }
  }
  return {
    content: blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '',
    accounts: rows.length,
    written: blocks.length,
    skipped,
  };
}

async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();
  const env = cliEnvSchema.safeParse(process.env);
  if (!env.success) {
    // Só os nomes das variáveis, nunca os valores (a URL do banco tem a senha).
    console.error('aws-sessions: DATABASE_URL ou as chaves do cofre ausentes ou fora do formato.');
    process.exit(1);
  }
  let keyring: VaultKeyring;
  try {
    const file = env.data.CREDENTIALS_PRIVATE_KEYS_FILE;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- o arquivo do tmpfs que o start.sh escreve
    const content = readFileSync(file, 'utf8');
    keyring = parsePrivateKeys(content, env.data.CREDENTIALS_KEY_CURRENT);
  } catch (error) {
    console.error(`aws-sessions: as chaves do cofre não abriram (${errorKind(error)}).`);
    process.exit(1);
  }
  const prisma = new PrismaService(env.data);
  try {
    const report = await awsSessions(prisma, keyring);
    process.stdout.write(report.content);
    const skipped = Object.entries(report.skipped)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(', ');
    console.error(
      `aws-sessions: ${report.written} de ${report.accounts} conta(s) AWS com sessão${skipped ? ` (de fora: ${skipped})` : ''}.`,
    );
  } catch (error) {
    console.error(`aws-sessions: falha ao ler as contas AWS do banco (${errorKind(error)}).`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
