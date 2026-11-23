import { ApiError } from '@/lib/api';
import type {
  AwsLogBucketSource,
  AwsStackMismatchField,
  CredentialKind,
  LogSourceProvider,
  LogSourceStatus,
  NodePlatform,
  NodeSyncAccountReport,
  NodeSyncNodeError,
  NodeSyncSourceCode,
} from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';

/**
 * Os textos das fontes de log no detalhe do cliente: os provedores, a situação de cada fonte, o que cada código do nó
 * quer dizer (e o que fazer) e as recusas da API (`apps/control-plane/src/admin/admin-log-sources.service.ts`).
 */

export const PROVIDER_LABELS: Readonly<Record<LogSourceProvider, string>> = {
  aws: 'AWS',
  gcp: 'GCP',
  cloudflare: 'Cloudflare',
};

/** O que é o "ID da conta" em cada provedor. */
export const ACCOUNT_LABELS: Readonly<Record<LogSourceProvider, string>> = {
  aws: 'ID da conta AWS',
  gcp: 'ID do projeto da GCP',
  cloudflare: 'ID da conta do Cloudflare',
};

export const PLATFORM_LABELS: Readonly<Record<NodePlatform, string>> = {
  gcp: 'GCP (infraestrutura da Verax)',
  vm: 'VM do cliente',
};

export const CREDENTIAL_KIND_LABELS: Readonly<Record<CredentialKind, string>> = {
  cloudflare_api_token: 'Token de API do Cloudflare',
  aws_access_key: 'Chave de acesso do usuário IAM',
  gcp_service_account_key: 'Chave da conta de serviço da GCP',
};

/** O tipo de credencial de cada provedor (a lista do GET diz se ele vale neste cliente). */
export const PROVIDER_CREDENTIAL_KINDS: Readonly<Record<LogSourceProvider, CredentialKind>> = {
  aws: 'aws_access_key',
  gcp: 'gcp_service_account_key',
  cloudflare: 'cloudflare_api_token',
};

export const BUCKET_SOURCES: readonly AwsLogBucketSource[] = ['cloudtrail', 'guardduty', 'waf'];

export const BUCKET_LABELS: Readonly<Record<AwsLogBucketSource, string>> = {
  cloudtrail: 'Bucket do CloudTrail',
  guardduty: 'Bucket do GuardDuty',
  waf: 'Bucket do WAF',
};

export const SOURCE_STATUS_LABELS: Readonly<Record<LogSourceStatus, string>> = {
  pending: 'Pendente',
  applied: 'Aplicada',
  failed: 'Falhou',
  removing: 'Removendo',
  removed: 'Removida',
};

export const CONNECTION_LABELS: Readonly<Record<NodeSyncAccountReport['connection'], string>> = {
  waiting: 'Aguardando o primeiro sinal',
  connected: 'Conectada',
  error: 'Com erro',
};

export const COLLECTION_ERROR_LABELS: Readonly<
  Record<NonNullable<NodeSyncAccountReport['collectionError']>, string>
> = {
  aws_token_stale:
    'O token do servidor para a AWS está velho: a coleta dos buckets e dos grupos de logs parou.',
  wazuh_apply_failed: 'O servidor não conseguiu aplicar a leitura dos buckets e dos grupos de logs.',
};

export const MISMATCH_LABELS: Readonly<Record<AwsStackMismatchField, string>> = {
  serviceAccountId: 'o ID da conta de serviço',
  egressIps: 'os IPs de saída',
  audience: 'o audience',
};

/** Um código do nó: o que houve e o que fazer. */
export interface SourceCodeMessage {
  message: string;
  action: string;
}

