import {
  AWS_READER_AUDIENCE,
  AWS_READER_AUTHORIZATIONS,
  AWS_READER_STACK_NAME,
  AWS_READER_TEMPLATE_FILE,
  type AwsOnboarding,
  awsLogBucketArns,
  awsReaderPrefilledFileName,
  type CloudAccount,
  cloudFormationConsoleUrl,
  logBucketNames,
} from '@verax/shared';
import { Download } from 'lucide-react';
import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  authorizationParameters,
  type AwsAuthorizationChoice,
  awsConsoleRegion,
  awsDeployCommand,
  downloadTextFile,
  openInNewTab,
} from '@/features/admin/aws-connect';
import { type AwsStackFile, useAwsStackFile, useNow } from '@/features/admin/aws-hooks';
import { useAwsConnect } from '@/features/admin/aws-onboarding-api';
import {
  AWS_AUTHORIZATION_FOOTNOTE,
  AWS_AUTHORIZATION_TEXTS,
  AWS_DISCOVERY_AUTHORIZATION_TEXT,
  AWS_PREFILL_PROBLEM_TEXTS,
  awsOnboardingErrorText,
} from '@/features/admin/aws-onboarding-labels';
import { AWS_READER_TEMPLATE_URL } from '@/features/admin/aws-reader-template';
import { ConsoleTerm, Notice, OutLink, Section, ToneIcon } from '@/features/admin/aws-ui';
import { CommandBlock, StackValue } from '@/features/admin/command-block';
import { AWS_READER_GUIDE_URL } from '@/features/admin/labels';
import { formatDuration } from '@/lib/format';

/**
 * "O que você autoriza": as três autorizações do papel de leitura, cada uma com o que permite e o que não permite, e a
 * descoberta, que vale sempre. A escolha vai para o arquivo que a tela baixa (e para o comando da CLI): quem decide o
 * que o Verax lê é o cliente, antes de criar a pilha.
 */
