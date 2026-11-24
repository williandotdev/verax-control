import { MAX_LINE_CHARS } from './alb/alb-line.js';

/**
 * Separa em linhas os pedaços descompactados de um objeto, sem nunca guardar mais que uma linha. Os bytes viram texto em
 * latin1 (um byte, um caractere): byte fora do UTF-8 não quebra nada, e o que não é ASCII é mascarado adiante. A linha
 * maior que 64 KB é pulada inteira e contada.
 */
export class LineSplitter {
  oversize = 0;
  private rest = '';
  private skipping = false;
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let at = 0;
    for (;;) {
      const end = bytes.indexOf(10, at);
      const stop = end < 0 ? bytes.length : end;
      this.take(bytes, at, stop);
      if (end < 0) return;
      this.flush();
      at = end + 1;
    }
  }

  /** O fim do objeto: a última linha pode não ter quebra. */
  end(): void {
    if (this.rest !== '' || this.skipping) this.flush();
  }

  private take(bytes: Buffer, from: number, to: number): void {
    if (this.skipping || from === to) return;
    if (this.rest.length + (to - from) > MAX_LINE_CHARS) {
      this.skipping = true;
      this.rest = '';
      return;
    }
    const text = bytes.toString('latin1', from, to);
    this.rest = this.rest === '' ? text : this.rest + text;
  }

  private flush(): void {
    const line = this.rest.endsWith('\r') ? this.rest.slice(0, -1) : this.rest;
    this.rest = '';
    if (this.skipping) {
      this.skipping = false;
      this.oversize += 1;
      return;
    }
    if (line !== '') this.onLine(line);
  }
}
