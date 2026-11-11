import type { SizeId } from '@/lib/api-types';
import { getAt, type Path } from '@/lib/paths';

const SIZES: readonly SizeId[] = ['P', 'M', 'G'];

function numberAt(root: unknown, path: readonly (string | number)[]): number | undefined {
  const value = getAt(root, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface MachineCost {
  /** VM + disco + snapshots + NAT + IP do NAT + outros, em US$ por mês; `undefined` se faltar algum número. */
  usd: number | undefined;
  /** O mesmo em centavos de real, com o câmbio e a folga (a linha de infraestrutura da DRE, sem a ingestão). */
  brlCents: number | undefined;
}

export interface NodeCostRow extends MachineCost {
  size: SizeId;
}

/** A célula compartilhada da Plataforma: o custo da máquina e o rateio por GB/dia de capacidade. */
export interface CellCost extends MachineCost {
  capacityGbDay: number | undefined;
  /** Custo da máquina ÷ capacidade, em centavos de real por GB/dia contratado (sem a ingestão nem o fixo por cliente). */
  brlCentsPerGbDay: number | undefined;
}

/** O custo de uma máquina do rascunho, pela fórmula da DRE (`apps/control-plane/src/pricing/dre.ts`, `machineUsd`). */
function machineCost(draft: unknown, path: Path): MachineCost {
  const shared = [
    'diskUsdPerGibMonth',
    'snapshotUsdPerGibMonth',
    'natUsdPerVmMonth',
    'natIpUsdPerMonth',
    'otherUsdPerNodeMonth',
  ].map((key) => numberAt(draft, ['infrastructure', key]));
  const fx = numberAt(draft, ['exchange', 'brlPerUsd']);
  const buffer = numberAt(draft, ['exchange', 'cloudBuffer']);
  const vm = numberAt(draft, [...path, 'vmUsdPerMonth']);
  const disk = numberAt(draft, [...path, 'diskGb']);
  const snapshot = numberAt(draft, [...path, 'snapshotGib']);
  const [diskPrice, snapshotPrice, nat, natIp, other] = shared;
  if (
    vm === undefined ||
    disk === undefined ||
    snapshot === undefined ||
    diskPrice === undefined ||
    snapshotPrice === undefined ||
    nat === undefined ||
    natIp === undefined ||
    other === undefined
  ) {
    return { usd: undefined, brlCents: undefined };
  }
  const usd = vm + disk * diskPrice + snapshot * snapshotPrice + nat + natIp + other;
  const brlCents =
    fx === undefined || buffer === undefined ? undefined : Math.round(usd * fx * 100 * (1 + buffer));
  return { usd, brlCents };
}

/**
 * O custo do nó dedicado de cada porte do rascunho, sem a ingestão (que depende do GB/dia). Só para a prévia da tela:
 * a DRE e a checagem de verdade são da API.
 */
export function nodeCostBySize(draft: unknown): NodeCostRow[] {
  return SIZES.flatMap((size): NodeCostRow[] =>
    getAt(draft, ['infrastructure', 'sizes', size]) === undefined
      ? []
      : [{ size, ...machineCost(draft, ['infrastructure', 'sizes', size]) }],
  );
}

/** O custo da célula compartilhada e o rateio por GB/dia (custo ÷ capacidade), como a DRE da Plataforma o usa. */
export function sharedCellCost(draft: unknown): CellCost | undefined {
  if (getAt(draft, ['infrastructure', 'sharedCell']) === undefined) return undefined;
  const machine = machineCost(draft, ['infrastructure', 'sharedCell']);
  const capacity = numberAt(draft, ['infrastructure', 'sharedCell', 'capacityGbDay']);
  const valid = capacity !== undefined && capacity > 0;
  return {
    ...machine,
    capacityGbDay: capacity,
    brlCentsPerGbDay:
      machine.brlCents === undefined || !valid ? undefined : Math.round(machine.brlCents / capacity),
  };
}
