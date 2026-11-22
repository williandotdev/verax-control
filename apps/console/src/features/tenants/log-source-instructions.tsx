import { Download, ExternalLink, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { AwsStackView, CloudflareTokenView, LogSourceView, ReadKeysView } from '@/lib/api-types';
import { MISMATCH_LABELS } from './log-source-labels';
import {
  adminPath,
  AWS_TEMPLATE_FILE,
  awsReadKeysMessage,
  awsStackMessage,
  cloudflareTokenMessage,
  gcpReadKeysMessage,
  httpsHref,
  listText,
  policyText,
  useClipboard,
} from './log-source-messages';

/**
 * O que mandar ao cliente para cada fonte: no ambiente da Verax, a pilha do papel de leitura sem chave da AWS (o
 * modelo do CloudFormation, os parâmetros, o comando e o link do console); na VM do cliente, as chaves de leitura que
 * ele cria (o usuário IAM ou a conta de serviço da GCP); no Cloudflare, o link do token de leitura e os IPs do filtro.
 * Os valores vêm do cp-admin (`awsStack`, `readKeys`, `cloudflareToken`): nada aqui é segredo.
 */

type Clip = ReturnType<typeof useClipboard>;

/** Uma linha de valor com o botão de copiar (o botão fica dentro do `dd`, como pede a lista de definição). */
export function ValueRow({ label, value, clip }: { label: string; value: string; clip: Clip }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="w-44 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 font-mono text-xs break-all">{value}</span>
        {clip.available && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Copiar: ${label}`}
            onClick={() => void clip.copy(label, value)}
          >
            Copiar
          </Button>
        )}
      </dd>
    </div>
  );
}

/** Uma linha sem valor para copiar, com o motivo. */
function EmptyRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <dt className="w-44 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xs text-muted-foreground">{children}</dd>
    </div>
  );
}

/** Um texto longo (comando, política) num bloco rolável pelo teclado, com o botão de copiar. */
function CodeBlock({ label, text, clip }: { label: string; text: string; clip: Clip }) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">{label}</p>
        {clip.available && (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Copiar: ${label}`}
            onClick={() => void clip.copy(label, text)}
          >
            Copiar
          </Button>
        )}
      </div>
      <pre
        aria-label={label}
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-md border bg-surface-raised p-3 font-mono text-xs whitespace-pre"
      >
        {text}
      </pre>
    </div>
  );
}

/** O botão da mensagem pronta e a linha que diz o que a última cópia fez. */
function MessageActions({ clip, message, disabled }: { clip: Clip; message: string; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {clip.available && (
        <Button
          size="sm"
          disabled={disabled === true}
          onClick={() => void clip.copy('mensagem para o cliente', message)}
        >
          Copiar mensagem para o cliente
        </Button>
      )}
      <span role="status" className="text-xs text-muted-foreground">
        {clip.status}
      </span>
    </div>
  );
}

function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">(abre em outra aba)</span>
    </a>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="space-y-3 rounded-lg border p-3">
      <h4 className="text-sm font-semibold">{label}</h4>
      {children}
    </section>
  );
}

