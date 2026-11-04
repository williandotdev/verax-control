import { type DynamicModule, Global, Module } from '@nestjs/common';
import { CLOCK, type Clock, SystemClock } from '../common/clock.js';
import { DOCUMENT_STORE, type DocumentStore } from './document-store.js';

export interface FirestoreModuleOptions {
  /** `FirestoreDocumentStore` em produção; `MemoryDocumentStore` nos testes unitários. */
  store: DocumentStore;
  /** Relógio dos carimbos de tempo; os testes passam um relógio falso. */
  clock?: Clock;
}

@Global()
@Module({})
export class FirestoreModule {
  static forRoot(options: FirestoreModuleOptions): DynamicModule {
    return {
      module: FirestoreModule,
      providers: [
        { provide: DOCUMENT_STORE, useValue: options.store },
        { provide: CLOCK, useValue: options.clock ?? new SystemClock() },
      ],
      exports: [DOCUMENT_STORE, CLOCK],
    };
  }
}
