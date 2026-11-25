import type { CaseQueue } from '../generated/prisma/client.js';
import { type CaseFold, type CaseKey, type CaseKeyPart, NETWORK_PART } from './case-key.js';

/**
 * Os limites de abertura de casos. Só valem na hora de abrir: o alerta que tem caso aberto na chave dele sempre entra
 * nele. Contam as aberturas das 24 h anteriores à chegada do alerta.
 *
 * - **Fan-out**: quem troca de rede de origem abriria um caso por rede. Passados 8 casos da mesma família, conta e alvo
 *   (a chave sem a rede) com rede da internet, o seguinte vai para um caso `distributed`. Não vale para origem privada
 *   (a rede interna do cliente não é rotativa), para item da lista de proteção nem, até 100 casos, para o crítico; do
 *   101º em diante, o crítico vai para um caso `overflow`, separado do dos altos.
 * - **Teto da fila**: com 40 casos na fila de detecção ou de postura, a chave de severidade média ou baixa que abriria
 *   outro vai para um caso por fonte (`rollup`). O alto e o crítico nunca: o teto é um alvo, não um corte. Na fila de
 *   vulnerabilidade não há teto (decisão D1 de 24/11/2026: pacote e recurso literais, e a tela agrupa). Item da lista de
 *   proteção também não entra no `rollup`.
 */
export const LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FAN_OUT_LIMIT = 8;
export const FAN_OUT_CRITICAL_LIMIT = 100;
export const QUEUE_SOFT_CAP = 40;

/** As filas com teto, e as únicas cujas aberturas os limites precisam ler. */
export const LIMITED_QUEUES = ['detection', 'posture'] as const satisfies readonly CaseQueue[];

/** Uma abertura de caso, do banco ou deste lote. */
export interface CaseOpening {
  queue: CaseQueue;
  openedAt: Date;
  /** O grupo do fan-out (`fanOutGroup`), ou null se o caso não tem rede da internet na chave. */
  group: string | null;
}

/**
 * O grupo do fan-out de um caso: a família, a conta e as partes sem a rede. Null sem rede da internet na chave (a rede
 * privada é o endereço exato, sem a máscara).
 */
export function fanOutGroup(family: string, accountId: string, parts: readonly CaseKeyPart[]): string | null {
  const network = parts.find((part) => part.name === NETWORK_PART);
  if (network === undefined || !network.value.includes('/')) return null;
  return JSON.stringify([
    family,
    accountId,
    ...parts.filter((part) => part.name !== NETWORK_PART).map((part) => [part.name, part.value]),
  ]);
}

/** As aberturas recentes de um cliente: as do banco mais as que o lote vai fazendo. */
export class RecentOpenings {
  private readonly openings: CaseOpening[];

  constructor(openings: readonly CaseOpening[] = []) {
    this.openings = [...openings];
  }

  add(opening: CaseOpening): void {
    this.openings.push(opening);
  }

  inQueue(queue: CaseQueue, arrival: Date): number {
    return this.count(arrival, (opening) => opening.queue === queue);
  }

  inGroup(group: string, arrival: Date): number {
    return this.count(arrival, (opening) => opening.group === group);
  }

  private count(arrival: Date, matches: (opening: CaseOpening) => boolean): number {
    const until = arrival.getTime();
    return this.openings.filter(
      (opening) =>
        matches(opening) &&
        opening.openedAt.getTime() <= until &&
        opening.openedAt.getTime() > until - LIMIT_WINDOW_MS,
    ).length;
  }
}

/** As reuniões para onde um alerta pode ir: quem lê o banco antes de decidir busca os casos abertos delas. */
export function possibleFolds(key: CaseKey, accountId: string): CaseFold[] {
  if (fanOutGroup(key.family, accountId, key.parts) !== null) return ['distributed', 'overflow'];
  return key.tier === 'ml' ? ['rollup'] : [];
}

/** Para qual caso reunido vai o alerta cuja chave precisaria abrir um caso; null se ele abre o próprio. */
export function foldFor(
  key: CaseKey,
  alert: { accountId: string; severity: string; isProtected: boolean },
  arrival: Date,
  openings: RecentOpenings,
): CaseFold | null {
  if (alert.isProtected) return null;
  const group = fanOutGroup(key.family, alert.accountId, key.parts);
  if (group !== null) {
    const critical = alert.severity === 'critical';
    const limit = critical ? FAN_OUT_CRITICAL_LIMIT : FAN_OUT_LIMIT;
    if (openings.inGroup(group, arrival) < limit) return null;
    return critical ? 'overflow' : 'distributed';
  }
  if (key.tier !== 'ml') return null;
  return openings.inQueue(key.queue, arrival) >= QUEUE_SOFT_CAP ? 'rollup' : null;
}
