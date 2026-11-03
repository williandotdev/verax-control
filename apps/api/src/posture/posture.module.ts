import { Module } from '@nestjs/common';
import { PostureController } from './posture.controller.js';
import { PostureService } from './posture.service.js';

@Module({
  controllers: [PostureController],
  providers: [PostureService],
  exports: [PostureService],
})
export class PostureModule {}
