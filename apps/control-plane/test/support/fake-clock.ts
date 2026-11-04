import type { Clock } from '../../src/common/clock.js';

/** Relógio controlado pelo teste: começa numa data fixa e só anda quando o teste manda. */
export class FakeClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date('2026-11-04T12:00:00.000Z')) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

export const MINUTE_MS = 60_000;
