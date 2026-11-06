import { tenantUrls, type TenantDomainSettings } from '../access/tenant-urls.js';
import type { TenantRecord, TenantState } from '../tenants/tenant.schema.js';

/**
 * Os passos do provisionamento na ordem do plano (§4c), com a estimativa de minutos até o ambiente ficar pronto a
 * partir de cada um, para a página mostrar a lista com o atual marcado e "cerca de 15 a 30 minutos". O certificado do
 * domínio do painel (`panel.domain_wait`) leva de minutos a horas: sem estimativa ("o endereço está sendo emitido").
 * Os nomes são os das tasks (CP-07); um passo fora da lista não vai à página.
 */
export const PROVISIONING_PROGRESS: readonly { step: string; etaMinutes: number | null }[] = [
  { step: 'preflight', etaMinutes: 30 },
  { step: 'cloudflare.tunnel', etaMinutes: 30 },
  { step: 'firebase.site', etaMinutes: 28 },
  { step: 'terraform.apply', etaMinutes: 25 },
  { step: 'terraform.wait', etaMinutes: 22 },
  { step: 'secrets.smtp_password', etaMinutes: 19 },
  { step: 'secrets.tunnel_token', etaMinutes: 18 },
  { step: 'node.wait_ready', etaMinutes: 15 },
  { step: 'node.health', etaMinutes: 5 },
  { step: 'panel.domain_wait', etaMinutes: null },
  { step: 'access.ready', etaMinutes: 1 },
];

/**
 * O que `GET /v1/public/status` (e o `claim`) devolve (plano §4g). Nada sensível: estado, etapa, estimativa e
 * endereços. Nunca o código de um erro, o e-mail, o CNPJ nem dado de cobrança; o link do boleto é lido na hora da
 * Stripe e não é guardado.
 */
export interface StatusView {
  /** `pending` também enquanto a compra ainda não virou cliente (o webhook não chegou): "confirmando o pagamento". */
  state: TenantState;
  /** Só em `provisioning`: o passo atual, um dos de `PROVISIONING_PROGRESS`. */
  step: string | null;
  /** Só em `provisioning`: minutos estimados até o fim; `null` quando não dá para estimar. */
  etaMinutes: number | null;
  /** Do ambiente pronto em diante (espera da conexão, ativo, inadimplente, suspenso, cancelado). */
  panelUrl: string | null;
  apiUrl: string | null;
  /** O botão "Mostrar acesso": esperando a conexão e a senha ainda não foi mostrada. */
  revealAvailable: boolean;
  /** Só em `pending` com boleto em aberto: a página do boleto na Stripe. */
  boletoUrl?: string;
}

/** Estados em que o ambiente existe e a página mostra os endereços (plano §4g). */
const READY_STATES: ReadonlySet<TenantState> = new Set([
  'waiting_customer_connection',
  'active',
  'past_due',
  'suspended',
  'canceled',
]);

function progressOf(step: string | undefined): { step: string | null; etaMinutes: number | null } {
  const known = PROVISIONING_PROGRESS.find((entry) => entry.step === (step ?? 'preflight'));
  return known === undefined ? { step: null, etaMinutes: null } : known;
}

/**
 * A visão pública de um cliente. `undefined` é a compra paga que ainda não virou cliente: `pending`, sem mais nada.
 * O cliente excluído não chega aqui (404 genérico, em quem chama).
 */
export function buildStatusView(
  tenant: TenantRecord | undefined,
  domains: TenantDomainSettings,
  boletoUrl?: string,
): StatusView {
  if (tenant === undefined) {
    return {
      state: 'pending',
      step: null,
      etaMinutes: null,
      panelUrl: null,
      apiUrl: null,
      revealAvailable: false,
    };
  }
  const ready = READY_STATES.has(tenant.state);
  const urls = ready ? tenantUrls(tenant.slug, domains) : { panelUrl: null, apiUrl: null };
  const progress =
    tenant.state === 'provisioning'
      ? progressOf(tenant.provisioning?.step)
      : { step: null, etaMinutes: null };
  return {
    state: tenant.state,
    ...progress,
    ...urls,
    revealAvailable:
      tenant.state === 'waiting_customer_connection' && tenant.access?.passwordRevealedAt === undefined,
    ...(tenant.state === 'pending' && boletoUrl !== undefined ? { boletoUrl } : {}),
  };
}
