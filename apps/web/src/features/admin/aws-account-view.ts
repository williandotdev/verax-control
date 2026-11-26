import { type AwsOnboarding, type AwsSource, needsAwsSourceAttention } from '@verax/shared';
import { useCallback } from 'react';
import { useSearchParams } from 'react-router';
import { groupAwsSources } from '@/features/admin/aws-sources';

/**
 * O que a visão geral e as abas do detalhe da conta AWS conectada (E-04 da auditoria de UX) compartilham com a página:
 * as abas, a aba no endereço, o `id` dos dados da conta e as fontes que pedem atenção.
 */

/** O `id` dos dados da conta (conexão, última coleta, papel de leitura), na aba "Conexão e pilha". */
export const AWS_ACCOUNT_FACTS_ID = 'aws-conta-dados';

/** As fontes autorizadas que pedem alguém, na ordem da tabela "Fontes autorizadas". */
export function attentionSources(onboarding: Pick<AwsOnboarding, 'sources'>): AwsSource[] {
  return groupAwsSources(onboarding.sources).authorized.filter(needsAwsSourceAttention);
}

export const AWS_ACCOUNT_TABS = [
  'visao-geral',
  'fontes',
  'autorizar',
  'ataques-web',
  'conexao',
  'avancado',
] as const;
export type AwsAccountTab = (typeof AWS_ACCOUNT_TABS)[number];

const TAB_PARAM = 'aba';
const DEFAULT_TAB: AwsAccountTab = 'visao-geral';

export function isAwsAccountTab(value: string | null): value is AwsAccountTab {
  return (AWS_ACCOUNT_TABS as readonly (string | null)[]).includes(value);
}

/** A aba aberta, pelo endereço; trocar de aba troca o endereço sem empilhar histórico. */
export function useAwsAccountTab(): [AwsAccountTab, (tab: AwsAccountTab) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(TAB_PARAM);
  const tab = isAwsAccountTab(raw) ? raw : DEFAULT_TAB;
  const setTab = useCallback(
    (next: AwsAccountTab) =>
      setParams(
        (previous) => {
          const updated = new URLSearchParams(previous);
          if (next === DEFAULT_TAB) updated.delete(TAB_PARAM);
          else updated.set(TAB_PARAM, next);
          return updated;
        },
        { replace: true },
      ),
    [setParams],
  );
  return [tab, setTab];
}
