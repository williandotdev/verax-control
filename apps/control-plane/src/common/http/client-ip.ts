import { BlockList, isIP } from 'node:net';
import type { AppConfig } from '../config/config.module.js';

/** A função que o Express aceita em `trust proxy`: endereço e a posição dele, contada do contêiner (0 = o socket). */
export type TrustProxy = (address: string, hop: number) => boolean;

const IPV4_MAPPED_PREFIX = '::ffff:';

/** `::ffff:a.b.c.d` (IPv4 mapeado em IPv6, como chega num socket dual-stack) vira `a.b.c.d`. */
function normalize(address: string): string {
  if (!address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)) return address;
  const rest = address.slice(IPV4_MAPPED_PREFIX.length);
  return isIP(rest) === 4 ? rest : address;
}

/**
 * Regra do IP do cliente atrás do Firebase Hosting e do Cloud Run (decisão documentada em `env.schema.ts`,
 * TRUST_PROXY_HOPS e TRUSTED_PROXIES). O Express percorre o X-Forwarded-For de trás para a frente, começando pelo
 * socket, e para no primeiro endereço não confiável: é ele o `req.ip`. São confiáveis os `TRUST_PROXY_HOPS`
 * primeiros saltos (no Cloud Run, só o front end dele) e, em qualquer posição, os endereços de `TRUSTED_PROXIES`
 * (as saídas do Hosting). Um endereço que não é IP (lixo no cabeçalho) nunca é confiável.
 */
export function buildTrustProxy(config: Pick<AppConfig, 'TRUST_PROXY_HOPS' | 'TRUSTED_PROXIES'>): TrustProxy {
  const trusted = new BlockList();
  for (const entry of config.TRUSTED_PROXIES ?? []) {
    const [address = entry, prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) trusted.addAddress(address, family);
    else trusted.addSubnet(address, Number(prefix), family);
  }
  const hops = config.TRUST_PROXY_HOPS;
  return (address, hop) => {
    if (hop < hops) return true;
    const normalized = normalize(address);
    const version = isIP(normalized);
    return version !== 0 && trusted.check(normalized, version === 6 ? 'ipv6' : 'ipv4');
  };
}
