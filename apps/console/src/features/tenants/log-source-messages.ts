import { useState } from 'react';
import type { AwsStackView, CloudflareTokenView, ReadKeysView } from '@/lib/api-types';

/**
 * O que o console manda ao cliente para cada fonte de log, em texto: a pilha do papel de leitura da AWS (gerenciado),
 * as chaves de leitura que ele cria (VM do cliente) e o token de leitura do Cloudflare. Os valores vêm do cp-admin e
 * não são segredo. E o botão de copiar, com o que aconteceu.
 */

/** O arquivo do modelo do CloudFormation (o mesmo nome no repositório e no download). */
export const AWS_TEMPLATE_FILE = 'verax-control-reader.yaml';

/** O que aconteceu na última cópia (sem `navigator.clipboard`, fora do https, os botões somem). */
export function useClipboard(): {
  available: boolean;
  copy: (label: string, text: string) => Promise<void>;
  /** O texto da linha de situação ao lado dos botões. */
  status: string;
} {
  const [status, setStatus] = useState('');
  const clipboard =
    typeof navigator === 'undefined' ? undefined : (navigator.clipboard as Clipboard | undefined);

  async function copy(label: string, text: string): Promise<void> {
    try {
      await clipboard?.writeText(text);
      setStatus(`Copiado: ${label}.`);
    } catch {
      setStatus('Não deu para copiar: selecione e copie à mão.');
    }
  }

  return { available: clipboard !== undefined, copy, status };
}

