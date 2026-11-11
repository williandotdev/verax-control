import type {
  BillingMode,
  Hosting,
  NodeFitProblem,
  ProvisioningStepName,
  TenantState,
  TimelineStepStatus,
} from '@/lib/api-types';

/** Os estados do cliente, como o responsável os lê. */
export const STATE_LABELS: Readonly<Record<TenantState, string>> = {
  pending: 'Aguardando início',
  provisioning: 'Provisionando',
  provisioning_failed: 'Provisionamento parou',
  waiting_customer_install: 'Aguardando instalação pelo cliente',
  waiting_customer_connection: 'Pronto, esperando o cliente',
  active: 'Ativo',
  past_due: 'Pagamento em atraso',
  suspended: 'Suspenso',
  canceled: 'Cancelado',
  deleted: 'Excluído',
};

export const BILLING_LABELS: Readonly<Record<BillingMode, string>> = {
  stripe: 'Stripe (site)',
  contract: 'Contrato direto',
};

/** Onde o ambiente roda, sem nome de provedor (a infraestrutura da Verax pode mudar). */
export const HOSTING_LABELS: Readonly<Record<Hosting, string>> = {
  verax: 'Infraestrutura da Verax',
  customer: 'Infraestrutura do cliente',
};

/** Os passos do provisionamento (CP-07), na ordem e na linguagem da página de status. */
export const STEP_LABELS: Readonly<Record<ProvisioningStepName, string>> = {
  preflight: 'Conferência inicial',
  'cloudflare.tunnel': 'Túnel e DNS no Cloudflare',
  'firebase.site': 'Site do painel no Firebase',
  'terraform.apply': 'Criação do nó (Terraform)',
  'terraform.wait': 'Espera da criação do nó',
  'secrets.smtp_password': 'Senha do e-mail do nó no cofre',
  'secrets.tunnel_token': 'Token do túnel no cofre',
  'node.wait_ready': 'Instalação do nó',
  'node.health': 'Saúde da API e do painel',
  'panel.domain_wait': 'Certificado do endereço do painel',
  'access.ready': 'Senha do administrador no cofre',
};

export function stepLabel(step: string | undefined): string {
  if (step === undefined) return '—';
  return Object.hasOwn(STEP_LABELS, step) ? STEP_LABELS[step as ProvisioningStepName] : step;
}

export const STEP_STATUS_LABELS: Readonly<Record<TimelineStepStatus, string>> = {
  pending: 'Ainda não',
  running: 'Em andamento',
  waiting: 'Esperando',
  done: 'Feito',
  failed: 'Parou',
};

export const SUSPENSION_LABELS: Readonly<Record<string, string>> = {
  unpaid: 'assinatura não paga',
  grace_expired: 'carência vencida',
  fraud_review: 'contestação ou alerta de fraude',
  owner: 'pelo responsável (contrato direto)',
};

export const PROBLEM_LABELS: Readonly<Record<NodeFitProblem, string>> = {
  mode: 'só o modo gerenciado (na infraestrutura da Verax) é provisionado hoje',
  size: 'o provisionamento cria só o porte P hoje',
  agents: 'agentes nas instâncias do cliente ainda não são provisionados',
  limits: 'os limites ficam fora das faixas que o nó aceita',
};

/** O mesmo, com o ambiente na infraestrutura do cliente (nada é provisionado; o guia de instalação é o limite). */
export const CUSTOMER_PROBLEM_LABELS: Readonly<Record<NodeFitProblem, string>> = {
  ...PROBLEM_LABELS,
  agents: 'agentes nas instâncias ainda não têm instalação no ambiente do cliente (o guia não cobre)',
};

/**
 * O que fazer quando a operação não chegou ao fim no cp-worker. Nos 5xx a API devolve só o código (a mensagem é a
 * genérica), e é este texto que explica; nos outros, a mensagem da API já serve.
 */
