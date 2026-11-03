import { Controller, Get, Query } from '@nestjs/common';
import {
  type Paginated,
  type PostureCheck,
  type PostureCheckListQuery,
  postureCheckListQuerySchema,
  type PostureOverview,
} from '@verax/shared';
import { RequirePermission } from '../auth/decorators.js';
import { PostureService } from './posture.service.js';

/** Postura do cliente da sessão (T5.8): nota por conta, evolução e checagens reprovadas. */
@Controller('posture')
export class PostureController {
  constructor(private readonly posture: PostureService) {}

  @Get()
  @RequirePermission('posture:read')
  overview(): Promise<PostureOverview> {
    return this.posture.overview();
  }

  @Get('checks')
  @RequirePermission('posture:read')
  checks(
    @Query({ schema: postureCheckListQuerySchema }) query: PostureCheckListQuery,
  ): Promise<Paginated<PostureCheck>> {
    return this.posture.checks(query);
  }
}
