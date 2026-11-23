import type { CloudAccount } from '@verax/shared';
import { useEffect, useMemo, useState } from 'react';
import {
  type AwsAuthorizationChoice,
  type PrefilledTemplate,
  prefilledReaderTemplate,
} from '@/features/admin/aws-connect';
import { useAwsReaderTemplate } from '@/features/admin/aws-onboarding-api';

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
