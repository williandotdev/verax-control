import type { CollectionSource, TowerSummary } from '@verax/shared';
import { formatList, formatRelative } from '@/lib/format';

/** Nome de cada fonte da "Saúde da coleta" e o que ela cobre. */
export const COLLECTION_SOURCE_LABELS: Readonly<
  Record<CollectionSource, { name: string; short: string; description: string }>
> = {
  aws: { name: 'AWS', short: 'AWS', description: 'CloudTrail, GuardDuty e WAF, pelo Wazuh' },
  gcp: { name: 'GCP', short: 'GCP', description: 'Cloud Logging, pelo Pub/Sub' },
  cloudflare: { name: 'Cloudflare', short: 'Cloudflare', description: 'Auditoria e eventos de segurança' },
  agents: { name: 'Agentes nas instâncias', short: 'agentes', description: 'Wazuh nos servidores' },
  posture: {
    name: 'Postura e inventário',
    short: 'postura e inventário',
    description: 'Leitura diária da AWS',
  },
};

/** A prova de vida da coleta: quantas fontes configuradas coletam, quantas estão paradas e o último dado. */
export interface CollectionProof {
  /** Fontes que o cliente tem (todas menos as não configuradas). */
  configured: number;
  /** Delas, as coletando dentro do prazo. */
  active: number;
  /** As paradas, pelo nome curto, na ordem da tela. */
  stalled: string[];
  lastDataAt: string | null;
}

/** A prova, ou null num nó de antes do OP-02 (sem as fontes). */
export function collectionProof(summary: TowerSummary): CollectionProof | null {
  const sources = summary.coverage.sources;
  if (!sources) return null;
  const configured = sources.filter((source) => source.state !== 'not_configured');
  return {
    configured: configured.length,
    active: configured.filter((source) => source.state === 'collecting').length,
    stalled: sources
      .filter((source) => source.state === 'stalled')
      .map((source) => COLLECTION_SOURCE_LABELS[source.source].short),
    lastDataAt: summary.coverage.lastDataAt ?? null,
  };
}

/** Tudo coletando, com pelo menos uma fonte: o "Tudo calmo" pode ser afirmado. */
export function allCollecting(proof: CollectionProof | null): boolean {
  return proof !== null && proof.configured > 0 && proof.active === proof.configured;
}

/** "Coleta ativa em 3 de 4 fontes, último dado há 2 minutos." */
export function proofSentence(proof: CollectionProof, now?: Date): string {
  if (proof.configured === 0) return 'Nenhuma fonte de dados conectada ainda.';
  const sources = proof.configured === 1 ? 'fonte' : 'fontes';
  const last = proof.lastDataAt ? `, último dado ${formatRelative(proof.lastDataAt, now)}` : '';
  return `Coleta ativa em ${proof.active} de ${proof.configured} ${sources}${last}.`;
}

/** "coleta parada (GCP e agentes)". */
export function stalledPhrase(proof: CollectionProof | null): string {
  return proof && proof.stalled.length > 0 ? `coleta parada (${formatList(proof.stalled)})` : 'coleta parada';
}
