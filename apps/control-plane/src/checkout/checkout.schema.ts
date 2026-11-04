import { z } from 'zod';
import { planIdSchema, slugSchema } from '../tenants/tenant.schema.js';
import { CNPJ_INPUT_MAX_LENGTH, isValidCnpj, normalizeCnpj } from './cnpj.js';

/** Sem caracteres de controle (quebra de linha, tabulação, NUL): o nome vai a e-mail, painel e nota fiscal. */
function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

const versionSchema = z.string().min(1).max(64);

/**
 * Corpo de `POST /v1/public/checkout` (plano §4a): estrito (campo desconhecido é recusado), com o CNPJ normalizado
 * (sem a máscara, letras em maiúsculas) e conferido pelos dígitos verificadores. O subdomínio é conferido só no
 * formato aqui; a lista reservada responde como "indisponível" (409), igual à consulta. As versões do aceite são
 * comparadas com as vigentes no serviço depois da validação (409 `terms_outdated`).
 */
export const checkoutRequestSchema = z.strictObject({
  plan: planIdSchema,
  companyName: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .refine(hasNoControlCharacters, { error: 'caracteres inválidos' }),
  cnpj: z
    .string()
    .max(CNPJ_INPUT_MAX_LENGTH)
    .transform(normalizeCnpj)
    .refine(isValidCnpj, { error: 'CNPJ inválido' }),
  adminEmail: z.string().trim().max(254).pipe(z.email()),
  slug: z.string().max(64).pipe(slugSchema),
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