export const WORKER_FAILURE_MESSAGES: Readonly<Record<string, string>> = {
  worker_refused:
    'O cp-worker recusou o console. Confira o run.invoker da conta cp-admin no cp-worker e o ADMIN_SA_EMAIL (GUIA, "Operações do responsável no cp-worker").',
  worker_unavailable:
    'O cp-worker não respondeu. Se a entrada dele estiver só de dentro do projeto (INGRESS_TRAFFIC_INTERNAL_ONLY), o console não o alcança: veja o GUIA, "Operações do responsável no cp-worker".',
  worker_unconfigured:
    'O console está sem o endereço do cp-worker (WORKER_URL): aplique o Terraform de novo.',
  export_unavailable:
    'A exportação não está configurada: falta a conta que assina o link (EXPORT_SIGNER_SA_EMAIL, GUIA, "Exportação sob pedido").',
  export_check_failed: 'O backup não pôde ser conferido no Cloud Storage. Tente de novo em instantes.',
  not_allowed: 'O cliente não está num estado que permita isso.',
  stripe_managed:
    'Cliente da Stripe: o provisionamento começa com o pagamento, e o resto segue a assinatura.',
  customer_hosted:
    'O ambiente deste cliente roda na infraestrutura dele: a Verax não provisiona, não para, não liga nem apaga nada lá.',
  not_customer_hosted:
    'O ambiente deste cliente roda na infraestrutura da Verax: não há instalação para enviar.',
  release_unconfigured:
    'O cp-worker está sem a versão do nó: confira RELEASE_BUCKET e NODE_RELEASE (node-vX.Y.Z) no worker_env (GUIA, "O provisionamento (CP-07)").',
  release_manifest_missing:
    'O manifesto da versão do nó não está no bucket de releases: publique a versão (docs/runbooks/versao-no.md) ou confira o NODE_RELEASE.',
  release_manifest_invalid:
    'O manifesto da versão do nó foi recusado (assinatura que não fecha com as chaves do repositório, ou fora do formato). Não envie nada ao cliente.',
  release_unavailable: 'O bucket de releases não respondeu. Tente de novo em instantes.',
};

export function workerFailureMessage(code: string): string {
  return WORKER_FAILURE_MESSAGES[code] ?? `O cp-worker não atendeu o pedido (${code}).`;
}

/** O código de uma falha de provisionamento: o que ele quer dizer, em uma linha (o runbook tem o resto). */
export const FAILURE_HINTS: Readonly<Record<string, string>> = {
  provisioning_disabled: 'O provisionamento está desligado ou com a configuração incompleta.',
  configuration_unsupported: 'Foi contratado algo que o nó ainda não cria (modo, porte, agentes ou limites).',
  admin_email_invalid: 'O e-mail do administrador é o da conta de suporte, ou está fora do formato do nó.',
  tenant_name_invalid: 'A razão social está fora do formato do nó.',
  access_email_unconfigured:
    'Cliente de contrato direto sem o e-mail "ambiente pronto": falta o SMTP do cp-worker ou a página de status.',
  panel_bundle_missing: 'A versão do nó não tem o bundle do painel.',
  firebase_pool_full: 'Todos os projetos do Firebase dos painéis estão cheios.',
  terraform_failed: 'O apply do Terraform falhou duas vezes.',
  ready_timeout: 'O nó não ficou pronto em 90 minutos.',
  health_failed: 'A API pelo túnel ou o painel não responderam.',
  domain_timeout: 'O certificado do endereço do painel não saiu em 24 horas.',
  bootstrap_missing: 'O nó ficou pronto, mas a senha do administrador não chegou ao cofre.',
  retries_exhausted: 'Um erro passageiro durou todas as tentativas da fila.',
};

export function failureHint(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  if (Object.hasOwn(FAILURE_HINTS, code)) return FAILURE_HINTS[code];
  if (code.startsWith('node_error:')) return 'A instalação no nó gravou um erro (veja a saída serial da VM).';
  if (code.startsWith('terraform_refused:')) return 'O executor do Terraform recusou o plano. Não force.';
  if (code.endsWith('_denied')) return 'Um serviço recusou a credencial ou a permissão.';
  return undefined;
}
