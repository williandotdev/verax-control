import type { LegalKind } from '@/lib/api-types';

/** Cada texto legal no console: o nome, o pedaço da rota (em português) e a página do site que o mostra. */
export interface LegalKindConfig {
  kind: LegalKind;
  title: string;
  /** "/textos-legais/termos". */
  basePath: string;
  /** A página do site que lê o texto vigente. */
  sitePath: string;
  description: string;
}

export const LEGAL_ROOT = '/textos-legais';

export const LEGAL_KIND_CONFIGS: readonly LegalKindConfig[] = [
  {
    kind: 'terms',
    title: 'Termos de uso',
    basePath: `${LEGAL_ROOT}/termos`,
    sitePath: '/termos',
    description:
      'O contrato de uso do Verax Control: o serviço, o pagamento, o reembolso, o cancelamento e as responsabilidades.',
  },
  {
    kind: 'privacy',
    title: 'Política de privacidade',
    basePath: `${LEGAL_ROOT}/privacidade`,
    sitePath: '/privacidade',
    description:
      'O que a Verax faz com os dados de cadastro e de cobrança (controladora) e os direitos do titular (LGPD).',
  },
  {
    kind: 'dpa',
    title: 'Acordo de tratamento de dados (DPA)',
    basePath: `${LEGAL_ROOT}/dpa`,
    sitePath: '/dpa',
    description:
      'Como a Verax trata, como operadora, os logs e os dados do ambiente do cliente: finalidade, segurança, suboperadores, incidentes e exclusão.',
  },
];

export function configOfKind(kind: LegalKind): LegalKindConfig {
  const config = LEGAL_KIND_CONFIGS.find((entry) => entry.kind === kind);
  if (config === undefined) throw new TypeError(`texto legal desconhecido: ${kind}`);
  return config;
}

/** O texto pelo pedaço da rota (`termos`, `privacidade`, `dpa`); `undefined` para outro. */
export function configOfSlug(slug: string | undefined): LegalKindConfig | undefined {
  return LEGAL_KIND_CONFIGS.find((entry) => entry.basePath === `${LEGAL_ROOT}/${slug ?? ''}`);
}

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' });

/** Uma sugestão de versão: o dia de hoje em São Paulo (`AAAA-MM-DD`) e, se já existir, `-2`, `-3`... */
export function suggestLegalVersion(existing: readonly string[], now: Date = new Date()): string {
  const day = today.format(now);
  if (!existing.includes(day)) return day;
  let next = 2;
  while (existing.includes(`${day}-${next}`)) next += 1;
  return `${day}-${next}`;
}

/** O tamanho do texto como a API conta (bytes de UTF-8, depois de trocar `\r\n` por `\n`). */
export function textBytes(text: string): number {
  return new TextEncoder().encode(text.replace(/\r\n?/g, '\n')).length;
}

/** O teto do texto na API (`MAX_LEGAL_TEXT_BYTES`). */
export const MAX_LEGAL_TEXT_BYTES = 100 * 1024;

/** "12,3 KB"; abaixo de 1 KB, em bytes ("44 bytes"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
}
