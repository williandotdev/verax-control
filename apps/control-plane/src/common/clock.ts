/**
 * Relógio injetável: todo carimbo de tempo gravado no Firestore (`updatedAt`, `lock.expiresAt`, `expiresAt` do
 * TTL) sai daqui, e não de `new Date()`, para os testes de prazo (lock vencida, carência, D+30, D+97) andarem o
 * tempo sem esperar. O Firestore não grava `serverTimestamp` de propósito: a comparação de prazos é feita pelo
 * app, com o mesmo relógio que escreveu.
 */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
