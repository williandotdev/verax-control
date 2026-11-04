import { type Env, envSchema } from './env.schema.js';

export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Valida as variáveis de ambiente. As mensagens citam só o nome da variável e o problema,
 * nunca o valor recebido, que pode ser um segredo (mesma regra da API).
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Readonly<Env> {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(ambiente)';
      const key = issue.path[0];
      const isMissing = typeof key === 'string' && source[key] === undefined;
      return `${name}: ${isMissing ? 'obrigatória e não definida' : issue.message}`;
    });
    throw new ConfigValidationError(problems);
  }
  return Object.freeze(result.data);
}
