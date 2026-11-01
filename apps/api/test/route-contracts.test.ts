import 'reflect-metadata';
import { Body, Controller, Get, Module, Param, Post, Query } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findRouteContractViolations } from '../src/common/http/route-contracts.js';
import type { ErrorResponseBody } from '../src/common/http/all-exceptions.filter.js';
import { createApp } from './support/create-app.js';
import { ProbeController, ProbeModule } from './support/probe.module.js';

/** Controller com cada violação possível, para provar que o meta-teste as encontra. */
@Controller('broken')
class BrokenController {
  @Post('no-schema')
  noSchema(@Body() body: unknown): unknown {
    return body;
  }

  @Get('field')
  field(@Query('page', { schema: z.string() }) page: string): { page: string } {
    return { page };
  }

  @Post('loose')
  loose(@Body({ schema: z.object({ name: z.string() }) }) body: unknown): unknown {
    return body;
  }

  @Post('nested-loose')
  nestedLoose(
    @Body({ schema: z.strictObject({ items: z.array(z.object({ id: z.string() })).optional() }) })
    body: unknown,
  ): unknown {
    return body;
  }

  @Get(':id')
  param(@Param('id') id: string): { id: string } {
    return { id };
  }
}

@Module({ controllers: [BrokenController] })
class BrokenModule {}

describe('contrato de entrada de todas as rotas (T1.2)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ imports: [ProbeModule, BrokenModule] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('toda rota real da aplicação valida corpo, query e parâmetros com schema estrito', () => {
    const violations = findRouteContractViolations(app).filter(
      (violation) => !violation.route.startsWith(BrokenController.name),
    );
    expect(violations).toEqual([]);
  });

  it('as rotas-sonda dos testes também seguem o contrato', () => {
    const probeViolations = findRouteContractViolations(app).filter((violation) =>
      violation.route.startsWith(ProbeController.name),
    );
    expect(probeViolations).toEqual([]);
  });

  it('detecta cada tipo de violação', () => {
    const broken = findRouteContractViolations(app).filter((violation) =>
      violation.route.startsWith(BrokenController.name),
    );

    expect(broken).toEqual(
      expect.arrayContaining([
        { route: 'BrokenController.noSchema', problem: 'body sem schema zod' },
        {
          route: 'BrokenController.field',
          problem: 'query extraído por campo ("page"); valide o objeto inteiro',
        },
        { route: 'BrokenController.loose', problem: 'body: objeto não estrito em $' },
        { route: 'BrokenController.nestedLoose', problem: 'body: objeto não estrito em $.items[]' },
        { route: 'BrokenController.param', problem: 'param sem schema zod' },
      ]),
    );
    expect(broken).toHaveLength(5);
  });

  it('em tempo de execução, rota sem schema não chega ao handler (500 genérico)', async () => {
    const server = app.getHttpServer();
    const response = await request(server).post('/v1/broken/no-schema').send({ any: 'thing' }).expect(500);
    expect((response.body as ErrorResponseBody).message).toBe('Erro interno');
    await request(server).get('/v1/broken/qualquer-coisa').expect(500);
  });
});
