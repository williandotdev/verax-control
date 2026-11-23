import { AWS_SOURCE_RETRY_INTERVAL_MS, type AwsOnboardingErrorCode, type CloudAccount } from '@verax/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  type AwsAuthorizationChoice,
  type PrefilledTemplate,
  prefilledReaderTemplate,
} from '@/features/admin/aws-connect';
import { useAwsReaderTemplate, useAwsRetrySource } from '@/features/admin/aws-onboarding-api';
import { ApiRequestError } from '@/lib/api-client';

/**
 * O horário de agora (em milissegundos), atualizado de tempos em tempos: para o que a tela mostra em relação ao relógio
 * (o tempo que falta da janela do "Conectar"). O estado da conta continua vindo só da API; isto só redesenha a conta
 * regressiva.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** O arquivo da pilha desta conta: carregando, com erro de leitura do modelo, ou montado (ou recusado, com o motivo). */
export interface AwsStackFile {
  loading: boolean;
  error: boolean;
  retry: () => void;
  file: PrefilledTemplate | null;
}

/**
 * O arquivo preenchido desta conta com a escolha atual, pronto antes do clique: o modelo é lido quando a tela abre, e o
 * preenchimento roda no navegador. Assim o clique baixa o arquivo e abre o console na hora, sem esperar a rede.
 */
export function useAwsStackFile(
  account: CloudAccount,
  choice: AwsAuthorizationChoice,
  enabled = true,
): AwsStackFile {
  const template = useAwsReaderTemplate(enabled);
  const file = useMemo(
    () => (template.data === undefined ? null : prefilledReaderTemplate(template.data, account, choice)),
    [template.data, account, choice],
  );
  return {
    loading: enabled && template.isPending,
    error: template.isError,
    retry: () => void template.refetch(),
    file,
  };
}

/** O "Verificar de novo" (ou "Tentar de novo") das fontes de uma conta. */
export interface SourceRetry {
  /** Pede à API a conferência da fonte. */
  retry: (sourceId: string) => void;
  /** A fonte cujo pedido está indo para a API agora; null sem pedido no caminho. */
  pendingId: string | null;
  /** Quantos segundos faltam para a mesma fonte aceitar outro pedido; 0 quando já aceita. */
  secondsLeft: (sourceId: string) => number;
  /** A recusa do último pedido e a fonte dele; null sem recusa. */
  error: { sourceId: string; error: unknown } | null;
}

const RETRY_RATE_LIMITED: AwsOnboardingErrorCode = 'SOURCE_RETRY_RATE_LIMITED';

/**
 * O pedido de conferência de uma fonte, um para a conta inteira (a fonte muda de lista quando a resposta chega). A API
 * aceita um pedido a cada 30 s por fonte (`AWS_SOURCE_RETRY_INTERVAL_MS`; o seguinte responde 429
 * `SOURCE_RETRY_RATE_LIMITED`): depois do clique, o botão da fonte fica desligado pelos segundos que faltam, contados
 * aqui, para o clique seguinte não bater na recusa. A contagem só anda enquanto alguma fonte está esperando. Uma
 * recusa por outro motivo (a conta desconectada, por exemplo) desfaz a espera: a API não gravou pedido nenhum, e o
 * botão volta a valer assim que o motivo for resolvido.
 */
export function useSourceRetry(accountId: string): SourceRetry {
  const mutation = useAwsRetrySource(accountId);
  const [until, setUntil] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [now, setNow] = useState(() => Date.now());
  const waiting = [...until.values()].some((at) => at > now);
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  const retry = (sourceId: string) => {
    const clickedAt = Date.now();
    setNow(clickedAt);
    setUntil((current) => new Map(current).set(sourceId, clickedAt + AWS_SOURCE_RETRY_INTERVAL_MS));
    mutation.mutate(sourceId, {
      onError: (error) => {
        if (error instanceof ApiRequestError && error.code === RETRY_RATE_LIMITED) return;
        setUntil((current) => {
          const next = new Map(current);
          next.delete(sourceId);
          return next;
        });
      },
    });
  };
  const failed = mutation.variables;
  return {
    retry,
    pendingId: mutation.isPending ? (mutation.variables ?? null) : null,
    secondsLeft: (sourceId) => Math.max(0, Math.ceil(((until.get(sourceId) ?? 0) - now) / 1_000)),
    error: mutation.error && failed !== undefined ? { sourceId: failed, error: mutation.error } : null,
  };
}
