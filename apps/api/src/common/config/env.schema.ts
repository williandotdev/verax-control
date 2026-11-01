import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * Variáveis de ambiente da API. A API não sobe se alguma obrigatória faltar ou for inválida.
 * Cada task que precisar de configuração nova acrescenta o campo aqui e no .env.example.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    WEB_ORIGIN: z.url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' }),
    DATABASE_URL: z
      .string({ error: 'obrigatória' })
      .regex(/^postgres(ql)?:\/\/.+/, { error: 'deve ser uma URL postgresql://' }),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && !env.WEB_ORIGIN.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'deve usar https em produção' });
    }
  });

export type Env = z.infer<typeof envSchema>;
