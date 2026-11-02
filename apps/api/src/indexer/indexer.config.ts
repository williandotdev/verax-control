import { z } from 'zod';

/**
 * Configuração do acesso ao indexer do Wazuh (T5.1).
 *
 * Em produção a credencial vem do Secrets Manager (segredo `<nome>/wazuh-api-read`, só leitura dos alertas) e o
 * certificado da CA do Wazuh, do SSM Parameter Store (T4.8): nada disso fica em variável de ambiente. Em
 * desenvolvimento e teste, credencial e CA podem vir do ambiente e de um arquivo local.
 *
 * Schema próprio até o módulo ser registrado na API (T5.3), quando os campos passam para o env.schema.
 */
const httpsUrl = z.url({ protocol: /^https$/, error: 'deve ser uma URL https:// (TLS obrigatório)' });

export const indexerConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    INDEXER_URL: httpsUrl,
    INDEXER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
    // Produção: segredo e parâmetro da AWS.
    INDEXER_CREDENTIALS_SECRET_ARN: z
      .string()
      .regex(/^arn:aws[a-z-]*:secretsmanager:/)
      .optional(),
    INDEXER_CA_PARAMETER: z
      .string()
      .regex(/^\/[A-Za-z0-9/_.-]+$/)
      .optional(),
    // Desenvolvimento e teste: credencial no ambiente e CA num arquivo.
    INDEXER_USERNAME: z.string().min(1).optional(),
    INDEXER_PASSWORD: z.string().min(1).optional(),
    INDEXER_CA_FILE: z.string().min(1).optional(),
    AWS_REGION: z
      .string()
      .regex(/^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/)
      .optional(),
  })
  .superRefine((env, ctx) => {
    const fromAws =
      env.INDEXER_CREDENTIALS_SECRET_ARN !== undefined || env.INDEXER_CA_PARAMETER !== undefined;
    const fromEnv =
      env.INDEXER_USERNAME !== undefined ||
      env.INDEXER_PASSWORD !== undefined ||
      env.INDEXER_CA_FILE !== undefined;

    if (env.NODE_ENV === 'production') {
      if (fromEnv) {
        ctx.addIssue({
          code: 'custom',
          path: ['INDEXER_PASSWORD'],
          message: 'em produção a credencial e a CA vêm do Secrets Manager e do SSM, nunca do ambiente',
        });
      }
      for (const key of ['INDEXER_CREDENTIALS_SECRET_ARN', 'INDEXER_CA_PARAMETER', 'AWS_REGION'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória em produção' });
        }
      }
      return;
    }

    if (!fromAws) {
      for (const key of ['INDEXER_USERNAME', 'INDEXER_PASSWORD', 'INDEXER_CA_FILE'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória sem o Secrets Manager' });
        }
      }
    }
  });

export type IndexerConfig = z.infer<typeof indexerConfigSchema>;

/** Lê e valida a configuração; a mensagem de erro cita só os nomes das variáveis, nunca os valores. */
export function loadIndexerConfig(source: Record<string, string | undefined> = process.env): IndexerConfig {
  const result = indexerConfigSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Configuração do indexer inválida:\n${problems.join('\n')}`);
  }
  return result.data;
}
