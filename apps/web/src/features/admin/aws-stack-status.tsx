import {
  AWS_READER_AUTHORIZATIONS,
  AWS_READER_POLICY_FILE,
  AWS_READER_STACK_NAME,
  AWS_READER_TEMPLATE_VERSION,
  awsLogBucketArns,
  type AwsOnboarding,
  awsReaderUserPolicy,
  awsReaderUserUpdateCommands,
  type CloudAccount,
  cloudFormationStacksUrl,
  logBucketNames,
} from '@verax/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  ALL_AWS_AUTHORIZATIONS,
  authorizationChoiceOf,
  authorizationParameters,
  type AwsAuthorizationChoice,
  awsConsoleRegion,
  capabilitiesOfChoice,
  downloadTextFile,
} from '@/features/admin/aws-connect';
import {
  AwsAuthorizationChoices,
  PrefilledStackCli,
  StackFileProblem,
} from '@/features/admin/aws-connect-panel';
import { useAwsStackFile } from '@/features/admin/aws-hooks';
import { useAwsVerify } from '@/features/admin/aws-onboarding-api';
import { AWS_AUTHORIZATION_TEXTS, awsOnboardingErrorText } from '@/features/admin/aws-onboarding-labels';
import { ConsoleTerm, Notice, OutLink, Section, ToneBadge } from '@/features/admin/aws-ui';
import { CommandBlock, PolicyBlock } from '@/features/admin/command-block';
import { formatRelative } from '@/lib/format';

/** Por que a pilha precisa (ou pode) ser atualizada. */
type UpdateReason = 'outdated' | 'unreadable' | 'authorization_off' | 'change';

function updateReason(onboarding: AwsOnboarding): UpdateReason {
  const { template } = onboarding;
  // Sem a leitura das etiquetas, não se sabe o que a pilha tem: nada a pedir, só o caminho para quem quiser atualizar.
  if (template.checkedAt === null) return 'change';
  if (template.outdated) return 'outdated';
  if (template.version === null) return 'unreadable';
  const off = AWS_READER_AUTHORIZATIONS.some(
    (authorization) => !template.capabilities.includes(authorization),
  );
  return off ? 'authorization_off' : 'change';
}

const REASON_TEXTS: Readonly<Record<UpdateReason, { role: string; key: string }>> = {
  outdated: {
    role: 'A pilha desta conta foi criada com o modelo anterior. Sem atualizar, o Verax não encontra todas as fontes de log da conta, e nenhuma das três autorizações vale.',
    key: 'O usuário de leitura desta conta foi criado com as políticas do modelo anterior. Sem atualizar, o Verax não encontra todas as fontes de log da conta, e nenhuma das três autorizações vale.',
  },
  unreadable: {
    role: 'O Verax não conseguiu identificar a versão do modelo desta pilha. Atualize a pilha com o arquivo abaixo para as informações dela serem gravadas de novo.',
    key: 'O Verax não conseguiu identificar a versão do modelo das políticas do usuário de leitura. Grave de novo as etiquetas dele, com os comandos abaixo.',
  },
  authorization_off: {
    role: 'Há autorização desligada na pilha. As fontes desse tipo aparecem em "Precisam de permissão adicional" e não podem ser coletadas. Para ligar, marque abaixo e atualize a pilha.',
    key: 'Há autorização desligada nas políticas do usuário de leitura. As fontes desse tipo aparecem em "Precisam de permissão adicional" e não podem ser coletadas. Para ligar, marque abaixo e atualize a política.',
  },
  change: {
    role: 'Para ligar ou desligar uma autorização, ou depois de mudar os buckets fora do padrão, escolha abaixo e atualize a pilha. Desligar uma autorização tira a permissão do Verax na hora.',
    key: 'Para ligar ou desligar uma autorização, ou depois de mudar os buckets fora do padrão, escolha abaixo e atualize a política. Desligar uma autorização tira a permissão do Verax na hora.',
  },
};

