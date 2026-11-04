import { isIP } from 'node:net';
import type { Clock } from '../clock.js';

/** `capacity` pedidos de uma vez e, depois, `capacity` por `windowMs`, repostos aos poucos (token bucket). */
export interface RateLimitRule {
  capacity: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Segundos até haver um pedido disponível de novo (0 quando liberado). Vai no cabeçalho `Retry-After`. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Teto de chaves guardadas: além dele, saem primeiro os baldes cheios e, se preciso, os mais antigos. */
const DEFAULT_MAX_KEYS = 10_000;
/** Folga de ponto flutuante na reposição (um pedido inteiro que chegou como 0,9999999999). */
const TOKEN_EPSILON = 1e-9;

/**
 * Limite por chave (o IP do cliente) em memória, por instância do serviço (plano §2.3): com 2 instâncias o limite
 * efetivo dobra, o que o plano aceita; o teto diário global fica no Firestore. Nada é gravado fora da memória, e o IP
 * nunca vai a log por aqui. A memória é limitada: um balde cheio equivale a um balde novo e pode sair a qualquer
 * hora, e a ordem do `Map` (atualizada a cada uso) dá o mais antigo.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly clock: Clock,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
  ) {
    if (!Number.isInteger(rule.capacity) || rule.capacity < 1 || rule.windowMs <= 0) {
      throw new RangeError('limite inválido');
    }
  }

  take(key: string): RateLimitDecision {
    const now = this.clock.now().getTime();
    const bucket = this.refill(this.buckets.get(key), now);
    this.buckets.delete(key);
    if (bucket.tokens + TOKEN_EPSILON >= 1) {
      this.buckets.set(key, { tokens: Math.max(0, bucket.tokens - 1), updatedAt: now });
      this.evict(now);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    this.buckets.set(key, bucket);
    this.evict(now);
    const waitMs = ((1 - bucket.tokens) * this.rule.windowMs) / this.rule.capacity;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  /** Quantas chaves estão guardadas (para os testes do teto de memória). */
  get size(): number {
    return this.buckets.size;
  }

  private refill(bucket: Bucket | undefined, now: number): Bucket {
    if (bucket === undefined) return { tokens: this.rule.capacity, updatedAt: now };
    const elapsed = Math.max(0, now - bucket.updatedAt);
    const refilled = bucket.tokens + (elapsed * this.rule.capacity) / this.rule.windowMs;
    return { tokens: Math.min(this.rule.capacity, refilled), updatedAt: now };
  }

  private evict(now: number): void {
    if (this.buckets.size <= this.maxKeys) return;
    for (const [key, bucket] of this.buckets) {
      if (this.refill(bucket, now).tokens + TOKEN_EPSILON >= this.rule.capacity) this.buckets.delete(key);
    }
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

const IPV4_MAPPED_PREFIX = '::ffff:';

/** Os quatro primeiros grupos (o /64) de um IPv6 sem `::` comprimido nem zona; `undefined` se não der para expandir. */
function ipv6Prefix64(address: string): string | undefined {
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] === '' || halves[0] === undefined ? [] : halves[0].split(':');
  const tail = halves.length === 2 && halves[1] !== '' && halves[1] !== undefined ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'), ...tail];
  return groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group, 16).toString(16))
    .join(':');
}

/**
 * A chave do limite por IP. IPv4 (inclusive mapeado em IPv6) é o próprio endereço; IPv6 conta pelo /64, o bloco que
 * um provedor entrega a um assinante: sem isso, quem tem um /64 trocaria de endereço a cada pedido e nunca seria
 * limitado. Sem IP (não deveria acontecer atrás do Cloud Run), todos caem num balde só.
 */
export function rateLimitKey(ip: string | undefined): string {
  if (ip === undefined) return 'sem-ip';
  const address = ip.split('%', 1)[0] ?? ip;
  if (
    address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX) &&
    isIP(address.slice(IPV4_MAPPED_PREFIX.length)) === 4
  ) {
    return address.slice(IPV4_MAPPED_PREFIX.length);
  }
  const version = isIP(address);
  if (version === 4) return address;
  if (version === 6 && !address.includes('.')) {
    const prefix = ipv6Prefix64(address.toLowerCase());
    if (prefix !== undefined) return `${prefix}::/64`;
  }
  return address;
}
