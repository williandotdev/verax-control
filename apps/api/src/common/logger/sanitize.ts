/**
 * Limpeza de dados sensíveis antes de qualquer linha de log (regra 7 do PLANO).
 *
 * Três camadas:
 * - por nome de chave, em qualquer profundidade: senha, token, cookie, Authorization, segredos AWS etc.;
 * - por padrão de valor, em qualquer string: `Bearer ...`, ID de chave de acesso AWS, a linha do segredo da AWS de um
 *   arquivo `credentials` e senha embutida em URL;
 * - por valor exato, em qualquer string: os segredos vivos, decifrados do cofre de credenciais neste processo
 *   (`registerLiveSecret`). Um segredo da AWS ou um token do Cloudflare não tem formato que o distinga de um texto
 *   qualquer, e uma mensagem de erro de terceiros pode repeti-lo sem nome de campo nenhum.
 *
 * Na dúvida, a chave é ocultada: um campo inofensivo a menos no log é melhor que um segredo vazado. A exceção são
 * valores booleanos (`mustChangePassword: true`): um sim ou não não carrega segredo, e a auditoria precisa mostrar a
 * mudança de estado.
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
const SENSITIVE_KEYS_EXACT = new Set([
  'otp',
  'totp',
  'pin',
  'pwd',
  'externalid',
  'signature',
  // Texto cifrado do cofre de credenciais (fase 2): não é o segredo, mas não tem por que ir para o log nem para a
  // auditoria.
  'ciphertext',
]);

const VALUE_PATTERNS: readonly [RegExp, string][] = [
  // Header Authorization copiado para uma mensagem.
  [/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTED}`],
  // ID de chave de acesso AWS, de longo prazo (AKIA) ou temporária (ASIA).
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // Linha de um arquivo `credentials` da AWS (o que o Wazuh do nó lê) copiada para uma mensagem: o valor vai até o
  // primeiro espaço.
  [/(\baws_(?:secret_access_key|session_token)\s*=\s*)\S+/gi, `$1${REDACTED}`],
  // Senha embutida em URL, como postgresql://usuario:senha@host/banco.
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/?#@]+:)[^\s@/?#]+@/gi, `$1${REDACTED}@`],
];

/**
 * Segredos vivos: os valores decifrados do cofre de credenciais neste processo (a chave secreta da AWS e o token do
 * Cloudflare, registrados pelos invólucros de `credentials/credential-vault.ts`). Ficam enquanto o processo vive: só o
 * worker decifra, e as contas de um nó são poucas. Valores curtos ficam de fora, para não ocultar pedaços de texto
 * comum.
 */
const liveSecrets = new Set<string>();
export const MIN_LIVE_SECRET_LENGTH = 16;

/** Passa a ocultar este valor em toda linha de log e em todo estado de auditoria deste processo. */
export function registerLiveSecret(value: string): void {
  if (value.length >= MIN_LIVE_SECRET_LENGTH) liveSecrets.add(value);
}

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
  let text = value;
  for (const secret of liveSecrets) {
    if (text.includes(secret)) text = text.replaceAll(secret, REDACTED);
  }
  return VALUE_PATTERNS.reduce(
    (result, [pattern, replacement]) => result.replace(pattern, replacement),
    text,
  );
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
      result[key] =
        isSensitiveKey(key) && typeof item !== 'boolean' ? REDACTED : sanitize(item, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
