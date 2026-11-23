import { AWS_READER_AUTHORIZATIONS, type AwsOnboarding } from '@verax/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ALL_AWS_AUTHORIZATIONS,
  authorizationChoiceOf,
  type AwsAuthorizationChoice,
  chosenAuthorizations,
  storedAuthorizationChoice,
} from '@/features/admin/aws-connect';
import { useAwsConnect, useAwsConnecting } from '@/features/admin/aws-onboarding-api';

/**
 * A escolha das autorizações no "Conectar com AWS" e a gravação dela (`POST …/aws/connect` com as autorizações): o que
 * as caixas mostram, o que a API confirmou, e um pedido de cada vez entre os dois.
 *
 * - **O que sai da tela é a escolha confirmada.** O arquivo da pilha, o comando da CLI e os valores para digitar saem
 *   da escolha que a API confirmou (`confirmed`), nunca de uma caixa que o cliente marcou e que ainda não foi gravada.
 *   Assim o arquivo baixado é sempre o da escolha que ficou registrada.
 * - **Um pedido de cada vez, e vale a última escolha.** Enquanto um pedido está no caminho, marcar e desmarcar só muda
 *   o que as caixas mostram; quando ele termina, o seguinte leva a escolha de agora, se ela não for a que a API acabou
 *   de confirmar. Dois pedidos juntos poderiam ser gravados fora de ordem, e ficaria gravada uma escolha que o cliente
 *   já tinha desfeito.
 * - **A falha não some.** Se o pedido falha, as caixas ficam como o cliente as deixou, marcadas como não gravadas
 *   (`unsaved`), com o erro; nada sai da tela até a gravação dar certo (`retry`, ou o próprio "Conectar"). Voltar as
 *   caixas sozinho para a escolha gravada poderia marcar de novo uma autorização que o cliente acabou de desligar.
 * - **Um pedido de outra parte da tela também conta.** `saving` vale para qualquer "Conectar" desta conta no caminho
 *   (o "Conectar de novo" das conferências, ou o pedido de uma tela que fechou antes de ele terminar).
 */
export interface AwsChoiceControl {
  /** O que as caixas mostram: o que o cliente marcou por último, ou, sem mudança por gravar, a escolha confirmada. */
  shown: AwsAuthorizationChoice;
  /** A escolha que a API confirmou por último (a gravada): a do arquivo, do comando e de tudo que sai da tela. */
  confirmed: AwsAuthorizationChoice;
  /** Um "Conectar" desta conta está no caminho: a escolha gravada pode estar para mudar. */
  saving: boolean;
  /** As caixas mostram uma escolha que não está gravada, e nenhum pedido a está gravando. */
  unsaved: boolean;
  /** O erro do último pedido; null sem falha. */
  error: unknown;
  /** Marca ou desmarca sem gravar (antes de conectar: quem grava é o clique em "Conectar"). */
  pick: (choice: AwsAuthorizationChoice) => void;
  /** Marca ou desmarca e grava (na espera pela pilha: a escolha vale para o arquivo baixado de novo). */
  save: (choice: AwsAuthorizationChoice) => void;
  /** Tenta de novo a gravação que falhou. */
  retry: () => void;
  /**
   * Grava a escolha das caixas (o "Conectar") e devolve a que a API confirmou; null se o pedido falhou. Com um pedido
   * já no caminho, espera por ele e pelo que ainda faltar gravar.
   */
  confirm: () => Promise<AwsAuthorizationChoice | null>;
}

/** As duas escolhas ligam as mesmas autorizações? */
export function sameAwsChoice(a: AwsAuthorizationChoice, b: AwsAuthorizationChoice): boolean {
  return AWS_READER_AUTHORIZATIONS.every((authorization) => a[authorization] === b[authorization]);
}

/** A API respondeu sem a escolha que o pedido levou: nada do que as caixas mostram pode sair da tela. */
export class AwsChoiceNotConfirmedError extends Error {
  constructor() {
    super('A escolha das autorizações não foi confirmada.');
    this.name = 'AwsChoiceNotConfirmedError';
  }
}

/** A escolha gravada na resposta de um pedido que a levou; null se a API não a devolveu. */
function confirmedChoiceOf(onboarding: AwsOnboarding): AwsAuthorizationChoice | null {
  const { capabilities } = onboarding.connect;
  return capabilities === null ? null : authorizationChoiceOf(capabilities);
}

export function useAwsChoice(accountId: string, onboarding: AwsOnboarding | undefined): AwsChoiceControl {
  const { mutateAsync } = useAwsConnect(accountId);
  const confirmed = onboarding === undefined ? ALL_AWS_AUTHORIZATIONS : storedAuthorizationChoice(onboarding);
  // O que o cliente marcou e a API ainda não confirmou; null quando as caixas mostram a escolha confirmada.
  const [desired, setDesired] = useState<AwsAuthorizationChoice | null>(null);
  const [flushing, setFlushing] = useState(false);
  const connecting = useAwsConnecting(accountId);
  const saving = flushing || connecting;
  const [error, setError] = useState<unknown>(null);
  // O mesmo que `desired`, para o laço da gravação ler a escolha de agora (e não a do desenho em que ele começou).
  const wanted = useRef<AwsAuthorizationChoice | null>(null);
  const running = useRef<Promise<AwsAuthorizationChoice | null> | null>(null);
  const latestConfirmed = useRef(confirmed);
  useEffect(() => {
    latestConfirmed.current = confirmed;
  }, [confirmed]);

  const want = useCallback((choice: AwsAuthorizationChoice) => {
    wanted.current = choice;
    setDesired(choice);
    setError(null);
  }, []);

  const flush = useCallback((): Promise<AwsAuthorizationChoice | null> => {
    // Um pedido de cada vez: o que já está no caminho manda a escolha de agora quando terminar.
    if (running.current !== null) return running.current;
    const run = (async () => {
      setFlushing(true);
      setError(null);
      try {
        let result: AwsAuthorizationChoice | null = null;
        for (;;) {
          const sending = wanted.current;
          if (sending === null || (result !== null && sameAwsChoice(sending, result))) break;
          result = confirmedChoiceOf(await mutateAsync(chosenAuthorizations(sending)));
          // A API grava a escolha do pedido como veio: outra coisa na resposta não é uma confirmação.
          if (result === null || !sameAwsChoice(result, sending)) throw new AwsChoiceNotConfirmedError();
        }
        wanted.current = null;
        setDesired(null);
        return result;
      } catch (failure) {
        setError(failure);
        return null;
      } finally {
        running.current = null;
        setFlushing(false);
      }
    })();
    running.current = run;
    return run;
  }, [mutateAsync]);

  const save = useCallback(
    (choice: AwsAuthorizationChoice) => {
      want(choice);
      void flush();
    },
    [want, flush],
  );
  const retry = useCallback(() => void flush(), [flush]);
  const confirm = useCallback(() => {
    // Sem mudança por gravar, o "Conectar" confirma a escolha que está na tela: ela passa a ser a gravada.
    want(wanted.current ?? latestConfirmed.current);
    return flush();
  }, [want, flush]);

  return {
    shown: desired ?? confirmed,
    confirmed,
    saving,
    // Marcada igual à gravada (o "Verificar" a gravou, ou o pedido que falhou levava a mesma), não há o que gravar.
    unsaved: !saving && desired !== null && !sameAwsChoice(desired, confirmed),
    error,
    pick: want,
    save,
    retry,
    confirm,
  };
}
