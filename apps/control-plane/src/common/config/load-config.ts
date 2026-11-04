import { type Env, envSchema, isRole, otherRoles, ROLE_ONLY } from './env.schema.js';

export class ConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Configuração inválida:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

/** Recebe cada aviso da carga (variável ignorada); `main.ts` os manda para o logger depois que ele sobe. */
export type ConfigWarning = (message: string) => void;

function warnToConsole(message: string): void {
  console.warn(message);
}

/** Tira do ambiente as variáveis comuns de outro papel (`ROLE_ONLY.settings`), avisando cada uma pelo nome. */
function dropOtherRoleSettings(source: NodeJS.ProcessEnv, onWarning: ConfigWarning): NodeJS.ProcessEnv {
  const role = source['ROLE'];
  if (!isRole(role)) return source;
  const ignored = new Set<string>();
  for (const other of otherRoles(role)) {
    for (const key of ROLE_ONLY[other].settings) {
      if (source[key] === undefined) continue;
      ignored.add(key);
      onWarning(`${key}: só o papel ${other} usa; ignorada no papel ${role}`);
    }
  }
  if (ignored.size === 0) return source;
  return Object.fromEntries(Object.entries(source).filter(([key]) => !ignored.has(key)));
}

/**
 * Valida as variáveis de ambiente. As mensagens citam só o nome da variável e o problema,
 * nunca o valor recebido, que pode ser um segredo (mesma regra da API).
 */
export function loadConfig(
  source: NodeJS.ProcessEnv = process.env,
  onWarning: ConfigWarning = warnToConsole,
): Readonly<Env> {
  const env = dropOtherRoleSettings(source, onWarning);
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(ambiente)';
      const key = issue.path[0];
      const isMissing = typeof key === 'string' && env[key] === undefined;
      return `${name}: ${isMissing ? 'obrigatória e não definida' : issue.message}`;
    });
    throw new ConfigValidationError(problems);
  }
  return Object.freeze(result.data);
}
