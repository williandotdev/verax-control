import { z } from 'zod';
import { type Cidr, cidrContains, parseCidr, parseIp } from './ip.js';

/**
 * Fontes confiáveis declaradas pelo cliente (monitor, escritório, parceiro, pentest, proxy), como entrada pura.
 *
 * - Calam só 990401, 990402, 990404 e 990405 (e o 990411, depois), **antes** de virarem achado e com contador à vista.
 *   Nunca o 990403, o 990406 nem o 990407: o acesso que deu certo e o ataque distribuído aparecem sempre.
 * - Só faixa CIDR isenta alguém; o User-Agent, nunca.
 * - Pisos: nada mais largo que /16 (IPv4) ou /32 (IPv6). No IPv6, nada mais estreito que /64: a contagem é por /64, e uma
 *   isenção menor que a chave calaria o /64 inteiro de quem divide a rede.
 * - Validade de até 365 dias. Vencida, não vale; fora dos pisos, é recusada e não cala nada.
 */
export const TRUSTED_KINDS = ['monitor', 'office', 'partner', 'pentest', 'proxy'] as const;
export type TrustedKind = (typeof TRUSTED_KINDS)[number];

export const MAX_TRUSTED = 200;
const MAX_VALIDITY_MS = 365 * 24 * 60 * 60_000;

export const webTrustedSourceSchema = z.strictObject({
  id: z.string().min(1).max(64),
  cidr: z
    .string()
    .max(49)
    .refine((value) => trustedCidr(value) !== null, {
      error: 'faixa inválida: IPv4 de /16 a /32, IPv6 de /32 a /64, sem bit de máquina',
    }),
  kind: z.enum(TRUSTED_KINDS),
  reason: z.string().min(1).max(200),
  expiresAt: z.iso.datetime(),
});
export type WebTrustedSource = z.infer<typeof webTrustedSourceSchema>;

function trustedCidr(text: string): Cidr | null {
  const cidr = parseCidr(text);
  if (cidr === null) return null;
  if (cidr.version === 4) return cidr.prefix >= 16 ? cidr : null;
  return cidr.prefix >= 32 && cidr.prefix <= 64 ? cidr : null;
}

export class TrustedSources {
  /** As faixas dos proxies do cliente (a classe `customer_proxy`). */
  readonly proxies: readonly Cidr[];
  /** Entradas recusadas (a faixa, a validade ou o formato): não valem, e quem chama mostra. */
  readonly rejected: readonly string[];
  private readonly active: readonly { id: string; cidr: Cidr }[];

  constructor(sources: readonly WebTrustedSource[], now: number) {
    const active: { id: string; cidr: Cidr }[] = [];
    const proxies: Cidr[] = [];
    const rejected: string[] = [];
    for (const source of sources.slice(0, MAX_TRUSTED)) {
      const parsed = webTrustedSourceSchema.safeParse(source);
      const cidr = parsed.success ? trustedCidr(parsed.data.cidr) : null;
      const until = parsed.success ? Date.parse(parsed.data.expiresAt) : NaN;
      if (cidr === null || !(until - now <= MAX_VALIDITY_MS)) {
        rejected.push(String(source.id).slice(0, 64));
        continue;
      }
      if (until <= now) continue;
      if (source.kind === 'proxy') proxies.push(cidr);
      else active.push({ id: source.id, cidr });
    }
    for (const source of sources.slice(MAX_TRUSTED)) rejected.push(String(source.id).slice(0, 64));
    this.active = active;
    this.proxies = proxies;
    this.rejected = rejected;
  }

  /** A fonte confiável do endereço, ou null. */
  sourceOf(ip: string): string | null {
    const parsed = parseIp(ip);
    if (parsed === null) return null;
    return this.active.find(({ cidr }) => cidrContains(cidr, parsed))?.id ?? null;
  }
}