/** Todo código de `NODE_SYNC_SOURCE_CODES` (`@verax/shared`), em português. */
export const SOURCE_CODE_MESSAGES: Readonly<Record<NodeSyncSourceCode, SourceCodeMessage>> = {
  invalid_spec: {
    message: 'O servidor recusou o cadastro: ele não passa nas regras do painel.',
    action: 'Confira os campos e altere a fonte.',
  },
  immutable_changed: {
    message: 'A revisão troca o provedor ou o ID da conta.',
    action: 'Outra conta é outra fonte: remova esta e cadastre a nova.',
  },
  tenant_ambiguous: {
    message: 'O banco do servidor tem mais de um cliente: nada é aplicado.',
    action: 'Confira a instalação do servidor (deve haver um cliente só).',
  },
  plan_limit_reached: {
    message: 'Limite de contas do plano.',
    action:
      'O plano do cliente não tem vaga para mais uma conta: remova outra fonte ou faça um aditivo do contrato. O servidor tenta de novo a cada hora.',
  },
  tenant_plan_missing: {
    message: 'O servidor ainda não recebeu o plano do cliente.',
    action: 'Confira a instalação do servidor; depois, altere a fonte para ele tentar de novo.',
  },
  account_exists_panel: {
    message: 'O cliente já cadastrou esta conta no painel dele; ela continua sendo dele.',
    action:
      'O servidor não mexe nela. Para a Verax cuidar da conta, o cliente a remove no painel; depois, remova esta fonte e cadastre de novo.',
  },
  origin_conflict: {
    message: 'Um bucket, uma assinatura ou uma zona desta fonte já é de outra conta.',
    action: 'Tire o que se repete (altere a fonte) ou ajuste a outra conta.',
  },
  vault_disabled: {
    message: 'O servidor está sem o cofre de credenciais: a chave não foi aplicada.',
    action: 'Confira a instalação do servidor (o cofre) e envie a chave de novo.',
  },
  credential_kind_not_allowed: {
    message: 'Este tipo de chave não vale no servidor deste cliente.',
    action:
      'No ambiente da Verax, a AWS é lida pelo papel sem chave: mande a pilha do CloudFormation ao cliente.',
  },
  credential_unreadable: {
    message: 'O servidor não conseguiu abrir a chave enviada (a chave do cofre mudou depois do envio).',
    action: 'Envie a chave de novo.',
  },
  credential_rejected_invalid: {
    message: 'A origem recusou a chave: ela não é válida.',
    action: 'Confira o valor com o cliente e envie de novo (ou ele cola no painel).',
  },
  credential_rejected_inactive: {
    message: 'A chave está desativada na origem.',
    action: 'Peça ao cliente para reativá-la ou criar outra, e envie de novo.',
  },
  credential_rejected_expired: {
    message: 'A chave venceu.',
    action: 'Peça ao cliente uma chave nova e envie de novo.',
  },
  credential_rejected_not_yet_valid: {
    message: 'A chave ainda não está valendo (o início é no futuro).',
    action: 'Envie de novo quando ela começar a valer, ou peça outra ao cliente.',
  },
  credential_rejected_no_account_access: {
    message: 'A chave não alcança esta conta.',
    action:
      'Confira as permissões da chave e, no Cloudflare, o filtro de IP do token (os IPs de saída do servidor).',
  },
  credential_rejected_wrong_identity: {
    message: 'A chave é de outra conta ou de outra identidade.',
    action: 'Confira se a chave é da conta cadastrada e envie de novo.',
  },
  deleted_in_panel: {
    message: 'Excluída pelo cliente no painel dele.',
    action:
      'Para cadastrar de novo, altere a fonte aqui (nova revisão) ou peça ao cliente para conectar pelo painel.',
  },
  source_unavailable: {
    message: 'A origem não respondeu à conferência da chave.',
    action: 'Nada a fazer: o servidor tenta de novo sozinho, com espera crescente (até 30 minutos).',
  },
  internal_error: {
    message: 'Falha inesperada no servidor.',
    action:
      'O detalhe fica no log do servidor do cliente. Se continuar, altere a fonte para ele tentar de novo.',
  },
};

export const NODE_ERROR_MESSAGES: Readonly<Record<NodeSyncNodeError, string>> = {
  tenant_ambiguous:
    'O banco do servidor tem mais de um cliente: nenhuma fonte é aplicada até sobrar um. Confira a instalação.',
  vault_unreadable:
    'O servidor não consegue ler o cofre de credenciais: nenhuma chave é aplicada nem pode ser enviada. Confira a instalação.',
};

/** As recusas da API das fontes de log, com o que fazer. */
export const LOG_SOURCE_ERRORS: Readonly<Record<string, string>> = {
  source_exists: 'Esta conta já é uma fonte deste cliente: altere a fonte que existe.',
  source_limit:
    'O cliente chegou ao máximo de fontes da sincronização (contando as removidas): nada foi gravado.',
  source_removed: 'A fonte já foi removida: para ler esta conta de novo, cadastre outra fonte.',
  source_not_found: 'A fonte não existe mais. Atualize a página.',
  no_change: 'Nada muda nesta alteração: nada foi gravado.',
  placement_unsupported:
    'Cliente da célula compartilhada: as fontes de log ainda não são cadastradas pelo console.',
  not_allowed:
    'O contrato deste cliente já terminou (cancelado ou excluído): não há fonte para cadastrar ou alterar.',
  node_not_synced:
    'O servidor do cliente ainda não sincronizou com a Verax: a chave só pode ser cifrada para ele depois disso. Cadastre sem a chave, ou o cliente cola no painel dele.',
  vault_disabled:
    'O servidor do cliente está sem o cofre de credenciais (ou não consegue lê-lo): não há para quem cifrar a chave. Confira a instalação.',
  platform_mismatch:
    'O servidor informou outra plataforma que a do lugar deste cliente: nada foi cifrado. Confira a instalação.',
  vault_key_invalid:
    'A chave do cofre que o servidor informou não confere (formato ou impressão digital): nada foi cifrado. Confira a instalação.',
  gcp_unsupported_managed:
    'Projetos da GCP pelo console só no ambiente na VM do cliente, por enquanto: o servidor na infraestrutura da Verax ainda não recebe projetos de cliente.',
  credential_kind_not_allowed:
    'Este tipo de chave não vale no servidor deste cliente: no ambiente da Verax, a AWS é lida pelo papel sem chave (a pilha do CloudFormation).',
  cloudflare_oauth_only:
    'Neste cliente, o Cloudflare é conectado por ele mesmo, no painel ("Conectar com Cloudflare"): nenhum token novo foi enviado. A conta que já coleta com token segue coletando.',
  credential_provider_mismatch: 'A chave é de outro provedor que o da fonte.',
  confirmation_mismatch: 'O subdomínio não confere com o do cliente: nada mudou.',
  rate_limited:
    'Muitas operações em pouco tempo (o limite é de 20 por hora). Aguarde e tente de novo: nada foi gravado.',
  invalid_request: 'A API recusou os dados: confira os campos apontados.',
  tenant_not_found: 'Cliente não encontrado.',
};

/** A mensagem de um erro das fontes de log: a do código; senão, a genérica. */
export function logSourceErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== undefined && Object.hasOwn(LOG_SOURCE_ERRORS, error.code)) {
    return LOG_SOURCE_ERRORS[error.code] ?? errorMessage(error);
  }
  return errorMessage(error);
}
