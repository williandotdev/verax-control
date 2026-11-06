import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';
import { companyNameSchema, slugSchema } from '../tenants/tenant.schema.js';
import { CNPJ_INPUT_MAX_LENGTH, isValidCnpj, normalizeCnpj } from './cnpj.js';

const versionSchema = z.string().min(1).max(64);

/**
 * Os campos do cadastro do cliente, com as mesmas regras e os mesmos limites no checkout do site e no cadastro de um
 * cliente de contrato direto pelo console do responsável (`admin/admin-tenants.schema.ts`). A razão social é o
 * `companyNameSchema` de `tenant.schema.ts` (até 120, o limite do nó).
 */
export const cnpjInputSchema = z
  .string()
  .max(CNPJ_INPUT_MAX_LENGTH)
  .transform(normalizeCnpj)
  .refine(isValidCnpj, { error: 'CNPJ inválido' });
export const adminEmailSchema = z.string().trim().max(254).pipe(z.email());
export const slugInputSchema = z.string().max(64).pipe(slugSchema);

/**
 * Corpo de `POST /v1/public/checkout` (plano §4a, com o preço configurável): estrito (campo desconhecido é recusado),
 * com o CNPJ normalizado (sem a máscara, letras em maiúsculas) e conferido pelos dígitos verificadores. O preço vem
 * só da cotação gravada (`quoteId`, de `POST /v1/public/quote`): nenhum campo de preço, plano ou item é aceito. O
 * subdomínio é conferido só no formato aqui; a lista reservada responde como "indisponível" (409), igual à consulta.
 * As versões do aceite são comparadas com as vigentes no serviço depois da validação (409 `terms_outdated`). O nome da
 * empresa vai até 120 caracteres, o limite do nó (`companyNameSchema`): o que passa aqui chega inteiro ao nó.
 */
export const checkoutRequestSchema = z.strictObject({
  quoteId: z.string().max(64).regex(ULID_PATTERN),
  companyName: companyNameSchema,
  cnpj: cnpjInputSchema,
  adminEmail: adminEmailSchema,
  slug: slugInputSchema,
  consent: z.strictObject({ terms: versionSchema, privacy: versionSchema, dpa: versionSchema }),
});

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;

/** Campos que a resposta de erro pode citar pelo nome. Um campo desconhecido não é ecoado. */
export const CHECKOUT_FIELDS: ReadonlySet<string> = new Set(Object.keys(checkoutRequestSchema.shape));

export interface CheckoutResponse {
  /** Endereço do Checkout hospedado; o site redireciona por `window.location`. */
  url: string;
  /** `false` no modo de teste: o site mostra a faixa "modo de teste" (decisão 1 do plano). */
  livemode: boolean;
}

export interface SlugAvailability {
  available: boolean;
}
