import { useQueryClient } from '@tanstack/react-query';
import {
  AWS_READER_STACK_NAME,
  type AwsOnboarding,
  type AwsOnboardingState,
  type CloudAccount,
  needsAwsSourceAttention,
} from '@verax/shared';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SOURCE_ATTENTION_KEY } from '@/features/admin/admin-api';
import { useAwsChoice } from '@/features/admin/aws-choice';
import { AwsAccountOverview } from '@/features/admin/aws-account-overview';
import { type AwsAccountTabItem, AwsAccountTabs } from '@/features/admin/aws-account-tabs';
import type { AwsAccountTab } from '@/features/admin/aws-account-view';
import { AwsConnectPanel, AwsWaitingPanel } from '@/features/admin/aws-connect-panel';
import { AwsDiscoveryResults } from '@/features/admin/aws-discovery-results';
import { useSourceRetry } from '@/features/admin/aws-hooks';
import { AwsKeySteps } from '@/features/admin/aws-key-steps';
import { useAwsOnboarding, useAwsVerify } from '@/features/admin/aws-onboarding-api';
import { awsOnboardingErrorText } from '@/features/admin/aws-onboarding-labels';
import { AwsOnboardingChecks, AwsOnboardingStatus } from '@/features/admin/aws-onboarding-status';
import { AwsSourceGroups } from '@/features/admin/aws-source-groups';
import { AwsSourceMonitor } from '@/features/admin/aws-source-monitor';
import { groupAwsSources } from '@/features/admin/aws-sources';
import { AwsStackStatus } from '@/features/admin/aws-stack-status';
import { Section } from '@/features/admin/aws-ui';
import { WebAttacksSection } from '@/features/web-attacks/web-attacks-section';

/** Os estados em que o Verax não está dentro da conta: antes de conectar, esperando, com o tempo esgotado ou recusado. */
const OUTSIDE_STATES: readonly AwsOnboardingState[] = [
  'not_started',
  'awaiting_authorization',
  'authorization_timeout',
  'disconnected',
];

/** As listas de contas mostram a conexão e as regiões, que mudam junto com o estado do onboarding. */
const ACCOUNT_LIST_KEYS = ['admin-cloud-accounts', SOURCE_ATTENTION_KEY, 'cloud-accounts'] as const;

/**
 * Quando o estado da conta, a descoberta ou as regiões mudam numa releitura, as listas de contas são relidas: o selo da
 * conexão e as regiões monitoradas do cadastro acompanham o que o servidor gravou.
 */
function useAccountListRefresh(onboarding: AwsOnboarding | undefined): void {
  const queryClient = useQueryClient();
  const signature =
    onboarding === undefined
      ? null
      : `${onboarding.state}|${onboarding.discovery.run?.status ?? ''}|${onboarding.discovery.regions.join(',')}|${onboarding.sources.filter(needsAwsSourceAttention).length}`;
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (signature === null) return;
    if (previous.current !== null && previous.current !== signature) {
      for (const key of ACCOUNT_LIST_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    }
    previous.current = signature;
  }, [signature, queryClient]);
}

/**
 * O caminho de volta: quando a conta muda fora desta seção (os buckets fora do padrão salvos, o monitoramento
 * desativado ou reativado, a chave trocada), a conexão recomeça na API, e o estado do onboarding é relido na hora, em
 * vez de esperar a próxima releitura.
 */
function useOnboardingRefresh(account: CloudAccount, refetch: () => void): void {
  const signature = `${account.updatedAt}|${account.status}|${account.connection}|${account.checkRequestedAt ?? ''}`;
  const previous = useRef(signature);
  useEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    refetch();
  }, [signature, refetch]);
}

/**
 * A conta que já esteve conectada e voltou ao começo (os buckets fora do padrão mudaram, ou o monitoramento foi
 * reativado): a pilha provavelmente continua na conta, e criar outra daria erro. O caminho é atualizar a pilha, se
 * algo mudou, e verificar a conexão.
 */
