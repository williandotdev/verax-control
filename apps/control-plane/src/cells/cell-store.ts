import { Inject, Injectable } from '@nestjs/common';
import { cellIdSchema } from '@verax/shared';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  parseDocument,
} from '../firestore/document-store.js';
import { type CellRecord, cellSchema } from './cell.schema.js';

/** A célula pedida não está no registro (ou o id nem é de célula). */
export class CellNotFoundError extends Error {
  constructor() {
    super('célula fora do registro');
    this.name = 'CellNotFoundError';
  }
}

/**
 * Leitura do registro `cells/{id}` (CE-06). A gravação é do responsável, pelo console (CE-15, junto com a escolha da
 * célula); aqui, só o que o canal precisa: os nomes do tópico de comandos e da assinatura de relatórios.
 */
@Injectable()
export class CellStore {
  constructor(@Inject(DOCUMENT_STORE) private readonly store: DocumentStore) {}

  async get(cellId: string, reader: DocumentReader = this.store): Promise<CellRecord | undefined> {
    if (!cellIdSchema.safeParse(cellId).success) return undefined;
    const data = await reader.get(COLLECTIONS.cells, cellId);
    if (data === undefined) return undefined;
    return { id: cellId, ...parseDocument(cellSchema, COLLECTIONS.cells, cellId, data) };
  }

  async require(cellId: string, reader?: DocumentReader): Promise<CellRecord> {
    const cell = await this.get(cellId, reader);
    if (cell === undefined) throw new CellNotFoundError();
    return cell;
  }
}
