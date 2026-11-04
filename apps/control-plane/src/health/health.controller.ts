import { Controller, Get } from '@nestjs/common';

/**
 * Health check do Cloud Run (sonda de partida) e do workflow de implantação, que só promove a revisão nova
 * depois de um 200 aqui. Fica fora do prefixo `/v1`, não exige autenticação e não consulta dependência alguma:
 * se o Firestore oscilar, a instância não entra em ciclo de reinício.
 */
@Controller('health')
export class HealthController {
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