/** O "verificar de novo" depois de atualizar: o servidor relê a versão do modelo e as autorizações do papel. */
function VerifyAfterUpdate({ account, waiting }: { account: CloudAccount; waiting: boolean }) {
  const verify = useAwsVerify(account.id);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="secondary"
        onClick={() => verify.mutate()}
        disabled={waiting || verify.isPending || account.status !== 'active'}
      >
        {waiting ? 'Verificando…' : 'Verificar de novo'}
      </Button>
      {verify.error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(verify.error)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * "Atualize a pilha": o arquivo do modelo atual com as autorizações escolhidas (as que a pilha já tem, mais as que o
 * cliente quer ligar) e os passos para atualizar a pilha que já existe. O console do CloudFormation mantém, na
 * atualização, os valores que a pilha já tinha: por isso o passo dos parâmetros diz como cada autorização deve ficar.
 */
function UpdateStack({
  account,
  onboarding,
  initial,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  initial: AwsAuthorizationChoice;
}) {
  const [choice, setChoice] = useState(initial);
  const stack = useAwsStackFile(account, choice);
  const waiting = onboarding.state === 'awaiting_authorization';
  const bucketArns = awsLogBucketArns(logBucketNames(account.buckets)).join(',');
  const download = () => {
    if (stack.file !== null && stack.file.ok) downloadTextFile(stack.file.fileName, stack.file.text);
  };
  return (
    <div className="space-y-3">
      <AwsAuthorizationChoices choice={choice} onChange={setChoice} legend="Como a pilha deve ficar" />
      <StackFileProblem stack={stack} />
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li className="space-y-1">
          <p>Baixe o arquivo do modelo atual, já com os valores deste ambiente e as escolhas acima:</p>
          <Button
            type="button"
            variant="secondary"
            onClick={download}
            disabled={stack.file === null || !stack.file.ok}
          >
            <Download aria-hidden />
            Baixar o arquivo da pilha
          </Button>
        </li>
        <li>
          No <OutLink href={cloudFormationStacksUrl(awsConsoleRegion(account))}>CloudFormation</OutLink>, abra
          a pilha <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code> e clique em{' '}
          <ConsoleTerm pt="Atualizar pilha" en="Update stack" />.
        </li>
        <li>
          Escolha <ConsoleTerm pt="Substituir o modelo existente" en="Replace existing template" />, depois{' '}
          <ConsoleTerm pt="Carregar um arquivo de modelo" en="Upload a template file" />, e envie o arquivo
          baixado.
        </li>
        <li className="space-y-1">
          <p>
            Na tela dos parâmetros, deixe as autorizações assim (o console mantém os valores que a pilha já
            tinha: mude só o que estiver diferente):
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {authorizationParameters(choice).map(({ authorization, parameter, value }) => (
              <li key={authorization}>
                {AWS_AUTHORIZATION_TEXTS[authorization].label} (<code className="font-mono">{parameter}</code>
                ): <code className="font-mono">{value}</code>
              </li>
            ))}
            <li>
              Buckets adicionais, fora do padrão AWSLogs (<code className="font-mono">LogBucketArns</code>):{' '}
              {bucketArns === '' ? 'vazio' : <code className="break-all font-mono">{bucketArns}</code>}
            </li>
          </ul>
        </li>
        <li>
          Avance, marque a confirmação de IAM e envie. Quando a pilha terminar de atualizar, clique em
          Verificar de novo, abaixo.
        </li>
      </ol>
      <PrefilledStackCli account={account} choice={choice} stack={stack}>
        O comando atualiza a pilha que já existe e leva os valores deste ambiente e as autorizações escolhidas
        acima: numa atualização, a AWS mantém o valor anterior de todo parâmetro que o comando não informa.
      </PrefilledStackCli>
      <VerifyAfterUpdate account={account} waiting={waiting} />
    </div>
  );
}

/**
 * Na VM própria do cliente não há pilha: quem lê é um usuário IAM, e atualizar é gravar uma versão nova da política de
 * leitura dele (com as autorizações escolhidas) e as etiquetas, que dizem ao Verax a versão do modelo e o que foi
 * autorizado.
 */
function UpdateReaderUser({
  account,
  onboarding,
  initial,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  initial: AwsAuthorizationChoice;
}) {
  const [choice, setChoice] = useState(initial);
  const capabilities = capabilitiesOfChoice(choice);
  const policy = awsReaderUserPolicy({
    accountId: account.accountId,
    buckets: logBucketNames(account.buckets),
    egressIps: account.egressIps,
    capabilities,
  });
  return (
    <div className="space-y-3">
      <AwsAuthorizationChoices choice={choice} onChange={setChoice} legend="Como a leitura deve ficar" />
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li className="space-y-1">
          <p>
            Salve a política de leitura com este conteúdo, no arquivo{' '}
            <code className="font-mono text-xs">{AWS_READER_POLICY_FILE}</code>:
          </p>
          <PolicyBlock file={AWS_READER_POLICY_FILE} policy={policy} />
        </li>
        <li className="space-y-1">
          <p>
            No terminal ou no AWS CloudShell, na pasta do arquivo, grave a versão nova da política e as
            etiquetas do usuário de leitura:
          </p>
          <CommandBlock
            command={awsReaderUserUpdateCommands(account.accountId, capabilities)}
            label="Copiar os comandos da CLI"
          />
          <p className="text-xs text-muted-foreground">
            Uma política do IAM guarda no máximo 5 versões: se o primeiro comando recusar por isso, apague uma
            versão antiga (<code className="font-mono">aws iam delete-policy-version</code>) e rode de novo.
          </p>
        </li>
        <li>Depois, clique em Verificar de novo, abaixo.</li>
      </ol>
      <VerifyAfterUpdate account={account} waiting={onboarding.state === 'awaiting_authorization'} />
    </div>
  );
}

/**
 * A pilha na AWS como o Verax a leu (as etiquetas do papel): a versão do modelo e as autorizações ligadas. Com o modelo
 * anterior ou uma autorização desligada, o bloco "Atualize a pilha" aparece aberto; com tudo em dia, fica fechado, para
 * quem quiser desligar uma autorização.
 */
export function AwsStackStatus({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const { template } = onboarding;
  const keyMode = onboarding.credentialMode === 'access_key';
  const reason = updateReason(onboarding);
  const needed = reason !== 'change';
  // O modelo anterior não tinha autorizações: o arquivo novo sai com as três, como o padrão do modelo.
  const initial =
    reason === 'outdated' || reason === 'unreadable' || template.checkedAt === null
      ? ALL_AWS_AUTHORIZATIONS
      : authorizationChoiceOf(template.capabilities);
  // Outra leitura das etiquetas (a pilha foi atualizada) recomeça a escolha a partir do que a pilha tem agora.
  const resetKey = `${String(template.version)}:${template.capabilities.join(',')}`;
  const update = keyMode ? (
    <UpdateReaderUser key={resetKey} account={account} onboarding={onboarding} initial={initial} />
  ) : (
    <UpdateStack key={resetKey} account={account} onboarding={onboarding} initial={initial} />
  );
  const updateTitle = keyMode ? 'Atualize as políticas do usuário de leitura' : 'Atualize a pilha';

  return (
    <Section id="aws-pilha" title={keyMode ? 'Usuário de leitura na AWS' : 'Pilha na AWS'}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Modelo</dt>
        <dd>
          {template.checkedAt === null ? (
            <ToneBadge tone="progress">ainda não lido</ToneBadge>
          ) : template.version === null ? (
            <ToneBadge tone="high">versão não identificada</ToneBadge>
          ) : template.outdated ? (
            <ToneBadge tone="high">
              versão {template.version} (anterior: a atual é a {AWS_READER_TEMPLATE_VERSION})
            </ToneBadge>
          ) : (
            <ToneBadge tone="ok">versão {template.version} (atual)</ToneBadge>
          )}
        </dd>
        <dt className="text-muted-foreground">Autorizações</dt>
        <dd>
          <ul className="space-y-0.5">
            <li>
              <ToneBadge tone="ok">Descoberta e postura: sempre ligada</ToneBadge>
            </li>
            {AWS_READER_AUTHORIZATIONS.map((authorization) => {
              const on = template.capabilities.includes(authorization);
              return (
                <li key={authorization}>
                  <ToneBadge tone={on ? 'ok' : 'idle'}>
                    {AWS_AUTHORIZATION_TEXTS[authorization].label}: {on ? 'ligada' : 'desligada'}
                  </ToneBadge>
                </li>
              );
            })}
          </ul>
        </dd>
        <dt className="text-muted-foreground">Conferido</dt>
        <dd>{template.checkedAt === null ? 'ainda não' : formatRelative(template.checkedAt)}</dd>
      </dl>
      {needed ? (
        <Notice tone={reason === 'authorization_off' ? 'medium' : 'high'} title={updateTitle}>
          <p>{REASON_TEXTS[reason][keyMode ? 'key' : 'role']}</p>
          {canWrite ? (
            update
          ) : (
            <p className="text-muted-foreground">Quem administra as contas atualiza a pilha.</p>
          )}
        </Notice>
      ) : (
        canWrite && (
          <details className="space-y-3 text-sm">
            <summary className="cursor-pointer font-medium">
              {keyMode ? 'Mudar o que está autorizado' : 'Atualizar a pilha ou mudar o que está autorizado'}
            </summary>
            <p className="text-muted-foreground">{REASON_TEXTS.change[keyMode ? 'key' : 'role']}</p>
            {update}
          </details>
        )
      )}
    </Section>
  );
}
