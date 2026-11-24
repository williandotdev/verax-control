/** Quanto o valor vale e quantos clientes cabem. */
export interface TenantCacheOptions {
  ttlMs: number;
  maxTenants: number;
  now?: () => number;
}

interface Entry<T> {
  value: Promise<T>;
  /** Ainda sendo calculado: quem chega espera o mesmo cálculo, mesmo depois da validade. */
  pending: boolean;
  expiresAt: number;
}

/**
 * Memória curta, por cliente e por processo, de um cálculo caro que muitos painéis pedem ao mesmo tempo. Quem chama dá
 * o cliente do escopo da sessão (nunca um id do request), e o cálculo roda nesse mesmo escopo: um cliente nunca recebe o
 * valor de outro. Vários pedidos juntos fazem um cálculo só; o que falha não fica guardado. O tamanho é limitado: passa
 * do limite, sai o mais antigo.
 */
export class TenantCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxTenants: number;
  private readonly now: () => number;

  constructor({ ttlMs, maxTenants, now = () => performance.now() }: TenantCacheOptions) {
    if (!(ttlMs >= 0) || !Number.isInteger(maxTenants) || maxTenants < 1) {
      throw new Error('validade e tamanho da memória por cliente precisam ser positivos');
    }
    this.ttlMs = ttlMs;
    this.maxTenants = maxTenants;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(tenantId: string, load: () => Promise<T>): Promise<T> {
    const known = this.entries.get(tenantId);
    if (known !== undefined && (known.pending || this.now() < known.expiresAt)) return known.value;
    const entry: Entry<T> = { value: load(), pending: true, expiresAt: this.now() + this.ttlMs };
    // De novo no fim da fila: o primeiro do mapa é sempre o mais antigo.
    this.entries.delete(tenantId);
    this.entries.set(tenantId, entry);
    while (this.entries.size > this.maxTenants) {
      const [oldest] = this.entries.keys();
      this.entries.delete(oldest as string);
    }
    entry.value.then(
      () => {
        entry.pending = false;
      },
      () => {
        if (this.entries.get(tenantId) === entry) this.entries.delete(tenantId);
      },
    );
    return entry.value;
  }
}
