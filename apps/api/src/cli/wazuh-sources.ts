import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { findWazuhSourceRows, serializeWazuhSources, toWazuhSources } from '../aws/wazuh-sources.js';
import { requiresVerifiedTls } from '../common/config/env.schema.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { errorKind } from '../common/logger/error-kind.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Lista das contas AWS que o Wazuh do nó lê (fase 2, PR-V4'), na saída padrão: uma linha de JSON que o
 * `infra/node/bin/wazuh-apply.sh` passa ao gerador da configuração do manager (`render-manager-config.py`). Roda no
 * job `wazuh-sources` do `infra/node/compose.wazuh.yaml` (imagem da API, ambiente do worker, rede do banco).
 *
 * Nenhum valor é segredo: o nó entra no papel de leitura de cada conta com o token do Google, e não existe chave. Do
 * ambiente, só o banco é lido: o arquivo das chaves do cofre, que o worker.env aponta, nem está montado neste job. Um
 * erro sai só pelo tipo, com o código 1, e nada vai para a saída padrão: o wazuh-apply.sh então deixa a configuração
 * do manager como está (uma saída vazia seria lida como "nenhuma conta").
 */
const cliEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
    DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\/.+/),
  })
  .refine((env) => env.NODE_ENV !== 'production' || requiresVerifiedTls(env.DATABASE_URL), {
    path: ['DATABASE_URL'],
    error: 'deve usar sslmode=verify-full em produção',
  });

/** A linha que o CLI imprime (sem a quebra do fim). */
export async function wazuhSourcesLine(db: Prisma.TransactionClient): Promise<string> {
  return serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(db)));
}

async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();
  const env = cliEnvSchema.safeParse(process.env);
  if (!env.success) {
    // Só o nome da variável, nunca o valor (a URL do banco tem a senha).
    console.error('wazuh-sources: DATABASE_URL ausente ou fora do formato.');
    process.exit(1);
  }
  const prisma = new PrismaService(env.data);
  try {
    const line = await wazuhSourcesLine(prisma);
    process.stdout.write(`${line}\n`);
  } catch (error) {
    console.error(`wazuh-sources: falha ao ler as contas AWS do banco (${errorKind(error)}).`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
