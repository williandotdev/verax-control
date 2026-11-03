import { BlockList, isIP } from 'node:net';
import type { AlertExceptionField } from '@verax/shared';
import type { FindingDraft } from './finding-draft.js';

/** Exceção de alerta do cliente (T3.5), como o sync a compara. */
export interface ActiveException {
  id: string;
  ruleId: string;
  field: AlertExceptionField;
  value: string;
  expiresAt: Date | null;
}

type MatchedFields = Pick<FindingDraft, 'ruleId' | 'actorUser' | 'sourceIp' | 'resource'>;

/** IP dentro do IP ou da faixa CIDR da exceção, pela lista de bloqueio do próprio Node (sem regex nem pacote). */
function ipMatches(rule: string, ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const [base = '', prefix] = rule.split('/');
  if (isIP(base) !== family) return false;
  const list = new BlockList();
  if (prefix === undefined) {
    list.addAddress(base, type);
  } else {
    const bits = Number(prefix);
    if (!Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128)) return false;
    list.addSubnet(base, bits, type);
  }
  return list.check(ip, type);
}

function fieldMatches(exception: ActiveException, finding: MatchedFields): boolean {
  switch (exception.field) {
    case 'user':
      return finding.actorUser === exception.value;
    case 'resource':
      return finding.resource === exception.value;
    case 'ip':
      return finding.sourceIp !== null && ipMatches(exception.value, finding.sourceIp);
  }
}

/**
 * A exceção que marca o achado como esperado (T3.5): mesma regra do Wazuh, dentro da validade e com o usuário, o
 * recurso (iguais) ou o IP (dentro da faixa) do achado. As exceções chegam na ordem de criação, e vale a primeira.
 */
export function matchingException(
  finding: MatchedFields,
  exceptions: readonly ActiveException[],
  now: Date,
): ActiveException | null {
  for (const exception of exceptions) {
    if (exception.ruleId !== finding.ruleId) continue;
    if (exception.expiresAt !== null && exception.expiresAt.getTime() <= now.getTime()) continue;
    if (fieldMatches(exception, finding)) return exception;
  }
  return null;
}
