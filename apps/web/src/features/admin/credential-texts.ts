import type { CloudCredentialStatus, CloudProvider } from '@verax/shared';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

/** Os textos da credencial de cada provedor: o token do Cloudflare e as chaves de leitura da VM própria. */
export interface CredentialTexts {
  title: string;
  idLabel: string;
  replace: string;
  remove: string;
  removeWarning: string;
  saved: (suffix: string) => string;
  removed: string;
  pastePrompt: string;
  inactive: string;
  readOnly: string;
  unavailable: string;
}

export const CREDENTIAL_TEXTS: Readonly<Record<CloudProvider, CredentialTexts>> = {
  cloudflare: {
    title: 'Token de API guardado',
    idLabel: 'Token',
    replace: 'Trocar token',
    remove: 'Remover token',
    removeWarning:
      'A coleta do Cloudflare para até outro token ser colado. Apague o token no Cloudflare também.',
    saved: (suffix) => `Token conferido no Cloudflare e guardado no cofre do nó (…${suffix}).`,
    removed: 'Token removido do cofre do nó. Apague-o também no Cloudflare.',
    pastePrompt: 'Cole o token aqui:',
    inactive: 'Reative o monitoramento para colar o token: a conta desativada não guarda credencial.',
    readOnly: 'Quem administra as contas cola o token aqui. Nenhum token guardado ainda.',
    unavailable: 'O Cloudflare não respondeu a tempo. Tente de novo em instantes.',
  },
  aws: {
    title: 'Chave de acesso guardada',
    idLabel: 'ID da chave',
    replace: 'Trocar chave',
    remove: 'Remover chave',
    removeWarning:
      'A leitura da AWS para até outra chave ser colada. Desative e apague a chave no IAM também.',
    saved: (suffix) => `Chave conferida na AWS e guardada no cofre do nó (…${suffix}).`,
    removed: 'Chave removida do cofre do nó. Desative e apague a chave no IAM também.',
    pastePrompt: 'Cole a chave de acesso do usuário de leitura aqui:',
    inactive: 'Reative o monitoramento para colar a chave: a conta desativada não guarda credencial.',
    readOnly: 'Quem administra as contas cola a chave aqui. Nenhuma chave guardada ainda.',
    unavailable: 'A AWS não respondeu a tempo. Tente de novo em instantes.',
  },
  gcp: {
    title: 'Chave da conta de serviço guardada',
    idLabel: 'ID da chave',
    replace: 'Trocar chave',
    remove: 'Remover chave',
    removeWarning:
      'A leitura do projeto para até outra chave ser colada. Apague a chave na conta de serviço também.',
    saved: (suffix) => `Chave conferida no Google e guardada no cofre do nó (…${suffix}).`,
    removed: 'Chave removida do cofre do nó. Apague-a também na conta de serviço, no Google.',
    pastePrompt: 'Cole o conteúdo do arquivo JSON da chave aqui:',
    inactive: 'Reative o monitoramento para colar a chave: a conta desativada não guarda credencial.',
    readOnly: 'Quem administra as contas cola a chave aqui. Nenhuma chave guardada ainda.',
    unavailable: 'O Google não respondeu a tempo. Tente de novo em instantes.',
  },
};

/** O que o formulário de colar recebe do passo da credencial. */
export interface CredentialFormProps {
  replacing?: boolean;
  focusOnMount?: boolean;
  onCancel?: () => void;
  onSaved: (keyStatus: CloudCredentialStatus) => void;
}

/** O erro da API em texto, para ficar junto do campo ou do cartão (o 503 é a origem que não respondeu). */
export function credentialErrorText(
  error: unknown,
  texts: CredentialTexts = CREDENTIAL_TEXTS.cloudflare,
): string {
  if (error instanceof ApiRequestError && error.status === 503) return texts.unavailable;
  // 404 aqui é a conta ou o token que outra pessoa já tirou: a mensagem da API diz qual.
  if (error instanceof ApiRequestError && error.status === 404) return error.message;
  return errorMessage(error);
}
