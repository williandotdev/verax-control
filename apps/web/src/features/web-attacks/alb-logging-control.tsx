import { useQueryClient } from '@tanstack/react-query';
import {
  AWS_READER_ALB_LOGS_PARAMETER,
  AWS_READER_STACK_NAME,
  type AwsOnboarding,
  type AwsSource,
  type CloudAccount,
  cloudFormationStacksUrl,
  type WebAlbLogging,
  type WebAlbLoggingAction,
} from '@verax/shared';
import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { awsConsoleRegion, downloadTextFile, storedAuthorizationChoice } from '@/features/admin/aws-connect';
import { StackFileProblem } from '@/features/admin/aws-connect-panel';
import { useAwsStackFile } from '@/features/admin/aws-hooks';
import { awsSourceName } from '@/features/admin/aws-onboarding-labels';
import { ConsoleTerm, Notice, OutLink } from '@/features/admin/aws-ui';
import { formatMinute } from '@/lib/format';
import { AlbLoggingSteps } from './alb-logging-steps';
import { useAlbLogging, useRequestAlbLogging } from './web-logs-api';
import { ALB_LOGGING_FAILURE_TEXTS, isAlbStackUpdateFailure, webLogsErrorText } from './web-logs-labels';

/**
 * O log de acesso de um ALB ligado pelo painel (a pilha com `EnableAlbAccessLogs`). O nó de antes não tem a rota: aí fica o
 * caminho de antes, os passos para o cliente fazer na conta dele (`AlbLoggingSteps`). Com a rota, o botão "Ligar logs", uma
 * confirmação que diz o que muda na AWS, e os passos como alternativa recolhida.
 */

const isAlb = (source: AwsSource): boolean => source.details.arn?.includes(':loadbalancer/app/') === true;

/** Relê a conta quando o worker responde: a descoberta que ele pediu muda o balanceador de lista. */
function useRefreshOnResult(account: CloudAccount, state: WebAlbLogging | null | undefined) {
  const queryClient = useQueryClient();
  const pending = state?.pending ?? null;
  const seen = useRef(pending);
  useEffect(() => {
    if (seen.current !== null && pending === null) {
      void queryClient.invalidateQueries({ queryKey: ['aws-onboarding', account.id] });
    }
    seen.current = pending;
  }, [pending, queryClient, account.id]);
}

/** O que a pessoa vê antes de ligar: o que muda na AWS dela, o custo e como desfazer. */
function EnableExplanation({ source }: { source: AwsSource }) {
  return (
    <>
      <p>Na sua conta AWS, o Verax muda só isto:</p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          liga o <strong>log de acesso</strong> do balanceador{' '}
          <span className="font-mono text-xs wrap-anywhere">{awsSourceName(source)}</span>. Nenhuma outra
          configuração dele muda, e o tráfego dos seus usuários segue igual;
        </li>
        <li>
          os arquivos do log passam a ser gravados no bucket que a pilha da Verax criou na sua conta (região{' '}
          {source.region}), privado e com retenção. Nenhum log que já existe é tocado.
        </li>
      </ul>
      <p>
        <strong>Tem custo na AWS:</strong> o S3 cobra pelo que é gravado e guardado. Quanto mais visitas,
        maior a conta.
      </p>
      <p>
        <strong>Para desfazer:</strong> em &ldquo;Fontes de log&rdquo;, &ldquo;Desligar log&rdquo; (depois de
        tirar a autorização, se tiver dado), ou no console do EC2, em{' '}
        <ConsoleTerm pt="Atributos" en="Attributes" /> do balanceador. Antes de mudar, o Verax confere de
        novo: se o log já estiver ligado, ele não mexe em nada.
      </p>
    </>
  );
}

