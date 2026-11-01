import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** TLS com verificação de certificado e de hostname até o banco (regra 5: nada de TLS sem validação). */
function requiresVerifiedTls(databaseUrl: string): boolean {
  try {
    return new URL(databaseUrl).searchParams.get('sslmode') === 'verify-full';
  } catch {
    return false;
  }
}

/**
 * Variáveis de ambiente da API. A API não sobe se alguma obrigatória faltar ou for inválida.
 * Cada task que precisar de configuração nova acrescenta o campo aqui e no .env.example.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Quantos proxies confiáveis ficam na frente da API (o ALB conta 1). Define de onde sai o IP do cliente
    // na auditoria e no limite de tentativas: com 0, o X-Forwarded-For é ignorado e não pode ser forjado.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    WEB_ORIGIN: z.url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' }),
    API_ORIGIN: z.url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' }),
    // Assina os cookies de sessão e cifra o segredo do TOTP. Gerado por `pnpm setup:env` (256 bits).
    BETTER_AUTH_SECRET: z
      .string({ error: 'obrigatória' })
      .min(32, { error: 'deve ter pelo menos 32 caracteres' }),
    DATABASE_URL: z
      .string({ error: 'obrigatória' })
      .regex(/^postgres(ql)?:\/\/.+/, { error: 'deve ser uma URL postgresql://' }),
  })
  .superRefine((env, ctx) => {
    for (const key of ['WEB_ORIGIN', 'API_ORIGIN'] as const) {
      if (env.NODE_ENV === 'production' && !env[key].startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'deve usar https em produção' });
      }
    }
    if (env.NODE_ENV === 'production' && !requiresVerifiedTls(env.DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'deve usar sslmode=verify-full em produção (TLS com certificado conferido)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
