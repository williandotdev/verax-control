import { z } from 'zod';

/**
 * Configuração do acesso ao indexer do Wazuh (T5.1 e fase 2, PR-W2). Dois modos, escolhidos por `INDEXER_AUTH` e
 * nunca misturados:
 * - `aws`: a credencial vem do Secrets Manager (segredo `<nome>/wazuh-api-read`, só leitura dos alertas) e o
 *   certificado da CA do Wazuh, do SSM Parameter Store (T4.8). Nada disso fica em variável de ambiente. É o padrão em
 *   produção, para não mudar a implantação na AWS.
 * - `node`: o Wazuh roda no próprio nó (perfil `standard`). O usuário só leitura e a senha vêm do ambiente, que o
 *   `start.sh` monta em memória a partir dos segredos gerados na VM, e a CA, de um arquivo do volume público dos
 *   certificados, montado só leitura. Fora de produção, é o padrão sem as variáveis da AWS (desenvolvimento e teste).
 *
 * Schema próprio até o módulo ser registrado na API (T5.3), quando os campos passam para o env.schema.
 */
const httpsUrl = z.url({ protocol: /^https$/, error: 'deve ser uma URL https:// (TLS obrigatório)' });

const INDEXER_AUTH_MODES = ['aws', 'node'] as const;
export type IndexerAuth = (typeof INDEXER_AUTH_MODES)[number];

/** As variáveis de cada modo: as de um modo não são aceitas no outro. */
const AWS_KEYS = ['INDEXER_CREDENTIALS_SECRET_ARN', 'INDEXER_CA_PARAMETER'] as const;
const NODE_KEYS = ['INDEXER_USERNAME', 'INDEXER_PASSWORD', 'INDEXER_CA_FILE'] as const;

/** Mesmo piso da senha guardada no Secrets Manager (`indexer-secrets.ts`). */
const MIN_NODE_PASSWORD_LENGTH = 16;

const rawSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']),
  INDEXER_URL: httpsUrl,
  INDEXER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(10000),
  INDEXER_AUTH: z.enum(INDEXER_AUTH_MODES, { error: 'deve ser aws ou node' }).optional(),
  // Modo aws: segredo e parâmetro da AWS.
  INDEXER_CREDENTIALS_SECRET_ARN: z
    .string()
    .regex(/^arn:aws[a-z-]*:secretsmanager:/)
    .optional(),
  INDEXER_CA_PARAMETER: z
    .string()
    .regex(/^\/[A-Za-z0-9/_.-]+$/)
    .optional(),
  // Modo node: credencial no ambiente e CA num arquivo.
  INDEXER_USERNAME: z.string().min(1).optional(),
  INDEXER_PASSWORD: z.string().min(1).optional(),
  INDEXER_CA_FILE: z.string().min(1).optional(),
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}(-gov)?-[a-z]+-[0-9]$/)
    .optional(),
});

type RawIndexerConfig = z.infer<typeof rawSchema>;

/**
 * O modo em vigor. Sem `INDEXER_AUTH`: em produção, `aws` (o nó com Wazuh declara `node`); fora dela, `aws` se alguma
 * variável da AWS estiver definida, senão `node`.
 */
function authOf(env: RawIndexerConfig): IndexerAuth {
  if (env.INDEXER_AUTH !== undefined) return env.INDEXER_AUTH;
  const fromAws = AWS_KEYS.some((key) => env[key] !== undefined);
  return env.NODE_ENV === 'production' || fromAws ? 'aws' : 'node';
}

export const indexerConfigSchema = rawSchema
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    if (authOf(env) === 'aws') {
      for (const key of NODE_KEYS) {
        if (env[key] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message:
              'com INDEXER_AUTH=aws, a credencial e a CA vêm do Secrets Manager e do SSM, nunca do ambiente (no nó com Wazuh, use INDEXER_AUTH=node)',
          });
        }
      }
      for (const key of AWS_KEYS) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com INDEXER_AUTH=aws' });
        }
      }
      if (production && env.AWS_REGION === undefined) {
        ctx.addIssue({ code: 'custom', path: ['AWS_REGION'], message: 'obrigatória em produção' });
      }
      return;
    }

    for (const key of AWS_KEYS) {
      if (env[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'com INDEXER_AUTH=node, a credencial vem do ambiente e a CA de um arquivo: não se mistura com o Secrets Manager nem com o SSM',
        });
      }
    }
    for (const key of NODE_KEYS) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com INDEXER_AUTH=node' });
      }
    }
    if (
      production &&
      env.INDEXER_PASSWORD !== undefined &&
      env.INDEXER_PASSWORD.length < MIN_NODE_PASSWORD_LENGTH
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['INDEXER_PASSWORD'],
        message: `deve ter pelo menos ${MIN_NODE_PASSWORD_LENGTH} caracteres em produção`,
      });
    }
  })
  .transform((env) => ({ ...env, INDEXER_AUTH: authOf(env) }));

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
