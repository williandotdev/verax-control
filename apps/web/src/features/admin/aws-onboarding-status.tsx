import { type AwsOnboarding, type AwsOnboardingCheck, type CloudAccount } from '@verax/shared';
import { Button } from '@/components/ui/button';
import { useAwsConnect, useAwsDiscovery, useAwsVerify } from '@/features/admin/aws-onboarding-api';
import {
  AWS_CHECK_STATUS_LABELS,
  AWS_CHECK_STATUS_TONES,
  AWS_ONBOARDING_STATE_STEP,
  AWS_ONBOARDING_STEP_LABELS,
  AWS_ONBOARDING_STEPS,
  type AwsCheckAction,
  awsCheckLabel,
  awsCheckText,
  awsOnboardingErrorText,
  awsOnboardingStateText,
  STEP_STATUS_LABELS,
  type StepStatus,
  type Tone,
} from '@/features/admin/aws-onboarding-labels';
import { attentionChecks, lastVerifiedAt } from '@/features/admin/aws-sources';
import { Notice, Section, ToneIcon } from '@/features/admin/aws-ui';
import { cn } from '@/lib/cn';
import { formatRelative, formatTimestamp } from '@/lib/format';

const STEP_TONES: Readonly<Record<Exclude<StepStatus, 'current'>, Tone>> = {
  done: 'ok',
  failed: 'critical',
  upcoming: 'idle',
};

/**
 * Os passos da conexão, na ordem em que acontecem. O passo atual e o que já passou saem só do estado que a API mandou:
 * a tela nunca marca um passo como feito por conta própria. O atual leva o nome do estado ("Descoberta em andamento",
 * "Parcialmente operacional"); os outros, o nome do passo.
 */
