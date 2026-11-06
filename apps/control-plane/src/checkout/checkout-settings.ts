import type { AppConfig } from '../common/config/config.module.js';
import type { EnvKey } from '../common/config/env.schema.js';

/**
 * Variáveis sem as quais o checkout não abre sessão (plano §2.5, grupos "Site" e "Stripe"). Ficam opcionais no
 * schema, como os demais grupos: faltando alguma, o serviço sobe assim mesmo (o `/health` responde e a revisão pode
 * ser promovida), avisa no log quais faltam (só os nomes) e o checkout responde 503 `checkout_unavailable`. A
 * consulta de subdomínio não depende delas. `STRIPE_WEBHOOK_SECRET` e `STRIPE_PORTAL_LOGIN_URL` são do CP-04/CP-05.
 * Os preços não estão aqui: saem da tabela publicada no Firestore (preço configurável), pela cotação.
 */
export const CHECKOUT_REQUIRED = [
  'SITE_ORIGINS',
  'SITE_SUCCESS_URL',
  'SITE_CANCEL_URL',
  'TERMS_VERSION',
  'PRIVACY_VERSION',
  'DPA_VERSION',
  'STRIPE_SECRET_KEY',
] as const satisfies readonly EnvKey[];

/** Páginas dos textos legais no site (plano §9, item 18), relativas à origem das páginas de retorno do Checkout. */
export const LEGAL_PAGES = { terms: '/termos', privacy: '/privacidade', dpa: '/dpa' } as const;

export interface CheckoutSettings {
  successUrl: string;
  cancelUrl: string;
  /** Endereços completos dos textos legais, citados no aceite do Checkout. */
  legalUrls: { terms: string; privacy: string; dpa: string };
  versions: { terms: string; privacy: string; dpa: string };
  /** `STRIPE_LIVE`: a chave já foi conferida contra ele na partida. */
  livemode: boolean;
}

export type CheckoutSettingsResult =
  { ready: true; settings: CheckoutSettings } | { ready: false; missing: readonly EnvKey[] };

export const CHECKOUT_SETTINGS = Symbol('CHECKOUT_SETTINGS');

export function resolveCheckoutSettings(config: AppConfig): CheckoutSettingsResult {
  const missing = CHECKOUT_REQUIRED.filter((key) => config[key] === undefined);
  const {
    SITE_SUCCESS_URL: successUrl,
    SITE_CANCEL_URL: cancelUrl,
    TERMS_VERSION: terms,
    PRIVACY_VERSION: privacy,
    DPA_VERSION: dpa,
  } = config;
  if (
    missing.length > 0 ||
    successUrl === undefined ||
    cancelUrl === undefined ||
    terms === undefined ||
    privacy === undefined ||
    dpa === undefined
  ) {
    return { ready: false, missing };
  }
  const site = new URL(successUrl).origin;
  return {
    ready: true,
    settings: {
      successUrl,
      cancelUrl,
      legalUrls: {
        terms: `${site}${LEGAL_PAGES.terms}`,
        privacy: `${site}${LEGAL_PAGES.privacy}`,
        dpa: `${site}${LEGAL_PAGES.dpa}`,
      },
      versions: { terms, privacy, dpa },
      livemode: config.STRIPE_LIVE,
    },
  };
}
