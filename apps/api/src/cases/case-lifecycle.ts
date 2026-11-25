import type { CaseQueue } from '../generated/prisma/client.js';

/**
 * Quando um alerta entra no caso aberto da chave dele e quando esse caso é selado e outro abre.
 *
 * Tudo pelo **horário de chegada** do alerta no servidor (`Finding.createdAt`, nunca depois do relógio de agora), e
 * nunca pelo horário do log, que quem ataca pode escrever. Como a chegada fica gravada, o resultado é o mesmo com o
 * alerta atribuído na hora, no histórico ou depois de uma volta de versão: a tarefa parada não junta nem parte casos.
 */

const HOUR_MS = 60 * 60 * 1000;
/** Silêncio máximo entre dois alertas do mesmo caso de detecção. */
export const CASE_SILENCE_MS = 24 * HOUR_MS;
/** Idade máxima de um caso de detecção ao receber um alerta. */
export const CASE_AGE_MS = 7 * 24 * HOUR_MS;

/** Por que a atribuição sela um caso (o `split` é de quem divide, noutra parte). */
export type CaseSealReason = 'window' | 'treated' | 'idle';

/** O que decide se o caso aberto ainda recebe alerta. */
export interface OpenCaseState {
  queue: CaseQueue;
  openedAt: Date;
  lastAlertAt: Date;
  /** Há alerta pendente (fora de incidente, novo ou em análise). */
  pending: boolean;
  /** Algum alerta dele, ou o próprio caso, está num incidente que não foi resolvido. */
  promoted: boolean;
  /** Algum alerta dele foi tratado: legítimo, resolvido ou num incidente. */
  treated: boolean;
}

/** A chegada do alerta no servidor. O relógio que voltou (chegada no futuro) não estica a janela. */
export function arrivalOf(createdAt: Date, now: Date): Date {
  return createdAt.getTime() > now.getTime() ? now : createdAt;
}

/**
 * O motivo para selar o caso aberto antes do alerta que chegou, ou null se o alerta entra nele:
 * - **sem nada pendente** (e sem incidente aberto), o caso já acabou e nunca engole um alerta novo: `treated` se alguém
 *   tratou o que ele tem (inclusive com o incidente já resolvido), `idle` se ele não tem mais alerta nenhum;
 * - **detecção**: mais de 24 h sem alerta, ou mais de 7 dias de idade, é `window` (o caso continua pendente e listado).
 *   Vale também para o caso em análise ou promovido: um caso esquecido não engole alertas para sempre;
 * - **vulnerabilidade e postura** não têm janela: o caso fica aberto até ser tratado.
 *
 * O caso em análise e o promovido com incidente aberto, dentro da janela, continuam recebendo os alertas (como novos).
 */
export function sealReasonFor(open: OpenCaseState, arrival: Date): CaseSealReason | null {
  if (!open.pending && !open.promoted) return open.treated ? 'treated' : 'idle';
  if (open.queue !== 'detection') return null;
  const silence = arrival.getTime() - open.lastAlertAt.getTime();
  const age = arrival.getTime() - open.openedAt.getTime();
  return silence > CASE_SILENCE_MS || age > CASE_AGE_MS ? 'window' : null;
}
