import type { z } from 'zod';

/**
 * Fronteira entre o domínio e o Firestore: o pouco que os repositórios precisam (ler um documento, consultar uma
 * coleção, escrever dentro de uma transação). Há duas implementações com os mesmos testes de contrato:
 * `FirestoreDocumentStore` (produção e testes contra o emulador oficial) e `MemoryDocumentStore` (unitários).
 *
 * Decisões que simplificam o dublê e valem para as duas:
 * - documentos são substituídos inteiros (`set`), nunca atualizados por campo: o repositório lê, muda e grava
 *   dentro da transação, com validação zod antes de escrever;
 * - valores aceitos: objetos simples, arrays, string, number, boolean, null e `Date` (o Firestore guarda como
 *   `Timestamp` e a leitura devolve `Date` de volta); `undefined` é descartado;
 * - numa transação, todas as leituras vêm antes de todas as escritas, como o Firestore exige.
 */
export type DocumentData = Record<string, unknown>;

export interface StoredDocument {
  id: string;
  data: DocumentData;
}

export type WhereOperator = '==' | '<' | '<=' | '>' | '>=';

export interface WhereClause {
  /** Caminho do campo, com ponto para campos aninhados (`billing.graceUntil`). */
  field: string;
  op: WhereOperator;
  value: unknown;
}

export interface DocumentQuery {
  where?: readonly WhereClause[];
  /** Como no Firestore, documentos sem o campo da ordenação ficam fora do resultado. */
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  limit?: number;
}

export interface DocumentReader {
  get(collection: string, id: string): Promise<DocumentData | undefined>;
  query(collection: string, query?: DocumentQuery): Promise<StoredDocument[]>;
}

/** Escritas ficam pendentes até o commit da transação. */
export interface DocumentTransaction extends DocumentReader {
  /** Falha no commit (`DocumentAlreadyExistsError`) se o documento já existir. */
  create(collection: string, id: string, data: DocumentData): void;
  /** Substitui o documento inteiro (cria se não existir). */
  set(collection: string, id: string, data: DocumentData): void;
  delete(collection: string, id: string): void;
}

export interface DocumentStore extends DocumentReader {
  /**
   * Executa `fn` numa transação. No Firestore, uma transação que leu um documento alterado por outra antes do
   * commit é repetida do zero (até 5 vezes): `fn` precisa ser idempotente e lançar erro quando o estado relido
   * não permite mais a operação. Erros lançados por `fn` abortam a transação e são repassados sem nova tentativa.
   */
  runTransaction<T>(fn: (tx: DocumentTransaction) => Promise<T>): Promise<T>;
  /** Id aleatório para documentos sem chave natural (transições, auditoria). */
  newId(): string;
}

export const DOCUMENT_STORE = Symbol('DOCUMENT_STORE');

export class DocumentAlreadyExistsError extends Error {
  constructor(readonly documents: readonly string[]) {
    super(`documento já existe: ${documents.join(', ')}`);
    this.name = 'DocumentAlreadyExistsError';
  }
}

export class ReadAfterWriteError extends Error {
  constructor() {
    super('numa transação, todas as leituras vêm antes de todas as escritas');
    this.name = 'ReadAfterWriteError';
  }
}

/** Documento gravado fora do formato esperado. A mensagem cita o caminho e os campos, nunca os valores. */
export class DocumentValidationError extends Error {
  constructor(
    readonly collection: string,
    readonly id: string,
    readonly issues: readonly string[],
  ) {
    super(`documento inválido em ${collection}/${id}: ${issues.join('; ')}`);
    this.name = 'DocumentValidationError';
  }
}

/** Valida um documento lido ("zod em toda leitura"), nomeando o documento no erro. */
export function parseDocument<T extends z.ZodType>(
  schema: T,
  collection: string,
  id: string,
  data: DocumentData,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new DocumentValidationError(
      collection,
      id,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`),
    );
  }
  return result.data;
}

const SEGMENT_PATTERN = /^[^/]+$/;

/** Caminho de coleção: número ímpar de segmentos (`tenants`, `tenants/<id>/transitions`), nenhum vazio. */
export function assertCollectionPath(collection: string): void {
  const segments = collection.split('/');
  if (segments.length % 2 === 0 || segments.some((segment) => !SEGMENT_PATTERN.test(segment))) {
    throw new TypeError(`caminho de coleção inválido: ${collection}`);
  }
}

export function assertDocumentId(id: string): void {
  if (!SEGMENT_PATTERN.test(id) || id === '.' || id === '..') {
    throw new TypeError('id de documento inválido');
  }
}
