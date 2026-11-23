/**
 * A trava de só leitura dos clientes da AWS que a descoberta usa (a ideia do `ReadOnlyClient` de
 * `infra/diagnostico/diagnostico_aws.py`): só passam os comandos cujo nome começa com `Describe`, `Get`, `List` ou
 * `BatchGet`. Qualquer outro é recusado aqui, antes de sair para a rede, mesmo que o papel do cliente tivesse a
 * permissão: a Verax nunca cria nem altera nada na conta dele.
 *
 * É a segunda linha de defesa. A primeira é a política do papel de leitura (só ações de leitura, com as negações
 * explícitas de `Guardrails`); esta protege de um erro nosso, como um comando de escrita que entre por engano num
 * coletor novo.
 */

/** O nome da classe do comando do SDK (`DescribeTrailsCommand`), como ele sai na trilha do CloudTrail sem o sufixo. */
const READ_ONLY_COMMAND = /^(?:Describe|Get|List|BatchGet)[A-Z][A-Za-z0-9]*Command$/;

/** Tentativa de mandar um comando que não é de leitura. A mensagem só tem o nome do comando. */
export class ReadOnlyViolation extends Error {
  constructor(readonly command: string) {
    super(`a descoberta só faz chamadas de leitura: ${command} foi recusado`);
    this.name = 'ReadOnlyViolation';
  }
}

/** O nome do comando (o da classe dele); vazio para o que não é um comando do SDK. */
export function commandName(command: unknown): string {
  const name = (command as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
  return typeof name === 'string' ? name : '';
}

export function isReadOnlyCommand(command: unknown): boolean {
  return READ_ONLY_COMMAND.test(commandName(command));
}

/** Lança `ReadOnlyViolation` para o comando que não é de leitura. */
export function assertReadOnly(command: unknown): void {
  if (!isReadOnlyCommand(command))
    throw new ReadOnlyViolation(commandName(command) || 'comando desconhecido');
}

type Sender<T extends { send: unknown }> = Pick<T, 'send'>;

/**
 * O cliente com a trava: o `send` confere o comando antes de repassar ao cliente de verdade. A recusa é uma exceção
 * lançada na hora, sem promessa pendente e sem nenhuma chamada de rede.
 */
export function readOnly<T extends { send: unknown }>(client: Sender<T>): Sender<T> {
  const target = client as unknown as { send(command: unknown, ...rest: unknown[]): unknown };
  const send = (command: unknown, ...rest: unknown[]): unknown => {
    assertReadOnly(command);
    return target.send(command, ...rest);
  };
  return { send };
}
