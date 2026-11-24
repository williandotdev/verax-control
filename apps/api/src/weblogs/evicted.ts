/**
 * Os clientes que saíram da memória de uma rota de login, num slot: o hash com chave do cliente e as falhas dele. É o que
 * deixa a 990407 dizer a verdade sobre quem saiu: cada cliente conta **uma vez** na janela, e só se a soma dele, com o que
 * ficou na memória e nos outros slots, não passar de 20 falhas.
 *
 * Cabe pouco (5 bytes por posição), e o orçamento é comum a todas as rotas. No teto, o registro **maior** é raleado: fica
 * metade dos hashes, escolhida pelos bits altos (`shift`). Quem fica tem a soma exata; quem sai, sai de todos os slots pelo
 * mesmo critério, e a contagem da janela é a da amostra vezes `2^shift`. Assim:
 *
 * - encher o registro de uma rota não tira o lugar das outras (quem é raleado é o maior);
 * - a amostra não é escolha do atacante: o hash tem chave aleatória por processo;
 * - um cliente nunca aparece com menos falhas do que teve, então um barulhento não passa por discreto.
 *
 * Colisão de hash (32 bits): com 20 mil clientes, espera-se 0,05. Ela junta dois clientes num só (conta um a menos).
 */
export const MIN_LEDGER_CELLS = 32;
const SATURATED = 255;

/** O hash está na amostra do nível dado: os `shift` bits altos são zero. */
export const isSampled = (tag: number, shift: number): boolean => shift === 0 || tag >>> (32 - shift) === 0;

export class EvictedLedger {
  /** Quantas vezes foi raleado. */
  shift = 0;
  private count = 0;
  /** O zero marca posição vazia: o hash 0 nunca é usado (`WebTally.tagOf`). */
  private tags = new Int32Array(MIN_LEDGER_CELLS);
  private failures = new Uint8Array(MIN_LEDGER_CELLS);

  get cells(): number {
    return this.tags.length;
  }

  get size(): number {
    return this.count;
  }

  /** Soma as falhas do cliente. False: é um cliente novo e não há lugar (crescer ou ralear antes). */
  add(tag: number, failures: number): boolean {
    const mask = this.tags.length - 1;
    let at = tag & mask;
    for (;;) {
      const held = this.tags[at];
      if (held === tag) {
        this.failures[at] = Math.min(SATURATED, (this.failures[at] ?? 0) + failures);
        return true;
      }
      if (held === 0) break;
      at = (at + 1) & mask;
    }
    if (this.count * 2 >= this.tags.length) return false;
    this.tags[at] = tag;
    this.failures[at] = Math.min(SATURATED, failures);
    this.count += 1;
    return true;
  }

  *entries(): Generator<readonly [tag: number, failures: number]> {
    for (let at = 0; at < this.tags.length; at += 1) {
      const tag = this.tags[at] ?? 0;
      if (tag !== 0) yield [tag, this.failures[at] ?? 0];
    }
  }

  /** Dobra a tabela. */
  grow(): void {
    this.rebuild(this.tags.length * 2);
  }

  /** Fica com a metade dos hashes e encolhe a tabela. Devolve quantas posições liberou. */
  thin(): number {
    const before = this.tags.length;
    this.shift += 1;
    let kept = 0;
    for (const [tag] of this.entries()) if (isSampled(tag, this.shift)) kept += 1;
    let size = MIN_LEDGER_CELLS;
    while (kept * 2 >= size) size *= 2;
    this.rebuild(Math.min(size, before));
    return before - this.tags.length;
  }

  private rebuild(size: number): void {
    const held = [...this.entries()].filter(([tag]) => isSampled(tag, this.shift));
    this.tags = new Int32Array(size);
    this.failures = new Uint8Array(size);
    this.count = 0;
    for (const [tag, failures] of held) this.add(tag, failures);
  }
}