function Warning({ children }: { children: ReactNode }) {
  return (
    <div
      role="note"
      className="flex items-start gap-2 rounded-lg border border-high/60 bg-high/10 p-3 text-sm"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-high" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function AwsStackBlock({ accountId, stack }: { accountId: string; stack: AwsStackView }) {
  const clip = useClipboard();
  const consoleHref = httpsHref(stack.consoleUrl, 'console.aws.amazon.com');
  const template = adminPath(stack.templateUrl);
  // Sem o ID da conta de serviço ou sem o IP de saída, o comando leva o marcador: a mensagem não sai assim.
  const missing =
    stack.nodeServiceAccountId === null
      ? 'o ID da conta de serviço'
      : stack.egressIps.length === 0
        ? 'o IP de saída'
        : undefined;
  return (
    <Block label="Papel de leitura da AWS (CloudFormation)">
      <p className="text-sm">
        A AWS é lida sem chave: o cliente cria na conta dele o papel de leitura com o modelo do
        CloudFormation, e o servidor da Verax entra nele com a identidade do Google. Baixe o modelo, anexe e
        mande a mensagem.
      </p>
      {stack.mismatch && (
        <Warning>
          <p className="font-medium">
            O servidor informou valores diferentes dos que a Verax conhece:{' '}
            {stack.mismatches.map((field) => MISMATCH_LABELS[field]).join(', ')}.
          </p>
          <p>
            Confira o servidor do cliente antes de mandar a pilha. Os valores abaixo são os do plano de
            controle.
          </p>
        </Warning>
      )}
      {missing !== undefined && (
        <Warning>
          O provisionamento ainda não gravou {missing} do servidor: o comando leva o marcador, e a mensagem
          para o cliente fica para depois.
        </Warning>
      )}
      <dl className="space-y-2">
        <ValueRow label="Nome da pilha" value={stack.stackName} clip={clip} />
        <ValueRow label="Papel criado" value={stack.roleArn} clip={clip} />
        {stack.nodeServiceAccountId === null ? (
          <EmptyRow label="NodeServiceAccountId">Ainda não gravado.</EmptyRow>
        ) : (
          <ValueRow label="NodeServiceAccountId" value={stack.nodeServiceAccountId} clip={clip} />
        )}
        {stack.egressIps.length === 0 ? (
          <EmptyRow label="NodeEgressIps">Ainda não gravado.</EmptyRow>
        ) : (
          <ValueRow label="NodeEgressIps" value={listText(stack.egressIps)} clip={clip} />
        )}
        <ValueRow label="Audience" value={stack.audience} clip={clip} />
        {stack.bucketArns.length === 0 ? (
          <EmptyRow label="LogBucketArns">Vazio (a fonte não tem bucket cadastrado).</EmptyRow>
        ) : (
          <ValueRow label="LogBucketArns" value={listText(stack.bucketArns)} clip={clip} />
        )}
      </dl>
      <CodeBlock label="Comando da AWS CLI" text={stack.deployCommand} clip={clip} />
      <div className="flex flex-wrap items-center gap-4">
        {template !== undefined && (
          <a
            href={template}
            download={AWS_TEMPLATE_FILE}
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
          >
            <Download aria-hidden className="size-3.5" />
            Baixar modelo
          </a>
        )}
        {consoleHref !== undefined && (
          <ExternalAnchor href={consoleHref}>Abrir o CloudFormation no console da AWS</ExternalAnchor>
        )}
      </div>
      <MessageActions
        clip={clip}
        message={awsStackMessage(accountId, stack)}
        disabled={missing !== undefined}
      />
    </Block>
  );
}

function ReadKeysBlock({ accountId, keys }: { accountId: string; keys: ReadKeysView }) {
  const clip = useClipboard();
  if (keys.provider === 'aws') {
    return (
      <Block label="Usuário IAM de leitura (VM do cliente)">
        <p className="text-sm">
          Na VM do cliente não há identidade de nuvem: ele cria um usuário IAM só de leitura e a chave de
          acesso dele, que ele cola no painel (ou você envia aqui, em “Enviar chave…”).
        </p>
        {keys.egressIps.length === 0 && (
          <Warning>
            O servidor ainda não informou os IPs de saída: as políticas saem sem o filtro de IP.
          </Warning>
        )}
        <dl className="space-y-2">
          <ValueRow label="Usuário IAM" value={keys.userArn} clip={clip} />
          <ValueRow label="Política de leitura" value={keys.readerPolicyName} clip={clip} />
          <ValueRow label="Política de proteção" value={keys.guardrailsPolicyName} clip={clip} />
          {keys.egressIps.length > 0 && (
            <ValueRow label="IPs de saída do servidor" value={listText(keys.egressIps)} clip={clip} />
          )}
        </dl>
        <CodeBlock label={keys.readerPolicyFile} text={policyText(keys.readerPolicy)} clip={clip} />
        <CodeBlock label={keys.guardrailsPolicyFile} text={policyText(keys.guardrailsPolicy)} clip={clip} />
        <CodeBlock label="Comandos da AWS CLI" text={keys.commands} clip={clip} />
        <MessageActions clip={clip} message={awsReadKeysMessage(accountId, keys)} />
      </Block>
    );
  }
  return (
    <Block label="Conta de serviço de leitura da GCP (VM do cliente)">
      <p className="text-sm">
        O cliente cria no projeto dele o tópico, a assinatura, o coletor dos eventos de segurança e uma conta
        de serviço só com a leitura da assinatura; a chave dela ele cola no painel (ou você envia aqui).
      </p>
      <dl className="space-y-2">
        <ValueRow label="Assinatura" value={keys.subscription} clip={clip} />
        <ValueRow label="Conta de serviço" value={keys.serviceAccountEmail} clip={clip} />
        <ValueRow label="Papel" value={keys.role} clip={clip} />
        <ValueRow label="Arquivo da chave" value={keys.keyFile} clip={clip} />
      </dl>
      <CodeBlock label="Comandos do Cloud Shell" text={keys.commands} clip={clip} />
      <MessageActions clip={clip} message={gcpReadKeysMessage(accountId, keys)} />
    </Block>
  );
}

function CloudflareTokenBlock({ accountId, token }: { accountId: string; token: CloudflareTokenView }) {
  const clip = useClipboard();
  const href = httpsHref(token.templateUrl, 'dash.cloudflare.com');
  return (
    <Block label="Token de leitura do Cloudflare">
      <p className="text-sm">
        O cliente cria um token de API só de leitura (o link já marca as permissões) e o restringe aos IPs de
        saída do servidor.
      </p>
      {href !== undefined && <ExternalAnchor href={href}>Criar o token no Cloudflare</ExternalAnchor>}
      <dl className="space-y-2">
        <ValueRow label="Nome do token" value={token.tokenName} clip={clip} />
        {token.egressIps.length === 0 ? (
          <EmptyRow label="IPs para o filtro do token">
            O servidor ainda não informou os IPs de saída: o token fica sem filtro de IP por enquanto.
          </EmptyRow>
        ) : (
          <ValueRow label="IPs para o filtro do token" value={token.egressIps.join(', ')} clip={clip} />
        )}
      </dl>
      <MessageActions clip={clip} message={cloudflareTokenMessage(accountId, token)} />
    </Block>
  );
}

/** Os blocos de instrução de uma fonte ativa (nenhum na removida). */
export function SourceInstructions({ source }: { source: LogSourceView }) {
  if (source.state === 'removed') return null;
  const accountId = source.spec.accountId;
  return (
    <>
      {source.awsStack !== null && <AwsStackBlock accountId={accountId} stack={source.awsStack} />}
      {source.readKeys !== null && <ReadKeysBlock accountId={accountId} keys={source.readKeys} />}
      {source.cloudflareToken !== null && (
        <CloudflareTokenBlock accountId={accountId} token={source.cloudflareToken} />
      )}
    </>
  );
}
