import {
  BadRequestException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ApiError, ValidationException } from './api-error.js';
import { toErrorResponse } from './all-exceptions.filter.js';

describe('toErrorResponse', () => {
  it('erro desconhecido vira 500 genérico', () => {
    expect(toErrorResponse(new Error('detalhe interno'))).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Erro interno',
    });
  });

  it('valores que nem são erros também viram 500 genérico', () => {
    expect(toErrorResponse('texto solto').statusCode).toBe(500);
    expect(toErrorResponse(undefined).statusCode).toBe(500);
  });

  it('mantém o status de exceções HTTP, com mensagem genérica', () => {
    expect(toErrorResponse(new NotFoundException('Usuário 42 não existe no cliente B'))).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Recurso não encontrado',
    });
    expect(toErrorResponse(new BadRequestException('detalhe')).message).toBe('Requisição inválida');
  });

  it('só ApiError mostra a mensagem própria', () => {
    expect(toErrorResponse(new ApiError(HttpStatus.CONFLICT, 'Já existe')).message).toBe('Já existe');
  });

  it('ApiError com status 5xx continua genérico', () => {
    expect(toErrorResponse(new ApiError(HttpStatus.BAD_GATEWAY, 'AWS respondeu X')).message).toBe(
      'Erro interno',
    );
  });

  it('503 tem mensagem própria, também genérica', () => {
    expect(toErrorResponse(new ServiceUnavailableException('banco caiu em db.internal'))).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Serviço temporariamente indisponível',
    });
  });

  it('validação devolve os problemas de cada campo', () => {
    const issues = [{ path: 'name', code: 'too_big', message: 'Muito grande' }];
    expect(toErrorResponse(new ValidationException(issues))).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Dados inválidos',
      issues,
    });
  });

  it('erros 4xx do parser do Express viram o status com mensagem genérica', () => {
    const parseError = Object.assign(new SyntaxError('Unexpected token } in JSON at position 12'), {
      status: 400,
      expose: true,
      type: 'entity.parse.failed',
    });
    expect(toErrorResponse(parseError)).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Requisição inválida',
    });
  });

  it('erro com status 4xx mas sem expose é tratado como interno', () => {
    expect(toErrorResponse(Object.assign(new Error('x'), { status: 401 })).statusCode).toBe(500);
  });
});
