import { Controller, Get } from '@nestjs/common';

/**
 * Health check do ALB e do ECS. Fica fora do prefixo /v1 e não exige sessão.
 *
 * `/health` responde se o processo está vivo e não consulta dependências: se o banco cair, as tasks não
 * entram em ciclo de reinício. A prontidão com o banco fica em `/health/ready`.
 */
@Controller('health')
export class HealthController {
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
