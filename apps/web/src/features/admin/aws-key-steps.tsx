import {
  AWS_GUARDRAILS_POLICY_FILE,
  AWS_READER_POLICY_FILE,
  type AwsOnboardingState,
  awsGuardrailsPolicy,
  awsReaderUserArn,
  awsReaderUserCommands,
  awsReaderUserPolicy,
  type CloudAccount,
  cloudCredentialInputSchema,
  logBucketNames,
} from '@verax/shared';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { useCloudCredential } from '@/features/admin/admin-api';
import {
  type AwsAuthorizationChoice,
  capabilitiesOfChoice,
  chosenAuthorizations,
} from '@/features/admin/aws-connect';
import { AwsAuthorizationChoices } from '@/features/admin/aws-connect-panel';
import { useAwsVerify } from '@/features/admin/aws-onboarding-api';
import { awsOnboardingErrorText } from '@/features/admin/aws-onboarding-labels';
import { Section } from '@/features/admin/aws-ui';
import { CommandBlock, PolicyBlock } from '@/features/admin/command-block';
import { CredentialStep } from '@/features/admin/credential-step';
import {
  CREDENTIAL_TEXTS,
  type CredentialFormProps,
  credentialErrorText,
} from '@/features/admin/credential-texts';

/**
 * Conectar AWS na VM própria do cliente: o nó não tem identidade do Google para entrar no papel sem chave. O cliente
 * cria um usuário IAM só de leitura com as mesmas duas políticas do papel (leitura e negações; a de leitura também é o
 * limite de permissões do usuário), cria uma chave de acesso dele e cola aqui. A chave vai cifrada para o cofre do nó e
 * nunca volta para a tela; o Wazuh do nó lê os logs com sessões de 1 hora tiradas dela.
 *
 * As três autorizações valem aqui como na pilha: a política de leitura e as etiquetas do usuário saem com as escolhidas.
 * Aceita a chave, a conta segue o mesmo caminho das outras: a descoberta, as fontes e a saúde da coleta.
 */
export function AwsKeySteps({
  account,
  canWrite,
  choice,
  onChoiceChange,
  state,
}: {
  account: CloudAccount;
  canWrite: boolean;
  choice: AwsAuthorizationChoice;
  onChoiceChange: (choice: AwsAuthorizationChoice) => void;
  /** O estado da conexão, pela API: antes de conectar, o "Verificar" fica aqui; depois, na situação da conexão. */
  state: AwsOnboardingState;
}) {
  const capabilities = capabilitiesOfChoice(choice);
  const values = {
    accountId: account.accountId,
    buckets: logBucketNames(account.buckets),
    egressIps: account.egressIps,
    capabilities,
  };
  return (
    <Section id="aws-conectar" title={`Conectar a conta ${account.accountId}`}>
      <p className="text-sm text-muted-foreground">
        Este ambiente roda numa VM sua, sem identidade de nuvem: o Verax lê a conta com a chave de acesso de
        um usuário IAM só de leitura. A chave fica cifrada no cofre do nó, na sua VM: não volta para esta
        tela, nem para a auditoria ou o log.
      </p>
      <AwsAuthorizationChoices choice={choice} onChange={onChoiceChange} disabled={!canWrite} />
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li className="space-y-2">
          <p>
            Crie as duas políticas com o conteúdo abaixo: a de leitura (a configuração da conta, para
            descobrir as fontes de log e para Ativos e Postura, mais o que você autorizou acima e os buckets
            cadastrados em &ldquo;Avançado: buckets fora do padrão&rdquo;) e a de negações (nada de alterar
            logs nem ampliar o próprio acesso
            {account.egressIps.length > 0 ? ', e nada de fora do IP da VM' : ''}).
          </p>
          <PolicyBlock file={AWS_READER_POLICY_FILE} policy={awsReaderUserPolicy(values)} />
          <PolicyBlock file={AWS_GUARDRAILS_POLICY_FILE} policy={awsGuardrailsPolicy(values)} />
          <p className="text-xs text-muted-foreground">
            Mudou as autorizações ou a lista de buckets aqui? Atualize a política de leitura com o conteúdo
            novo (uma versão nova dela) e clique em Verificar.
          </p>
        </li>
        <li className="space-y-2">
          <p>
            Crie o usuário <code className="font-mono text-xs">{awsReaderUserArn(account.accountId)}</code>{' '}
            com as duas políticas e a de leitura como limite de permissões, e a chave de acesso dele. No
            terminal ou no AWS CloudShell, na pasta dos dois arquivos:
          </p>
          <CommandBlock
            command={awsReaderUserCommands(account.accountId, capabilities)}
            label="Copiar os comandos da CLI"
          />
          <p className="text-xs text-muted-foreground">
            Nunca use a chave do root nem a de um usuário com outras permissões: o Verax recusa a do root, e
            confere todo dia se o usuário ganhou permissão além da leitura.
          </p>
        </li>
        <li className="space-y-2">
          <CredentialStep
            account={account}
            canWrite={canWrite}
            texts={CREDENTIAL_TEXTS.aws}
            renderForm={(props) => <AwsKeyForm account={account} {...props} />}
          />
        </li>
        <li className="space-y-2">
          <AwsKeyVerify account={account} canWrite={canWrite} state={state} choice={choice} />
        </li>
      </ol>
      <p className="text-xs text-muted-foreground">
        Para desconectar: desative o monitoramento aqui (a chave sai do cofre do nó) e desative e apague a
        chave no IAM.
      </p>
    </Section>
  );
}