/** "Atualize a pilha da Verax": o arquivo da pilha desta conta com o log dos ALB ligado, e os passos no console. */
function AlbStackUpdate({ account, onboarding }: { account: CloudAccount; onboarding: AwsOnboarding }) {
  const [choice] = useState(() => storedAuthorizationChoice(onboarding));
  const stack = useAwsStackFile(account, choice, true, { albLogs: true });
  if (onboarding.credentialMode === 'access_key') {
    return (
      <p>
        Esta conta usa a chave de um usuário de leitura, e com ela o Verax não liga nada. Faça você mesmo, nos
        passos abaixo.
      </p>
    );
  }
  const download = () => {
    if (stack.file !== null && stack.file.ok) downloadTextFile(stack.file.fileName, stack.file.text);
  };
  return (
    <div className="space-y-2">
      <p>
        A opção <code className="font-mono text-xs">{AWS_READER_ALB_LOGS_PARAMETER}</code> da pilha cria um
        bucket só para esses logs e deixa o Verax mudar só o log de acesso dos balanceadores da região da
        pilha. Nada que já existe na sua conta muda ao atualizar.
      </p>
      <StackFileProblem stack={stack} />
      <ol className="list-decimal space-y-2 pl-5">
        <li className="space-y-1">
          <p>Baixe o arquivo da pilha, já com os valores deste ambiente e a opção ligada:</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
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
          <ConsoleTerm pt="Atualizar pilha" en="Update stack" />. Escolha{' '}
          <ConsoleTerm pt="Substituir o modelo existente" en="Replace existing template" /> e envie o arquivo
          baixado.
        </li>
        <li>
          Nos parâmetros, deixe <code className="font-mono text-xs">{AWS_READER_ALB_LOGS_PARAMETER}</code> em{' '}
          <code className="font-mono text-xs">true</code> (os outros ficam como estão). Avance, marque a
          confirmação de IAM e envie.
        </li>
        <li>Quando a pilha terminar de atualizar, clique em &ldquo;Ligar logs&rdquo; de novo.</li>
      </ol>
    </div>
  );
}

