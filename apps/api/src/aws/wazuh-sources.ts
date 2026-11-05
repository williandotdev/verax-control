import { createHash } from 'node:crypto';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * As contas AWS que o Wazuh do nó lê (fase 2, PR-V4'): o que o CLI `wazuh-sources` imprime para o gerador da
 * configuração do manager (`infra/wazuh/scripts/render-manager-config.py`, pelo `infra/node/bin/wazuh-apply.sh`) e o que
 * a tarefa `wazuh-config` do worker resume na geração. Nenhum valor é segredo: o nó entra no papel de leitura de cada
 * conta com o token que o Google assina para a conta de serviço dele, sem chave nem ExternalId.
 *
 * Entra a conta AWS ativa que passou pela verificação ao menos uma vez (`ingestFrom`, gravado uma vez só pela tarefa
 * `aws-check`) e que tem ao menos um bucket. A conexão de agora não conta: um erro passageiro, uma edição de bucket (que
 * volta a conta a "aguardando") ou o aviso que a própria coleta grava (`collectionError`) não tiram a conta do manager
 * nem o reiniciam. Desativar a conta, sim. O papel nunca vai na lista: o gerador o deriva do ID.
 */
export interface WazuhSource {
  accountId: string;
  /** A primeira região monitorada: a do STS e do S3 no profile da conta. */
  region: string;
  /** O `only_logs_after` do Wazuh (`2026-NOV-01`): o dia de `ingestFrom`. */
  onlyLogsAfter: string;
  cloudtrailBucket?: string;
  guarddutyBucket?: string;
  wafBucket?: string;
}

export const WAZUH_SOURCE_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  regions: true,
  ingestFrom: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  // O aviso da coleta, que só a tarefa wazuh-config grava; a conexão não entra (é da tarefa aws-check).
  collectionError: true,
} as const satisfies Prisma.CloudAccountSelect;
export type WazuhSourceRow = Prisma.CloudAccountGetPayload<{ select: typeof WAZUH_SOURCE_SELECT }>;

/**
 * As contas do Wazuh do nó, numa busca de sistema (todos os clientes do nó), em ordem de ID: a mesma lista dá sempre a
 * mesma geração. `tenantIds`: só os testes, que dividem o banco com outras suítes.
 */
export function findWazuhSourceRows(
  db: Prisma.TransactionClient,
  tenantIds?: readonly string[],
): Promise<WazuhSourceRow[]> {
  return db.cloudAccount.findMany({
    where: {
      provider: 'aws',
      status: 'active',
      ingestFrom: { not: null },
      OR: [
        { cloudtrailBucket: { not: null } },
        { guarddutyBucket: { not: null } },
        { wafBucket: { not: null } },
      ],
      ...(tenantIds !== undefined && { tenantId: { in: [...tenantIds] } }),
    },
    select: WAZUH_SOURCE_SELECT,
    orderBy: { accountId: 'asc' },
  });
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/** Uma data no formato do `only_logs_after` do Wazuh (`2026-NOV-01`), pelo dia em UTC. */
export function wazuhDate(day: Date): string {
  const month = MONTHS[day.getUTCMonth()] ?? 'JAN';
  return `${String(day.getUTCFullYear()).padStart(4, '0')}-${month}-${String(day.getUTCDate()).padStart(2, '0')}`;
}

/** As contas na ordem dos campos que o gerador espera; bucket ausente fica de fora (o gerador recusa null). */
export function toWazuhSources(rows: readonly WazuhSourceRow[]): WazuhSource[] {
  const sources: WazuhSource[] = [];
  for (const row of rows) {
    // A API exige ao menos uma região; a busca já exige o início da coleta.
    const region = row.regions[0];
    if (region === undefined || row.ingestFrom === null) continue;
    sources.push({
      accountId: row.accountId,
      region,
      onlyLogsAfter: wazuhDate(row.ingestFrom),
      ...(row.cloudtrailBucket !== null && { cloudtrailBucket: row.cloudtrailBucket }),
      ...(row.guarddutyBucket !== null && { guarddutyBucket: row.guarddutyBucket }),
      ...(row.wafBucket !== null && { wafBucket: row.wafBucket }),
    });
  }
  return sources;
}

/** A lista como o CLI a imprime: uma linha de JSON (o CLI acrescenta só a quebra de linha do fim). */
export function serializeWazuhSources(sources: readonly WazuhSource[]): string {
  return JSON.stringify(sources);
}

/**
 * A geração: o SHA-256 da lista serializada. O `wazuh-apply.sh` calcula o mesmo da saída do CLI (sem a quebra de linha)
 * e o devolve no sinal `applied`; o worker compara os dois para saber se o resultado é da lista de agora.
 */
export function wazuhSourcesGeneration(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
