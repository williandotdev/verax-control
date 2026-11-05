import type { SizeId } from '@/lib/api-types';
import { getAt } from '@/lib/paths';

const SIZES: readonly SizeId[] = ['P', 'M', 'G'];

function numberAt(root: unknown, path: readonly (string | number)[]): number | undefined {
  const value = getAt(root, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export interface NodeCostRow {
  size: SizeId;
  /** VM + disco + snapshots + NAT + IP do NAT + outros, em US$ por mês; `undefined` se faltar algum número. */
  usd: number | undefined;
  /** O mesmo em centavos de real, com o câmbio e a folga (a linha de infraestrutura da DRE, sem volume e agentes). */
  brlCents: number | undefined;
}

/**
 * O custo do nó de cada porte do rascunho, pela mesma fórmula da DRE (`apps/control-plane/src/pricing/dre.ts`,
 * `nodeCloudUsd`) sem a ingestão e sem os agentes, que dependem da configuração. Só para a prévia da tela: a DRE e a
 * checagem de verdade são da API.
 */
export function nodeCostBySize(draft: unknown): NodeCostRow[] {
  const shared = [
    'diskUsdPerGibMonth',
    'snapshotUsdPerGibMonth',
    'natUsdPerVmMonth',
    'natIpUsdPerMonth',
    'otherUsdPerNodeMonth',
  ].map((key) => numberAt(draft, ['infrastructure', key]));
  const fx = numberAt(draft, ['exchange', 'brlPerUsd']);
  const buffer = numberAt(draft, ['exchange', 'cloudBuffer']);
  return SIZES.flatMap((size): NodeCostRow[] => {
    if (getAt(draft, ['infrastructure', 'sizes', size]) === undefined) return [];
    const vm = numberAt(draft, ['infrastructure', 'sizes', size, 'vmUsdPerMonth']);
    const disk = numberAt(draft, ['infrastructure', 'sizes', size, 'diskGb']);
    const snapshot = numberAt(draft, ['infrastructure', 'sizes', size, 'snapshotGib']);
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
      return [{ size, usd: undefined, brlCents: undefined }];
    }
    const usd = vm + disk * diskPrice + snapshot * snapshotPrice + nat + natIp + other;
    const brlCents =
      fx === undefined || buffer === undefined ? undefined : Math.round(usd * fx * 100 * (1 + buffer));
    return [{ size, usd, brlCents }];
  });
}
