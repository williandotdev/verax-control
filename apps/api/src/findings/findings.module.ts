import { type DynamicModule, Module } from '@nestjs/common';
import { FindingsController } from './findings.controller.js';
import { FindingsService } from './findings.service.js';
import { NoRawEvents, RAW_EVENT_READER, type RawEventReader } from './raw-events.js';

@Module({})
export class FindingsModule {
  /** Sem indexer configurado (desenvolvimento e testes), o detalhe sai sem o evento bruto. */
  static register(rawEvents: RawEventReader = new NoRawEvents()): DynamicModule {
    return {
      module: FindingsModule,
      controllers: [FindingsController],
      providers: [FindingsService, { provide: RAW_EVENT_READER, useValue: rawEvents }],
    };
  }
}