function ReconnectPanel({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const verify = useAwsVerify(account.id);
  const active = account.status === 'active';
  return (
    <Section id="aws-reconectar" title={`Reconectar a conta ${account.accountId}`}>
      <p className="text-sm">
        Esta conta já esteve conectada. Se a pilha{' '}
        <code className="font-mono text-xs">{AWS_READER_STACK_NAME}</code> continua na conta, não crie outra:
        se os buckets fora do padrão ou as autorizações mudaram, atualize a pilha (em &ldquo;Pilha na
        AWS&rdquo;, abaixo) e depois clique em Verificar conexão.
      </p>
      {canWrite && active && (
        <Button type="button" onClick={() => verify.mutate()} disabled={verify.isPending}>
          Verificar conexão
        </Button>
      )}
      {canWrite && !active && <p className="text-sm">Reative o monitoramento para verificar a conta.</p>}
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

/**
 * A conta AWS em Contas cloud (`docs/ARQUITETURA.md`, "Onboarding AWS self-service"): a situação da conexão, o
 * "Conectar com AWS" (ou, na VM própria do cliente, os passos da chave de leitura), a pilha, o que a descoberta
 * encontrou, as fontes para autorizar e a saúde das autorizadas. O que aparece em cada momento sai do estado que a API
 * manda (`GET …/aws/onboarding`), relido sozinho enquanto uma mudança é esperada; a tela nunca adianta um passo.
 *
 * As autorizações marcadas também saem dele: a tela começa com a escolha que a API guardou (`storedAuthorizationChoice`)
 * e só passa a valer a que o cliente mudar aqui. Recarregada ou reaberta, ela devolve as mesmas caixas, e o arquivo
 * baixado de novo é o mesmo: nunca volta sozinha para as três ligadas. A gravação da escolha é uma só para a tela
 * inteira (`useAwsChoice`): um pedido de cada vez, e o arquivo sempre com a escolha que a API confirmou.
 */
/**
 * O que o detalhe da conta põe nas abas (E-04): os dados da conta (conexão, última coleta, papel de leitura), que vão
 * para "Conexão e pilha", e o fim do detalhe (buckets fora do padrão, desativar e excluir), que vai para "Avançado".
 * Sem as abas (a primeira conexão, guiada do passo 1 ao 3), os dois ficam acima e abaixo da seção, como sempre.
 */
export interface AwsAccountLayout {
  facts: ReactNode;
  advanced: ReactNode;
  /** A aba aberta e a troca dela (`useAwsAccountTab`, no endereço). */
  tab: AwsAccountTab;
  onTabChange: (tab: AwsAccountTab) => void;
}

export function AwsOnboardingSection({
  account,
  canWrite,
  layout,
}: {
  account: CloudAccount;
  canWrite: boolean;
  /** O detalhe da conta: com ele, a conta já conectada abre em abas. */
  layout?: AwsAccountLayout;
}) {
  const query = useAwsOnboarding(account.id);
  // O que as caixas mostram, a escolha que a API confirmou e a gravação entre as duas.
  const choice = useAwsChoice(account.id, query.data);
  // Um pedido de conferência para a conta inteira: a fonte muda de lista quando a resposta chega.
  const retry = useSourceRetry(account.id, query.data?.discoveryAvailable ?? true);
  useAccountListRefresh(query.data);
  const { refetch } = query;
  useOnboardingRefresh(
    account,
    useCallback(() => void refetch(), [refetch]),
  );

  if (query.error && !query.data) {
    return (
      <Framed layout={layout}>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Framed>
    );
  }
  if (!query.data) {
    return (
      <Framed layout={layout}>
        <LoadingState rows={3} label="Carregando a conexão da conta" />
      </Framed>
    );
  }

  const onboarding = query.data;
  const { state } = onboarding;
  const keyMode = onboarding.credentialMode === 'access_key';
  const outside = OUTSIDE_STATES.includes(state);
  // Já entrou nesta conta alguma vez (a primeira verificação grava o início da coleta; as etiquetas, a leitura delas).
  const connectedBefore = account.ingestFrom !== null || onboarding.template.checkedAt !== null;
  const discovered = onboarding.discovery.run !== null || onboarding.discovery.lastCompletedAt !== null;
  const waitingForStack = state === 'awaiting_authorization' && onboarding.connect.waitingUntil !== null;
  const connectPanel = (again: boolean) => (
    <AwsConnectPanel account={account} canWrite={canWrite} choice={choice} again={again} />
  );
  const keySteps = (
    <AwsKeySteps
      account={account}
      canWrite={canWrite}
      choice={choice.shown}
      onChoiceChange={choice.pick}
      state={state}
    />
  );

  // A conta já conectada (entrou alguma vez e tem fonte autorizada) abre em abas. A primeira conexão segue o passo a
  // passo, do "Conectar" à autorização das primeiras fontes, numa página só.
  const { authorized, groups } = groupAwsSources(onboarding.sources);
  if (layout && connectedBefore && authorized.length > 0) {
    const balancers = authorized.filter((source) => source.kind === 'elb_logs' && source.collectable).length;
    const listed = discovered || onboarding.sources.length > 0;
    const items: AwsAccountTabItem[] = [
      {
        value: 'visao-geral',
        label: 'Visão geral',
        content: (
          <>
            {/* O que há para fazer agora fica no topo: o tempo esgotado, a reconexão e a espera pela pilha. */}
            {!keyMode && state === 'authorization_timeout' && connectPanel(true)}
            {!keyMode && state === 'not_started' && <ReconnectPanel account={account} canWrite={canWrite} />}
            {!keyMode && waitingForStack && (
              <AwsWaitingPanel
                account={account}
                onboarding={onboarding}
                canWrite={canWrite}
                choice={choice}
              />
            )}
            <AwsAccountOverview
              account={account}
              onboarding={onboarding}
              onShowSources={() => layout.onTabChange('fontes')}
            />
          </>
        ),
      },
      {
        value: 'fontes',
        label: 'Fontes lidas',
        count: authorized.length,
        content:
          authorized.length > 0 ? (
            <AwsSourceMonitor account={account} onboarding={onboarding} canWrite={canWrite} retry={retry} />
          ) : (
            <p className="text-sm text-muted-foreground">
              Nenhuma fonte autorizada ainda. As que a descoberta encontrou estão em &ldquo;Para
              autorizar&rdquo;.
            </p>
          ),
      },
      {
        value: 'autorizar',
        label: 'Para autorizar',
        count: groups.available.length,
        content: listed ? (
          <AwsSourceGroups account={account} onboarding={onboarding} canWrite={canWrite} retry={retry} />
        ) : (
          <p className="text-sm text-muted-foreground">
            As fontes de log da conta aparecem aqui quando a descoberta terminar.
          </p>
        ),
      },
      ...(balancers > 0
        ? [
            {
              value: 'ataques-web',
              label: 'Ataques web',
              count: balancers,
              content: <WebAttacksSection account={account} onboarding={onboarding} canWrite={canWrite} />,
            } satisfies AwsAccountTabItem,
          ]
        : []),
      {
        value: 'conexao',
        label: keyMode ? 'Conexão e usuário' : 'Conexão e pilha',
        content: (
          <>
            {layout.facts}
            <AwsOnboardingStatus account={account} onboarding={onboarding} canWrite={canWrite} />
            {keyMode && (
              <details className="space-y-3" open={outside ? true : undefined}>
                <summary className="cursor-pointer text-sm font-medium">
                  Chave de leitura e políticas do usuário
                </summary>
                {keySteps}
              </details>
            )}
            {account.status === 'active' && (
              <AwsOnboardingChecks account={account} onboarding={onboarding} canWrite={canWrite} />
            )}
            <AwsStackStatus account={account} onboarding={onboarding} canWrite={canWrite} />
            <AwsDiscoveryResults account={account} onboarding={onboarding} canWrite={canWrite} />
            {!keyMode && (state === 'disconnected' || state === 'not_started') && (
              <details className="space-y-3">
                <summary className="cursor-pointer text-sm font-medium">
                  A pilha foi apagada da conta? Criar de novo
                </summary>
                {connectPanel(true)}
              </details>
            )}
          </>
        ),
      },
      { value: 'avancado', label: 'Avançado', content: layout.advanced },
    ];
    // Sem balanceador autorizado, a aba "Ataques web" não existe: o endereço que apontava para ela abre a visão geral.
    const shown = items.some((item) => item.value === layout.tab) ? layout.tab : 'visao-geral';
    return <AwsAccountTabs tab={shown} onTabChange={layout.onTabChange} items={items} />;
  }

  return (
    <Framed layout={layout}>
      <AwsOnboardingStatus account={account} onboarding={onboarding} canWrite={canWrite} />

      {/* Na VM própria: os passos da chave, abertos enquanto a conta não conecta e recolhidos depois. */}
      {keyMode && (
        <details className="space-y-3" open={outside ? true : undefined}>
          <summary className="cursor-pointer text-sm font-medium">
            Chave de leitura e políticas do usuário
          </summary>
          {keySteps}
        </details>
      )}

      {!keyMode && state === 'authorization_timeout' && connectPanel(true)}
      {!keyMode && state === 'not_started' && !connectedBefore && connectPanel(false)}
      {!keyMode && state === 'not_started' && connectedBefore && (
        <ReconnectPanel account={account} canWrite={canWrite} />
      )}
      {!keyMode && waitingForStack && (
        <AwsWaitingPanel account={account} onboarding={onboarding} canWrite={canWrite} choice={choice} />
      )}

      {/* Depois do que há para fazer agora (conectar, criar a pilha): o que o Verax conferiu, passo a passo. */}
      {account.status === 'active' && (
        <AwsOnboardingChecks account={account} onboarding={onboarding} canWrite={canWrite} />
      )}

      {(!outside || (state === 'not_started' && connectedBefore)) && (
        <AwsStackStatus account={account} onboarding={onboarding} canWrite={canWrite} />
      )}
      {/* Dentro da conta, a descoberta aparece mesmo antes de rodar: é dali que se pede a primeira. */}
      {(discovered || !outside) && (
        <AwsDiscoveryResults account={account} onboarding={onboarding} canWrite={canWrite} />
      )}
      {(discovered || onboarding.sources.length > 0) && (
        <>
          <AwsSourceMonitor account={account} onboarding={onboarding} canWrite={canWrite} retry={retry} />
          <WebAttacksSection account={account} onboarding={onboarding} canWrite={canWrite} />
          <AwsSourceGroups account={account} onboarding={onboarding} canWrite={canWrite} retry={retry} />
        </>
      )}

      {!keyMode && (state === 'disconnected' || (state === 'not_started' && connectedBefore)) && (
        <details className="space-y-3">
          <summary className="cursor-pointer text-sm font-medium">
            A pilha foi apagada da conta? Criar de novo
          </summary>
          {connectPanel(true)}
        </details>
      )}
    </Framed>
  );
}

/** Sem abas: os dados da conta acima da seção e o fim do detalhe abaixo, na ordem de sempre. */
function Framed({ layout, children }: { layout: AwsAccountLayout | undefined; children: ReactNode }) {
  return (
    <>
      {layout?.facts}
      <div className="space-y-5">{children}</div>
      {layout?.advanced}
    </>
  );
}