/**
 * O "Verificar" da chave: o pedido vai para o servidor, o único que usa a chave. Antes da primeira verificação, o botão
 * fica aqui, junto dos passos; depois, o resultado e o botão ficam em "Situação da conexão", como nas outras contas.
 * O pedido leva as autorizações marcadas acima (as das políticas mostradas), que ficam gravadas como a escolha.
 */
function AwsKeyVerify({
  account,
  canWrite,
  state,
  choice,
}: {
  account: CloudAccount;
  canWrite: boolean;
  state: AwsOnboardingState;
  choice: AwsAuthorizationChoice;
}) {
  const verify = useAwsVerify(account.id);
  const active = account.status === 'active';
  return (
    <>
      <p>
        Guardada a chave, clique em Verificar: o Verax confere que a chave é do usuário IAM desta conta e, em
        seguida, descobre sozinho as fontes de log dela. Depois, ele confere a conexão a cada 15 minutos e,
        uma vez por dia, se o usuário ganhou permissão além da leitura.
      </p>
      {state !== 'not_started' ? (
        <p className="text-muted-foreground">
          O resultado e o botão estão em &ldquo;Situação da conexão&rdquo;.
        </p>
      ) : canWrite && active ? (
        <Button
          type="button"
          onClick={() => verify.mutate(chosenAuthorizations(choice))}
          disabled={verify.isPending}
        >
          Verificar conexão
        </Button>
      ) : canWrite ? (
        <p>Reative o monitoramento para verificar a conta.</p>
      ) : (
        <p className="text-muted-foreground">Quem administra as contas pede a verificação.</p>
      )}
      {verify.error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(verify.error)}
        </p>
      ) : null}
    </>
  );
}

/**
 * Os dois campos da chave de acesso: o ID (não é segredo) e a chave secreta (tipo senha). Os dois são zerados no envio,
 * antes da resposta: o que foi colado vai do campo para a requisição e não fica em nenhum estado da tela.
 */
function AwsKeyForm({
  account,
  replacing = false,
  focusOnMount = false,
  onCancel,
  onSaved,
}: CredentialFormProps & { account: CloudAccount }) {
  const [keyId, setKeyId] = useState('');
  const [secret, setSecret] = useState('');
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const credential = useCloudCredential(account.id);
  useEffect(() => {
    if (focusOnMount) input.current?.focus();
  }, [focusOnMount]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = cloudCredentialInputSchema.safeParse({
      kind: 'aws_access_key',
      accessKeyId: keyId.trim(),
      secretAccessKey: secret.trim(),
    });
    setKeyId('');
    setSecret('');
    if (!parsed.success) {
      credential.reset();
      setError(parsed.error.issues[0]?.message ?? 'Chave inválida.');
      return;
    }
    setError(undefined);
    const saved = await credential.save(parsed.data);
    if (saved?.keyStatus) onSaved(saved.keyStatus);
  };

  const apiError = credential.error ? credentialErrorText(credential.error, CREDENTIAL_TEXTS.aws) : undefined;
  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-2">
      <Field
        ref={input}
        label="ID da chave de acesso"
        hint="Começa com AKIA (20 caracteres)."
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={keyId}
        onChange={(event) => setKeyId(event.target.value)}
      />
      <Field
        label="Chave secreta"
        hint="A AWS mostra a chave secreta uma vez só, ao criá-la. Depois de guardada, ela não volta para esta tela."
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        error={error ?? apiError}
      />
      {credential.pending && (
        <p role="status" className="text-xs text-muted-foreground">
          Conferindo a chave na AWS…
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={credential.pending}>
          {replacing ? 'Trocar chave' : 'Guardar chave'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
