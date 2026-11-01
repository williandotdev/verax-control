import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Public } from '../../src/auth/decorators.js';
import { type Paginated, type PaginationQuery, paginationQuerySchema } from '@verax/shared';
import { z } from 'zod';
import { ApiError } from '../../src/common/http/api-error.js';
import { toPaginated, toPrismaPage } from '../../src/common/http/pagination.js';

export const createProbeSchema = z.strictObject({
  name: z.string().min(1).max(60),
  contact: z.strictObject({ email: z.email() }),
});

const ITEMS = Array.from({ length: 30 }, (_, i) => ({ id: `item-${i + 1}` }));

/** Rotas-sonda que exercitam os padrões da API (T1.2). Só existem nos testes. */
@Controller('probe')
@Public()
export class ProbeController {
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body({ schema: createProbeSchema }) body: z.infer<typeof createProbeSchema>): {
    received: unknown;
  } {
    return { received: body };
  }

  @Get('items')
  list(@Query({ schema: paginationQuerySchema }) query: PaginationQuery): Paginated<{ id: string }> {
    const { skip, take } = toPrismaPage(query);
    return toPaginated(ITEMS.slice(skip, skip + take), ITEMS.length, query);
  }

  @Get('items/:id')
  findOne(@Param('id', { schema: z.uuid() }) id: string): { id: string } {
    return { id };
  }

  @Get('no-input')
  noInput(): { ok: true } {
    return { ok: true };
  }

  @Post('no-body')
  @HttpCode(HttpStatus.OK)
  noBody(): { ok: true } {
    return { ok: true };
  }

  @Get('crash')
  crash(): never {
    // Simula um erro inesperado com detalhe interno sensível.
    throw new Error('falha conectando em postgresql://verax:leak-crash-4001@db.internal/verax');
  }

  @Get('conflict')
  conflict(): never {
    throw new ApiError(HttpStatus.CONFLICT, 'Este ID de conta já pertence a outro cliente');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('detalhe interno: papel leitura tentou rota de admin');
  }
}

@Module({ controllers: [ProbeController] })
export class ProbeModule {}
