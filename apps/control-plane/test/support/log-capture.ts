import type { DestinationStream } from 'pino';

/** Destino do pino que guarda cada linha em memória, para os testes inspecionarem o que seria logado. */
export class LogCapture implements DestinationStream {
  readonly lines: string[] = [];

  write(line: string): void {
    this.lines.push(line);
  }

  get text(): string {
    return this.lines.join('');
  }

  entries(): Record<string, unknown>[] {
    return this.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
