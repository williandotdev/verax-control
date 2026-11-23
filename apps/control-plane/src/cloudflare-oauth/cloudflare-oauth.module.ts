import { Module } from '@nestjs/common';
import { TenantsModule } from '../tenants/tenants.module.js';
import {
  CLOUDFLARE_CALLBACK_RATE_LIMITS_PROVIDER,
  CloudflareCallbackController,
} from './cloudflare-callback.controller.js';

/** O retorno do Cloudflare (`GET /v1/public/cloudflare/callback`). Só o `cp-public` registra este módulo. */
@Module({
  imports: [TenantsModule],
  controllers: [CloudflareCallbackController],
  providers: [CLOUDFLARE_CALLBACK_RATE_LIMITS_PROVIDER],
})
export class CloudflareOauthModule {}
