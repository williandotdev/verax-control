import type { z } from 'zod';
import { envSchema, type Env, type WorkerEnv, workerEnvSchema } from './env.schema.js';

export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Valida as variáveis de ambiente. As mensagens citam só o nome da variável e o problema,
 * nunca o valor recebido, que pode ser um segredo.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): Readonly<Env> {
  return parseEnv(envSchema, source);
}

/** Configuração do worker do sync, com as mesmas regras de mensagem (só nomes, nunca valores). */
export function loadWorkerConfig(source: NodeJS.ProcessEnv = process.env): Readonly<WorkerEnv> {
  return parseEnv(workerEnvSchema, source);
}

function parseEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): Readonly<z.infer<T>> {
  const result = schema.safeParse(source);
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
