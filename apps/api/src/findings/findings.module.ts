import { Module } from '@nestjs/common';
import { FindingsController } from './findings.controller.js';
import { FindingsService } from './findings.service.js';
import { NoRawEvents, RAW_EVENT_READER } from './raw-events.js';

@Module({
  controllers: [FindingsController],
  providers: [FindingsService, { provide: RAW_EVENT_READER, useClass: NoRawEvents }],
})
export class FindingsModule {}
