/**
 * Limpeza de dados sensíveis antes de qualquer linha de log (regra 7 do PLANO).
 *
 * Duas camadas:
 * - por nome de chave, em qualquer profundidade: senha, token, cookie, Authorization, segredos AWS etc.;
 * - por padrão de valor, em qualquer string: `Bearer ...`, ID de chave de acesso AWS e senha embutida em URL.
 *
 * Na dúvida, a chave é ocultada: um campo inofensivo a menos no log é melhor que um segredo vazado.
 */
export const REDACTED = '[REDACTED]';

const MAX_DEPTH = 10;

/** Trechos que, encontrados no nome normalizado da chave (minúsculo, só letras e números), ocultam o valor. */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'accesskey',
  'credential',
  'connectionstring',
  'databaseurl',
  'backupcode',
  'recoverycode',
  'sessionid',
] as const;

/** Chaves curtas demais para busca por trecho, comparadas por igualdade. */
const SENSITIVE_KEYS_EXACT = new Set(['otp', 'totp', 'pin', 'pwd', 'externalid', 'signature']);

const VALUE_PATTERNS: readonly [RegExp, string][] = [
  // Header Authorization copiado para uma mensagem.
  [/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTED}`],
  // ID de chave de acesso AWS, de longo prazo (AKIA) ou temporária (ASIA).
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // Senha embutida em URL, como postgresql://usuario:senha@host/banco.
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/?#@]+:)[^\s@/?#]+@/gi, `$1${REDACTED}@`],
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS_EXACT.has(normalized) ||
    SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment))
  );
}

export function scrubString(value: string): string {
  return VALUE_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasToJSON(value: object): value is { toJSON: () => unknown } {
  return typeof (value as { toJSON?: unknown }).toJSON === 'function';
}

function serializeError(error: Error): Record<string, unknown> {
  const own: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    own[key] = (error as unknown as Record<string, unknown>)[key];
  }
  return {
    ...own,
    type: error.name,
    message: error.message,
    stack: error.stack,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  };
}

/**
 * Devolve uma cópia sem dados sensíveis. Percorre o mesmo conteúdo que o JSON do log teria:
 * propriedades próprias enumeráveis, `toJSON` quando existe, e mensagem/stack/causa de erros.
 */
export function sanitize(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[Binary]';
  if (value instanceof Date) return value;

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1, seen));
    if (value instanceof Error) return sanitize(serializeError(value), depth, seen);
    if (!isPlainObject(value) && hasToJSON(value)) return sanitize(value.toJSON(), depth, seen);

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? REDACTED : sanitize(item, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
