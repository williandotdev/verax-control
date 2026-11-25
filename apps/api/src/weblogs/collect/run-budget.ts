/** O que uma execução gasta, somados todos os balanceadores. */
export interface BudgetAmounts {
  objects: number;
  lines: number;
  bytes: number;
}

/**
 * O orçamento de uma execução da tarefa: arquivos, linhas, bytes descompactados e tempo. Conferido antes de abrir cada
 * arquivo: o último pode passar, no máximo, do que cabe num arquivo. Uma fatia gasta também do orçamento de onde saiu.
 */
export class RunBudget {
  private readonly left: BudgetAmounts;

  constructor(
    private readonly amounts: BudgetAmounts,
    private readonly expired: () => boolean,
    private readonly parent: RunBudget | null = null,
  ) {
    this.left = { ...amounts };
  }

  spend(amount: BudgetAmounts): void {
    this.left.objects -= amount.objects;
    this.left.lines -= amount.lines;
    this.left.bytes -= amount.bytes;
    this.parent?.spend(amount);
  }

  get exhausted(): boolean {
    return (
      this.left.objects <= 0 ||
      this.left.lines <= 0 ||
      this.left.bytes <= 0 ||
      this.expired() ||
      (this.parent?.exhausted ?? false)
    );
  }

  /** Uma parte do orçamento inteiro (não do que sobrou): nenhum balanceador come a vez dos outros. */
  slice(parts: number): RunBudget {
    const share = (value: number): number => Math.ceil(value / Math.max(1, parts));
    return new RunBudget(
      {
        objects: share(this.amounts.objects),
        lines: share(this.amounts.lines),
        bytes: share(this.amounts.bytes),
      },
      this.expired,
      this,
    );
  }
}
