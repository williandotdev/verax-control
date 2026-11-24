import { decimal, every, isAlnum, isDigit, isHex, isLower, isPrintable } from '../ascii.js';
import { parseIp } from '../ip.js';

/**
 * Chave de um objeto de log de acesso do ALB, pela gramática da documentação da AWS e mais nada:
 *
 * `[prefixo/]AWSLogs/<conta>/elasticloadbalancing/<região>/<aaaa>/<mm>/<dd>/`
 * `<conta>_elasticloadbalancing_<região>_app.<nome>.<id>_<AAAAMMDDTHHmmZ>_<ip do nó>_<aleatório>.log.gz`
 *
 * - A pasta do dia é a da **entrega**, não a do tráfego: só a sintaxe dela é conferida, e o horário vem do nome.
 * - Objeto plantado no bucket (outra conta, outro balanceador, outro prefixo, `..`, caractere fora do conjunto) não passa:
 *   quem chama compara com o que espera (`expect`).
 * - Os logs de conexão e de health check são outros tipos de log, e o nome deles não foi conferido ([?] no desenho): só
 *   passa o `<conta>_elasticloadbalancing_<região>_app.` exato, começando o nome do arquivo.
 */
export interface AlbObjectKey {
  key: string;
  /** O prefixo do bucket, sem a barra do fim; vazio quando não há. */
  prefix: string;
  accountId: string;
  region: string;
  lbName: string;
  lbId: string;
  /** `app/<nome>/<id>`: o mesmo texto do campo `elb` de cada linha. */
  loadBalancer: string;
  /** O fim do intervalo de 5 minutos do arquivo. */
  endMs: number;
  nodeIp: string;
}

export interface AlbKeyExpectation {
  prefix: string;
  accountId: string;
  region: string;
  loadBalancer: string;
}

const MAX_KEY = 512;

const isRegionChar = (code: number): boolean => isLower(code) || isDigit(code) || code === 45;
const isNameChar = (code: number): boolean => isAlnum(code) || code === 45;
const isPrefixChar = (code: number): boolean => isPrintable(code) && code !== 0x20 && code !== 0x22;

function dayIsValid(year: string, month: string, day: string): boolean {
  if (year.length !== 4 || month.length !== 2 || day.length !== 2) return false;
  const [y, m, d] = [decimal(year, 4), decimal(month, 2), decimal(day, 2)];
  return y >= 2000 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** `20261124T1005Z` em milissegundos, ou -1. */
function endTime(text: string): number {
  if (text.length !== 14 || text[8] !== 'T' || text[13] !== 'Z') return -1;
  const [year, month, day, hour, minute] = [
    decimal(text.slice(0, 4), 4),
    decimal(text.slice(4, 6), 2),
    decimal(text.slice(6, 8), 2),
    decimal(text.slice(9, 11), 2),
    decimal(text.slice(11, 13), 2),
  ];
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return -1;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return -1;
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  // 31 de fevereiro não vira 3 de março.
  return new Date(ms).getUTCDate() === day ? ms : -1;
}

export function parseAlbKey(key: string): AlbObjectKey | null {
  if (key.length > MAX_KEY) return null;
  const root = key.startsWith('AWSLogs/') ? 0 : key.indexOf('/AWSLogs/') + 1;
  if (root === 0 && !key.startsWith('AWSLogs/')) return null;
  const prefix = root === 0 ? '' : key.slice(0, root - 1);
  if (prefix !== '' && !every(prefix, isPrefixChar)) return null;
  const parts = key.slice(root).split('/');
  if (parts.length !== 8) return null;
  const [, accountId = '', service, region = '', year = '', month = '', day = '', file = ''] = parts;
  if (accountId.length !== 12 || !every(accountId, isDigit)) return null;
  if (service !== 'elasticloadbalancing') return null;
  if (region.length < 5 || region.length > 25 || !every(region, isRegionChar)) return null;
  if (!dayIsValid(year, month, day)) return null;

  const head = `${accountId}_elasticloadbalancing_${region}_app.`;
  if (!file.startsWith(head) || !file.endsWith('.log.gz')) return null;
  // `<nome>.<id>_<horário>_<ip>_<aleatório>`: nem o nome nem o id têm `_`.
  const fields = file.slice(head.length, -'.log.gz'.length).split('_');
  if (fields.length !== 4) return null;
  const [balancer = '', time = '', nodeIp = '', random = ''] = fields;
  const dot = balancer.indexOf('.');
  const lbName = balancer.slice(0, Math.max(dot, 0));
  const lbId = balancer.slice(dot + 1);
  if (lbName.length > 32 || !every(lbName, isNameChar)) return null;
  if (lbId.length !== 16 || !every(lbId, isHex)) return null;
  const endMs = endTime(time);
  if (endMs < 0 || parseIp(nodeIp) === null) return null;
  if (random.length > 32 || !every(random, isAlnum)) return null;
  return {
    key,
    prefix,
    accountId,
    region,
    lbName,
    lbId,
    loadBalancer: `app/${lbName}/${lbId}`,
    endMs,
    nodeIp,
  };
}

/** A chave é do balanceador autorizado, e só dele. */
export function matchesExpectation(key: AlbObjectKey, expect: AlbKeyExpectation): boolean {
  return (
    key.prefix === expect.prefix &&
    key.accountId === expect.accountId &&
    key.region === expect.region &&
    key.loadBalancer === expect.loadBalancer
  );
}
