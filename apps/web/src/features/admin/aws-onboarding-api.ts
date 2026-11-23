import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AwsConnect,
  type AwsOnboarding,
  awsOnboardingSchema,
  type AwsReaderAuthorization,
  type AwsSource,
  type AwsSourcesAuthorize,
  cloudAccountSchema,
} from '@verax/shared';
import { api } from '@/lib/api';
import { AWS_READER_TEMPLATE_URL } from './aws-reader-template';

/**
 * O onboarding self-service de uma conta AWS no painel (`GET` e as escritas de `/v1/cloud-accounts/:id/aws/...`). A
 * tela nunca adianta um estado: toda escrita responde com o estado da conta já atualizado, e é ele que entra no cache.
 * Enquanto uma mudança é esperada, a leitura se repete sozinha (`awsOnboardingPollInterval`); parada, não.
 */

/** Enquanto algo está para mudar sozinho: a pilha sendo criada, a descoberta, os coletores, uma conferência pedida. */
export const AWS_ONBOARDING_FAST_POLL_MS = 5_000;
/** Com fontes autorizadas: a saúde da coleta muda devagar. */
export const AWS_ONBOARDING_SLOW_POLL_MS = 60_000;

/** Por quanto tempo a fonte recém-configurada, ainda sem evento, conta como "para mudar logo". */
const SETTLING_WINDOW_MS = 2 * 60_000;
/** Por quanto tempo, depois de entrar na conta, a primeira descoberta ainda é esperada. */
const FIRST_DISCOVERY_WINDOW_MS = 5 * 60_000;

/**
 * A conta acabou de ser autenticada (o "Conectar" ou a leitura das etiquetas do papel foram há pouco)? Só aí a
 * primeira descoberta está para chegar; num ambiente que não descobre as fontes sozinho, a conta fica autenticada sem
 * descoberta, e reler a cada 5 s não traria nada.
 */
function justAuthenticated(onboarding: AwsOnboarding, now: number): boolean {
  const moments = [onboarding.template.checkedAt, onboarding.connect.requestedAt].flatMap((at) =>
    at === null ? [] : [Date.parse(at)],
  );
  return moments.some((at) => now - at < FIRST_DISCOVERY_WINDOW_MS);
}

/**
 * A fonte autorizada está para mudar de estado sozinha? Enquanto o coletor dela é configurado, sim; configurada e
 * ainda sem evento, só nos primeiros minutos (uma fonte sem tráfego pode ficar assim por muito tempo).
 */
function isSettling(source: AwsSource, now: number): boolean {
  if (source.authorization.authorizedAt === null || source.authorization.revokedAt !== null) return false;
  if (source.state === 'authorized' || source.state === 'configuring') return true;
  return source.state === 'waiting_events' && now - Date.parse(source.stateSince) < SETTLING_WINDOW_MS;
}

/**
 * De quanto em quanto tempo reler o estado, ou `false` para não reler:
 * - a cada 5 s enquanto uma transição é esperada: a espera pelo papel, a autenticação que acabou de passar (a
 *   descoberta vem em seguida, por uns minutos), a descoberta pendente ou em curso, os coletores sendo configurados (da
 *   conta ou de uma fonte recém-autorizada) e a conferência de uma fonte pedida no painel;
 * - a cada 60 s com fontes autorizadas (coletando, parcial ou com erro): a saúde da coleta;
 * - nunca quando só o cliente pode mudar algo: antes de conectar, com o tempo esgotado, desconectada, ou esperando a
 *   escolha das fontes.
 */
export function awsOnboardingPollInterval(
  onboarding: AwsOnboarding | undefined,
  now: number = Date.now(),
): number | false {
  if (onboarding === undefined) return false;
  const run = onboarding.discovery.run;
  const discovering = run !== null && (run.status === 'pending' || run.status === 'running');
  const probing = onboarding.sources.some((source) => source.probeRequestedAt !== null);
  const settling = onboarding.sources.some((source) => isSettling(source, now));
  switch (onboarding.state) {
    case 'awaiting_authorization':
    case 'discovering':
    case 'configuring':
      return AWS_ONBOARDING_FAST_POLL_MS;
    case 'authenticated':
      // A descoberta que falhou inteira não anda sozinha: fica parada até alguém pedir outra. Sem descoberta
      // nenhuma, a primeira só é esperada logo depois da entrada na conta.
      if (discovering || probing) return AWS_ONBOARDING_FAST_POLL_MS;
      return run === null && justAuthenticated(onboarding, now) ? AWS_ONBOARDING_FAST_POLL_MS : false;
    case 'collecting':
    case 'partial':
    case 'permission_error':
    case 'ingestion_failure':
      return discovering || probing || settling ? AWS_ONBOARDING_FAST_POLL_MS : AWS_ONBOARDING_SLOW_POLL_MS;
    case 'awaiting_sources':
    case 'not_started':
    case 'authorization_timeout':
    case 'disconnected':
      return discovering || probing ? AWS_ONBOARDING_FAST_POLL_MS : false;
  }
}

