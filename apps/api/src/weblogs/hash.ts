import { hash } from 'node:crypto';

/**
 * Hash de 32 bits com chave aleatória por processo, para as contagens de valores distintos (caminhos e User-Agents).
 * A chave impede que alguém de fora monte caminhos que colidem (e façam uma enumeração parecer um caminho só). Não é
 * identidade de nada: nunca é gravado, e muda a cada processo. Colisão por acaso: com 512 valores, cerca de 1 em 33 mil.
 */
export class KeyedHash {
  private readonly key: string;

  /** A chave vem de fora (`randomBytes(16)` na tarefa): o motor fica determinístico nos testes. */
  constructor(key: Uint8Array) {
    if (key.length < 16) throw new Error('weblogs: a chave do hash precisa de 16 bytes');
    this.key = Buffer.from(key).toString('hex');
  }

  of(text: string): number {
    return hash('sha256', this.key + text, 'buffer').readInt32LE(0);
  }
}

/**
 * Conjunto de inteiros de 32 bits em endereçamento aberto, com teto. Cresce em dobro a partir de 32 posições e para de
 * aceitar valor novo no teto (`full`): a contagem vira piso.
 */
export class IntSet {
  private table = new Int32Array(32);
  private count = 0;
  private hasZero = false;
  full = false;
  readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get size(): number {
    return this.count;
  }

  /** Posições na memória (4 bytes cada). */
  get cells(): number {
    return this.table.length;
  }

  add(value: number): void {
    // O zero marca posição vazia na tabela: é guardado à parte.
    if (value === 0) {
      if (!this.hasZero && this.admit()) this.hasZero = true;
      return;
    }
    const mask = this.table.length - 1;
    let at = value & mask;
    for (;;) {
      const held = this.table[at];
      if (held === value) return;
      if (held === 0) break;
      at = (at + 1) & mask;
    }
    if (!this.admit()) return;
    this.table[at] = value;
    if (this.count * 2 > this.table.length) this.grow();
  }

  private admit(): boolean {
    if (this.count >= this.cap) {
      this.full = true;
      return false;
    }
    this.count += 1;
    return true;
  }

  private grow(): void {
    const old = this.table;
    const next = new Int32Array(old.length * 2);
    const mask = next.length - 1;
    for (const value of old) {
      if (value === 0) continue;
      let at = value & mask;
      while (next[at] !== 0) at = (at + 1) & mask;
      next[at] = value;
    }
    this.table = next;
  }

  addTo(target: Set<number>): void {
    if (this.hasZero) target.add(0);
    for (const value of this.table) if (value !== 0) target.add(value);
  }
}
