import type { FindingDraft } from '../../alerts/finding-draft.js';
import type { AwsFindingKeyLabel } from './finding-keys.js';

/**
 * O que os coletores de achados da API da AWS dividem: os tipos lidos, o achado já conferido (antes de ter dono) e o
 * resultado da leitura de um registro. Cada serviço tem o próprio arquivo (`guardduty.ts`, `security-hub.ts`,
 * `inspector.ts`, `access-analyzer.ts`) com a leitura da página e a conversão do registro.
 */

/** Os tipos de fonte lidos pela API de achados de cada serviço (`AwsSource.kind` com `method = api`). */
export const AWS_FINDING_KINDS = ['guardduty', 'security_hub', 'inspector', 'access_analyzer'] as const;
export type AwsFindingKind = (typeof AWS_FINDING_KINDS)[number];

export function isAwsFindingKind(kind: string): kind is AwsFindingKind {
  return (AWS_FINDING_KINDS as readonly string[]).includes(kind);
}

/** O dono de um achado, já decidido: o cliente e a conta (a do achado, que é a da fonte ou uma conta dele). */
export interface FindingOwner {
  tenantId: string;
  accountId: string;
}

/** Um achado da origem, conferido, antes de ter dono. */
export interface ParsedFinding {
  /** O nome do serviço na chave (`finding-keys.ts`). */
  label: AwsFindingKeyLabel;
  /** O ID do achado na origem: a base da chave e a referência dele na fila sem dono. Nunca um link. */
  nativeId: string;
  /** A versão do achado na origem (`updatedAt`), em ISO 8601. */
  updatedAt: string;
  /** As contas citadas no achado (sem repetição); `null` com um campo de conta fora do formato. */
  accounts: string[] | null;
  /** Os bytes do registro (o JSON dele): a medida do volume. */
  bytes: number;
  /** Security Hub: o serviço que gerou o achado, quando ele tem coletor próprio (para não duplicar). */
  product?: { kind: Extract<AwsFindingKind, 'guardduty' | 'inspector'>; region: string | undefined };
  /** Access Analyzer: o achado de acesso externo precisa do detalhe (`GetFindingV2`) para virar rascunho. */
  needsDetail?: boolean;
  /** O mínimo para a fila sem dono, quando a conta do achado não é do cliente da fonte. */
  summary: { title: string; ruleId: string; ruleLevel: number };
  /**
   * Os rascunhos do achado para o dono decidido: um, ou um por item na sondagem de porta do GuardDuty. `detail` é a
   * resposta do `GetFindingV2`, só nos achados que a pedem.
   */
  drafts(owner: FindingOwner, detail?: unknown): FindingDraft[];
}

/**
 * O resultado da leitura de um registro: o achado; `inactive` (arquivado, resolvido ou suprimido na origem: fora da
 * coleta, sem erro); ou `invalid` (fora do formato: contado, e nada é gravado dele).
 */
export type ParseOutcome =
  { ok: true; finding: ParsedFinding } | { ok: false; reason: 'inactive' | 'invalid' };

export const INVALID: ParseOutcome = { ok: false, reason: 'invalid' };
export const INACTIVE: ParseOutcome = { ok: false, reason: 'inactive' };

/** O intervalo de atualização pedido à origem. */
export interface FindingsWindow {
  since: Date;
  before: Date;
}

/** Uma página lida da origem: os registros como vieram e a continuação (null no fim). */
export interface FindingsPage {
  records: unknown[];
  nextToken: string | null;
}

/** Tamanho máximo de uma continuação da AWS que o coletor aceita (as maiores passam de alguns milhares de caracteres). */
const MAX_TOKEN = 100_000;

/** A continuação de uma resposta, conferida: texto não vazio; qualquer outra coisa é o fim da listagem. */
export function nextTokenOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN ? value : null;
}

/**
 * Uma chamada à AWS que falhou, com a ação do IAM dela (`guardduty:ListFindings`): é a ação que vai para a fonte quando
 * a recusa é de permissão. A mensagem é só a ação; o erro da AWS fica em `cause`, e dele só o nome é usado.
 */
export class FindingsCallError extends Error {
  constructor(
    readonly action: string,
    override readonly cause: unknown,
  ) {
    super(`leitura de achados da AWS: ${action}`);
    this.name = 'FindingsCallError';
  }
}

/**
 * Como os coletores chamam a AWS: a tarefa passa a função que aplica o limite de requisições, repete a chamada limitada
 * pela AWS (com recuo e sorteio) e embrulha a falha com a ação do IAM.
 */
export type FindingsCaller = <T>(action: string, call: () => Promise<T>) => Promise<T>;
