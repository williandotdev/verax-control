/**
 * Limpeza de dados sensíveis antes de qualquer linha de log (regra 7) e de qualquer `details` da auditoria.
 * Cópia de `apps/api/src/common/logger/sanitize.ts` (a API não é dependência deste app), com os padrões que só
 * o plano de controle encontra: chaves e segredos de webhook da Stripe e tokens de identidade e de acesso do Google.
 *
 * Três camadas:
 * - por nome de chave, em qualquer profundidade: senha, token, cookie, Authorization, assinatura, segredos etc.;
 * - por padrão de valor, em qualquer string: `Bearer ...`, chave da Stripe, JWT, token de acesso do Google, ID de
 *   chave de acesso AWS e senha embutida em URL;
 * - por valor exato, em qualquer string: os segredos vivos deste processo (`registerLiveSecret`), como a senha
 *   temporária do primeiro admin na revelação única (CP-05). Uma senha não tem formato que a distinga de um texto
 *   qualquer, e uma mensagem de erro de terceiros pode repeti-la sem nome de campo nenhum.
 *
 * Na dúvida, a chave é ocultada: um campo inofensivo a menos no log é melhor que um segredo vazado. A exceção são
 * valores booleanos (`passwordRevealed: true`): um sim ou não não carrega segredo, e a auditoria precisa mostrar a
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
  // Assinatura do webhook da Stripe (`stripe-signature`) e de qualquer outro HMAC.
  'signature',
] as const;

/** Chaves curtas demais para busca por trecho, comparadas por igualdade. */
const SENSITIVE_KEYS_EXACT = new Set(['otp', 'totp', 'pin', 'pwd', 'externalid']);

const VALUE_PATTERNS: readonly [RegExp, string][] = [
  // Header Authorization copiado para uma mensagem.
  [/\bBearer\s+[\w.~+/=-]+/gi, `Bearer ${REDACTED}`],
  // Chave secreta ou restrita da Stripe e segredo de assinatura do webhook.
  [/\b(?:sk|rk)_(?:test|live)_[A-Za-z0-9]{8,}\b/g, REDACTED],
  [/\bwhsec_[A-Za-z0-9]{8,}\b/g, REDACTED],
  // Token de acesso OAuth do Google (tasks, Scheduler, APIs REST).
  [/\bya29\.[\w.-]+/g, REDACTED],
  // JWT (token de identidade do Google, entre outros): três partes base64url começando por `eyJ`.
  [/\beyJ[\w-]{4,}\.eyJ[\w-]{4,}\.[\w-]{4,}\b/g, REDACTED],
  // ID de chave de acesso AWS, de longo prazo (AKIA) ou temporária (ASIA).
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, REDACTED],
  // Senha embutida em URL, como postgresql://usuario:senha@host/banco.
  [/(\b[a-z][\w+.-]*:\/\/[^\s:/?#@]+:)[^\s@/?#]+@/gi, `$1${REDACTED}@`],
];

/**
 * Segredos vivos: valores que este processo segura por um instante (a senha temporária lida do Secret Manager, no
 * cp-worker, e repassada ao site, no cp-public). Quem recebe o valor registra antes de qualquer `await`, e quem o
 * entrega esquece no fim da resposta (`forgetLiveSecret`): o conjunto não cresce a cada revelação. Valores curtos
 * ficam de fora, para não ocultar pedaços de texto comum (a senha temporária do nó tem 23 caracteres).
 */
const liveSecrets = new Set<string>();
export const MIN_LIVE_SECRET_LENGTH = 16;

/** Passa a ocultar este valor em toda linha de log e em todo `details` da auditoria deste processo. */
export function registerLiveSecret(value: string): void {
  if (value.length >= MIN_LIVE_SECRET_LENGTH) liveSecrets.add(value);
}

/** Deixa de guardar o valor (no fim da resposta que o entregou). */
export function forgetLiveSecret(value: string): void {
  liveSecrets.delete(value);
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
  for (const liveValue of liveSecrets) {
    if (text.includes(liveValue)) text = text.replaceAll(liveValue, REDACTED);
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
