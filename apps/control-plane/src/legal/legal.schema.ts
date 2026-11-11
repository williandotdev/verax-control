import { z } from 'zod';

/**
 * Os três textos legais que o cliente aceita no checkout: os Termos de uso, a Política de privacidade e o Acordo de
 * tratamento de dados (DPA). O site os mostra em `/termos`, `/privacidade` e `/dpa` (`LEGAL_PAGES`, em
 * `checkout/checkout-settings.ts`), lendo o texto publicado pela rota pública.
 */
export const LEGAL_KINDS = ['terms', 'privacy', 'dpa'] as const;
export type LegalKind = (typeof LEGAL_KINDS)[number];
export const legalKindSchema = z.enum(LEGAL_KINDS);

export function isLegalKind(value: unknown): value is LegalKind {
  return typeof value === 'string' && (LEGAL_KINDS as readonly string[]).includes(value);
}

/** O nome de cada texto, como o site e o console o mostram. */
export const LEGAL_TITLES: Readonly<Record<LegalKind, string>> = {
  terms: 'Termos de uso',
  privacy: 'Política de privacidade',
  dpa: 'Acordo de tratamento de dados (DPA)',
};

/**
 * Estados de uma versão de um texto legal:
 * - `draft`: em edição, a única que muda;
 * - `published`: imutável, com `publishedAt` e `publishedBy`. A vigente de cada texto é a publicada mais recente; não há
 *   publicação agendada nem aposentadoria (a anterior continua legível pela versão, para quem a aceitou).
 */
export const LEGAL_STATUSES = ['draft', 'published'] as const;
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

/**
 * A versão de um texto: minúsculas, números e traço, como as das tabelas de preço (ex.: `2026-11-10` ou `v1`). É o que
 * o checkout compara com o aceite do site e o que o Checkout da Stripe mostra ao lado do link.
 */
/** Nomes das rotas fixas do console ao lado de `:versão` (`/textos-legais/<tipo>/novo` e `/historico`): uma versão com um deles ficaria inalcançável. */
export const RESERVED_LEGAL_VERSIONS: ReadonlySet<string> = new Set(['novo', 'historico']);

export const legalVersionSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'versão inválida (minúsculas, números e traço)' })
  .refine((value) => !RESERVED_LEGAL_VERSIONS.has(value), {
    error: 'nome reservado pelo console; escolha outra versão',
  });

/** Teto do texto, em bytes de UTF-8: um texto legal longo fica bem abaixo disso (e do 1 MiB do documento). */
export const MAX_LEGAL_TEXT_BYTES = 100 * 1024;

/** Caractere de controle que não é quebra de linha nem tabulação (o Markdown não precisa de nenhum). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x09 || code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * O texto em Markdown, como o console o manda: quebras de linha do Windows viram `\n`, até `MAX_LEGAL_TEXT_BYTES`,
 * sem caractere de controle. Pode ficar vazio no rascunho; a publicação recusa texto em branco.
 */
export const legalContentSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, '\n'))
  .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_LEGAL_TEXT_BYTES, {
    error: `texto acima de ${MAX_LEGAL_TEXT_BYTES / 1024} KB`,
  })
  .refine((value) => !hasControlCharacter(value), { error: 'texto com caractere de controle' });

const principal = z.string().min(1).max(254);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** O documento `legalTexts/{tipo}/versions/{versão}`, conferido em toda leitura e antes de toda escrita. */
export const legalTextDocumentSchema = z.strictObject({
  status: z.enum(LEGAL_STATUSES),
  content: legalContentSchema,
  /** A versão de onde o rascunho foi copiado, se não começou em branco. */
  basedOn: legalVersionSchema.optional(),
  publishedAt: z.date().optional(),
  publishedBy: principal.optional(),
  /** O SHA-256 do texto publicado (o que o cliente aceitou), também na auditoria da publicação. */
  contentSha256: sha256.optional(),
  createdAt: z.date(),
  createdBy: principal,
  updatedAt: z.date(),
  updatedBy: principal,
});
export type LegalTextDocument = z.infer<typeof legalTextDocumentSchema>;

export interface LegalTextRecord extends LegalTextDocument {
  kind: LegalKind;
  version: string;
}

/** Uma linha da lista do console: sem o texto, com o tamanho e a vigente marcada. */
export interface LegalVersionSummary {
  kind: LegalKind;
  version: string;
  status: LegalStatus;
  current: boolean;
  basedOn?: string;
  publishedAt?: Date;
  publishedBy?: string;
  contentSha256?: string;
  bytes: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

/** As versões vigentes dos três textos (o que o checkout exige no aceite); `undefined` em quem nunca foi publicado. */
export type CurrentLegalVersions = Record<LegalKind, string | undefined>;
