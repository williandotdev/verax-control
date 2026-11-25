import type { Prisma } from '../../generated/prisma/client.js';
import { objectHash } from '../../usage/aws-volume.js';
import type { TrafficDelta, WebTrafficStore } from './web-traffic-store.js';

/**
 * O registro dos objetos do log do ALB já tratados (`WebLogObject`): é o que faz cada objeto contar uma vez só, no volume
 * medido e no tráfego por país. Guarda o hash do bucket e da chave, nunca a chave. Sai depois de 10 dias
 * (`retention/retention-policy.ts`), bem além do atraso que a leitura alcança (24 h).
 */

/** `read` e `late` foram analisados (o `late` depois de a janela fechar); `quarantined` e `gap`, não. */
export const WEB_LOG_OBJECT_STATUSES = ['read', 'late', 'quarantined', 'gap'] as const;
export type WebLogObjectStatus = (typeof WEB_LOG_OBJECT_STATUSES)[number];

export interface WebLogObjectRecord {
  tenantId: string;
  cloudAccountId: string;
  sourceId: string;
  bucket: string;
  key: string;
  status: WebLogObjectStatus;
  /** O começo do intervalo de 5 minutos; null só no objeto não analisado cujo nome não o diz. */
  slotStart: Date | null;
  lines: number;
  /** Descompactados, os que contam no plano. */
  bytes: number;
  malformed: number;
  oversize: number;
  foreign: number;
  /** Quando foi tratado; sem ele, a hora do banco. */
  readAt?: Date;
}

/**
 * Grava a linha do objeto e, só se ela é nova, soma o tráfego dele, na transação do chamador. `false`: o objeto já foi
 * tratado (uma releitura, ou outra réplica), e nada foi somado. O volume medido (`UsageMeter.flushIn`) entra na mesma
 * transação, também só com `true`: se algo falhar, nada fica, e a releitura faz tudo de novo.
 *
 * O objeto não analisado não traz tráfego: as linhas dele não foram lidas.
 */
export async function settleWebLogObject(
  tx: Prisma.TransactionClient,
  traffic: Pick<WebTrafficStore, 'add'>,
  object: WebLogObjectRecord,
  deltas: readonly TrafficDelta[],
): Promise<boolean> {
  const { bucket, key, ...row } = object;
  const analysed = object.status === 'read' || object.status === 'late';
  if (!analysed && deltas.length > 0) throw new Error('objeto não analisado não soma tráfego');
  for (const delta of deltas) {
    if (delta.tenantId !== object.tenantId || delta.sourceId !== object.sourceId) {
      throw new Error('o tráfego não é do balanceador do objeto');
    }
  }
  const { count } = await tx.webLogObject.createMany({
    data: [{ ...row, bytes: BigInt(object.bytes), objectHash: objectHash(bucket, key) }],
    skipDuplicates: true,
  });
  if (count === 0) return false;
  await traffic.add(tx, deltas);
  return true;
}

/**
 * Registra objetos que ficaram sem leitura (`gap`): não são analisados, medidos nem somados, e não voltam a ser vistos como
 * novos. Devolve quantos ainda não estavam no registro.
 */
export async function settleWebLogGaps(
  tx: Prisma.TransactionClient,
  objects: readonly Omit<
    WebLogObjectRecord,
    'status' | 'lines' | 'bytes' | 'malformed' | 'oversize' | 'foreign'
  >[],
): Promise<number> {
  if (objects.length === 0) return 0;
  const { count } = await tx.webLogObject.createMany({
    data: objects.map(({ bucket, key, ...row }) => ({
      ...row,
      status: 'gap',
      objectHash: objectHash(bucket, key),
    })),
    skipDuplicates: true,
  });
  return count;
}