export function AwsAuthorizationChoices({
  choice,
  onChange,
  disabled = false,
  legend = 'O que você autoriza',
}: {
  choice: AwsAuthorizationChoice;
  onChange: (choice: AwsAuthorizationChoice) => void;
  disabled?: boolean;
  legend?: string;
}) {
  const id = useId();
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-semibold">{legend}</legend>
      <div className="flex gap-2 text-sm">
        <ToneIcon tone="ok" className="mt-0.5" />
        <div className="space-y-0.5">
          <p className="font-medium">{AWS_DISCOVERY_AUTHORIZATION_TEXT.label}</p>
          <p className="text-xs text-muted-foreground">{AWS_DISCOVERY_AUTHORIZATION_TEXT.description}</p>
        </div>
      </div>
      {AWS_READER_AUTHORIZATIONS.map((authorization) => {
        const text = AWS_AUTHORIZATION_TEXTS[authorization];
        const fieldId = `${id}-${authorization}`;
        return (
          <div key={authorization} className="flex gap-2 text-sm">
            <input
              id={fieldId}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0"
              checked={choice[authorization]}
              disabled={disabled}
              aria-describedby={`${fieldId}-dica`}
              onChange={(event) => onChange({ ...choice, [authorization]: event.target.checked })}
            />
            <div className="space-y-0.5">
              <label htmlFor={fieldId} className="font-medium">
                {text.label}
              </label>
              <p id={`${fieldId}-dica`} className="text-xs text-muted-foreground">
                {text.description}
              </p>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">{AWS_AUTHORIZATION_FOOTNOTE}</p>
    </fieldset>
  );
}

/** O que fazer no console do CloudFormation com o arquivo baixado: os três passos da criação da pilha. */
export function AwsCreateStackSteps({ account }: { account: CloudAccount }) {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm">
      <li>
        No CloudFormation, em <ConsoleTerm pt="Criar pilha" en="Create stack" />, escolha{' '}
        <ConsoleTerm pt="Carregar um arquivo de modelo" en="Upload a template file" /> e envie o arquivo
        baixado (<code className="font-mono text-xs">{awsReaderPrefilledFileName(account.accountId)}</code>).
      </li>
      <li>
        Dê o nome <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code> à pilha e avance sem
        mudar os valores: eles já vêm preenchidos.
      </li>
      <li>
        Na revisão, marque a confirmação de IAM (
        <span lang="en">
          I acknowledge that AWS CloudFormation might create IAM resources with custom names
        </span>
        ) e crie a pilha. Leva 1 ou 2 minutos.
      </li>
    </ol>
  );
}

/** O arquivo não pôde ser montado, ou o modelo não carregou: o que fazer, em vez de um arquivo quebrado. */
export function StackFileProblem({ stack }: { stack: AwsStackFile }) {
  if (stack.error) {
    return (
      <Notice tone="critical" role="alert" title="O modelo da pilha não carregou.">
        <p>Sem ele, o arquivo não pode ser preparado.</p>
        <Button type="button" variant="secondary" size="sm" onClick={stack.retry}>
          Tentar de novo
        </Button>
      </Notice>
    );
  }
  if (stack.file !== null && !stack.file.ok) {
    return (
      <Notice tone="high" role="alert" title="O arquivo da pilha não pode ser preparado agora.">
        <p>{AWS_PREFILL_PROBLEM_TEXTS[stack.file.problem]}</p>
      </Notice>
    );
  }
  return null;
}

/**
 * Antes de conectar (e depois do tempo esgotado): o que a integração faz, o que o cliente autoriza e o botão
 * **Conectar com AWS**. Um clique: (1) baixa o template com os valores deste ambiente e as autorizações escolhidas já
 * gravados, montado aqui no navegador; (2) abre o CloudFormation na criação de pilha, em outra aba; (3) avisa a API,
 * que passa a tentar a entrada no papel. A tela só muda de passo quando a API responde: nada é adiantado.
 */
export function AwsConnectPanel({
  account,
  canWrite,
  choice,
  onChoiceChange,
  again = false,
}: {
  account: CloudAccount;
  canWrite: boolean;
  choice: AwsAuthorizationChoice;
  onChoiceChange: (choice: AwsAuthorizationChoice) => void;
  /** A conta já passou por uma tentativa (o tempo esgotou, ou a pilha foi apagada): o título diz "de novo". */
  again?: boolean;
}) {
  const stack = useAwsStackFile(account, choice);
  const connect = useAwsConnect(account.id);
  const active = account.status === 'active';
  const ready = stack.file !== null && stack.file.ok;

  const start = () => {
    if (stack.file === null || !stack.file.ok) return;
    downloadTextFile(stack.file.fileName, stack.file.text);
    openInNewTab(cloudFormationConsoleUrl(awsConsoleRegion(account)));
    connect.mutate();
  };

  return (
    <Section
      id="aws-conectar"
      title={
        again ? `Conectar de novo a conta ${account.accountId}` : `Conectar a conta ${account.accountId}`
      }
    >
      <p className="text-sm text-muted-foreground">
        O Verax lê a sua conta AWS por um papel somente leitura, sem chave: não há nada para criar, copiar ou
        guardar. Você cria o papel com um arquivo pronto, no CloudFormation da própria conta.
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>
          Depois de conectar, o Verax encontra sozinho as fontes de log da conta: você não digita bucket,
          região nem nome de grupo.
        </li>
        <li>Nada é coletado até você escolher e autorizar cada fonte, aqui nesta tela.</li>
        <li>
          Só o servidor do Verax entra no papel, com uma credencial que vale no máximo 1 hora e só a partir do
          endereço dele.
        </li>
      </ul>
      <AwsAuthorizationChoices choice={choice} onChange={onChoiceChange} disabled={!canWrite} />
      {!canWrite ? (
        <p className="text-sm text-muted-foreground">Quem administra as contas conecta a conta.</p>
      ) : !active ? (
        <p className="text-sm">Reative o monitoramento para conectar a conta.</p>
      ) : (
        <>
          <StackFileProblem stack={stack} />
          {(ready || stack.loading) && (
            <div className="space-y-2">
              <Button type="button" onClick={start} disabled={!ready || connect.isPending}>
                {connect.isPending ? 'Conectando…' : 'Conectar com AWS'}
              </Button>
              <p className="text-xs text-muted-foreground">
                O botão baixa o arquivo da pilha, já com os valores deste ambiente e as suas escolhas (ele não
                tem segredo), e abre o CloudFormation em outra aba. Lá:
              </p>
              <AwsCreateStackSteps account={account} />
            </div>
          )}
          {connect.error ? (
            <p role="alert" className="text-sm text-critical-text">
              {awsOnboardingErrorText(connect.error)}
            </p>
          ) : null}
        </>
      )}
      <AwsManualAlternative
        account={account}
        choice={choice}
        canConnect={canWrite && active}
        connecting={connect.isPending}
        onConnect={() => connect.mutate()}
      />
    </Section>
  );
}

/**
 * A alternativa manual, fechada por padrão: o template como está no repositório (sem nada preenchido), os valores para
 * digitar na pilha, o comando da CLI com as autorizações escolhidas e o passo a passo. Criada a pilha por aqui, o
 * botão só avisa a API (não baixa nem abre nada).
 */
function AwsManualAlternative({
  account,
  choice,
  canConnect,
  connecting,
  onConnect,
}: {
  account: CloudAccount;
  choice: AwsAuthorizationChoice;
  canConnect: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  const bucketArns = awsLogBucketArns(logBucketNames(account.buckets)).join(',');
  const egressIps = account.egressIps.length > 0 ? account.egressIps.join(',') : null;
  return (
    <details className="space-y-3 text-sm">
      <summary className="cursor-pointer font-medium">Alternativa manual (sem o arquivo preenchido)</summary>
      <ol className="list-decimal space-y-3 pl-5">
        <li className="space-y-1">
          <p>
            <a
              href={AWS_READER_TEMPLATE_URL}
              download={AWS_READER_TEMPLATE_FILE}
              className="inline-flex items-center gap-1 font-medium underline"
            >
              <Download aria-hidden className="size-3.5" />
              Baixar o template ({AWS_READER_TEMPLATE_FILE})
            </a>
          </p>
          <p className="text-xs text-muted-foreground">
            É o arquivo revisado do repositório, sem nada preenchido. O que a pilha cria e o que o papel pode
            fazer estão no <OutLink href={AWS_READER_GUIDE_URL}>passo a passo</OutLink>.
          </p>
        </li>
        <li className="space-y-2">
          <p>
            No <OutLink href={cloudFormationConsoleUrl(awsConsoleRegion(account))}>CloudFormation</OutLink>,
            crie a pilha <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code> com o arquivo e
            preencha estes valores (nenhum é segredo):
          </p>
          <dl className="grid grid-cols-1 gap-y-1.5">
            <StackValue
              label="ID da conta de serviço do nó"
              parameter="NodeServiceAccountId"
              value={account.nodeServiceAccountId}
              missing="Este nó ainda não informa o ID. Peça à Verax antes de criar a pilha."
            />
            <StackValue
              label="IP de saída do nó"
              parameter="NodeEgressIps"
              value={egressIps}
              missing="Este nó ainda não informa o IP. Peça à Verax antes de criar a pilha."
            />
            <StackValue
              label="Audience"
              parameter="Audience"
              value={account.webIdentityAudience ?? AWS_READER_AUDIENCE}
              missing=""
              hint="Já vem preenchido no template: só confira."
            />
            {authorizationParameters(choice).map(({ authorization, parameter, value }) => (
              <StackValue
                key={authorization}
                label={AWS_AUTHORIZATION_TEXTS[authorization].label}
                parameter={parameter}
                value={value}
                missing=""
              />
            ))}
            {bucketArns && (
              <StackValue
                label="Buckets fora do padrão"
                parameter="LogBucketArns"
                value={bucketArns}
                missing=""
              />
            )}
          </dl>
        </li>
        <li className="space-y-1">
          <p>
            Ou pela CLI, no terminal ou no AWS CloudShell, na pasta do arquivo baixado. O mesmo comando cria a
            pilha ou atualiza a que já existe, com as autorizações escolhidas acima:
          </p>
          <CommandBlock command={awsDeployCommand(account, choice)} label="Copiar o comando da CLI" />
        </li>
        {canConnect && (
          <li className="space-y-1">
            <p>Criada a pilha, avise o Verax, que passa a conferir a conexão sozinho:</p>
            <Button type="button" variant="secondary" disabled={connecting} onClick={onConnect}>
              Já criei a pilha: conectar
            </Button>
          </li>
        )}
      </ol>
    </details>
  );
}

/** De quanto em quanto tempo a conta regressiva da espera é redesenhada. */
const COUNTDOWN_TICK_MS = 15_000;

/**
 * Depois do clique, enquanto a API diz que está esperando o papel (`awaiting_authorization`, com a janela do
 * "Conectar" aberta): os três passos de novo, o aviso de que o Verax não enxerga a pilha enquanto ela é criada, o
 * tempo que falta da janela de 60 min (do `connect.waitingUntil` da API) e os dois atalhos, baixar o arquivo de novo e
 * abrir o CloudFormation.
 */
export function AwsWaitingPanel({
  account,
  onboarding,
  canWrite,
  choice,
  onChoiceChange,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
  choice: AwsAuthorizationChoice;
  onChoiceChange: (choice: AwsAuthorizationChoice) => void;
}) {
  const now = useNow(COUNTDOWN_TICK_MS);
  const stack = useAwsStackFile(account, choice, canWrite);
  const until = onboarding.connect.waitingUntil;
  const remainingMs = until === null ? 0 : Math.max(0, Date.parse(until) - now);
  const again = () => {
    if (stack.file !== null && stack.file.ok) downloadTextFile(stack.file.fileName, stack.file.text);
  };
  return (
    <Section id="aws-aguardando" title="Crie a pilha na AWS">
      <AwsCreateStackSteps account={account} />
      <Notice tone="low" title="O Verax não enxerga a pilha enquanto ela é criada.">
        <p>
          Ele só sabe que ainda não conseguiu entrar no papel de leitura. Quando a pilha terminar, esta tela
          avança sozinha: não é preciso clicar em nada aqui.
        </p>
      </Notice>
      {until !== null && (
        <p className="text-sm">
          {remainingMs > 0 ? (
            <>
              Tempo restante para criar a pilha: <strong>{formatDuration(remainingMs / 1000)}</strong>. Depois
              disso, o Verax para de tentar e é preciso conectar de novo.
            </>
          ) : (
            'O prazo para criar a pilha acabou: o Verax confirma em instantes.'
          )}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {canWrite && (
          <Button
            type="button"
            variant="secondary"
            onClick={again}
            disabled={stack.file === null || !stack.file.ok}
          >
            <Download aria-hidden />
            Baixar o arquivo de novo
          </Button>
        )}
        <OutLink href={cloudFormationConsoleUrl(awsConsoleRegion(account))} className="text-sm">
          Abrir o CloudFormation
        </OutLink>
      </div>
      {canWrite && <StackFileProblem stack={stack} />}
      {canWrite && (
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer font-medium">O que o arquivo autoriza</summary>
          <AwsAuthorizationChoices
            choice={choice}
            onChange={onChoiceChange}
            legend="O arquivo baixado de novo sai com estas autorizações"
          />
        </details>
      )}
    </Section>
  );
}