function OnboardingSteps({ onboarding }: { onboarding: AwsOnboarding }) {
  const position = AWS_ONBOARDING_STATE_STEP[onboarding.state];
  if (position === null) return null;
  const current = AWS_ONBOARDING_STEPS.indexOf(position.step);
  const state = awsOnboardingStateText(onboarding.state, onboarding.credentialMode);
  return (
    <ol aria-label="Passos da conexão" className="space-y-1.5 text-sm">
      {AWS_ONBOARDING_STEPS.map((step, index) => {
        const status: StepStatus =
          index < current ? 'done' : index > current ? 'upcoming' : position.failed ? 'failed' : 'current';
        const here = index === current;
        return (
          <li
            key={step}
            aria-current={here ? 'step' : undefined}
            className={cn('flex items-start gap-2', status === 'upcoming' && 'text-muted-foreground')}
          >
            <ToneIcon tone={status === 'current' ? state.tone : STEP_TONES[status]} className="mt-0.5" />
            <span className={cn(here && 'font-semibold')}>
              {here ? state.label : AWS_ONBOARDING_STEP_LABELS[step]}
              <span className="sr-only"> ({STEP_STATUS_LABELS[status]})</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const ACTION_LABELS: Readonly<Record<AwsCheckAction, string>> = {
  connect: 'Conectar de novo',
  verify: 'Verificar de novo',
  discover: 'Rodar a descoberta de novo',
};

/**
 * As nove conferências da conexão, cada uma com a situação (ícone e texto), o que ela quer dizer pelo código e, quando
 * há o que fazer aqui, o "tentar de novo" dela: conectar de novo (o tempo esgotou), verificar a conexão ou rodar a
 * descoberta outra vez. As das fontes autorizadas apontam para a linha da fonte, onde está o que corrigir. Antes de a
 * conexão começar, nenhuma se aplica: a lista fica recolhida, para o "Conectar com AWS" vir primeiro.
 */
export function AwsOnboardingChecks({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const verify = useAwsVerify(account.id);
  const connect = useAwsConnect(account.id);
  const discovery = useAwsDiscovery(account.id);
  const act = (action: AwsCheckAction) => {
    if (action === 'connect') connect.mutate();
    else if (action === 'verify') verify.mutate();
    else discovery.mutate();
  };
  const error = verify.error ?? connect.error ?? discovery.error;
  const busy = verify.isPending || connect.isPending || discovery.isPending;
  const canAct = canWrite && account.status === 'active';
  // Com o pedido pendente ou a descoberta em curso, repetir o pedido não muda nada.
  const run = onboarding.discovery.run;
  const discovering = run !== null && (run.status === 'pending' || run.status === 'running');
  const available = (check: AwsOnboardingCheck, action: AwsCheckAction): boolean => {
    if (!canAct) return false;
    if (action === 'discover') return !discovering && check.id === 'discovery';
    return onboarding.state !== 'awaiting_authorization';
  };
  const list = (
    <ul aria-label="Conferências da conexão" className="divide-y rounded-md border text-sm">
      {onboarding.checks.map((check) => {
        const { text, action } = awsCheckText(check);
        return (
          <li key={check.id} className="flex items-start gap-2 px-3 py-2">
            <ToneIcon tone={AWS_CHECK_STATUS_TONES[check.status]} className="mt-0.5" />
            <div className="min-w-0 flex-1 space-y-1">
              <p>
                <span className="font-medium">{awsCheckLabel(check.id, onboarding.credentialMode)}</span>
                <span className="text-muted-foreground"> · {AWS_CHECK_STATUS_LABELS[check.status]}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {text}
                {check.checkedAt !== null && <> Conferido {formatRelative(check.checkedAt)}.</>}
              </p>
              {action !== null && available(check, action) && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => act(action)}
                >
                  {action === 'discover' && run === null ? 'Rodar a descoberta' : ACTION_LABELS[action]}
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
  return (
    <Section id="aws-conferencias" title="Conferências da conexão">
      {error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(error)}
        </p>
      ) : null}
      {onboarding.state === 'not_started' ? (
        <details className="space-y-3 text-sm">
          <summary className="cursor-pointer">
            O que o Verax confere depois de conectar ({onboarding.checks.length} conferências)
          </summary>
          {list}
        </details>
      ) : (
        list
      )}
    </Section>
  );
}

/**
 * A situação da conexão da conta: o aviso do estado (nunca um "tudo certo" com algo essencial pendente ou falhando), a
 * última verificação, os passos e o "Verificar conexão". Tudo vem do estado que a API mandou.
 */
export function AwsOnboardingStatus({
  account,
  onboarding,
  canWrite,
}: {
  account: CloudAccount;
  onboarding: AwsOnboarding;
  canWrite: boolean;
}) {
  const verify = useAwsVerify(account.id);
  const active = account.status === 'active';
  const state = awsOnboardingStateText(onboarding.state, onboarding.credentialMode);
  const attention = attentionChecks(onboarding);
  const verified = lastVerifiedAt(onboarding.checks);
  const waiting = onboarding.state === 'awaiting_authorization';
  // Verificação comum (sem a janela do "Conectar"): o papel já deveria existir, e o servidor tenta por 10 min.
  const verifying = waiting && onboarding.connect.waitingUntil === null;
  // Coletando, mas com uma conferência que falhou ou ainda espera: o aviso deixa de ser o verde do "tudo certo".
  const tone: Tone = state.tone === 'ok' && attention.length > 0 ? 'medium' : state.tone;
  const title = state.tone === 'ok' && attention.length > 0 ? `${state.label}, com pendências` : state.label;

  return (
    <Section id="aws-situacao" title="Situação da conexão">
      <Notice tone={active ? tone : 'idle'} title={active ? title : 'Monitoramento desativado'} role="status">
        <p>
          {!active
            ? 'Esta conta não está sendo monitorada. Reative o monitoramento para conectar a conta.'
            : verifying
              ? onboarding.credentialMode === 'access_key'
                ? 'O Verax está conferindo a conta com a chave do usuário de leitura. Uma chave recém-criada pode levar alguns segundos para valer: ele tenta de novo por até 10 minutos.'
                : 'O Verax está conferindo a conexão desta conta. Logo depois de criar ou atualizar a pilha, o papel pode levar alguns minutos para valer: ele tenta de novo por até 10 minutos.'
              : state.description}
        </p>
        {active && attention.length > 0 && (
          <p>
            Pendências:{' '}
            {attention.map((check) => awsCheckLabel(check.id, onboarding.credentialMode)).join('; ')}. O que
            fazer está em cada uma, em{' '}
            <a href="#aws-conferencias" className="underline">
              Conferências da conexão
            </a>
            .
          </p>
        )}
      </Notice>
      <p className="text-xs text-muted-foreground">
        {verified === null
          ? 'Conexão ainda não verificada.'
          : `Última verificação da conexão: ${formatRelative(verified)} (${formatTimestamp(verified)}).`}
      </p>
      {active && <OnboardingSteps onboarding={onboarding} />}
      {canWrite && active && onboarding.state !== 'not_started' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => verify.mutate()}
            disabled={waiting || verify.isPending}
          >
            {verifying ? 'Verificando…' : 'Verificar conexão'}
          </Button>
        </div>
      )}
      {!canWrite && (
        <p className="text-sm text-muted-foreground">Quem administra as contas pede a verificação.</p>
      )}
      {verify.error ? (
        <p role="alert" className="text-sm text-critical-text">
          {awsOnboardingErrorText(verify.error)}
        </p>
      ) : null}
    </Section>
  );
}