/** O botão e a confirmação de um pedido (ligar ou desligar). */
function RequestButton({
  source,
  action,
  label,
}: {
  source: AwsSource;
  action: WebAlbLoggingAction;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const request = useRequestAlbLogging(source.id);
  const name = awsSourceName(source);
  const enable = action === 'enable';
  return (
    <>
      <Button
        type="button"
        variant={enable ? 'primary' : 'secondary'}
        size="sm"
        onClick={() => {
          request.reset();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={enable ? `Ligar o log de acesso do ${name}?` : `Desligar o log de acesso do ${name}?`}
        description={
          enable
            ? 'O Verax faz a mudança na sua conta AWS, com a permissão que a pilha da Verax deu.'
            : 'O Verax desliga o log que ele mesmo ligou. Os arquivos já gravados ficam no bucket.'
        }
        confirmLabel={enable ? 'Ligar o log' : 'Desligar o log'}
        busyLabel="Pedindo…"
        danger={!enable}
        busy={request.isPending}
        error={request.error ? webLogsErrorText(request.error) : null}
        onConfirm={() => request.mutate(action, { onSuccess: () => setOpen(false) })}
      >
        {enable ? (
          <EnableExplanation source={source} />
        ) : (
          <p>
            Só o log de acesso deste balanceador é desligado, e só se ele ainda estiver como o Verax o deixou.
            O bucket e os arquivos continuam na sua conta, pela retenção dele. Para ligar de novo, é o mesmo
            botão.
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}

/**
 * O ALB com o log desligado (o grupo "Não habilitadas na AWS"): o pedido, o andamento, o resultado e, como alternativa, os
 * passos para fazer na conta.
 */
export function AlbLoggingControl({
  source,
  account,
  onboarding,
  canWrite,
}: {
  source: AwsSource;
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const alb = isAlb(source);
  const query = useAlbLogging(source.id, alb);
  const state = query.data;
  useRefreshOnResult(account, state);
  // O nó de antes (ou um NLB, que não chega aqui): o caminho de antes.
  if (!alb || state === null) return <AlbLoggingSteps source={source} account={account} />;
  if (state === undefined) {
    if (query.isError) {
      return (
        <div className="space-y-2">
          <p role="alert" className="text-xs text-critical-text">
            O estado do log não pôde ser lido. {webLogsErrorText(query.error)}
          </p>
          <AlbLoggingSteps source={source} account={account} manual />
        </div>
      );
    }
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Conferindo o log de acesso…
      </p>
    );
  }
  const manual = <AlbLoggingSteps source={source} account={account} manual />;
  if (state.pending !== null) {
    return (
      <p role="status" className="text-xs font-medium">
        {state.pending === 'enable'
          ? 'Ligando o log de acesso… O Verax confere a configuração na AWS antes de mudar.'
          : 'Desligando o log de acesso…'}
      </p>
    );
  }
  const canRequest = canWrite && account.status === 'active';
  if (state.status === 'enabled' && state.enabledByVerax) {
    return (
      <Notice tone="ok" title="Log de acesso ligado.">
        <p>
          O Verax ligou o log{state.enabledAt !== null && <> em {formatMinute(state.enabledAt)}</>}, no bucket{' '}
          <code className="break-all font-mono text-xs">{state.bucket}</code>. A descoberta já foi pedida: em
          alguns minutos o balanceador aparece em &ldquo;Disponíveis para coletar&rdquo;, e aí você pede a
          estimativa de volume.
        </p>
      </Notice>
    );
  }
  if (state.status === 'already_enabled') {
    return (
      <Notice tone="ok" title="O log já estava ligado.">
        <p>
          O log de acesso deste balanceador já grava no bucket{' '}
          <code className="break-all font-mono text-xs">{state.bucket ?? 'informado na AWS'}</code>, e o Verax
          não mudou nada. Rode a descoberta de novo: se o Verax ainda não ler esse bucket, ele aparece em
          &ldquo;Precisam de permissão adicional&rdquo;, com o que falta.
        </p>
      </Notice>
    );
  }
  const failure = state.status === 'failed' ? state.errorCode : null;
  return (
    <div className="space-y-2 text-sm">
      {failure !== null && (
        <Notice tone="medium" title="O log não foi ligado.">
          <p>{ALB_LOGGING_FAILURE_TEXTS[failure]}</p>
        </Notice>
      )}
      {isAlbStackUpdateFailure(failure) && (
        <Notice tone="medium" title="Atualize a pilha da Verax">
          <AlbStackUpdate account={account} onboarding={onboarding} />
        </Notice>
      )}
      {canRequest && failure !== 'other_region' && (
        <div className="flex flex-wrap items-center gap-2">
          <RequestButton source={source} action="enable" label="Ligar logs" />
          <span className="text-xs text-muted-foreground">
            O Verax liga só o log deste balanceador, num bucket da pilha. Tem custo na AWS.
          </span>
        </div>
      )}
      {manual}
    </div>
  );
}

/**
 * O ALB cujo log o Verax ligou, já entre os disponíveis ou os autorizados: de quando é, e o "Desligar log" (só com a
 * autorização retirada). Do log ligado por outra pessoa, nada aparece.
 */
export function AlbLoggingOwned({ source, canWrite }: { source: AwsSource; canWrite: boolean }) {
  const alb = isAlb(source);
  const query = useAlbLogging(source.id, alb);
  const state = query.data;
  if (!alb || state == null) return null;
  if (state.pending === 'disable') {
    return (
      <p role="status" className="text-xs font-medium">
        Desligando o log de acesso…
      </p>
    );
  }
  if (state.status === 'disabled' || state.status === 'released') {
    return (
      <p className="text-xs text-muted-foreground">
        {state.status === 'disabled'
          ? 'O Verax desligou o log de acesso deste balanceador. Rode a descoberta de novo para atualizar a lista.'
          : 'O log de acesso foi mudado fora do Verax depois de ligado: o Verax não mexe mais nele.'}
      </p>
    );
  }
  if (!state.enabledByVerax) return null;
  const authorized = source.authorization.authorizedAt !== null && source.authorization.revokedAt === null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Log de acesso ligado pelo Verax
        {state.enabledAt !== null && <> em {formatMinute(state.enabledAt)}</>}, no bucket{' '}
        <code className="break-all font-mono">{state.bucket}</code>.
      </p>
      {state.status === 'failed' && state.errorCode !== null && (
        <p role="alert" className="text-xs text-critical-text">
          O log não foi desligado. {ALB_LOGGING_FAILURE_TEXTS[state.errorCode]}
        </p>
      )}
      {canWrite &&
        (authorized ? (
          <p className="text-xs text-muted-foreground">
            Para desligar o log, retire antes a autorização deste balanceador.
          </p>
        ) : (
          <RequestButton source={source} action="disable" label="Desligar log" />
        ))}
    </div>
  );
}