/** Só `https` no host esperado (a API já monta; aqui, de novo, antes de virar link). */
export function httpsHref(url: string, host: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === host ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Um caminho do próprio console (`/v1/admin/...`), nunca outro endereço. */
export function adminPath(path: string): string | undefined {
  return path.startsWith('/v1/admin/') && !path.includes('//') && !path.includes('..') ? path : undefined;
}

export function listText(items: readonly string[]): string {
  return items.join(',');
}

/** A região do link do CloudFormation (a primeira monitorada). */
function regionOf(consoleUrl: string): string | undefined {
  try {
    return new URL(consoleUrl).searchParams.get('region') ?? undefined;
  } catch {
    return undefined;
  }
}

/** A política IAM como o cliente salva no arquivo. */
export function policyText(policy: unknown): string {
  return JSON.stringify(policy, null, 2);
}

/**
 * A mensagem pronta para o cliente criar a pilha do papel de leitura (o modelo vai em anexo). Começa pelo caminho do
 * painel (o "Conectar com AWS", com o arquivo já preenchido); os passos e o comando são para quem cria a pilha à mão.
 */
export function awsStackMessage(accountId: string, stack: AwsStackView): string {
  const region = regionOf(stack.consoleUrl);
  return [
    `Olá! Para o Verax Control ler os logs da conta AWS ${accountId}, crie nela o papel de leitura, sem chave, com o modelo do CloudFormation que segue em anexo (${AWS_TEMPLATE_FILE}).`,
    '',
    `O jeito mais simples é pelo painel do Verax Control: em Contas cloud, abra a conta ${accountId} e clique em "Conectar com AWS". O painel baixa o modelo já preenchido, abre o CloudFormation e, depois de criada a pilha, mostra as fontes de log da conta para você escolher o que autoriza.`,
    '',
    'Se preferir criar a pilha à mão, pelo console da AWS:',
    `1. Abra o CloudFormation${region === undefined ? '' : ` na região ${region}`}: ${stack.consoleUrl}`,
    `2. Em "Especificar modelo", escolha "Fazer upload de um arquivo de modelo" e envie o ${AWS_TEMPLATE_FILE}.`,
    `3. Nome da pilha: ${stack.stackName}`,
    '4. Parâmetros:',
    `   NodeServiceAccountId: ${stack.nodeServiceAccountId ?? ''}`,
    `   NodeEgressIps: ${listText(stack.egressIps)}`,
    `   Audience: ${stack.audience}`,
    `   LogBucketArns: ${stack.bucketArns.length === 0 ? '(deixe vazio)' : listText(stack.bucketArns)}`,
    '   ReadAwsServiceLogs, ReadSecurityFindings e ReadTaggedLogGroups: as três autorizações (os logs da AWS no S3, os achados de segurança e os grupos do CloudWatch Logs que você marcar) já vêm ligadas; troque para false a que não quiser.',
    '5. Marque a confirmação de que a pilha cria recursos do IAM com nomes personalizados e crie a pilha.',
    '',
    'Ou, pela AWS CLI, na pasta do modelo:',
    stack.deployCommand,
    '',
    `O papel criado (${stack.roleArn}) só lê os logs e a configuração de segurança, não tem chave e só aceita o servidor de vocês na Verax, vindo dos IPs acima. Nada é coletado até você autorizar cada fonte no painel. Quando a pilha terminar, o painel avança sozinho; se criou a pilha à mão, clique em "Já criei a pilha: conectar" (ou avise a Verax).`,
  ].join('\n');
}

/** A mensagem pronta para o cliente criar o usuário IAM de leitura (VM do cliente). */
export function awsReadKeysMessage(
  accountId: string,
  keys: Extract<ReadKeysView, { provider: 'aws' }>,
): string {
  return [
    `Olá! Para o Verax Control ler os logs da conta AWS ${accountId}, crie nela um usuário IAM só de leitura, com uma chave de acesso:`,
    '',
    `1. Salve as duas políticas do fim desta mensagem nos arquivos ${keys.readerPolicyFile} e ${keys.guardrailsPolicyFile}.`,
    '2. Na pasta dos arquivos, rode na AWS CLI, com um usuário administrador da conta:',
    keys.commands,
    `3. O último comando mostra a chave de acesso (AccessKeyId e SecretAccessKey). Cole as duas no painel do Verax Control, em Contas cloud, na conta ${accountId} (ou mande à Verax por um canal seguro).`,
    '',
    `${keys.readerPolicyFile}:`,
    policyText(keys.readerPolicy),
    '',
    `${keys.guardrailsPolicyFile}:`,
    policyText(keys.guardrailsPolicy),
    '',
    keys.egressIps.length === 0
      ? 'O usuário só lê os logs e a configuração de segurança.'
      : `O usuário só lê os logs e a configuração de segurança, e só a partir do servidor de vocês (${listText(keys.egressIps)}).`,
  ].join('\n');
}

/** A mensagem pronta para o cliente criar a conta de serviço de leitura da GCP (VM do cliente). */
export function gcpReadKeysMessage(
  projectId: string,
  keys: Extract<ReadKeysView, { provider: 'gcp' }>,
): string {
  return [
    `Olá! Para o Verax Control ler os eventos de segurança do projeto ${projectId} da GCP, rode no Cloud Shell do projeto:`,
    '',
    keys.commands,
    '',
    `Os comandos criam o tópico e a assinatura (${keys.subscription}), o coletor dos eventos de segurança e a conta de serviço ${keys.serviceAccountEmail}, só com o papel ${keys.role} na assinatura.`,
    `O último comando grava a chave no arquivo ${keys.keyFile}: cole o conteúdo dele no painel do Verax Control, em Contas cloud, no projeto ${projectId} (ou mande à Verax por um canal seguro). Depois, apague o arquivo.`,
  ].join('\n');
}

/** A mensagem pronta para o cliente criar o token de leitura do Cloudflare. */
export function cloudflareTokenMessage(accountId: string, token: CloudflareTokenView): string {
  const filter =
    token.egressIps.length === 0
      ? []
      : [`3. Em "Filtro de endereço IP do cliente", permita só: ${token.egressIps.join(', ')}`];
  return [
    `Olá! Para o Verax Control ler os logs da conta do Cloudflare ${accountId}, crie um token de API só de leitura:`,
    '',
    `1. Abra o link (as permissões de leitura já vêm marcadas): ${token.templateUrl}`,
    `2. Nome do token: ${token.tokenName}`,
    ...filter,
    `${filter.length + 3}. Crie o token e cole o valor no painel do Verax Control, em Contas cloud, na conta ${accountId} (ou mande à Verax por um canal seguro).`,
  ].join('\n');
}
