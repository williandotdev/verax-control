import type { Prisma } from '../generated/prisma/client.js';
import { MAX_EVIDENCE_BYTES, type WebEvidence, webEvidenceSchema } from '../weblogs/evidence.js';

/**
 * Gravação da evidência de um achado (`FindingEvidence`), só pelo `FindingStore`, na transação que grava o achado e sob o
 * lock dos achados do cliente. A tabela é só do sistema (`SYSTEM_WRITTEN_MODELS`): a escrita é pela transação, sempre com o
 * cliente e o achado que o chamador leu no escopo, e a chave composta recusa o par trocado.
 *
 * A evidência é trocada inteira, e só por uma mais nova: a atividade mais recente ou, no mesmo instante, a soma maior das
 * contagens (o arquivo de outro nó do balanceador que chegou depois). Reavaliar as mesmas linhas, o objeto atrasado
 * avaliado sozinho e a releitura depois de um reinício não a encolhem nem a fazem oscilar. A primeira atividade nunca
 * avança, e as amostras novas valem de novo os 30 dias delas.
 *
 * `refused`: a evidência não passa no schema ou no teto. Nada é gravado, e o achado segue sem ela: uma evidência errada é
 * defeito do código, e um alerta que não entra não volta. `kept`: já havia uma igual ou mais nova.
 */
export type EvidenceOutcome = 'stored' | 'kept' | 'refused';

/** Vírgulas e dois-pontos da estrutura: o `jsonb` escreve um espaço depois de cada um. */
function separators(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0;
  const items: unknown[] = Object.values(value);
  const own = Array.isArray(value) ? Math.max(0, items.length - 1) : Math.max(0, 2 * items.length - 1);
  return items.reduce((sum: number, item) => sum + separators(item), own);
}

/** O tamanho do JSON como o banco o mede no CHECK (`octet_length("data"::text)`). */
export function evidenceBytes(evidence: unknown): number {
  return Buffer.byteLength(JSON.stringify(evidence), 'utf8') + separators(evidence);
}

export async function saveFindingEvidence(
  tx: Prisma.TransactionClient,
  finding: { tenantId: string; findingId: string },
  draft: WebEvidence,
): Promise<EvidenceOutcome> {
  const parsed = webEvidenceSchema.safeParse(draft);
  if (!parsed.success) return 'refused';
  const evidence = parsed.data;
  // Acima do teto, o CHECK derrubaria a transação, e com ela o achado.
  if (evidenceBytes(evidence) > MAX_EVIDENCE_BYTES) return 'refused';
  const data = JSON.stringify(evidence);
  const first = Date.parse(evidence.firstSeenAt);
  const last = Math.max(first, Date.parse(evidence.lastSeenAt));
  const stored = await tx.$executeRaw`
    INSERT INTO "FindingEvidence" AS held
      ("findingId", "tenantId", "version", "data", "firstSeenAt", "lastSeenAt", "updatedAt")
    VALUES (
      ${finding.findingId}::uuid, ${finding.tenantId}::uuid, ${evidence.version}::smallint, ${data}::jsonb,
      ${new Date(first)}::timestamptz, ${new Date(last)}::timestamptz, now()
    )
    ON CONFLICT ("findingId", "tenantId") DO UPDATE SET
      "version" = EXCLUDED."version",
      "data" = EXCLUDED."data",
      "firstSeenAt" = LEAST(held."firstSeenAt", EXCLUDED."firstSeenAt"),
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "samplesPurgedAt" = NULL,
      "updatedAt" = now()
    WHERE EXCLUDED."lastSeenAt" > held."lastSeenAt"
      OR CASE
        WHEN EXCLUDED."lastSeenAt" = held."lastSeenAt" AND EXCLUDED."version" = held."version" THEN
          (SELECT sum(value::bigint) FROM jsonb_each_text(EXCLUDED."data" -> 'counters'))
            > (SELECT sum(value::bigint) FROM jsonb_each_text(held."data" -> 'counters'))
        ELSE false
      END`;
  return stored === 1 ? 'stored' : 'kept';
}