const onboardingKey = (accountId: string) => ['aws-onboarding', accountId] as const;
const path = (accountId: string, rest: string) =>
  `/v1/cloud-accounts/${encodeURIComponent(accountId)}/aws/${rest}`;

/** O estado da conexão, as conferências, a descoberta e as fontes da conta. */
export function useAwsOnboarding(accountId: string, enabled = true) {
  return useQuery({
    queryKey: onboardingKey(accountId),
    queryFn: () => api.get(path(accountId, 'onboarding'), awsOnboardingSchema),
    enabled,
    refetchInterval: (query) => awsOnboardingPollInterval(query.state.data),
  });
}

/** As listas de contas mostram a conexão e as regiões, que uma escrita do onboarding muda. */
const ACCOUNT_LIST_KEYS = ['admin-cloud-accounts', 'cloud-accounts'] as const;

/**
 * Uma escrita do onboarding: a resposta é o estado novo da conta, e é ela que a tela passa a mostrar. Uma leitura que
 * estava no caminho é cancelada antes, para não devolver à tela o estado de antes da escrita.
 */
function useOnboardingWrite<TInput>(accountId: string, write: (input: TInput) => Promise<AwsOnboarding>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    onSuccess: async (onboarding) => {
      await queryClient.cancelQueries({ queryKey: onboardingKey(accountId) });
      queryClient.setQueryData(onboardingKey(accountId), onboarding);
      for (const key of ACCOUNT_LIST_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/**
 * O corpo do "Conectar" e do "Verificar": as autorizações que o cliente marcou, quando o clique as confirma (a API as
 * guarda como a escolha dele); sem elas, nenhum corpo, e a escolha gravada fica como está.
 */
function choiceBody(capabilities: AwsReaderAuthorization[] | void): AwsConnect | undefined {
  return capabilities === undefined ? undefined : { capabilities };
}

/**
 * "Conectar com AWS": o servidor passa a tentar a entrada no papel por até 60 min. Com as autorizações marcadas na
 * tela, elas ficam gravadas: a tela recarregada devolve as mesmas caixas e o mesmo arquivo.
 */
export const useAwsConnect = (accountId: string) =>
  useOnboardingWrite(accountId, (capabilities: AwsReaderAuthorization[] | void) =>
    api.post(path(accountId, 'connect'), choiceBody(capabilities), awsOnboardingSchema),
  );

/** Pede outra descoberta das fontes (no máximo uma a cada 5 min). */
export const useAwsDiscovery = (accountId: string) =>
  useOnboardingWrite(accountId, () => api.post(path(accountId, 'discovery'), undefined, awsOnboardingSchema));

/** Autoriza a coleta das fontes citadas; as sensíveis vão repetidas em `sensitiveSourceIds`. */
export const useAwsAuthorizeSources = (accountId: string) =>
  useOnboardingWrite(accountId, (input: AwsSourcesAuthorize) =>
    api.post(path(accountId, 'sources/authorize'), input, awsOnboardingSchema),
  );

/** Tira a autorização de uma fonte. */
export const useAwsRevokeSource = (accountId: string) =>
  useOnboardingWrite(accountId, (sourceId: string) =>
    api.post(
      path(accountId, `sources/${encodeURIComponent(sourceId)}/revoke`),
      undefined,
      awsOnboardingSchema,
    ),
  );

/** "Verificar de novo" numa fonte: pede a conferência da permissão dela. */
export const useAwsRetrySource = (accountId: string) =>
  useOnboardingWrite(accountId, (sourceId: string) =>
    api.post(
      path(accountId, `sources/${encodeURIComponent(sourceId)}/retry`),
      undefined,
      awsOnboardingSchema,
    ),
  );

/**
 * "Verificar conexão": o pedido de sempre (`POST …/aws/verify`), que responde com a conta. O estado do onboarding é
 * relido em seguida, junto das listas de contas. Depois de atualizar a pilha (ou a política do usuário de leitura)
 * pela tela, o pedido leva as autorizações marcadas ali: passam a ser a escolha gravada do cliente.
 */
export function useAwsVerify(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (capabilities: AwsReaderAuthorization[] | void) =>
      api.post(path(accountId, 'verify'), choiceBody(capabilities), cloudAccountSchema),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: onboardingKey(accountId) });
      for (const key of ACCOUNT_LIST_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

/**
 * O texto do template do papel de leitura (o arquivo do repositório, servido pelo painel). Lido uma vez, quando a tela
 * de conectar abre: assim o clique em "Conectar com AWS" monta o arquivo, baixa e abre o console na hora, sem esperar
 * rede (um navegador barra a aba aberta depois de uma espera).
 */
export function useAwsReaderTemplate(enabled = true) {
  return useQuery({
    queryKey: ['aws-reader-template'],
    queryFn: async () => {
      const response = await fetch(AWS_READER_TEMPLATE_URL, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('template indisponível');
      return response.text();
    },
    enabled,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
